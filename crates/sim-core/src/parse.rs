//! Question parser. Turns a user's free-text question into a structured, pollable spec
//! (a framing + neutral restatement + option list), or returns a "not supported"
//! explanation with example phrasings that WOULD work. One LLM call.

use crate::model::{extract_json, Model, ModelClient};
use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, Serialize)]
pub struct ParsedQuestion {
    pub supported: bool,
    /// "vote" | "belief" | "options"
    pub framing: String,
    pub question: String,
    pub description: String,
    pub options: Vec<String>,
    /// Set when `supported == false`.
    pub reason: String,
    pub examples: Vec<String>,
}

impl ParsedQuestion {
    fn unsupported(reason: &str, examples: Vec<String>) -> Self {
        ParsedQuestion {
            supported: false,
            framing: String::new(),
            question: String::new(),
            description: String::new(),
            options: Vec::new(),
            reason: reason.to_string(),
            examples,
        }
    }
}

fn default_examples(city: &str) -> Vec<String> {
    vec![
        format!("Will {city} voters pass a measure to fund more public transit?"),
        format!("Which of these does a typical {city} resident prefer: cooking at home, eating out, or ordering delivery?"),
        "Will a Democrat win the next mayoral race?".to_string(),
    ]
}

pub async fn parse_question(
    client: &ModelClient,
    city: &str,
    raw: &str,
    model: Model,
) -> ParsedQuestion {
    let sys = format!(
        "You are a question router for a synthetic-population opinion simulator for {city}. \
The simulator polls a demographically-accurate panel of {city} residents and supports three framings:\n\
  - vote: a yes/no ballot measure or a two-side choice (YES = in favor / the first-named side).\n\
  - belief: a yes/no probability about an external event or outcome the residents would forecast.\n\
  - options: a choice among 2 or more named options. Use this for multi-candidate races AND for any \
non-political lifestyle/preference question (favorite cuisine, commute mode, weekend activity, where to live, etc.).\n\n\
Business, product, pricing and marketing scenarios ARE supported: the panel is the market. A question like \
\"what if I raise the price of my burrito bowls by 20%\" or \"should we open on Sundays\" must be answered as how \
residents would respond as customers or the public: reframe it as a consumer-reaction question and use the \
options framing with a sensible response set (e.g. keep buying as usual / buy less often / switch to a rival / \
stop buying), or vote/belief when the scenario is naturally yes/no. Never reject a question merely because it is \
hypothetical, first-person, or about a specific company, product, price, policy or event.\n\n\
Given the user's raw question, decide if a population panel can answer it. If yes, return a NEUTRAL, \
unbiased restatement, a short neutral one-sentence description, and — for the options framing — the list \
of options (invent a sensible 2-5 option set if the user implied a choice but didn't enumerate it). \
Only mark it unsupported when it truly cannot be answered by a panel (asks for a single objective fact, targets one named private individual, \
is incoherent, or needs information residents wouldn't have), mark it unsupported and give 2-3 example \
phrasings that WOULD work for {city}.\n\n\
Return STRICT JSON only, no prose:\n\
{{\"supported\":true,\"framing\":\"vote|belief|options\",\"question\":\"...\",\"description\":\"...\",\"options\":[\"...\"]}}\n\
or {{\"supported\":false,\"reason\":\"...\",\"examples\":[\"...\",\"...\"]}}"
    );
    let user = format!("City: {city}\nUser question: {raw}");
    match client.complete(model, &sys, &user, 700).await {
        Ok(text) => from_json(&text, city),
        Err(e) => {
            tracing::warn!("question router model call failed: {e:#}");
            ParsedQuestion::unsupported(
                "The router could not reach the model to parse this question.",
                default_examples(city),
            )
        }
    }
}

/// Parse a model/RocketRide JSON response into the stable API contract.
/// Keeping this normalizer in one place means every router produces the same
/// shape for the frontend.
pub fn from_json(text: &str, city: &str) -> ParsedQuestion {
    let v = match extract_json(text) {
        Ok(v) => v,
        Err(_) => {
            return ParsedQuestion::unsupported(
                "Could not parse the question into a supported form.",
                default_examples(city),
            )
        }
    };
    from_value(&v, city).unwrap_or_else(|| {
        ParsedQuestion::unsupported(
            "Could not parse the question into a supported form.",
            default_examples(city),
        )
    })
}

/// Convert a JSON object that follows the router schema into a parsed question.
/// Returns `None` when the value is not a router response at all.
pub fn from_value(v: &Value, city: &str) -> Option<ParsedQuestion> {
    if !v.is_object() || v.get("supported").and_then(|x| x.as_bool()).is_none() {
        return None;
    }
    let supported = v
        .get("supported")
        .and_then(|x| x.as_bool())
        .unwrap_or(false);
    if !supported {
        let reason = v
            .get("reason")
            .and_then(|x| x.as_str())
            .unwrap_or("This question isn't phrased in a way the resident panel can answer.")
            .to_string();
        let examples: Vec<String> = v
            .get("examples")
            .and_then(|x| x.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .filter(|e: &Vec<String>| !e.is_empty())
            .unwrap_or_else(|| default_examples(city));
        return Some(ParsedQuestion::unsupported(&reason, examples));
    }
    let question = v
        .get("question")
        .and_then(|x| x.as_str())
        .map(str::trim)
        .filter(|question| !question.is_empty())?
        .to_string();
    let framing = v
        .get("framing")
        .and_then(|x| x.as_str())
        .map(|s| s.to_lowercase())
        .filter(|s| s == "vote" || s == "belief" || s == "options")
        .unwrap_or_else(|| "vote".to_string());
    let options: Vec<String> = v
        .get("options")
        .and_then(|x| x.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    // A declared "options" framing with <2 options falls back to vote.
    let framing = if framing == "options" && options.len() < 2 {
        "vote".to_string()
    } else {
        framing
    };
    Some(ParsedQuestion {
        supported: true,
        framing,
        question,
        description: v
            .get("description")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        options,
        reason: String::new(),
        examples: Vec::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn supported_router_response_requires_a_question() {
        assert!(from_value(
            &json!({
                "supported": true,
                "framing": "vote",
                "question": "   "
            }),
            "San Francisco"
        )
        .is_none());
    }

    #[test]
    fn supported_router_response_trims_the_question() {
        let parsed = from_value(
            &json!({
                "supported": true,
                "framing": "belief",
                "question": "  Will transit ridership grow?  ",
                "description": "A neutral forecast."
            }),
            "San Francisco",
        )
        .expect("valid router response");

        assert_eq!(parsed.question, "Will transit ridership grow?");
        assert_eq!(parsed.framing, "belief");
    }
}
