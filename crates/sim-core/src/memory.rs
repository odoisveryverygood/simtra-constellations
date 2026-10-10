//! Persona memory layer (v0) backed by Neo4j.
//!
//! Every synthetic resident gets a durable memory of three things:
//!   1. **Events** thrown into the world (a news event such as "a political figure
//!      was shot"), scoped to a city so every persona in that city remembers it.
//!   2. **Tests** the resident took part in (polls, A/B tests, counterfactual runs)
//!      together with the answer their archetype gave and the rationale.
//!   3. **Stimuli** the resident was shown (A/B variants, counterfactual events).
//!
//! Graph shape:
//!
//! ```text
//! (:City {key, slug, workspace})   key = slug for the public workspace, "{ws}:{slug}" otherwise
//! Personas and Populations are SHARED by every workspace (one copy of each city's
//! residents). Workspace privacy lives on Test.workspace / Event.workspace and the
//! workspace's City node, so a new visitor costs a handful of nodes, not 10,000.
//! (:Population {key, city, seed, n})-[:IN_CITY]->(:City)
//! (:Persona {key, agent_id, name, ...})-[:MEMBER_OF]->(:Population)
//! (:Event {id, kind, text, as_of_date})-[:HAPPENED_IN]->(:City)     city-wide news
//! (:Persona)-[:EXPOSED_TO {at}]->(:Event)                            targeted exposure / stimulus
//! (:Test {id, kind, question, framing, as_of_date, model, p_yes, ...})-[:RAN_ON]->(:Population)
//! (:Persona)-[:ANSWERED {p_yes, dist, why, archetype, at, personal_p_yes?, personal_dist?, personal_why?}]->(:Test)
//! (:Test)-[:UNDER_EVENT]->(:Event)                                   the poll's stimulus event
//! (:Test)-[:USED_STIMULUS]->(:Stimulus {id, label, text})            A/B variants
//! (:DataQuery {id, question, answer, response_json})-[:ASKED_IN]->(:City)  verified-data questions
//! (:Persona)-[:REACTED_TO {text, sentiment, at}]->(:Event)            social-feed reaction
//! ```
//!
//! A persona's memory as of a date is the union of city-wide events, its explicit
//! exposures, and the tests it answered, all with `as_of_date <= date`. Recall is
//! ordered deterministically (date, then id) so the prompt text, and therefore the
//! model cache key, is stable across runs.
//!
//! The layer is optional and best-effort, like InsForge: a missing or unreachable
//! Neo4j never turns a successful prediction into a failed one. Writes run in
//! background tasks; recall runs inline with a short timeout and degrades to an
//! empty memory block.
//!
//! Transport is Neo4j's HTTP Query API (`/db/<db>/query/v2`), which Aura and
//! Neo4j 5.x both expose, so no driver crate is needed. Set `NEO4J_HTTP_API=tx`
//! for a Neo4j 4.x server that only has the legacy `/db/<db>/tx/commit` endpoint.

use crate::persona::Population;
use crate::predict::{Framing, Poll, PollResult};
use anyhow::{anyhow, Result};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::time::Duration;

/// Personas written per UNWIND batch. Neo4j handles far more, but keeping each
/// request small bounds latency and memory on the server side.
const BATCH: usize = 2_000;
/// Cap on events recalled per persona into a prompt.
pub const RECALL_EVENTS: usize = 5;
/// Cap on prior tests recalled per persona into a prompt.
pub const RECALL_TESTS: usize = 3;
/// Cap on characters of memory text appended to one resident profile.
/// Sized so RECALL_EVENTS events plus RECALL_TESTS tests fit at their per-item caps.
const RECALL_MAX_CHARS: usize = 900;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum HttpApi {
    /// `/db/<db>/query/v2`: one statement per request (Aura, Neo4j 5.x).
    Query,
    /// `/db/<db>/tx/commit`: legacy transactional endpoint (Neo4j 4.x / self-hosted).
    Tx,
}

#[derive(Clone)]
pub struct MemoryClient {
    http: Client,
    base: String,
    database: String,
    api: HttpApi,
    user: String,
    password: String,
}

/// Something that happened in the world and that residents remember.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MemoryEvent {
    pub id: String,
    pub city: String,
    /// `news` (city-wide fact), `stimulus` (hypothetical shown during a test).
    pub kind: String,
    pub text: String,
    pub as_of_date: String,
    pub created_at: String,
}

/// A recorded test (poll / A/B / counterfactual leg).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TestRecord {
    pub id: String,
    pub kind: String,
    pub question: String,
    pub description: String,
    pub framing: String,
    pub as_of_date: String,
    pub model: String,
    pub p_yes: f64,
    pub options: Vec<String>,
    pub p_distribution: Vec<f64>,
    pub n_agents: usize,
    pub n_archetypes: usize,
    pub simulation_id: String,
    pub branch_id: String,
    pub created_at: String,
    /// JSON `{"breakdowns", "option_breakdowns", "p_distribution"}` so the demographic
    /// evidence chart can be rebuilt from the timeline later. Empty when too large.
    #[serde(default)]
    pub breakdowns_json: String,
    /// Memory workspace the test belongs to (`public` = shared demo data).
    #[serde(default)]
    pub workspace: String,
    /// City slug the population was sampled from.
    #[serde(default)]
    pub city: String,
}

/// Largest breakdown payload stored on a Test node (bytes).
const MAX_BREAKDOWNS_BYTES: usize = 200_000;

/// A verified-data question answered from the committed PUMS snapshot (no model).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DataQueryRecord {
    pub id: String,
    pub city: String,
    pub question: String,
    pub answer: String,
    pub status: String,
    pub created_at: String,
}

/// One persona's answer to a test (inherited from its archetype).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AgentAnswer {
    pub agent_id: u32,
    pub p_yes: f64,
    pub dist: Vec<f64>,
    pub why: String,
    pub archetype: String,
    /// The resident's OWN answer (one model call per listed resident), when it has
    /// been asked for; otherwise the archetype answer above is all there is.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub personal_p_yes: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub personal_dist: Option<Vec<f64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub personal_why: Option<String>,
}

/// One resident's own answer to a test, in their own words.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PersonalAnswer {
    pub agent_id: u32,
    pub p_yes: f64,
    pub dist: Vec<f64>,
    pub why: String,
}

/// Sentiments a reaction may carry (exact wire strings).
pub const SENTIMENTS: [&str; 7] = [
    "support", "oppose", "worried", "angry", "sad", "hopeful", "indifferent",
];

/// Normalise a model-supplied sentiment to the vocabulary; unknown -> `indifferent`.
pub fn normalize_sentiment(s: &str) -> String {
    let s = s.trim().to_ascii_lowercase();
    SENTIMENTS
        .iter()
        .find(|k| **k == s)
        .map(|k| k.to_string())
        .unwrap_or_else(|| "indifferent".to_string())
}

/// One resident's public reaction to an event (social-feed comment).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Reaction {
    pub agent_id: u32,
    pub name: String,
    pub occupation: String,
    pub neighborhood: String,
    pub age: String,
    pub archetype: String,
    pub text: String,
    pub sentiment: String,
    pub at: String,
}

/// An event as shown in the feed: the event plus a reaction summary.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EventFeedItem {
    #[serde(flatten)]
    pub event: MemoryEvent,
    pub reaction_count: usize,
    pub sentiment: BTreeMap<String, usize>,
    pub reactions: Vec<Reaction>,
}

/// One entry in a city's lineage: everything thrown into the world (news events) and
/// everything asked of the residents (tests), in wall-clock order.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum LineageItem {
    Event {
        id: String,
        kind: String,
        text: String,
        as_of_date: String,
        created_at: String,
        reaction_count: usize,
        sentiment: BTreeMap<String, usize>,
    },
    Test {
        id: String,
        kind: String,
        question: String,
        description: String,
        framing: String,
        as_of_date: String,
        model: String,
        p_yes: f64,
        options: Vec<String>,
        p_distribution: Vec<f64>,
        n_agents: usize,
        n_archetypes: usize,
        simulation_id: String,
        branch_id: String,
        population_key: String,
        created_at: String,
        /// City events the residents could remember when this test was asked.
        events_known: usize,
        under_event: Option<String>,
        stimuli: Vec<StimulusRecord>,
        previous_p_yes: Option<f64>,
        delta: Option<f64>,
        /// Stored demographic breakdowns (`{"breakdowns","option_breakdowns","p_distribution"}`),
        /// or null for tests recorded before breakdowns were kept.
        breakdowns: Option<Value>,
    },
    /// A verified-data question (survey-weighted PUMS statistic, no model).
    #[serde(rename = "data_query")]
    DataQuery {
        id: String,
        question: String,
        answer: String,
        status: String,
        created_at: String,
        /// The full `/data-query` response, so the verified chart can be re-rendered.
        response: Value,
    },
}

impl LineageItem {
    pub fn created_at(&self) -> &str {
        match self {
            LineageItem::Event { created_at, .. }
            | LineageItem::Test { created_at, .. }
            | LineageItem::DataQuery { created_at, .. } => created_at,
        }
    }
    pub fn id(&self) -> &str {
        match self {
            LineageItem::Event { id, .. }
            | LineageItem::Test { id, .. }
            | LineageItem::DataQuery { id, .. } => id,
        }
    }
}

/// Fill `previous_p_yes`/`delta` on each test from the most recent earlier test with the
/// same question and framing. Input must already be in chronological order.
pub fn attach_deltas(items: &mut [LineageItem]) {
    let mut last: HashMap<(String, String), f64> = HashMap::new();
    for item in items.iter_mut() {
        if let LineageItem::Test { question, framing, p_yes, previous_p_yes, delta, .. } = item {
            let key = (question.clone(), framing.clone());
            match last.get(&key) {
                Some(prev) => {
                    *previous_p_yes = Some(*prev);
                    *delta = Some(*p_yes - *prev);
                }
                None => {
                    *previous_p_yes = None;
                    *delta = None;
                }
            }
            last.insert(key, *p_yes);
        }
    }
}

/// Count reactions per sentiment; only sentiments that occur are present.
pub fn sentiment_tally(reactions: &[Reaction]) -> BTreeMap<String, usize> {
    let mut m = BTreeMap::new();
    for r in reactions {
        *m.entry(r.sentiment.clone()).or_insert(0) += 1;
    }
    m
}

fn reaction_from_value(v: &Value) -> Option<Reaction> {
    let s = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
    Some(Reaction {
        agent_id: v.get("agent_id")?.as_u64()? as u32,
        name: s("name"),
        occupation: s("occupation"),
        neighborhood: s("neighborhood"),
        age: s("age"),
        archetype: s("archetype"),
        text: s("text"),
        sentiment: s("sentiment"),
        at: s("at"),
    })
}

/// A/B stimulus shown during a test.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StimulusRecord {
    pub label: String,
    pub text: String,
}

/// Where a test came from; attached to the Test node so memory can be traced back.
#[derive(Clone, Debug, Default)]
pub struct TestTag {
    pub kind: String,
    pub simulation_id: String,
    pub branch_id: String,
    pub stimuli: Vec<StimulusRecord>,
    /// Memory workspace the run reads from and writes to (empty = public).
    pub workspace: String,
}

impl TestTag {
    pub fn poll() -> Self {
        TestTag { kind: "poll".into(), ..Default::default() }
    }
    pub fn kind(kind: &str) -> Self {
        TestTag { kind: kind.into(), ..Default::default() }
    }
    pub fn on_branch(mut self, simulation_id: &str, branch_id: &str) -> Self {
        self.simulation_id = simulation_id.to_string();
        self.branch_id = branch_id.to_string();
        self
    }
    pub fn in_workspace(mut self, workspace: &str) -> Self {
        self.workspace = workspace.to_string();
        self
    }
    /// The effective workspace: `public` unless one was set.
    pub fn workspace(&self) -> String {
        normalize_workspace(if self.workspace.is_empty() { None } else { Some(&self.workspace) })
    }
}

/// Recalled memory for one persona, ordered oldest -> newest.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct PersonaMemory {
    pub events: Vec<RecalledEvent>,
    pub tests: Vec<RecalledTest>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RecalledEvent {
    pub id: String,
    pub kind: String,
    pub text: String,
    pub as_of_date: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RecalledTest {
    pub id: String,
    pub kind: String,
    pub question: String,
    pub as_of_date: String,
    pub p_yes: f64,
    pub options: Vec<String>,
    pub dist: Vec<f64>,
    pub why: String,
}

/// Stable identity for a population: the same (city, seed, n) always yields the
/// same personas, so memory survives server restarts and new simulations.
pub fn population_key(city: &str, seed: u64, n: usize) -> String {
    format!("{city}:{seed}:{n}")
}

/// Identity of a concrete population: the plain (city, seed, n) key, extended with a
/// fingerprint of the demographic filters when the population was sampled from a
/// filtered record set. Unfiltered populations keep the short key.
pub fn population_key_of(pop: &Population) -> String {
    let base = population_key(&pop.profile.slug, pop.seed, pop.n);
    if pop.filter_key.is_empty() {
        base
    } else {
        let mut h = Sha256::new();
        h.update(pop.filter_key.as_bytes());
        format!("{base}:f{}", &hex::encode(h.finalize())[..10])
    }
}

/// The workspace that holds all memory written before workspaces existed, and
/// the one used when a request carries no (valid) `X-Simtra-Workspace` header.
pub const PUBLIC_WORKSPACE: &str = "public";

/// Validate a workspace id from a header or query string; anything else is `public`.
pub fn normalize_workspace(raw: Option<&str>) -> String {
    match raw.map(str::trim) {
        Some(id)
            if !id.is_empty()
                && id.len() <= 32
                && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') =>
        {
            id.to_string()
        }
        _ => PUBLIC_WORKSPACE.to_string(),
    }
}

/// Key of the City node a workspace sees: the bare slug for `public` (existing data),
/// `"{workspace}:{slug}"` otherwise. Slugs never contain ':'.
pub fn city_key(workspace: &str, slug: &str) -> String {
    if workspace == PUBLIC_WORKSPACE {
        slug.to_string()
    } else {
        format!("{workspace}:{slug}")
    }
}

/// Inverse of [`city_key`]: (workspace, slug).
pub fn split_city_key(key: &str) -> (String, String) {
    match key.split_once(':') {
        Some((ws, slug)) => (ws.to_string(), slug.to_string()),
        None => (PUBLIC_WORKSPACE.to_string(), key.to_string()),
    }
}

/// Population identity as seen from a workspace. Personas and populations are SHARED
/// across workspaces (one copy of the 10,000 residents, whatever the workspace), so
/// this is always the bare [`population_key_of`]. Workspace privacy lives on the
/// memory nodes instead: `Test.workspace`, `Event.workspace`, and the workspace's City.
pub fn population_key_in(_workspace: &str, pop: &Population) -> String {
    population_key_of(pop)
}

pub fn persona_key(population_key: &str, agent_id: u32) -> String {
    format!("{population_key}:{agent_id}")
}

/// Map a Neo4j URI to the HTTP base the Query API lives on. Aura's `neo4j+s://host`
/// (Bolt) maps to `https://host`; plain `http(s)://` is used as given.
fn http_base(uri: &str) -> Option<String> {
    let uri = uri.trim().trim_end_matches('/');
    if uri.starts_with("http://") || uri.starts_with("https://") {
        return Some(uri.to_string());
    }
    for scheme in ["neo4j+s://", "neo4j+ssc://", "bolt+s://", "bolt+ssc://"] {
        if let Some(host) = uri.strip_prefix(scheme) {
            return Some(format!("https://{host}"));
        }
    }
    None
}

pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// Surveys every fresh workspace starts with (question prefix, copies to take). The
/// order is the order judges see them; a missing item falls back to the newest polls.
pub const SEED_SURVEYS: &[(&str, usize)] = &[
    ("Should San Francisco provide free Muni transit", 1),
    ("Would you keep buying Chipotle bowls if they raised prices", 1),
    ("Would you vote yes on a $1 billion bond to build new public housing", 1),
    ("How do you feel about fast-casual restaurant prices", 1),
];

/// News events every fresh workspace starts with (text prefix).
pub const SEED_EVENTS: &[&str] = &[
    "A magnitude 6.1 earthquake struck San Francisco",
    "SFUSD announced all San Francisco public schools",
    "Obama got shot",
];

/// Id of a node copied into a workspace by seeding: stable for (source, workspace),
/// so re-seeding never duplicates and two workspaces never collide.
pub fn seeded_id(prefix: &str, source_id: &str, workspace: &str) -> String {
    short_id(prefix, &["seed", source_id, workspace])
}

fn short_id(prefix: &str, parts: &[&str]) -> String {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p.as_bytes());
        h.update([0u8]);
    }
    format!("{prefix}-{}", &hex::encode(h.finalize())[..16])
}

pub fn framing_name(framing: Framing) -> &'static str {
    match framing {
        Framing::Vote => "vote",
        Framing::Belief => "belief",
        Framing::Options => "options",
    }
}

/// The Test statement shared by `lineage` and `test_detail`: one row per test with
/// its population key, memory context, hypothetical, stimuli and stored breakdowns.
const TEST_ROW_RETURN: &str = "RETURN t.id, t.kind, t.question, t.description, t.framing, t.as_of_date, t.model, \
              t.p_yes, t.options, t.p_distribution, t.n_agents, t.n_archetypes, t.simulation_id, \
              t.branch_id, p.key, t.created_at, events_known, ue.text, stimuli, t.breakdowns_json";

fn test_row_query(match_clause: &str) -> String {
    format!(
        "{match_clause} \
         OPTIONAL MATCH (t)-[:UNDER_EVENT]->(ue:Event) \
         OPTIONAL MATCH (t)-[:USED_STIMULUS]->(s:Stimulus) \
         WITH t, p, c, ue, [x IN collect(CASE WHEN s IS NULL THEN null ELSE {{label: s.label, text: s.text}} END) WHERE x IS NOT NULL] AS stimuli \
         WITH t, p, ue, stimuli, \
           size([(e:Event)-[:HAPPENED_IN]->(c) WHERE e.created_at <= t.created_at | e]) AS events_known \
         {TEST_ROW_RETURN} \
         ORDER BY t.created_at ASC, t.id ASC"
    )
}

fn test_item_from_row(r: &[Value]) -> LineageItem {
    let s = |i: usize| r.get(i).and_then(|v| v.as_str()).unwrap_or("").to_string();
    let f = |i: usize| r.get(i).and_then(|v| v.as_f64()).unwrap_or(0.0);
    let u = |i: usize| r.get(i).and_then(|v| v.as_u64()).unwrap_or(0) as usize;
    let ss = |i: usize| -> Vec<String> {
        r.get(i).and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
            .unwrap_or_default()
    };
    let fs = |i: usize| -> Vec<f64> {
        r.get(i).and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_f64()).collect())
            .unwrap_or_default()
    };
    let stimuli = r
        .get(18)
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| {
                    Some(StimulusRecord {
                        label: x.get("label")?.as_str()?.to_string(),
                        text: x.get("text")?.as_str()?.to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    LineageItem::Test {
        id: s(0), kind: s(1), question: s(2), description: s(3), framing: s(4),
        as_of_date: s(5), model: s(6), p_yes: f(7), options: ss(8),
        p_distribution: fs(9), n_agents: u(10), n_archetypes: u(11),
        simulation_id: s(12), branch_id: s(13), population_key: s(14),
        created_at: s(15), events_known: u(16),
        under_event: r.get(17).and_then(|v| v.as_str()).map(String::from),
        stimuli, previous_p_yes: None, delta: None,
        breakdowns: r
            .get(19)
            .and_then(|v| v.as_str())
            .filter(|t| !t.is_empty())
            .and_then(|t| serde_json::from_str::<Value>(t).ok()),
    }
}

impl MemoryClient {
    /// Build from env. Accepts the Aura credentials file variables verbatim:
    /// `NEO4J_URI` (`neo4j+s://host`, `https://host`, or `http://localhost:7474`),
    /// `NEO4J_USERNAME` or `NEO4J_USER` (default `neo4j`), `NEO4J_PASSWORD`,
    /// `NEO4J_DATABASE` (default `neo4j`; Aura free instances use the instance id).
    /// `NEO4J_HTTP_API=tx` selects the legacy endpoint for Neo4j 4.x.
    /// Returns `None` when `NEO4J_URI` is unset so the layer is opt-in.
    pub fn from_env() -> Option<Self> {
        let uri = std::env::var("NEO4J_URI").ok()?.trim().trim_end_matches('/').to_string();
        if uri.is_empty() {
            return None;
        }
        let Some(base) = http_base(&uri) else {
            tracing::warn!("NEO4J_URI '{uri}' is not an http(s):// or neo4j+s:// URI; memory layer disabled");
            return None;
        };
        let user = std::env::var("NEO4J_USERNAME")
            .or_else(|_| std::env::var("NEO4J_USER"))
            .unwrap_or_else(|_| "neo4j".into());
        let password = std::env::var("NEO4J_PASSWORD").unwrap_or_default();
        let database = std::env::var("NEO4J_DATABASE").unwrap_or_else(|_| "neo4j".into());
        let api = match std::env::var("NEO4J_HTTP_API").as_deref() {
            Ok("tx") => HttpApi::Tx,
            _ => HttpApi::Query,
        };
        let http = Client::builder()
            .user_agent("simtra-memory")
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(30))
            .build()
            .ok()?;
        Some(Self { http, base, database, api, user, password })
    }

    fn endpoint(&self) -> String {
        match self.api {
            HttpApi::Query => format!("{}/db/{}/query/v2", self.base, self.database),
            HttpApi::Tx => format!("{}/db/{}/tx/commit", self.base, self.database),
        }
    }

    /// Run one or more Cypher statements. Returns one row set per statement; each
    /// row is the list of column values. With the Query API each statement is its own
    /// auto-commit request; with the legacy endpoint they share one transaction.
    pub async fn run(&self, statements: &[(&str, Value)]) -> Result<Vec<Vec<Vec<Value>>>> {
        match self.api {
            HttpApi::Query => {
                let mut out = Vec::with_capacity(statements.len());
                for (stmt, params) in statements {
                    out.push(self.run_query_v2(stmt, params).await?);
                }
                Ok(out)
            }
            HttpApi::Tx => self.run_tx(statements).await,
        }
    }

    async fn post(&self, body: &Value) -> Result<Value> {
        let resp = self
            .http
            .post(self.endpoint())
            .basic_auth(&self.user, Some(&self.password))
            .header("accept", "application/json")
            .json(body)
            .send()
            .await?;
        let status = resp.status();
        let text = resp.text().await?;
        let v: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        if let Some(errs) = v.get("errors").and_then(|e| e.as_array()) {
            if let Some(first) = errs.first() {
                let code = first.get("code").and_then(|c| c.as_str()).unwrap_or("?");
                let msg = first.get("message").and_then(|c| c.as_str()).unwrap_or("");
                return Err(anyhow!("neo4j error {code}: {msg}"));
            }
        }
        if !status.is_success() {
            return Err(anyhow!("neo4j request failed ({status})"));
        }
        if v.is_null() {
            return Err(anyhow!("neo4j returned invalid JSON"));
        }
        Ok(v)
    }

    async fn run_query_v2(&self, statement: &str, params: &Value) -> Result<Vec<Vec<Value>>> {
        let v = self.post(&json!({"statement": statement, "parameters": params})).await?;
        Ok(v
            .get("data")
            .and_then(|d| d.get("values"))
            .and_then(|x| x.as_array())
            .map(|rows| rows.iter().filter_map(|r| r.as_array().cloned()).collect())
            .unwrap_or_default())
    }

    async fn run_tx(&self, statements: &[(&str, Value)]) -> Result<Vec<Vec<Vec<Value>>>> {
        let body = json!({
            "statements": statements
                .iter()
                .map(|(s, p)| json!({"statement": s, "parameters": p}))
                .collect::<Vec<_>>()
        });
        let v = self.post(&body).await?;
        let mut out = Vec::new();
        for res in v.get("results").and_then(|r| r.as_array()).cloned().unwrap_or_default() {
            let rows = res
                .get("data")
                .and_then(|d| d.as_array())
                .map(|rows| {
                    rows.iter()
                        .filter_map(|r| r.get("row").and_then(|x| x.as_array()).cloned())
                        .collect()
                })
                .unwrap_or_default();
            out.push(rows);
        }
        Ok(out)
    }

    /// Reachability check used by `/health`.
    pub async fn ping(&self) -> bool {
        self.run(&[("RETURN 1", json!({}))]).await.is_ok()
    }

    /// Uniqueness constraints (idempotent). Called once at startup, best-effort.
    pub async fn ensure_schema(&self) -> Result<()> {
        let stmts = [
            // Cities are keyed per workspace; nodes from before workspaces get key = slug.
            "MATCH (c:City) WHERE c.key IS NULL SET c.key = c.slug, c.workspace = 'public'",
            "CREATE INDEX test_workspace IF NOT EXISTS FOR (t:Test) ON (t.workspace)",
            "CREATE INDEX event_workspace IF NOT EXISTS FOR (e:Event) ON (e.workspace)",
            // Tests/events written before workspace tags: derive the tag from the City
            // they hang off (population -> city for tests).
            "MATCH (t:Test) WHERE t.workspace IS NULL \
             OPTIONAL MATCH (t)-[:RAN_ON]->(p:Population)-[:IN_CITY]->(c:City) \
             SET t.workspace = coalesce(c.workspace, 'public'), t.city = coalesce(c.slug, split(p.key, ':')[0])",
            "MATCH (e:Event) WHERE e.workspace IS NULL \
             OPTIONAL MATCH (e)-[:HAPPENED_IN]->(c:City) \
             SET e.workspace = coalesce(c.workspace, 'public')",
            "DROP CONSTRAINT city_slug IF EXISTS",
            "CREATE CONSTRAINT city_key IF NOT EXISTS FOR (c:City) REQUIRE c.key IS UNIQUE",
            "CREATE CONSTRAINT population_key IF NOT EXISTS FOR (p:Population) REQUIRE p.key IS UNIQUE",
            "CREATE CONSTRAINT persona_key IF NOT EXISTS FOR (p:Persona) REQUIRE p.key IS UNIQUE",
            "CREATE CONSTRAINT event_id IF NOT EXISTS FOR (e:Event) REQUIRE e.id IS UNIQUE",
            "CREATE CONSTRAINT test_id IF NOT EXISTS FOR (t:Test) REQUIRE t.id IS UNIQUE",
            "CREATE CONSTRAINT stimulus_id IF NOT EXISTS FOR (s:Stimulus) REQUIRE s.id IS UNIQUE",
            "CREATE CONSTRAINT data_query_id IF NOT EXISTS FOR (d:DataQuery) REQUIRE d.id IS UNIQUE",
        ];
        // Constraints cannot share a transaction with data writes, and one failing
        // (e.g. an older Neo4j syntax) should not block the others.
        for s in stmts {
            if let Err(e) = self.run(&[(s, json!({}))]).await {
                tracing::warn!("neo4j schema statement failed: {e:#}");
            }
        }
        Ok(())
    }

    /// Register every persona of a population (idempotent MERGE, batched).
    pub async fn ensure_population(&self, workspace: &str, pop: &Population) -> Result<()> {
        let city = city_key(workspace, &pop.profile.slug);
        let key = population_key_in(workspace, pop);
        // Cheap early exit once every persona has been written: callers on the hot
        // path (reactions, tests) can invoke this to close the race where a fresh
        // workspace reacts before its background registration finished.
        let done = self
            .run(&[(
                "MATCH (p:Population {key: $key}) RETURN p.registered",
                json!({"key": key}),
            )])
            .await?;
        if done
            .first()
            .and_then(|rows| rows.first())
            .and_then(|r| r.first())
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
        {
            return Ok(());
        }
        // The population (and its personas) is shared, so it hangs off the public City;
        // the workspace's own City node is created here too so events have a home.
        let public_city = city_key(PUBLIC_WORKSPACE, &pop.profile.slug);
        self.run(&[(
            "MERGE (c:City {key: $city}) ON CREATE SET c.slug = $slug, c.workspace = $ws \
             MERGE (pc:City {key: $public_city}) ON CREATE SET pc.slug = $slug, pc.workspace = 'public' \
             MERGE (p:Population {key: $key}) \
             ON CREATE SET p.city = $public_city, p.seed = $seed, p.n = $n, p.created_at = $now \
             MERGE (p)-[:IN_CITY]->(pc)",
            json!({"city": city, "public_city": public_city, "slug": pop.profile.slug, "ws": workspace,
                   "key": key, "seed": pop.seed as i64, "n": pop.n as i64, "now": now_iso()}),
        )])
        .await?;
        let cutoffs = pop.income_cutoffs;
        let rows: Vec<Value> = pop
            .agents
            .iter()
            .map(|a| {
                json!({
                    "key": persona_key(&key, a.id),
                    "agent_id": a.id,
                    "name": a.name,
                    "occupation": a.occupation,
                    "neighborhood": a.neighborhood,
                    "archetype": a.archetype_key(&cutoffs),
                    "age": a.rec.age_band(),
                    "weight": a.weight(),
                })
            })
            .collect();
        for chunk in rows.chunks(BATCH) {
            self.run(&[(
                "MATCH (p:Population {key: $pop}) \
                 UNWIND $rows AS r \
                 MERGE (a:Persona {key: r.key}) \
                 ON CREATE SET a.agent_id = r.agent_id, a.name = r.name, a.occupation = r.occupation, \
                   a.neighborhood = r.neighborhood, a.archetype = r.archetype, a.age = r.age, \
                   a.weight = r.weight, a.population_key = $pop \
                 MERGE (a)-[:MEMBER_OF]->(p)",
                json!({"pop": key, "rows": chunk}),
            )])
            .await?;
        }
        self.run(&[(
            "MATCH (p:Population {key: $key}) SET p.registered = true",
            json!({"key": key}),
        )])
        .await?;
        Ok(())
    }

    /// Throw a city-wide event into the world. Every persona in the city, present and
    /// future, remembers it (recall traverses Persona -> Population -> City <- Event).
    pub async fn add_city_event(
        &self,
        city: &str,
        kind: &str,
        text: &str,
        as_of_date: &str,
    ) -> Result<MemoryEvent> {
        let ev = MemoryEvent {
            id: short_id("evt", &[city, kind, text, as_of_date]),
            city: city.to_string(),
            kind: kind.to_string(),
            text: text.to_string(),
            as_of_date: as_of_date.to_string(),
            created_at: now_iso(),
        };
        let (ws, slug) = split_city_key(city);
        self.run(&[(
            "MERGE (c:City {key: $city}) ON CREATE SET c.slug = $slug, c.workspace = $ws \
             MERGE (e:Event {id: $id}) \
             ON CREATE SET e.kind = $kind, e.text = $text, e.as_of_date = $date, \
               e.city = $city, e.created_at = $now, e.workspace = $ws \
             MERGE (e)-[:HAPPENED_IN]->(c)",
            json!({"city": city, "slug": slug, "ws": ws, "id": ev.id, "kind": kind, "text": text,
                   "date": as_of_date, "now": ev.created_at}),
        )])
        .await?;
        Ok(ev)
    }

    /// Expose a specific set of personas to an event (targeted memory). Used for
    /// stimuli shown during a test and for events aimed at a subset of residents.
    pub async fn expose(&self, population_key: &str, agent_ids: &[u32], event_id: &str) -> Result<()> {
        let now = now_iso();
        let keys: Vec<String> = agent_ids.iter().map(|id| persona_key(population_key, *id)).collect();
        for chunk in keys.chunks(BATCH) {
            self.run(&[(
                "MATCH (e:Event {id: $event}) \
                 UNWIND $keys AS k \
                 MATCH (a:Persona {key: k}) \
                 MERGE (a)-[x:EXPOSED_TO]->(e) ON CREATE SET x.at = $now",
                json!({"event": event_id, "keys": chunk, "now": now}),
            )])
            .await?;
        }
        Ok(())
    }

    /// Create a stimulus-kind event (not city-wide) and expose the given personas to it.
    pub async fn add_stimulus_event(
        &self,
        workspace: &str,
        population_key: &str,
        city: &str,
        text: &str,
        as_of_date: &str,
        agent_ids: &[u32],
    ) -> Result<MemoryEvent> {
        let ev = MemoryEvent {
            id: short_id("stim", &[workspace, population_key, text, as_of_date]),
            city: city.to_string(),
            kind: "stimulus".into(),
            text: text.to_string(),
            as_of_date: as_of_date.to_string(),
            created_at: now_iso(),
        };
        self.run(&[(
            "MERGE (e:Event {id: $id}) \
             ON CREATE SET e.kind = 'stimulus', e.text = $text, e.as_of_date = $date, \
               e.city = $city, e.created_at = $now, e.workspace = $ws",
            json!({"id": ev.id, "text": text, "date": as_of_date, "city": city, "now": ev.created_at,
                   "ws": workspace}),
        )])
        .await?;
        self.expose(population_key, agent_ids, &ev.id).await?;
        Ok(ev)
    }

    /// Record a completed test and every persona's answer to it.
    pub async fn record_test(
        &self,
        population_key: &str,
        test: &TestRecord,
        answers: &[AgentAnswer],
        under_event: Option<&str>,
    ) -> Result<()> {
        self.run(&[(
            "MATCH (p:Population {key: $pop}) \
             MERGE (t:Test {id: $id}) \
             ON CREATE SET t.kind = $kind, t.question = $question, t.description = $description, \
               t.framing = $framing, t.as_of_date = $date, t.model = $model, t.p_yes = $p_yes, \
               t.options = $options, t.p_distribution = $dist, t.n_agents = $n_agents, \
               t.n_archetypes = $n_archetypes, t.simulation_id = $sim, t.branch_id = $branch, \
               t.created_at = $now, t.breakdowns_json = $breakdowns, \
               t.workspace = $ws, t.city = $slug \
             MERGE (t)-[:RAN_ON]->(p)",
            json!({
                "ws": if test.workspace.is_empty() { PUBLIC_WORKSPACE } else { test.workspace.as_str() },
                "slug": test.city,
                "pop": population_key, "id": test.id, "kind": test.kind, "question": test.question,
                "description": test.description, "framing": test.framing, "date": test.as_of_date,
                "model": test.model, "p_yes": test.p_yes, "options": test.options,
                "dist": test.p_distribution, "n_agents": test.n_agents as i64,
                "n_archetypes": test.n_archetypes as i64, "sim": test.simulation_id,
                "branch": test.branch_id, "now": test.created_at,
                "breakdowns": test.breakdowns_json,
            }),
        )])
        .await?;
        if let Some(ev) = under_event {
            self.run(&[(
                "MATCH (t:Test {id: $id}) MATCH (e:Event {id: $ev}) MERGE (t)-[:UNDER_EVENT]->(e)",
                json!({"id": test.id, "ev": ev}),
            )])
            .await?;
        }
        let rows: Vec<Value> = answers
            .iter()
            .map(|a| {
                json!({
                    "key": persona_key(population_key, a.agent_id),
                    "p_yes": a.p_yes, "dist": a.dist, "why": a.why, "archetype": a.archetype,
                })
            })
            .collect();
        for chunk in rows.chunks(BATCH) {
            self.run(&[(
                "MATCH (t:Test {id: $test}) \
                 UNWIND $rows AS r \
                 MATCH (a:Persona {key: r.key}) \
                 MERGE (a)-[x:ANSWERED]->(t) \
                 ON CREATE SET x.p_yes = r.p_yes, x.dist = r.dist, x.why = r.why, \
                   x.archetype = r.archetype, x.at = $now",
                json!({"test": test.id, "rows": chunk, "now": test.created_at}),
            )])
            .await?;
        }
        Ok(())
    }

    /// Attach A/B stimuli to a test.
    pub async fn record_stimuli(&self, test_id: &str, stimuli: &[StimulusRecord]) -> Result<()> {
        let rows: Vec<Value> = stimuli
            .iter()
            .map(|s| json!({"id": short_id("ab", &[test_id, &s.label, &s.text]), "label": s.label, "text": s.text}))
            .collect();
        if rows.is_empty() {
            return Ok(());
        }
        self.run(&[(
            "MATCH (t:Test {id: $test}) \
             UNWIND $rows AS r \
             MERGE (s:Stimulus {id: r.id}) ON CREATE SET s.label = r.label, s.text = r.text \
             MERGE (t)-[:USED_STIMULUS]->(s)",
            json!({"test": test_id, "rows": rows}),
        )])
        .await
        .map(|_| ())
    }

    /// Recall memory for a set of personas as of a date. Events come from the city
    /// (news) and explicit exposures (stimuli); tests from ANSWERED edges. Results are
    /// capped per persona and ordered deterministically.
    pub async fn recall(
        &self,
        workspace: &str,
        city_slug: &str,
        population_key: &str,
        agent_ids: &[u32],
        as_of_date: &str,
    ) -> Result<HashMap<u32, PersonaMemory>> {
        let keys: Vec<String> = agent_ids.iter().map(|id| persona_key(population_key, *id)).collect();
        let params = json!({
            "keys": keys, "date": as_of_date, "ws": workspace, "city": city_key(workspace, city_slug),
            "n_events": RECALL_EVENTS as i64, "n_tests": RECALL_TESTS as i64,
        });
        // Personas are shared across workspaces, so the workspace's own City (news) and
        // the workspace tag on stimuli/tests decide what this workspace remembers.
        let events_q = "UNWIND $keys AS k \
            MATCH (a:Persona {key: k}) \
            CALL { WITH a \
              MATCH (e:Event)-[:HAPPENED_IN]->(:City {key: $city}) \
              WHERE e.as_of_date <= $date RETURN e \
              UNION \
              WITH a MATCH (a)-[:EXPOSED_TO]->(e:Event) \
              WHERE e.as_of_date <= $date AND coalesce(e.workspace, 'public') = $ws RETURN e } \
            WITH a, e ORDER BY e.as_of_date DESC, e.created_at DESC, e.id ASC \
            WITH a, collect(e)[0..$n_events] AS evs \
            UNWIND evs AS e \
            RETURN a.agent_id, e.id, e.kind, e.text, e.as_of_date \
            ORDER BY a.agent_id, e.as_of_date, e.id";
        let tests_q = "UNWIND $keys AS k \
            MATCH (a:Persona {key: k})-[x:ANSWERED]->(t:Test) \
            WHERE t.as_of_date <= $date AND coalesce(t.workspace, 'public') = $ws \
            WITH a, x, t ORDER BY t.created_at DESC, t.id ASC \
            WITH a, collect({t: t, x: x})[0..$n_tests] AS rows \
            UNWIND rows AS r \
            RETURN a.agent_id, r.t.id, r.t.kind, r.t.question, r.t.as_of_date, r.x.p_yes, \
                   r.t.options, r.x.dist, r.x.why \
            ORDER BY a.agent_id, r.t.created_at, r.t.id";
        let res = self
            .run(&[(events_q, params.clone()), (tests_q, params)])
            .await?;
        let mut out: HashMap<u32, PersonaMemory> = HashMap::new();
        if let Some(rows) = res.first() {
            for r in rows {
                let id = r.first().and_then(|v| v.as_u64()).unwrap_or(u64::MAX) as u32;
                let s = |i: usize| r.get(i).and_then(|v| v.as_str()).unwrap_or("").to_string();
                out.entry(id).or_default().events.push(RecalledEvent {
                    id: s(1), kind: s(2), text: s(3), as_of_date: s(4),
                });
            }
        }
        if let Some(rows) = res.get(1) {
            for r in rows {
                let id = r.first().and_then(|v| v.as_u64()).unwrap_or(u64::MAX) as u32;
                let s = |i: usize| r.get(i).and_then(|v| v.as_str()).unwrap_or("").to_string();
                let f = |i: usize| r.get(i).and_then(|v| v.as_f64()).unwrap_or(0.0);
                let fs = |i: usize| -> Vec<f64> {
                    r.get(i).and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|x| x.as_f64()).collect()).unwrap_or_default()
                };
                let ss = |i: usize| -> Vec<String> {
                    r.get(i).and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default()
                };
                out.entry(id).or_default().tests.push(RecalledTest {
                    id: s(1), kind: s(2), question: s(3), as_of_date: s(4), p_yes: f(5),
                    options: ss(6), dist: fs(7), why: s(8),
                });
            }
        }
        Ok(out)
    }

    /// Full memory view of one persona (for the API), newest first, uncapped-ish.
    pub async fn persona_view(
        &self,
        workspace: &str,
        city_slug: &str,
        population_key: &str,
        agent_id: u32,
    ) -> Result<Value> {
        let key = persona_key(population_key, agent_id);
        let city = city_key(workspace, city_slug);
        let res = self
            .run(&[
                (
                    "MATCH (a:Persona {key: $key}) \
                     RETURN a.agent_id, a.name, a.occupation, a.neighborhood, a.archetype, a.population_key",
                    json!({"key": key}),
                ),
                (
                    "MATCH (a:Persona {key: $key}) \
                     CALL { WITH a \
                       MATCH (e:Event)-[:HAPPENED_IN]->(:City {key: $city}) RETURN e, 'city' AS via \
                       UNION WITH a MATCH (a)-[:EXPOSED_TO]->(e:Event) WHERE coalesce(e.workspace, 'public') = $ws RETURN e, 'exposed' AS via } \
                     RETURN e.id, e.kind, e.text, e.as_of_date, via ORDER BY e.as_of_date DESC, e.id LIMIT 50",
                    json!({"key": key, "city": city, "ws": workspace}),
                ),
                (
                    "MATCH (a:Persona {key: $key})-[x:ANSWERED]->(t:Test) \
                     WHERE coalesce(t.workspace, 'public') = $ws \
                     OPTIONAL MATCH (t)-[:USED_STIMULUS]->(s:Stimulus) \
                     OPTIONAL MATCH (t)-[:UNDER_EVENT]->(ev:Event) \
                     WITH t, x, collect(DISTINCT {label: s.label, text: s.text}) AS stimuli, ev \
                     RETURN t.id, t.kind, t.question, t.framing, t.as_of_date, t.model, t.p_yes, \
                            x.p_yes, x.dist, x.why, t.options, t.created_at, \
                            [s IN stimuli WHERE s.label IS NOT NULL], ev.text \
                     ORDER BY t.created_at DESC LIMIT 50",
                    json!({"key": key, "ws": workspace}),
                ),
            ])
            .await?;
        let persona = res.first().and_then(|r| r.first()).map(|r| {
            json!({
                "agent_id": r.first().cloned().unwrap_or(Value::Null),
                "name": r.get(1).cloned().unwrap_or(Value::Null),
                "occupation": r.get(2).cloned().unwrap_or(Value::Null),
                "neighborhood": r.get(3).cloned().unwrap_or(Value::Null),
                "archetype": r.get(4).cloned().unwrap_or(Value::Null),
                "population_key": r.get(5).cloned().unwrap_or(Value::Null),
            })
        });
        let Some(persona) = persona else {
            return Err(anyhow!("persona not in memory graph"));
        };
        let events: Vec<Value> = res
            .get(1)
            .map(|rows| {
                rows.iter()
                    .map(|r| json!({"id": r[0], "kind": r[1], "text": r[2], "as_of_date": r[3], "via": r[4]}))
                    .collect()
            })
            .unwrap_or_default();
        let tests: Vec<Value> = res
            .get(2)
            .map(|rows| {
                rows.iter()
                    .map(|r| {
                        json!({
                            "id": r[0], "kind": r[1], "question": r[2], "framing": r[3],
                            "as_of_date": r[4], "model": r[5], "population_p_yes": r[6],
                            "my_p_yes": r[7], "my_dist": r[8], "why": r[9], "options": r[10],
                            "created_at": r[11], "stimuli": r[12], "under_event": r[13],
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        Ok(json!({"persona": persona, "events": events, "tests": tests}))
    }

    /// List a city's events, newest first, each with its reaction summary and the
    /// three most recent reactions.
    pub async fn list_city_events(&self, city: &str, limit: usize) -> Result<Vec<EventFeedItem>> {
        let res = self
            .run(&[(
                "MATCH (e:Event)-[:HAPPENED_IN]->(:City {key: $city}) \
                 OPTIONAL MATCH (a:Persona)-[r:REACTED_TO]->(e) \
                 WITH e, r, a ORDER BY r.at DESC, a.agent_id ASC \
                 WITH e, [x IN collect(CASE WHEN r IS NULL THEN null ELSE {agent_id: a.agent_id, \
                   name: a.name, occupation: a.occupation, neighborhood: a.neighborhood, age: a.age, \
                   archetype: a.archetype, text: r.text, sentiment: r.sentiment, at: r.at} END) \
                   WHERE x IS NOT NULL] AS reactions \
                 RETURN e.id, e.kind, e.text, e.as_of_date, e.created_at, size(reactions), \
                   [x IN reactions | x.sentiment], reactions[0..3] \
                 ORDER BY e.as_of_date DESC, e.created_at DESC LIMIT $limit",
                json!({"city": city, "limit": limit as i64}),
            )])
            .await?;
        Ok(res
            .first()
            .map(|rows| {
                rows.iter()
                    .map(|r| {
                        let s = |i: usize| r.get(i).and_then(|v| v.as_str()).unwrap_or("").to_string();
                        let mut sentiment = BTreeMap::new();
                        if let Some(arr) = r.get(6).and_then(|v| v.as_array()) {
                            for v in arr.iter().filter_map(|v| v.as_str()) {
                                *sentiment.entry(v.to_string()).or_insert(0) += 1;
                            }
                        }
                        EventFeedItem {
                            event: MemoryEvent {
                                id: s(0), kind: s(1), text: s(2), as_of_date: s(3), created_at: s(4),
                                city: city.to_string(),
                            },
                            reaction_count: r.get(5).and_then(|v| v.as_u64()).unwrap_or(0) as usize,
                            sentiment,
                            reactions: r
                                .get(7)
                                .and_then(|v| v.as_array())
                                .map(|a| a.iter().filter_map(reaction_from_value).collect())
                                .unwrap_or_default(),
                        }
                    })
                    .collect()
            })
            .unwrap_or_default())
    }

    /// A city's lineage: news events and tests in the order they were created, oldest
    /// first. `limit` keeps the most recent items (still returned ascending).
    pub async fn lineage(&self, workspace: &str, city_slug: &str, limit: usize) -> Result<Vec<LineageItem>> {
        let city = city_key(workspace, city_slug);
        let params = json!({"city": city, "ws": workspace, "slug": city_slug});
        let events_q = "MATCH (e:Event)-[:HAPPENED_IN]->(:City {key: $city}) \
            OPTIONAL MATCH (:Persona)-[r:REACTED_TO]->(e) \
            WITH e, [x IN collect(r.sentiment) WHERE x IS NOT NULL] AS sentiments \
            RETURN e.id, e.kind, e.text, e.as_of_date, e.created_at, sentiments \
            ORDER BY e.created_at ASC, e.id ASC";
        // Tests are scoped by their workspace tag (populations are shared); the City is
        // only needed to count the events the residents knew at the time.
        let tests_q = test_row_query(
            "MATCH (c:City {key: $city}) \
             MATCH (t:Test)-[:RAN_ON]->(p:Population) \
             WHERE coalesce(t.workspace, 'public') = $ws AND coalesce(t.city, split(p.key, ':')[0]) = $slug",
        );
        let queries_q = "MATCH (d:DataQuery)-[:ASKED_IN]->(:City {key: $city}) \
            RETURN d.id, d.question, d.answer, d.status, d.created_at, d.response_json \
            ORDER BY d.created_at ASC, d.id ASC";
        let res = self
            .run(&[(events_q, params.clone()), (tests_q.as_str(), params.clone()), (queries_q, params)])
            .await?;
        let mut items: Vec<LineageItem> = Vec::new();
        if let Some(rows) = res.first() {
            for r in rows {
                let s = |i: usize| r.get(i).and_then(|v| v.as_str()).unwrap_or("").to_string();
                let mut sentiment = BTreeMap::new();
                if let Some(arr) = r.get(5).and_then(|v| v.as_array()) {
                    for v in arr.iter().filter_map(|v| v.as_str()) {
                        *sentiment.entry(v.to_string()).or_insert(0) += 1;
                    }
                }
                let reaction_count = sentiment.values().sum();
                items.push(LineageItem::Event {
                    id: s(0), kind: s(1), text: s(2), as_of_date: s(3), created_at: s(4),
                    reaction_count, sentiment,
                });
            }
        }
        if let Some(rows) = res.get(1) {
            for r in rows {
                items.push(test_item_from_row(r));
            }
        }
        if let Some(rows) = res.get(2) {
            for r in rows {
                let s = |i: usize| r.get(i).and_then(|v| v.as_str()).unwrap_or("").to_string();
                let response = r
                    .get(5)
                    .and_then(|v| v.as_str())
                    .and_then(|t| serde_json::from_str::<Value>(t).ok())
                    .unwrap_or(Value::Null);
                items.push(LineageItem::DataQuery {
                    id: s(0), question: s(1), answer: s(2), status: s(3), created_at: s(4), response,
                });
            }
        }
        items.sort_by(|a, b| a.created_at().cmp(b.created_at()).then(a.id().cmp(b.id())));
        attach_deltas(&mut items);
        if items.len() > limit {
            items.drain(..items.len() - limit);
        }
        Ok(items)
    }

    /// One recorded test by id, in the lineage item shape (with stored breakdowns).
    /// `Ok(None)` when no such test exists.
    pub async fn test_detail(&self, test_id: &str) -> Result<Option<LineageItem>> {
        let q = test_row_query(
            "MATCH (t:Test {id: $id})-[:RAN_ON]->(p:Population) \
             WITH t, p, coalesce(t.city, split(p.key, ':')[0]) AS slug, coalesce(t.workspace, 'public') AS ws \
             OPTIONAL MATCH (c:City {key: CASE WHEN ws = 'public' THEN slug ELSE ws + ':' + slug END})",
        );
        let res = self.run(&[(q.as_str(), json!({"id": test_id}))]).await?;
        Ok(res.first().and_then(|rows| rows.first()).map(|r| test_item_from_row(r)))
    }

    /// Every persona's answer to a test (the ANSWERED edges), ordered by agent id.
    /// `Ok(None)` when the test does not exist.
    pub async fn test_answers(&self, test_id: &str) -> Result<Option<Vec<AgentAnswer>>> {
        let res = self
            .run(&[
                ("MATCH (t:Test {id: $id}) RETURN t.id", json!({"id": test_id})),
                (
                    "MATCH (a:Persona)-[x:ANSWERED]->(t:Test {id: $id}) \
                     RETURN a.agent_id, x.p_yes, x.dist, x.why, x.archetype, \
                            x.personal_p_yes, x.personal_dist, x.personal_why ORDER BY a.agent_id",
                    json!({"id": test_id}),
                ),
            ])
            .await?;
        if res.first().map(|rows| rows.is_empty()).unwrap_or(true) {
            return Ok(None);
        }
        let answers = res
            .get(1)
            .map(|rows| {
                rows.iter()
                    .map(|r| AgentAnswer {
                        agent_id: r.first().and_then(|v| v.as_u64()).unwrap_or(0) as u32,
                        p_yes: r.get(1).and_then(|v| v.as_f64()).unwrap_or(0.0),
                        dist: r
                            .get(2)
                            .and_then(|v| v.as_array())
                            .map(|a| a.iter().filter_map(|x| x.as_f64()).collect())
                            .unwrap_or_default(),
                        why: r.get(3).and_then(|v| v.as_str()).unwrap_or("").to_string(),
                        archetype: r.get(4).and_then(|v| v.as_str()).unwrap_or("").to_string(),
                        personal_p_yes: r.get(5).and_then(|v| v.as_f64()),
                        personal_dist: r
                            .get(6)
                            .and_then(|v| v.as_array())
                            .map(|a| a.iter().filter_map(|x| x.as_f64()).collect()),
                        personal_why: r.get(7).and_then(|v| v.as_str()).map(String::from),
                    })
                    .collect()
            })
            .unwrap_or_default();
        Ok(Some(answers))
    }

    /// Personal answers already stored for these residents on a test.
    pub async fn personal_answers(
        &self,
        population_key: &str,
        test_id: &str,
        agent_ids: &[u32],
    ) -> Result<Vec<PersonalAnswer>> {
        let keys: Vec<String> = agent_ids.iter().map(|id| persona_key(population_key, *id)).collect();
        let res = self
            .run(&[(
                "UNWIND $keys AS k \
                 MATCH (a:Persona {key: k})-[x:ANSWERED]->(t:Test {id: $test}) \
                 WHERE x.personal_why IS NOT NULL \
                 RETURN a.agent_id, x.personal_p_yes, x.personal_dist, x.personal_why",
                json!({"keys": keys, "test": test_id}),
            )])
            .await?;
        Ok(res
            .first()
            .map(|rows| {
                rows.iter()
                    .map(|r| PersonalAnswer {
                        agent_id: r.first().and_then(|v| v.as_u64()).unwrap_or(0) as u32,
                        p_yes: r.get(1).and_then(|v| v.as_f64()).unwrap_or(0.0),
                        dist: r
                            .get(2)
                            .and_then(|v| v.as_array())
                            .map(|a| a.iter().filter_map(|x| x.as_f64()).collect())
                            .unwrap_or_default(),
                        why: r.get(3).and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    })
                    .collect()
            })
            .unwrap_or_default())
    }

    /// Store residents' own answers on their ANSWERED edge (SET, so re-asking
    /// overwrites; the edge is created for residents who never had one).
    pub async fn record_personal_answers(
        &self,
        population_key: &str,
        test_id: &str,
        answers: &[PersonalAnswer],
    ) -> Result<()> {
        if answers.is_empty() {
            return Ok(());
        }
        let now = now_iso();
        let rows: Vec<Value> = answers
            .iter()
            .map(|a| json!({"key": persona_key(population_key, a.agent_id), "p_yes": a.p_yes, "dist": a.dist, "why": a.why}))
            .collect();
        self.run(&[(
            "MATCH (t:Test {id: $test}) \
             UNWIND $rows AS r \
             MATCH (a:Persona {key: r.key}) \
             MERGE (a)-[x:ANSWERED]->(t) \
             ON CREATE SET x.p_yes = r.p_yes, x.dist = r.dist, x.why = r.why, x.archetype = a.archetype, x.at = $now \
             SET x.personal_p_yes = r.p_yes, x.personal_dist = r.dist, x.personal_why = r.why, x.personal_at = $now",
            json!({"test": test_id, "rows": rows, "now": now}),
        )])
        .await
        .map(|_| ())
    }

    /// Remember a verified-data question and its full response (the statistic, chart
    /// and provenance), attached to the city so it shows up in the lineage.
    pub async fn record_data_query(
        &self,
        city: &str,
        question: &str,
        response: &Value,
    ) -> Result<DataQueryRecord> {
        let created_at = now_iso();
        let rec = DataQueryRecord {
            id: short_id("dq", &[city, question, &created_at]),
            city: city.to_string(),
            question: question.to_string(),
            answer: response.get("answer").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            status: response.get("status").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            created_at,
        };
        let mut response_json = serde_json::to_string(response).unwrap_or_default();
        if response_json.len() > MAX_BREAKDOWNS_BYTES {
            response_json = String::new();
        }
        let (ws, slug) = split_city_key(city);
        self.run(&[(
            "MERGE (c:City {key: $city}) ON CREATE SET c.slug = $slug, c.workspace = $ws \
             MERGE (d:DataQuery {id: $id}) \
             ON CREATE SET d.city = $city, d.question = $question, d.answer = $answer, \
               d.status = $status, d.response_json = $response, d.created_at = $now \
             MERGE (d)-[:ASKED_IN]->(c)",
            json!({"city": city, "slug": slug, "ws": ws, "id": rec.id, "question": rec.question,
                   "answer": rec.answer, "status": rec.status, "response": response_json, "now": rec.created_at}),
        )])
        .await?;
        Ok(rec)
    }

    /// Counts of what a workspace remembers across all cities: (events, tests, data queries).
    pub async fn workspace_summary(&self, workspace: &str) -> Result<(usize, usize, usize)> {
        let params = json!({"ws": workspace});
        let res = self
            .run(&[
                ("MATCH (e:Event)-[:HAPPENED_IN]->(c:City {workspace: $ws}) RETURN count(e)", params.clone()),
                ("MATCH (t:Test) WHERE coalesce(t.workspace, 'public') = $ws RETURN count(t)", params.clone()),
                ("MATCH (d:DataQuery)-[:ASKED_IN]->(c:City {workspace: $ws}) RETURN count(d)", params),
            ])
            .await?;
        let n = |i: usize| -> usize {
            res.get(i)
                .and_then(|rows| rows.first())
                .and_then(|r| r.first())
                .and_then(|v| v.as_u64())
                .unwrap_or(0) as usize
        };
        Ok((n(0), n(1), n(2)))
    }

    /// Give a fresh workspace something to look at: copy a curated set of surveys and
    /// news events from `from_workspace` (falling back to the newest ones when a
    /// curated item is missing). Personas are shared, so ANSWERED / REACTED_TO edges
    /// attach the same residents to the copies. No-op for the public workspace or
    /// once the workspace has any test or event. Returns (tests copied, events copied).
    pub async fn seed_workspace(
        &self,
        workspace: &str,
        from_workspace: &str,
        pop: &Population,
        take: usize,
    ) -> Result<(usize, usize)> {
        if workspace == PUBLIC_WORKSPACE || workspace == from_workspace {
            return Ok((0, 0));
        }
        let (events, tests, _) = self.workspace_summary(workspace).await?;
        if events > 0 || tests > 0 {
            return Ok((0, 0));
        }
        self.ensure_population(workspace, pop).await?;
        let slug = pop.profile.slug.clone();
        let src_city = city_key(from_workspace, &slug);
        let city = city_key(workspace, &slug);
        let ids = |rows: &Vec<Vec<Value>>| -> Vec<String> {
            rows.iter().filter_map(|r| r.first().and_then(|v| v.as_str()).map(String::from)).collect()
        };

        // Curated surveys: judge-ready sources with stored breakdowns, matched by
        // question prefix so they survive id changes; `max` copies per entry (the
        // five-day-week pair shows a before/after delta).
        let mut test_ids: Vec<String> = Vec::new();
        for (prefix, max) in SEED_SURVEYS {
            let rows = self
                .run(&[(
                    "MATCH (t:Test)-[:RAN_ON]->(p:Population) \
                     WHERE coalesce(t.workspace, 'public') = $from AND t.kind = 'poll' \
                       AND t.breakdowns_json IS NOT NULL AND t.breakdowns_json <> '' \
                       AND coalesce(t.city, split(p.key, ':')[0]) = $slug \
                       AND toLower(t.question) STARTS WITH toLower($prefix) \
                       AND EXISTS { (:Persona)-[:ANSWERED]->(t) } \
                     RETURN t.id ORDER BY t.created_at DESC LIMIT $max",
                    json!({"from": from_workspace, "slug": slug, "prefix": prefix, "max": *max as i64}),
                )])
                .await?;
            for id in rows.first().map(ids).unwrap_or_default() {
                if !test_ids.contains(&id) {
                    test_ids.push(id);
                }
            }
        }
        if test_ids.len() < take {
            let rows = self
                .run(&[(
                    "MATCH (t:Test)-[:RAN_ON]->(p:Population) \
                     WHERE coalesce(t.workspace, 'public') = $from AND t.kind = 'poll' \
                       AND t.breakdowns_json IS NOT NULL AND t.breakdowns_json <> '' \
                       AND coalesce(t.city, split(p.key, ':')[0]) = $slug \
                     RETURN t.id ORDER BY t.created_at DESC LIMIT $take",
                    json!({"from": from_workspace, "slug": slug, "take": take as i64}),
                )])
                .await?;
            for id in rows.first().map(ids).unwrap_or_default() {
                if test_ids.len() >= take {
                    break;
                }
                if !test_ids.contains(&id) {
                    test_ids.push(id);
                }
            }
        }

        let mut event_ids: Vec<String> = Vec::new();
        for prefix in SEED_EVENTS {
            let rows = self
                .run(&[(
                    "MATCH (e:Event)-[:HAPPENED_IN]->(:City {key: $src}) \
                     WHERE coalesce(e.kind, 'news') <> 'stimulus' \
                       AND toLower(e.text) STARTS WITH toLower($prefix) \
                     RETURN e.id ORDER BY e.created_at DESC LIMIT 1",
                    json!({"src": src_city, "prefix": prefix}),
                )])
                .await?;
            for id in rows.first().map(ids).unwrap_or_default() {
                if !event_ids.contains(&id) {
                    event_ids.push(id);
                }
            }
        }
        if event_ids.len() < take {
            let rows = self
                .run(&[(
                    "MATCH (e:Event)-[:HAPPENED_IN]->(:City {key: $src}) \
                     WHERE coalesce(e.kind, 'news') <> 'stimulus' \
                     RETURN e.id ORDER BY e.created_at DESC LIMIT $take",
                    json!({"src": src_city, "take": take as i64}),
                )])
                .await?;
            for id in rows.first().map(ids).unwrap_or_default() {
                if event_ids.len() >= take {
                    break;
                }
                if !event_ids.contains(&id) {
                    event_ids.push(id);
                }
            }
        }

        let mut n_tests = 0;
        for src in &test_ids {
            let new_id = seeded_id("test", src, workspace);
            self.run(&[(
                "MATCH (t:Test {id: $src})-[:RAN_ON]->(p:Population) \
                 MERGE (nt:Test {id: $new}) \
                 ON CREATE SET nt = t {.*, id: $new, seeded: true, simulation_id: 'seed', branch_id: 'seed', \
                   workspace: $ws, city: coalesce(t.city, split(p.key, ':')[0])} \
                 MERGE (nt)-[:RAN_ON]->(p)",
                json!({"src": src, "new": new_id, "ws": workspace}),
            )])
            .await?;
            self.run(&[(
                "MATCH (a:Persona)-[x:ANSWERED]->(t:Test {id: $src}) \
                 MATCH (nt:Test {id: $new}) \
                 MERGE (a)-[nx:ANSWERED]->(nt) ON CREATE SET nx = properties(x)",
                json!({"src": src, "new": new_id}),
            )])
            .await?;
            n_tests += 1;
        }
        let mut n_events = 0;
        for src in &event_ids {
            let new_id = seeded_id("evt", src, workspace);
            self.run(&[(
                "MATCH (e:Event {id: $src}) \
                 MERGE (c:City {key: $city}) ON CREATE SET c.slug = $slug, c.workspace = $ws \
                 MERGE (ne:Event {id: $new}) \
                 ON CREATE SET ne = e {.*, id: $new, seeded: true, workspace: $ws} \
                 MERGE (ne)-[:HAPPENED_IN]->(c)",
                json!({"src": src, "new": new_id, "city": city, "slug": slug, "ws": workspace}),
            )])
            .await?;
            self.run(&[(
                "MATCH (a:Persona)-[r:REACTED_TO]->(e:Event {id: $src}) \
                 MATCH (ne:Event {id: $new}) \
                 MERGE (a)-[nr:REACTED_TO]->(ne) ON CREATE SET nr = properties(r)",
                json!({"src": src, "new": new_id}),
            )])
            .await?;
            n_events += 1;
        }
        Ok((n_tests, n_events))
    }

    /// Store residents' reactions to an event. Re-reacting overwrites the old reaction.
    pub async fn record_reactions(
        &self,
        population_key: &str,
        event_id: &str,
        reactions: &[Reaction],
    ) -> Result<()> {
        let rows: Vec<Value> = reactions
            .iter()
            .map(|r| {
                json!({"key": persona_key(population_key, r.agent_id), "text": r.text,
                       "sentiment": r.sentiment, "at": r.at})
            })
            .collect();
        for chunk in rows.chunks(BATCH) {
            self.run(&[(
                "MATCH (e:Event {id: $event}) \
                 UNWIND $rows AS r \
                 MATCH (a:Persona {key: r.key}) \
                 MERGE (a)-[x:REACTED_TO]->(e) \
                 SET x.text = r.text, x.sentiment = r.sentiment, x.at = r.at",
                json!({"event": event_id, "rows": chunk}),
            )])
            .await?;
        }
        Ok(())
    }

    /// An event (must belong to `city`) with its reactions, newest first.
    /// `Ok(None)` when the event does not exist in that city.
    pub async fn event_reactions(
        &self,
        city: &str,
        event_id: &str,
        limit: usize,
    ) -> Result<Option<(MemoryEvent, Vec<Reaction>)>> {
        let res = self
            .run(&[(
                "MATCH (e:Event {id: $id})-[:HAPPENED_IN]->(:City {key: $city}) \
                 OPTIONAL MATCH (a:Persona)-[r:REACTED_TO]->(e) \
                 WITH e, r, a ORDER BY r.at DESC, a.agent_id ASC \
                 WITH e, [x IN collect(CASE WHEN r IS NULL THEN null ELSE {agent_id: a.agent_id, \
                   name: a.name, occupation: a.occupation, neighborhood: a.neighborhood, age: a.age, \
                   archetype: a.archetype, text: r.text, sentiment: r.sentiment, at: r.at} END) \
                   WHERE x IS NOT NULL] AS reactions \
                 RETURN e.id, e.kind, e.text, e.as_of_date, e.created_at, reactions[0..$limit]",
                json!({"id": event_id, "city": city, "limit": limit as i64}),
            )])
            .await?;
        let Some(r) = res.first().and_then(|rows| rows.first()) else {
            return Ok(None);
        };
        let s = |i: usize| r.get(i).and_then(|v| v.as_str()).unwrap_or("").to_string();
        let event = MemoryEvent {
            id: s(0), kind: s(1), text: s(2), as_of_date: s(3), created_at: s(4),
            city: city.to_string(),
        };
        let reactions = r
            .get(5)
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(reaction_from_value).collect())
            .unwrap_or_default();
        Ok(Some((event, reactions)))
    }
}

/// Build the Test node payload from a finished poll.
pub fn test_record(pop_key: &str, city: &str, poll: &Poll, result: &PollResult, tag: &TestTag) -> TestRecord {
    let created_at = now_iso();
    let workspace = tag.workspace();
    TestRecord {
        id: short_id(
            "test",
            &[pop_key, &workspace, &tag.kind, &poll.question, &poll.as_of_date, &result.model, &created_at, &tag.branch_id],
        ),
        workspace,
        city: city.to_string(),
        kind: tag.kind.clone(),
        question: poll.question.clone(),
        description: poll.description.clone(),
        framing: framing_name(poll.framing).to_string(),
        as_of_date: poll.as_of_date.clone(),
        model: result.model.clone(),
        p_yes: result.p_yes,
        options: poll.options.clone(),
        p_distribution: result.p_distribution.iter().map(|(_, p)| *p).collect(),
        n_agents: result.n_agents,
        n_archetypes: result.n_archetypes,
        simulation_id: tag.simulation_id.clone(),
        branch_id: tag.branch_id.clone(),
        created_at,
        breakdowns_json: breakdowns_json(result),
    }
}

/// The demographic breakdowns of a result as one JSON string, in the shape the
/// evidence chart's `normalizeBreakdowns` reads; empty when over the size cap.
pub fn breakdowns_json(result: &PollResult) -> String {
    let v = json!({
        "breakdowns": result.breakdowns,
        "option_breakdowns": result.option_breakdowns,
        "p_distribution": result.p_distribution,
    });
    let s = serde_json::to_string(&v).unwrap_or_default();
    if s.len() > MAX_BREAKDOWNS_BYTES { String::new() } else { s }
}

fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let mut t: String = s.chars().take(max.saturating_sub(1)).collect();
        t.push('…');
        t
    }
}

/// Render one persona's memory as a compact, deterministic prompt fragment.
/// Empty string when there is nothing to remember. Hypothetical stimuli are labelled
/// so the model does not mistake a past test scenario for a real event.
pub fn prompt_fragment(mem: &PersonaMemory) -> String {
    if mem.events.is_empty() && mem.tests.is_empty() {
        return String::new();
    }
    let mut parts: Vec<String> = Vec::new();
    for e in &mem.events {
        let label = if e.kind == "stimulus" { "was shown (hypothetical)" } else { "news" };
        parts.push(format!("[{} {label}] {}", e.as_of_date, truncate_chars(&e.text, 100)));
    }
    for t in &mem.tests {
        let ans = if !t.options.is_empty() && t.dist.len() == t.options.len() {
            let (best, p) = t
                .options
                .iter()
                .zip(&t.dist)
                .fold((t.options[0].as_str(), -1.0f64), |acc, (o, p)| if *p > acc.1 { (o.as_str(), *p) } else { acc });
            format!("leaned \"{}\" ({:.0}%)", truncate_chars(best, 40), p * 100.0)
        } else {
            format!("{:.0}% yes", t.p_yes * 100.0)
        };
        let why = if t.why.is_empty() { String::new() } else { format!(" — {}", truncate_chars(&t.why, 60)) };
        parts.push(format!(
            "[{} asked] \"{}\" → {ans}{why}",
            t.as_of_date,
            truncate_chars(&t.question, 80)
        ));
    }
    truncate_chars(&format!(" Memory: {}", parts.join(" | ")), RECALL_MAX_CHARS)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lineage_test(id: &str, q: &str, framing: &str, p: f64, at: &str) -> LineageItem {
        LineageItem::Test {
            id: id.into(), kind: "poll".into(), question: q.into(), description: String::new(),
            framing: framing.into(), as_of_date: "2026-09-12".into(), model: "m".into(), p_yes: p,
            options: vec![], p_distribution: vec![], n_agents: 1, n_archetypes: 1,
            simulation_id: String::new(), branch_id: String::new(), population_key: "sf:1:1".into(),
            created_at: at.into(), events_known: 0, under_event: None, stimuli: vec![],
            previous_p_yes: Some(9.9), delta: Some(9.9), breakdowns: None,
        }
    }

    #[test]
    fn data_query_items_serialize_and_do_not_break_deltas() {
        let mut items = vec![
            lineage_test("t1", "Q?", "vote", 0.40, "2026-09-11T00:00:00Z"),
            LineageItem::DataQuery {
                id: "dq1".into(), question: "Show the age distribution".into(),
                answer: "Most residents are 25-34.".into(), status: "ok".into(),
                created_at: "2026-09-11T00:30:00Z".into(),
                response: serde_json::json!({"status": "ok", "chart": {"type": "bar"}}),
            },
            lineage_test("t2", "Q?", "vote", 0.50, "2026-09-11T01:00:00Z"),
        ];
        attach_deltas(&mut items);
        let j = serde_json::to_value(&items[1]).unwrap();
        assert_eq!(j["type"], "data_query");
        assert_eq!(j["response"]["chart"]["type"], "bar");
        match &items[2] {
            LineageItem::Test { previous_p_yes, delta, .. } => {
                assert_eq!(*previous_p_yes, Some(0.40));
                assert!((delta.unwrap() - 0.10).abs() < 1e-9);
            }
            _ => panic!(),
        }
        let back: LineageItem = serde_json::from_value(j).unwrap();
        assert!(matches!(back, LineageItem::DataQuery { .. }));
    }

    #[test]
    fn test_record_keeps_breakdowns_for_the_chart() {
        use crate::hydra::HydraEvidence;
        use crate::predict::{DemoBreak, Framing, Poll, PollResult};
        let poll = Poll {
            question: "Q?".into(), description: String::new(), framing: Framing::Vote,
            as_of_date: "2026-09-12".into(), model: None, population: None, event: None, options: vec![],
        };
        let mut breakdowns = HashMap::new();
        breakdowns.insert("age".to_string(), vec![DemoBreak { key: "25-34".into(), yes_share: 0.7, weight: 100.0, n: 12 }]);
        let result = PollResult {
            question: "Q?".into(), as_of_date: "2026-09-12".into(), model: "m".into(), p_yes: 0.6,
            ci_low: 0.5, ci_high: 0.7, n_agents: 10, n_eff: 9.0, design_effect: 1.0, breakdowns,
            n_archetypes: 2, n_llm_calls: 1, sample_rationales: vec![], p_distribution: vec![],
            option_breakdowns: vec![], option_ci: None, hydra: HydraEvidence::default(),
            memory_test_id: None,
        };
        let rec = test_record("sf:1:10", "sf", &poll, &result, &TestTag::poll());
        let v: Value = serde_json::from_str(&rec.breakdowns_json).unwrap();
        assert_eq!(v["breakdowns"]["age"][0]["key"], "25-34");
        assert_eq!(v["breakdowns"]["age"][0]["yes_share"], 0.7);
        assert!(v["option_breakdowns"].as_array().unwrap().is_empty());
    }

    #[test]
    fn attach_deltas_links_same_question_and_framing_only() {
        let mut items = vec![
            LineageItem::Event {
                id: "e1".into(), kind: "news".into(), text: "x".into(), as_of_date: "2026-09-10".into(),
                created_at: "2026-09-10T00:00:00Z".into(), reaction_count: 0, sentiment: BTreeMap::new(),
            },
            lineage_test("t1", "Q?", "vote", 0.40, "2026-09-11T00:00:00Z"),
            lineage_test("t2", "Q?", "belief", 0.70, "2026-09-11T01:00:00Z"),
            lineage_test("t3", "Q?", "vote", 0.55, "2026-09-11T02:00:00Z"),
        ];
        attach_deltas(&mut items);
        assert!(matches!(&items[0], LineageItem::Event { id, .. } if id == "e1"));
        match &items[1] {
            LineageItem::Test { previous_p_yes, delta, .. } => {
                assert_eq!(*previous_p_yes, None);
                assert_eq!(*delta, None);
            }
            _ => panic!(),
        }
        match &items[2] {
            LineageItem::Test { previous_p_yes, .. } => assert_eq!(*previous_p_yes, None),
            _ => panic!(),
        }
        match &items[3] {
            LineageItem::Test { previous_p_yes, delta, .. } => {
                assert_eq!(*previous_p_yes, Some(0.40));
                assert!((delta.unwrap() - 0.15).abs() < 1e-9);
            }
            _ => panic!(),
        }
        let j = serde_json::to_value(&items[3]).unwrap();
        assert_eq!(j["type"], "test");
        assert_eq!(serde_json::to_value(&items[0]).unwrap()["type"], "event");
    }

    #[test]
    fn keys_are_stable() {
        assert_eq!(population_key("sf", 42, 100), "sf:42:100");
        assert_eq!(persona_key("sf:42:100", 7), "sf:42:100:7");
        assert_eq!(short_id("evt", &["a", "b"]), short_id("evt", &["a", "b"]));
        assert_ne!(short_id("evt", &["a", "b"]), short_id("evt", &["ab", ""]));
    }

    #[test]
    fn sentiment_tally_counts_only_present_keys() {
        let mk = |s: &str| Reaction {
            agent_id: 0, name: String::new(), occupation: String::new(), neighborhood: String::new(),
            age: String::new(), archetype: String::new(), text: String::new(),
            sentiment: s.into(), at: String::new(),
        };
        let t = sentiment_tally(&[mk("angry"), mk("sad"), mk("angry")]);
        assert_eq!(t.get("angry"), Some(&2));
        assert_eq!(t.get("sad"), Some(&1));
        assert!(!t.contains_key("support"));
        assert_eq!(normalize_sentiment(" Angry "), "angry");
        assert_eq!(normalize_sentiment("meh"), "indifferent");
    }

    #[test]
    fn empty_memory_renders_nothing() {
        assert_eq!(prompt_fragment(&PersonaMemory::default()), "");
    }

    #[test]
    fn fragment_labels_news_stimulus_and_tests() {
        let mem = PersonaMemory {
            events: vec![
                RecalledEvent { id: "e1".into(), kind: "news".into(), text: "A senator was shot at a rally.".into(), as_of_date: "2026-09-10".into() },
                RecalledEvent { id: "s1".into(), kind: "stimulus".into(), text: "Imagine rent control passed.".into(), as_of_date: "2026-09-11".into() },
            ],
            tests: vec![
                RecalledTest { id: "t1".into(), kind: "poll".into(), question: "Support Prop X?".into(), as_of_date: "2026-09-11".into(), p_yes: 0.72, options: vec![], dist: vec![], why: "cost of living".into() },
                RecalledTest { id: "t2".into(), kind: "ab_test".into(), question: "Which slogan?".into(), as_of_date: "2026-09-11".into(), p_yes: 0.0, options: vec!["A".into(), "B".into()], dist: vec![0.3, 0.7], why: String::new() },
            ],
        };
        let s = prompt_fragment(&mem);
        assert!(s.starts_with(" Memory: "));
        assert!(s.contains("[2026-09-10 news] A senator was shot"));
        assert!(s.contains("was shown (hypothetical)] Imagine rent control"));
        assert!(s.contains("\"Support Prop X?\" → 72% yes — cost of living"));
        assert!(s.contains("\"Which slogan?\" → leaned \"B\" (70%)"));
        assert!(s.chars().count() <= RECALL_MAX_CHARS);
    }

    #[test]
    fn fragment_is_bounded() {
        let mem = PersonaMemory {
            events: (0..RECALL_EVENTS)
                .map(|i| RecalledEvent { id: format!("e{i}"), kind: "news".into(), text: "x".repeat(400), as_of_date: "2026-01-01".into() })
                .collect(),
            tests: vec![],
        };
        assert!(prompt_fragment(&mem).chars().count() <= RECALL_MAX_CHARS);
    }

    #[test]
    fn http_base_maps_aura_and_plain_uris() {
        assert_eq!(http_base("neo4j+s://abc.databases.neo4j.io").unwrap(), "https://abc.databases.neo4j.io");
        assert_eq!(http_base("http://localhost:7474/").unwrap(), "http://localhost:7474");
        assert_eq!(http_base("https://x.example").unwrap(), "https://x.example");
        assert!(http_base("bolt://localhost:7687").is_none());
        assert!(http_base("").is_none());
    }

    #[test]
    fn endpoint_follows_api_choice() {
        let mk = |api| MemoryClient {
            http: Client::new(),
            base: "https://abc.databases.neo4j.io".into(),
            database: "abc".into(),
            api,
            user: "u".into(),
            password: "p".into(),
        };
        assert_eq!(mk(HttpApi::Query).endpoint(), "https://abc.databases.neo4j.io/db/abc/query/v2");
        assert_eq!(mk(HttpApi::Tx).endpoint(), "https://abc.databases.neo4j.io/db/abc/tx/commit");
    }
}

#[cfg(test)]
mod population_key_tests {
    use super::*;
    use crate::city::CityProfile;
    use std::sync::Arc;

    fn pop(filter_key: &str) -> Population {
        Population {
            agents: vec![],
            income_cutoffs: [0.0; 4],
            seed: 42,
            n: 100,
            profile: Arc::new(CityProfile::sf()),
            filter_key: filter_key.to_string(),
        }
    }

    #[test]
    fn workspace_keys_are_scoped_and_public_is_bare() {
        assert_eq!(normalize_workspace(None), "public");
        assert_eq!(normalize_workspace(Some("  ")), "public");
        assert_eq!(normalize_workspace(Some("bad id!")), "public");
        assert_eq!(normalize_workspace(Some("Ab_c-9")), "Ab_c-9");
        assert_eq!(normalize_workspace(Some(&"x".repeat(33))), "public");
        assert_eq!(city_key("public", "sf"), "sf");
        assert_eq!(city_key("w1", "sf"), "w1:sf");
        assert_eq!(split_city_key("w1:sf"), ("w1".to_string(), "sf".to_string()));
        assert_eq!(split_city_key("sf"), ("public".to_string(), "sf".to_string()));
        assert_eq!(population_key_in("public", &pop("")), "sf:42:100");
        // personas are shared across workspaces: the key never carries the workspace
        assert_eq!(population_key_in("w1", &pop("")), "sf:42:100");
        assert_eq!(TestTag::poll().workspace(), "public");
        assert_eq!(TestTag::poll().in_workspace("w1").workspace(), "w1");
    }

    #[test]
    fn filtered_populations_get_distinct_keys() {
        assert_eq!(population_key_of(&pop("")), "sf:42:100");
        let a = population_key_of(&pop(r#"{"sex":"female"}"#));
        let b = population_key_of(&pop(r#"{"sex":"male"}"#));
        assert!(a.starts_with("sf:42:100:f"));
        assert_ne!(a, b);
        assert_eq!(a, population_key_of(&pop(r#"{"sex":"female"}"#)));
    }
}

#[cfg(test)]
mod seeded_id_tests {
    use super::seeded_id;
    #[test]
    fn seeded_ids_are_stable_and_workspace_specific() {
        let a = seeded_id("test", "test-abc", "ws1");
        assert_eq!(a, seeded_id("test", "test-abc", "ws1"));
        assert!(a.starts_with("test-"));
        assert_ne!(a, seeded_id("test", "test-abc", "ws2"));
        assert_ne!(a, seeded_id("test", "test-abd", "ws1"));
        assert_ne!(seeded_id("evt", "x", "ws1"), seeded_id("test", "x", "ws1"));
    }
}
