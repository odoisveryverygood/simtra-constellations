//! Live Neo4j integration test for the persona memory layer. Skipped unless
//! `NEO4J_URI` is set (e.g. `NEO4J_URI=http://localhost:7474 NEO4J_PASSWORD=... cargo test --test memory_neo4j`).

use simfrancisco::hydra::HydraEvidence;
use simfrancisco::memory::{self, AgentAnswer, MemoryClient, StimulusRecord, TestTag};
use simfrancisco::predict::{Framing, Poll, PollResult};
use std::collections::HashMap;

const EVENT_TEXT: &str = "A political figure was shot at a rally.";

/// Personas registered under a population key (shared across workspaces).
async fn persona_count(mem: &MemoryClient, pop_key: &str) -> u64 {
    mem.run(&[(
        "MATCH (a:Persona) WHERE a.key STARTS WITH $k + ':' RETURN count(a)",
        serde_json::json!({"k": pop_key}),
    )])
    .await
    .unwrap()[0][0][0]
        .as_u64()
        .unwrap()
}

#[tokio::test]
async fn neo4j_memory_roundtrip() {
    let ws_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    std::env::set_current_dir(&ws_root).ok();
    simfrancisco::load_dotenv(".env");
    let Some(mem) = MemoryClient::from_env() else {
        eprintln!("NEO4J_URI not set; skipping neo4j memory integration test");
        return;
    };
    assert!(mem.ping().await, "neo4j not reachable at NEO4J_URI");
    mem.ensure_schema().await.unwrap();

    // unique population per run so reruns against a persistent DB never collide
    let seed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let n = 30usize;
    let records = simfrancisco::pums::load_sf().unwrap();
    let pop = simfrancisco::persona::build_population(&records, n, seed, None);
    // Throwaway workspace: everything this run writes is scoped to it.
    let ws = format!("test-{seed}");
    let city = memory::city_key(&ws, &pop.profile.slug);
    assert_eq!(city, format!("test-{seed}:sf"));
    // Personas are shared across workspaces: the population key carries no workspace.
    let pop_key = memory::population_key_in(&ws, &pop);
    assert_eq!(pop_key, format!("sf:{seed}:{n}"));
    mem.ensure_population(&ws, &pop).await.unwrap();
    assert_eq!(persona_count(&mem, &pop_key).await, n as u64);

    // city-wide event: every persona in sf remembers it
    // A crashed earlier run can leave same-day filler events behind; they would push
    // this run's event out of the recall cap, so clear them first.
    mem.run(&[(
        "MATCH (e:Event) WHERE e.text STARTS WITH 'Same-day filler event' DETACH DELETE e",
        serde_json::json!({}),
    )])
    .await
    .unwrap();
    let ev = mem
        .add_city_event(&city, "news", EVENT_TEXT, "2026-09-10")
        .await
        .unwrap();
    // Recall as of the event's own date: the city graph is shared and may hold many
    // newer events, and recall keeps only the RECALL_EVENTS most recent ones.
    let recalled = mem.recall(&ws, "sf", &pop_key, &[0, 1, 2], "2026-09-10").await.unwrap();
    for id in [0u32, 1, 2] {
        let m = recalled.get(&id).unwrap_or_else(|| panic!("persona {id} has no memory"));
        assert!(m.events.iter().any(|e| e.id == ev.id), "persona {id} missing city event");
        assert!(memory::prompt_fragment(m).contains("political figure"));
    }
    // Same-day events: the most recently created one must be recalled even when
    // more than RECALL_EVENTS events share the date (ordering by created_at, not id).
    let mut same_day = Vec::new();
    for i in 0..(memory::RECALL_EVENTS + 2) {
        // created_at has second resolution: give the last one a distinct timestamp
        if i == memory::RECALL_EVENTS + 1 { tokio::time::sleep(std::time::Duration::from_millis(1100)).await; }
        let e = mem
            .add_city_event(&city, "news", &format!("Same-day filler event {i} for {seed}"), "2026-09-10")
            .await
            .unwrap();
        same_day.push(e.id);
    }
    let newest = same_day.last().unwrap().clone();
    let again = mem.recall(&ws, "sf", &pop_key, &[0], "2026-09-10").await.unwrap();
    assert!(
        again[&0].events.iter().any(|e| e.id == newest),
        "newest same-day event must survive the recall cap"
    );

    // dated before the event: not recalled (backtests stay leakage-free)
    let before = mem.recall(&ws, "sf", &pop_key, &[0, 1, 2], "2026-09-01").await.unwrap();
    // Another workspace shares these very personas but must not see this event.
    let other_ws = format!("other-{seed}");
    let elsewhere = mem.recall(&other_ws, "sf", &pop_key, &[0, 1, 2], "2026-09-12").await.unwrap();
    for id in [0u32, 1, 2] {
        assert!(
            elsewhere.get(&id).map(|m| m.events.is_empty()).unwrap_or(true),
            "workspace {other_ws} must not recall workspace {ws}'s event"
        );
    }
    for id in [0u32, 1, 2] {
        let none = before.get(&id).map(|m| !m.events.iter().any(|e| e.id == ev.id)).unwrap_or(true);
        assert!(none, "persona {id} recalled a future event");
    }

    // a test the population took part in
    let poll = Poll {
        question: "Do you support stricter gun laws?".into(),
        description: "A neutral description.".into(),
        framing: Framing::Vote,
        as_of_date: "2026-09-12".into(),
        model: Some("test".into()),
        population: None,
        event: None,
        options: vec![],
    };
    let result = PollResult {
        question: poll.question.clone(),
        as_of_date: poll.as_of_date.clone(),
        model: "test".into(),
        p_yes: 0.61,
        ci_low: 0.55,
        ci_high: 0.67,
        n_agents: n,
        n_eff: 28.0,
        design_effect: 1.05,
        breakdowns: HashMap::new(),
        n_archetypes: 3,
        n_llm_calls: 1,
        sample_rationales: vec!["safety".into()],
        p_distribution: vec![],
        option_breakdowns: vec![],
        option_ci: None,
        hydra: HydraEvidence::default(),
            memory_test_id: None,
    };
    let tag = TestTag::kind("poll").on_branch("sim-test", "sim-test:main").in_workspace(&ws);
    let record = memory::test_record(&pop_key, "sf", &poll, &result, &tag);
    assert_eq!(record.workspace, ws);
    assert_eq!(record.city, "sf");
    let answers: Vec<AgentAnswer> = (0..n as u32)
        .map(|id| AgentAnswer {
            agent_id: id,
            p_yes: 0.72,
            dist: vec![],
            why: "safety first".into(),
            archetype: "arch".into(),
            personal_p_yes: None,
            personal_dist: None,
            personal_why: None,
        })
        .collect();
    mem.record_test(&pop_key, &record, &answers, Some(&ev.id)).await.unwrap();
    mem.record_stimuli(
        &record.id,
        &[
            StimulusRecord { label: "A".into(), text: "variant a".into() },
            StimulusRecord { label: "B".into(), text: "variant b".into() },
        ],
    )
    .await
    .unwrap();

    // every persona's answer and the test itself are readable back by id
    let answers = mem.test_answers(&record.id).await.unwrap().expect("test exists");
    assert_eq!(answers.len(), 30);
    assert!(answers.iter().all(|a| (a.p_yes - 0.72).abs() < 1e-9 && a.why == "safety first"));
    assert!(mem.test_answers("test-does-not-exist").await.unwrap().is_none());
    match mem.test_detail(&record.id).await.unwrap().expect("test detail") {
        memory::LineageItem::Test { id, question, population_key, breakdowns, .. } => {
            assert_eq!(id, record.id);
            assert_eq!(question, poll.question);
            assert_eq!(population_key, pop_key);
            assert!(breakdowns.is_some());
        }
        other => panic!("unexpected lineage item: {other:?}"),
    }

    // personal answers: stored on the ANSWERED edge and readable back
    mem.record_personal_answers(
        &pop_key,
        &record.id,
        &[memory::PersonalAnswer { agent_id: 5, p_yes: 0.31, dist: vec![], why: "I ride Muni daily and this is my own take.".into() }],
    )
    .await
    .unwrap();
    let personal = mem.personal_answers(&pop_key, &record.id, &[5, 6]).await.unwrap();
    assert_eq!(personal.len(), 1);
    assert_eq!(personal[0].agent_id, 5);
    assert!((personal[0].p_yes - 0.31).abs() < 1e-9);
    let all = mem.test_answers(&record.id).await.unwrap().unwrap();
    let a5 = all.iter().find(|a| a.agent_id == 5).unwrap();
    assert_eq!(a5.personal_why.as_deref(), Some("I ride Muni daily and this is my own take."));
    assert!(all.iter().find(|a| a.agent_id == 6).unwrap().personal_why.is_none());

    let recalled = mem.recall(&ws, "sf", &pop_key, &[0, 5, 29], "2026-09-12").await.unwrap();
    // ...and the same residents, asked from another workspace, remember no tests.
    let elsewhere = mem.recall(&other_ws, "sf", &pop_key, &[0, 5, 29], "2026-09-12").await.unwrap();
    assert!(elsewhere.values().all(|m| m.tests.is_empty()), "tests are scoped by workspace");
    for id in [0u32, 5, 29] {
        let m = recalled.get(&id).unwrap();
        let t = m.tests.iter().find(|t| t.id == record.id).unwrap_or_else(|| panic!("persona {id} missing test"));
        assert!((t.p_yes - 0.72).abs() < 1e-9);
        assert_eq!(t.why, "safety first");
        let frag = memory::prompt_fragment(m);
        assert!(frag.contains("stricter gun laws"), "{frag}");
        assert!(frag.contains("72% yes"), "{frag}");
    }

    let view = mem.persona_view(&ws, "sf", &pop_key, 0).await.unwrap();
    assert_eq!(view["persona"]["agent_id"], 0);
    assert!(!view["events"].as_array().unwrap().is_empty());
    let tests = view["tests"].as_array().unwrap();
    assert!(!tests.is_empty());
    let mine = tests.iter().find(|t| t["id"] == record.id).unwrap();
    assert_eq!(mine["under_event"], EVENT_TEXT);
    assert_eq!(mine["stimuli"].as_array().unwrap().len(), 2);

    let events = mem.list_city_events(&city, 100).await.unwrap();
    assert!(events.iter().any(|e| e.event.id == ev.id));

    // Workspace isolation: another workspace (and the public one) sees none of it.
    let other = memory::city_key(&format!("other-{seed}"), "sf");
    let elsewhere = mem.list_city_events(&other, 100).await.unwrap();
    assert!(elsewhere.is_empty(), "other workspace must be empty");
    let public = mem.list_city_events("sf", 200).await.unwrap();
    assert!(!public.iter().any(|e| e.event.id == ev.id), "public must not see the workspace event");
    let lineage = mem.lineage(&ws, "sf", 100).await.unwrap();
    let other_lineage = mem.lineage(&other_ws, "sf", 100).await.unwrap();
    assert!(!other_lineage.iter().any(|i| i.id() == record.id), "other workspace lineage must not list the test");
    assert!(lineage.iter().any(|i| i.id() == record.id), "lineage lists the workspace test");
    let (n_events, n_tests, _) = mem.workspace_summary(&ws).await.unwrap();
    assert!(n_events >= 1 && n_tests >= 1, "workspace summary counts this run");

    // Seeding: a fresh workspace copies this workspace's most recent survey and news
    // event onto the SAME shared personas (no new Persona nodes), and never does it twice.
    let seeded_ws = format!("seeded-{seed}");
    let personas_before = persona_count(&mem, &pop_key).await;
    let (n_t, n_e) = mem.seed_workspace(&seeded_ws, &ws, &pop, 3).await.unwrap();
    assert!(n_t >= 1 && n_e >= 1, "seed copies at least one survey and one event, got {n_t}/{n_e}");
    assert_eq!(persona_count(&mem, &pop_key).await, personas_before, "seeding must not create personas");
    let seeded_city = memory::city_key(&seeded_ws, "sf");
    let copied_test = memory::seeded_id("test", &record.id, &seeded_ws);
    let seeded_lineage = mem.lineage(&seeded_ws, "sf", 100).await.unwrap();
    assert!(seeded_lineage.iter().any(|i| i.id() == copied_test), "seeded lineage lists the copied survey");
    // the 3 most recent events are copied (the same-day fillers outrank the first one)
    let copied_events = seeded_lineage
        .iter()
        .filter(|i| serde_json::to_value(i).unwrap()["type"] == "event")
        .count();
    assert_eq!(copied_events, n_e, "seeded lineage lists every copied event");
    assert!(copied_events >= 1);
    let copied_answers = mem.test_answers(&copied_test).await.unwrap().expect("copied test exists");
    assert_eq!(copied_answers.len(), answers.len(), "every answer is attached to the shared personas");
    assert!((copied_answers[0].p_yes - 0.72).abs() < 1e-9);
    let again = mem.seed_workspace(&seeded_ws, &ws, &pop, 3).await.unwrap();
    assert_eq!(again, (0, 0), "seeding is idempotent");
    // Seeded workspace cleanup: only its tests, events and city (personas are shared).
    mem.run(&[
        ("MATCH (t:Test {workspace: $ws}) DETACH DELETE t", serde_json::json!({"ws": seeded_ws})),
        ("MATCH (e:Event)-[:HAPPENED_IN]->(c:City {key: $city}) DETACH DELETE e, c", serde_json::json!({"city": seeded_city})),
    ])
    .await
    .unwrap();

    // Clean up: the graph is shared with the demo city, so remove this run's
    // population, personas, tests, stimuli and the seeded event.
    mem.run(&[
        (
            "MATCH (p:Population {key: $pop}) \
             OPTIONAL MATCH (a:Persona)-[:MEMBER_OF]->(p) \
             OPTIONAL MATCH (t:Test)-[:RAN_ON]->(p) \
             OPTIONAL MATCH (t)-[:USED_STIMULUS]->(s:Stimulus) \
             DETACH DELETE a, t, s, p",
            serde_json::json!({"pop": pop_key}),
        ),
        ("MATCH (e:Event {id: $id}) DETACH DELETE e", serde_json::json!({"id": ev.id})),
        ("MATCH (e:Event) WHERE e.id IN $ids DETACH DELETE e", serde_json::json!({"ids": same_day})),
        ("MATCH (c:City {key: $city}) DETACH DELETE c", serde_json::json!({"city": city})),
        ("MATCH (t:Test {workspace: $ws}) DETACH DELETE t", serde_json::json!({"ws": ws})),
        ("MATCH (c:City {key: $city}) DETACH DELETE c", serde_json::json!({"city": memory::city_key(&other_ws, "sf")})),
    ])
    .await
    .unwrap();
}
