//! Optional RocketRide question-router integration.
//!
//! RocketRide is an adapter rather than a replacement for the backend contract:
//! it receives the raw question, returns the same structured `ParsedQuestion`,
//! and falls back to the existing model router if unavailable or malformed.

use crate::model::Model;
use crate::parse::ParsedQuestion;
use anyhow::{anyhow, Context, Result};
use reqwest::Client;
use serde_json::{json, Value};
use std::time::Duration;

#[derive(Clone)]
pub struct RocketRideClient {
    http: Client,
    webhook_url: String,
    token: Option<String>,
}

impl RocketRideClient {
    /// Configure RocketRide only when an endpoint is explicitly supplied.
    /// This keeps local development and existing deployments unchanged.
    pub fn from_env() -> Option<Self> {
        if matches!(
            std::env::var("ROCKETRIDE_ENABLED").ok().as_deref(),
            Some("0" | "false" | "off" | "no")
        ) {
            return None;
        }
        let webhook_url = std::env::var("ROCKETRIDE_WEBHOOK_URL")
            .or_else(|_| std::env::var("ROCKETRIDE_URL"))
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())?;
        if !webhook_url.starts_with("http://") && !webhook_url.starts_with("https://") {
            tracing::warn!("RocketRide URL is not HTTP(S); integration disabled");
            return None;
        }
        let http = Client::builder()
            .timeout(Duration::from_secs(20))
            .build()
            .expect("reqwest client with static RocketRide timeout");
        let token = std::env::var("ROCKETRIDE_WEBHOOK_TOKEN")
            .or_else(|_| std::env::var("ROCKETRIDE_AUTH"))
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        Some(Self {
            http,
            webhook_url,
            token,
        })
    }

    /// Send the stable router request to a deployed RocketRide webhook.
    pub async fn parse_question(
        &self,
        city: &str,
        raw: &str,
        model: Model,
    ) -> Result<ParsedQuestion> {
        let payload = json!({
            "city": city,
            "question": raw,
            "model": model.id(),
            "output_schema": {
                "supported": "boolean",
                "framing": "vote|belief|options",
                "question": "string",
                "description": "string",
                "options": "string[]",
                "reason": "string",
                "examples": "string[]"
            }
        });
        // The checked-in pipeline uses the Webhook text lane so it works with
        // RocketRide's raw HTTP source. The JSON remains intact inside the text
        // payload and is decoded by the pipeline's prompt/LLM chain.
        let mut request = self
            .http
            .post(&self.webhook_url)
            .header(reqwest::header::CONTENT_TYPE, "text/plain")
            .body(serde_json::to_string(&payload)?);
        if let Some(token) = &self.token {
            request = request.bearer_auth(token);
        }
        let response = request.send().await.context("RocketRide webhook request")?;
        let status = response.status();
        if !status.is_success() {
            return Err(anyhow!("RocketRide webhook returned HTTP {status}"));
        }
        let body: Value = response
            .json()
            .await
            .context("RocketRide returned non-JSON data")?;
        let payload = extract_router_payload(&body)
            .ok_or_else(|| anyhow!("RocketRide response did not contain router JSON"))?;
        crate::parse::from_value(&payload, city)
            .ok_or_else(|| anyhow!("RocketRide router JSON did not match the expected schema"))
    }
}

/// RocketRide response nodes can wrap output in a lane array, or return JSON as
/// a string. We accept both forms while still requiring the router schema.
fn extract_router_payload(value: &Value) -> Option<Value> {
    if crate::parse::from_value(value, "this city").is_some() {
        return Some(value.clone());
    }
    match value {
        Value::String(text) => serde_json::from_str::<Value>(text)
            .ok()
            .and_then(|v| extract_router_payload(&v)),
        Value::Array(items) => items.iter().find_map(extract_router_payload),
        Value::Object(map) => ["result", "json", "answers", "output", "data"]
            .iter()
            .filter_map(|key| map.get(*key))
            .find_map(extract_router_payload),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    fn router_json() -> Value {
        json!({
            "supported": true,
            "framing": "options",
            "question": "Which commute mode do residents prefer?",
            "description": "A neutral preference question.",
            "options": ["Transit", "Car", "Walk or bike"]
        })
    }

    #[test]
    fn normalizes_direct_router_response() {
        let parsed = extract_router_payload(&router_json()).expect("payload");
        assert_eq!(parsed["framing"], "options");
    }

    #[test]
    fn normalizes_response_lane_array() {
        let wrapped = json!({ "result": [router_json()] });
        let parsed = extract_router_payload(&wrapped).expect("payload");
        assert_eq!(parsed["supported"], true);
    }

    #[test]
    fn normalizes_json_string_inside_answers_lane() {
        let wrapped = json!({ "answers": [router_json().to_string()] });
        let parsed = extract_router_payload(&wrapped).expect("payload");
        assert_eq!(
            parsed["question"],
            "Which commute mode do residents prefer?"
        );
    }

    #[test]
    fn rejects_unrelated_response() {
        assert!(extract_router_payload(&json!({ "status": "ok" })).is_none());
    }

    #[test]
    fn rejects_supported_response_without_a_question() {
        assert!(extract_router_payload(&json!({
            "supported": true,
            "framing": "vote",
            "question": " "
        }))
        .is_none());
    }

    #[tokio::test]
    async fn posts_router_payload_and_reads_webhook_response() {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
        let address = listener.local_addr().expect("address");
        let expected = router_json();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("connection");
            let mut request = vec![0_u8; 16 * 1024];
            let bytes = socket.read(&mut request).await.expect("request");
            let request = String::from_utf8_lossy(&request[..bytes]);
            assert!(request.contains("content-type: text/plain"));
            assert!(request.contains("\"city\":\"sf\""));
            let body = json!({ "answers": [expected.to_string()] }).to_string();
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(), body
            );
            socket
                .write_all(response.as_bytes())
                .await
                .expect("response");
        });

        let client = RocketRideClient {
            http: Client::new(),
            webhook_url: format!("http://{address}"),
            token: Some("test-token".to_string()),
        };
        let parsed = client
            .parse_question("sf", "Do you support transit?", Model::Gpt4o)
            .await
            .expect("parsed response");
        assert!(parsed.supported);
        assert_eq!(parsed.options.len(), 3);
        server.await.expect("server task");
    }
}
