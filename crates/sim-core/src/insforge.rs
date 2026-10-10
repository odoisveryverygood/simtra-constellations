//! Server-side persistence for completed prediction runs.
//!
//! The Rust API owns this client so InsForge's project API key never reaches the
//! browser. The app remains fully usable when InsForge is not configured; a
//! persistence outage is logged and does not turn a successful prediction into
//! a failed one.

use crate::predict::{Framing, Poll, PollResult, Population0};
use anyhow::{anyhow, Result};
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;

const TABLE: &str = "prediction_results";

#[derive(Clone)]
pub struct InsforgeClient {
    http: Client,
    base_url: String,
    api_key: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct PredictionRecord {
    pub city: String,
    pub question: String,
    pub description: String,
    pub framing: String,
    pub as_of_date: String,
    pub model: String,
    pub population: String,
    pub p_yes: f64,
    pub ci_low: f64,
    pub ci_high: f64,
    pub n_agents: usize,
    pub n_eff: f64,
    pub design_effect: f64,
    pub n_archetypes: usize,
    pub n_llm_calls: usize,
    pub p_distribution: Value,
    pub breakdowns: Value,
    pub sample_rationales: Value,
    pub hydra_evidence: Value,
    pub simulation_id: String,
    pub branch_id: String,
}

#[derive(Debug, Deserialize)]
struct ProjectConfig {
    api_key: Option<String>,
    oss_host: Option<String>,
}

impl InsforgeClient {
    /// Build a server-only client from env vars. For local development, the
    /// linked `.insforge/project.json` is a convenient fallback; it is ignored
    /// by git and is never used by frontend code.
    pub fn from_env() -> Option<Self> {
        let (base_url, api_key) = match (
            std::env::var("INSFORGE_URL").ok(),
            std::env::var("INSFORGE_API_KEY")
                .or_else(|_| std::env::var("INSFORGE_ADMIN_KEY"))
                .ok(),
        ) {
            (Some(url), Some(key)) if !url.trim().is_empty() && !key.trim().is_empty() => {
                (url, key)
            }
            _ => Self::read_linked_project_config()?,
        };

        let http = Client::builder()
            .user_agent("sim-francisco-insforge")
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(12))
            .build()
            .ok()?;

        Some(Self {
            http,
            base_url: base_url.trim_end_matches('/').to_string(),
            api_key,
        })
    }

    fn read_linked_project_config() -> Option<(String, String)> {
        let text = std::fs::read_to_string(".insforge/project.json").ok()?;
        let config: ProjectConfig = serde_json::from_str(&text).ok()?;
        let base_url = config.oss_host?.trim_end_matches('/').to_string();
        let api_key = config.api_key?;
        if base_url.is_empty() || api_key.trim().is_empty() {
            return None;
        }
        Some((base_url, api_key))
    }

    pub fn record_from_poll(
        city: &str,
        poll: &Poll,
        result: &PollResult,
        simulation_id: &str,
        branch_id: &str,
    ) -> Result<PredictionRecord> {
        Ok(PredictionRecord {
            city: city.to_string(),
            question: result.question.clone(),
            description: poll.description.clone(),
            framing: framing_name(poll.framing),
            as_of_date: result.as_of_date.clone(),
            model: result.model.clone(),
            population: population_name(poll.pop()),
            p_yes: result.p_yes,
            ci_low: result.ci_low,
            ci_high: result.ci_high,
            n_agents: result.n_agents,
            n_eff: result.n_eff,
            design_effect: result.design_effect,
            n_archetypes: result.n_archetypes,
            n_llm_calls: result.n_llm_calls,
            p_distribution: serde_json::to_value(&result.p_distribution)?,
            breakdowns: serde_json::to_value(&result.breakdowns)?,
            sample_rationales: serde_json::to_value(&result.sample_rationales)?,
            hydra_evidence: serde_json::to_value(&result.hydra)?,
            simulation_id: simulation_id.to_string(),
            branch_id: branch_id.to_string(),
        })
    }

    pub async fn insert_prediction(&self, record: &PredictionRecord) -> Result<()> {
        let response = self
            .http
            .post(self.records_url(TABLE)?)
            .bearer_auth(&self.api_key)
            .header("content-type", "application/json")
            .header("accept", "application/json")
            .header("prefer", "return=minimal")
            .json(&[record])
            .send()
            .await?;
        self.ensure_success(response, "insert prediction").await
    }

    pub async fn list_predictions(&self, city: Option<&str>, limit: usize) -> Result<Vec<Value>> {
        let mut url = self.records_url(TABLE)?;
        {
            let mut query = url.query_pairs_mut();
            query.append_pair("select", "*");
            query.append_pair("order", "created_at.desc");
            query.append_pair("limit", &limit.to_string());
            if let Some(city) = city.filter(|value| !value.trim().is_empty()) {
                query.append_pair("city", &format!("eq.{city}"));
            }
        }
        let response = self
            .http
            .get(url)
            .bearer_auth(&self.api_key)
            .header("accept", "application/json")
            .send()
            .await?;
        let status = response.status();
        let body = response.text().await?;
        if !status.is_success() {
            return Err(anyhow!("InsForge list prediction failed ({status})"));
        }
        serde_json::from_str(&body)
            .map_err(|_| anyhow!("InsForge returned invalid prediction history JSON"))
    }

    fn records_url(&self, table: &str) -> Result<Url> {
        Url::parse(&format!("{}/api/database/records/{}", self.base_url, table)).map_err(Into::into)
    }

    async fn ensure_success(&self, response: reqwest::Response, operation: &str) -> Result<()> {
        let status = response.status();
        if status.is_success() {
            return Ok(());
        }
        // Do not include response text: cloud errors can echo request details.
        Err(anyhow!("InsForge {operation} failed ({status})"))
    }
}

fn framing_name(framing: Framing) -> String {
    match framing {
        Framing::Vote => "vote",
        Framing::Belief => "belief",
        Framing::Options => "options",
    }
    .to_string()
}

fn population_name(population: Population0) -> String {
    match population {
        Population0::All => "all",
        Population0::CvapLikelyVoter => "cvap_likely_voter",
    }
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hydra::HydraEvidence;
    use crate::predict::PollResult;
    use std::collections::HashMap;

    #[test]
    fn builds_a_small_persistence_record_without_secrets() {
        let poll = Poll {
            question: "Will this pass?".into(),
            description: "A simple test question.".into(),
            framing: Framing::Vote,
            as_of_date: "2026-07-28".into(),
            model: Some("test".into()),
            population: None,
            event: None,
            options: vec![],
        };
        let result = PollResult {
            question: poll.question.clone(),
            as_of_date: poll.as_of_date.clone(),
            model: "test".into(),
            p_yes: 0.6,
            ci_low: 0.5,
            ci_high: 0.7,
            n_agents: 10,
            n_eff: 9.0,
            design_effect: 1.1,
            breakdowns: HashMap::new(),
            n_archetypes: 2,
            n_llm_calls: 1,
            sample_rationales: vec!["because".into()],
            p_distribution: vec![],
            option_breakdowns: vec![],
            option_ci: None,
            hydra: HydraEvidence::default(),
            memory_test_id: None,
        };
        let record =
            InsforgeClient::record_from_poll("sf", &poll, &result, "sim", "branch").unwrap();
        assert_eq!(record.city, "sf");
        assert_eq!(record.framing, "vote");
        assert_eq!(record.population, "all");
        assert!(!serde_json::to_string(&record).unwrap().contains("api_key"));
    }
}
