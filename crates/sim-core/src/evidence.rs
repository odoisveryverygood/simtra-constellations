//! Provenance for simulated estimates. Source observations, synthetic residents,
//! and model answers are different evidence classes even when displayed together.

use crate::city::CityProfile;
use crate::hydra::HydraEvidence;
use crate::predict::PollResult;
use serde::Serialize;

/// Additive HTTP contract; flattening preserves every existing PollResult field
/// without changing Rust callers that construct PollResult directly.
#[derive(Serialize)]
pub struct PollResponse {
    #[serde(flatten)]
    pub result: PollResult,
    pub evidence: PollEvidence,
}

impl PollResponse {
    pub fn new(result: PollResult, profile: &CityProfile) -> Self {
        let evidence = PollEvidence::new(profile, &result.hydra);
        Self { result, evidence }
    }
}

#[derive(Serialize)]
pub struct PopulationSource {
    pub provider: &'static str,
    pub dataset: &'static str,
    pub vintage: Option<String>,
    pub url: Option<String>,
    pub local_snapshot: Option<String>,
    pub weight_field: &'static str,
    pub retrieved_at: Option<String>,
}

#[derive(Serialize)]
pub struct ContextSource {
    pub provider: &'static str,
    pub title: String,
    #[serde(rename = "type")]
    pub source_type: String,
    pub url: Option<String>,
    pub retrieved_at: Option<String>,
}

#[derive(Serialize)]
pub struct ContextRetrieval {
    pub provider: &'static str,
    pub enabled: bool,
    pub status: String,
    pub chunks: usize,
}

#[derive(Serialize)]
pub struct PollEvidence {
    pub claim_class: &'static str,
    pub population_source: PopulationSource,
    pub reliability: &'static str,
    pub limitations: Vec<&'static str>,
    pub context_sources: Vec<ContextSource>,
    pub context_retrieval: ContextRetrieval,
}

impl PollEvidence {
    pub fn new(profile: &CityProfile, hydra: &HydraEvidence) -> Self {
        Self {
            claim_class: "simulated_estimate",
            population_source: PopulationSource {
                provider: "U.S. Census Bureau",
                dataset: "ACS PUMS",
                // No snapshot-bound source manifest is committed. The historical
                // session log mentions a 2023 download but does not establish
                // provenance for the current city CSVs or runtime path overrides.
                // PUMA boundary vintage, poll as_of_date, and file modification
                // times must not be substituted for dataset/retrieval metadata.
                vintage: None,
                url: None,
                local_snapshot: if profile.pums_path.trim().is_empty() {
                    None
                } else {
                    Some(profile.pums_path.clone())
                },
                weight_field: "PWGTP",
                retrieved_at: None,
            },
            reliability: "model_based_unvalidated",
            limitations: vec![
                "Census ACS PUMS demographic inputs and PWGTP weights are sourced observations; synthetic residents are simulated representations, not identifiable surveyed people.",
                "Poll answers and predicted support are model-based simulated estimates, not observed survey responses or Census statistics. Predictive accuracy is not established by this response.",
                "Personas, values, home tenure, and map positions are simulated. Income groups are population-specific quintiles of household income-to-poverty ratio (POVPIP), not observed dollar-income brackets. The gender segment uses recorded PUMS SEX, not gender identity.",
                "Intervals and effective sample size describe weighted model outputs; they do not capture all model error or establish real-world accuracy.",
                "Resident segments identify demographic membership, not individual answers. Polls can exclude unanswered archetypes and apply citizen-voting-age eligibility and modeled turnout weights; pums_weight is the original PWGTP, not necessarily the final poll weight.",
                "The current local snapshots have no verified vintage, source URL, or retrieval timestamp in a snapshot-bound repository manifest.",
                "Hydra sources are retrieved context, not verified observations of poll outcomes. Hydra context does not turn a simulated estimate into an observed result; source URLs and retrieval times are unavailable in Hydra summaries.",
            ],
            context_sources: hydra.sources.iter().map(|source| ContextSource {
                provider: "HydraDB",
                title: source.title.clone(),
                source_type: source.source_type.clone(),
                url: None,
                retrieved_at: None,
            }).collect(),
            context_retrieval: ContextRetrieval {
                provider: "HydraDB",
                enabled: hydra.enabled,
                status: if hydra.status.trim().is_empty() {
                    "unknown".to_string()
                } else {
                    hydra.status.clone()
                },
                chunks: hydra.chunks,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hydra::HydraSourceSummary;
    use serde_json::json;

    #[test]
    fn response_preserves_all_legacy_values_when_hydra_is_unavailable() {
        let result = PollResult {
            question: "Fixture".into(),
            as_of_date: "2024-06-01".into(),
            model: "fixture".into(),
            p_yes: 0.6,
            ci_low: 0.4,
            ci_high: 0.8,
            n_agents: 10,
            n_eff: 8.0,
            design_effect: 1.25,
            breakdowns: Default::default(),
            n_archetypes: 2,
            n_llm_calls: 1,
            sample_rationales: vec!["Fixture only".into()],
            p_distribution: vec![],
            option_breakdowns: vec![],
            option_ci: None,
            hydra: HydraEvidence {
                enabled: true,
                status: "unavailable".into(),
                chunks: 0,
                sources: vec![],
            },
            memory_test_id: None,
        };
        let legacy = serde_json::to_value(&result).unwrap();
        let mut response =
            serde_json::to_value(PollResponse::new(result, &CityProfile::sf())).unwrap();
        let evidence = response
            .as_object_mut()
            .unwrap()
            .remove("evidence")
            .unwrap();
        assert_eq!(response, legacy, "evidence must be additive");
        assert_eq!(evidence["context_retrieval"]["status"], "unavailable");
        assert_eq!(evidence["context_retrieval"]["enabled"], true);
        assert_eq!(evidence["context_sources"], json!([]));
        assert_eq!(evidence["claim_class"], "simulated_estimate");
    }

    #[test]
    fn unknown_metadata_is_explicit_even_for_a_dated_custom_path() {
        let mut profile = CityProfile::sf();
        profile.pums_path = "custom/2026/pums.csv".into();
        let value =
            serde_json::to_value(PollEvidence::new(&profile, &HydraEvidence::default())).unwrap();
        assert_eq!(
            value["population_source"]["local_snapshot"],
            profile.pums_path
        );
        for field in ["vintage", "url", "retrieved_at"] {
            assert_eq!(
                value["population_source"].get(field),
                Some(&serde_json::Value::Null)
            );
        }
        assert_eq!(value["context_retrieval"]["status"], "unknown");
        profile.pums_path.clear();
        assert!(PollEvidence::new(&profile, &HydraEvidence::default())
            .population_source
            .local_snapshot
            .is_none());
    }

    #[test]
    fn hydra_states_never_change_the_claim_class() {
        for status in ["disabled", "unavailable", "connected"] {
            let hydra = HydraEvidence {
                enabled: status != "disabled",
                status: status.into(),
                chunks: usize::from(status == "connected"),
                sources: if status == "connected" {
                    vec![HydraSourceSummary {
                        title: "Context fixture".into(),
                        source_type: "document".into(),
                    }]
                } else {
                    vec![]
                },
            };
            let value =
                serde_json::to_value(PollEvidence::new(&CityProfile::sf(), &hydra)).unwrap();
            assert_eq!(value["claim_class"], "simulated_estimate");
            assert_eq!(value["reliability"], "model_based_unvalidated");
            assert_eq!(value["context_retrieval"]["status"], status);
            assert_eq!(value["context_retrieval"]["enabled"], hydra.enabled);
            assert_eq!(value["context_retrieval"]["chunks"], hydra.chunks);
            if status == "connected" {
                assert_eq!(
                    value["context_sources"],
                    json!([{
                        "provider": "HydraDB", "title": "Context fixture", "type": "document",
                        "url": null, "retrieved_at": null
                    }])
                );
            } else {
                assert_eq!(value["context_sources"], json!([]));
            }
        }
    }
}
