//! HydraDB context retrieval for live prediction runs.
//!
//! HydraDB is an evidence layer, not the simulator's population store. The
//! deterministic PUMS population remains local; retrieved HydraDB chunks are
//! bounded, marked as untrusted data in the model prompt, and returned as
//! provenance so the UI can show what grounded a run.

use anyhow::{anyhow, Result};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::time::Duration;

const DEFAULT_BASE_URL: &str = "https://api.hydradb.com";
const DEFAULT_TENANT: &str = "default-tenant";
const DEFAULT_SUBTENANT: &str = "simfrancisco-raw";
const MAX_CONTEXT_CHARS: usize = 6_000;
const MAX_CHUNK_CHARS: usize = 1_800;
const MAX_RECALL_ATTEMPTS: usize = 3;

#[derive(Clone)]
pub struct HydraClient {
    http: Client,
    base_url: String,
    api_key: String,
    tenant_id: String,
    sub_tenant_id: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct HydraEvidence {
    pub enabled: bool,
    pub status: String,
    pub chunks: usize,
    pub sources: Vec<HydraSourceSummary>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HydraSourceSummary {
    pub title: String,
    #[serde(rename = "type")]
    pub source_type: String,
}

#[derive(Clone, Debug)]
pub struct HydraRecall {
    pub context: String,
    pub evidence: HydraEvidence,
}

#[derive(Debug, Deserialize)]
struct RecallResponse {
    #[serde(default)]
    chunks: Vec<RecallChunk>,
    #[serde(default)]
    sources: Vec<RecallSource>,
}

#[derive(Debug, Deserialize)]
struct RecallChunk {
    #[serde(default)]
    chunk_content: String,
}

#[derive(Debug, Deserialize)]
struct RecallSource {
    #[serde(default)]
    title: String,
    #[serde(rename = "type", default)]
    source_type: String,
}

impl HydraClient {
    /// Build a client when a HydraDB key is configured. The API key is never
    /// included in serialized evidence or error messages.
    pub fn from_env() -> Option<Self> {
        let api_key = std::env::var("HYDRA_DB_KEY")
            .or_else(|_| std::env::var("HYDRA_DB_API_KEY"))
            .ok()
            .filter(|value| !value.trim().is_empty())?;
        let base_url = std::env::var("HYDRA_DB_URL")
            .unwrap_or_else(|_| DEFAULT_BASE_URL.to_string())
            .trim_end_matches('/')
            .to_string();
        let tenant_id =
            std::env::var("HYDRA_DB_TENANT_ID").unwrap_or_else(|_| DEFAULT_TENANT.to_string());
        let sub_tenant_id = std::env::var("HYDRA_DB_SUBTENANT")
            .or_else(|_| std::env::var("HYDRA_DB_SUB_TENANT_ID"))
            .unwrap_or_else(|_| DEFAULT_SUBTENANT.to_string());
        let http = Client::builder()
            .user_agent("sim-francisco-hydradb")
            .connect_timeout(Duration::from_secs(8))
            .timeout(Duration::from_secs(20))
            .build()
            .ok()?;
        Some(Self {
            http,
            base_url,
            api_key,
            tenant_id,
            sub_tenant_id,
        })
    }

    pub fn tenant_id(&self) -> &str {
        &self.tenant_id
    }

    pub async fn full_recall(&self, query: &str) -> Result<HydraRecall> {
        let parsed = self
            .post_recall(
                "/recall/full_recall",
                json!({
                    "tenant_id": self.tenant_id,
                    "sub_tenant_id": self.sub_tenant_id,
                    "query": query,
                    "max_results": 5,
                    "mode": "fast",
                    "graph_context": true
                }),
            )
            .await?;
        let mut context = String::new();
        let mut used_chunks = 0usize;
        for chunk in parsed.chunks.iter() {
            let text = chunk.chunk_content.trim();
            if text.is_empty() || context.len() >= MAX_CONTEXT_CHARS {
                continue;
            }
            let remaining = MAX_CONTEXT_CHARS - context.len();
            let take = text
                .chars()
                .take(remaining.min(MAX_CHUNK_CHARS))
                .collect::<String>();
            if take.is_empty() {
                continue;
            }
            context.push_str(&take);
            context.push_str("\n\n");
            used_chunks += 1;
        }
        let sources = parsed
            .sources
            .into_iter()
            .filter(|source| !source.title.trim().is_empty())
            .map(|source| HydraSourceSummary {
                title: source.title,
                source_type: source.source_type,
            })
            .collect::<Vec<_>>();
        Ok(HydraRecall {
            context,
            evidence: HydraEvidence {
                enabled: true,
                status: "connected".to_string(),
                chunks: used_chunks,
                sources,
            },
        })
    }

    async fn post_recall(&self, path: &str, payload: serde_json::Value) -> Result<RecallResponse> {
        for attempt in 0..MAX_RECALL_ATTEMPTS {
            let response = self
                .http
                .post(format!("{}{}", self.base_url, path))
                .bearer_auth(&self.api_key)
                .json(&payload)
                .send()
                .await?;
            let status = response.status();
            let body = response.text().await?;
            if status.is_success() {
                return serde_json::from_str(&body)
                    .map_err(|_| anyhow!("HydraDB recall returned invalid JSON"));
            }
            let retryable = matches!(status.as_u16(), 429 | 500 | 503);
            if retryable && attempt + 1 < MAX_RECALL_ATTEMPTS {
                let delay_ms = 300 * 2u64.pow(attempt as u32);
                tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                continue;
            }
            return Err(anyhow!("HydraDB recall returned HTTP {}", status.as_u16()));
        }
        unreachable!("recall loop always returns")
    }
}
