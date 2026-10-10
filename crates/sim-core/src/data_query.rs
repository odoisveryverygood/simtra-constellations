//! Deterministic, allowlisted demographic questions over complete verified ACS rows.
//! No model, simulation, cache of model answers, or synthetic resident is involved.
use crate::data_source::{self, Dataset, PersonRow};
use axum::{
    extract::{rejection::JsonRejection, State},
    routing::post,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Dimension {
    Age,
    Sex,
    RaceEthnicity,
    Education,
    IncomeToPoverty,
    Employment,
    Citizenship,
    Nativity,
    MaritalStatus,
    Tenure,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Measure {
    Count,
    Percentage,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct QuerySpec {
    pub dimension: Dimension,
    pub measure: Measure,
    #[serde(default)]
    pub category: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub city: String,
    pub question: String,
    #[serde(default)]
    pub query_spec: Option<QuerySpec>,
}

pub const DIMENSIONS: [Dimension; 10] = [
    Dimension::Age,
    Dimension::Sex,
    Dimension::RaceEthnicity,
    Dimension::Education,
    Dimension::IncomeToPoverty,
    Dimension::Employment,
    Dimension::Citizenship,
    Dimension::Nativity,
    Dimension::MaritalStatus,
    Dimension::Tenure,
];

impl Dimension {
    pub fn name(self) -> &'static str {
        match self {
            Self::Age => "age",
            Self::Sex => "recorded sex",
            Self::RaceEthnicity => "race and ethnicity",
            Self::Education => "education",
            Self::IncomeToPoverty => "income-to-poverty group",
            Self::Employment => "employment",
            Self::Citizenship => "citizenship",
            Self::Nativity => "nativity",
            Self::MaritalStatus => "marital status",
            Self::Tenure => "housing tenure",
        }
    }
    pub fn aliases(self) -> &'static [&'static str] {
        match self {
            Self::Age => &["age", "age group"],
            Self::Sex => &["sex", "recorded sex", "recorded pums sex"],
            Self::RaceEthnicity => &["race and ethnicity", "race/ethnicity"],
            Self::Education => &["education", "educational attainment"],
            Self::IncomeToPoverty => &["income-to-poverty group", "income-to-poverty ratio"],
            Self::Employment => &["employment", "employment status"],
            Self::Citizenship => &["citizenship"],
            Self::Nativity => &["nativity"],
            Self::MaritalStatus => &["marital status"],
            Self::Tenure => &["tenure", "housing tenure"],
        }
    }
    /// Keys and labels are fixed, exhaustive and ordered; no prompt supplies bins.
    pub fn groups(self) -> &'static [(&'static str, &'static str)] {
        match self {
            Self::Age => &[
                ("u18", "Under 18"),
                ("18-24", "18–24"),
                ("25-34", "25–34"),
                ("35-44", "35–44"),
                ("45-54", "45–54"),
                ("55-64", "55–64"),
                ("65+", "65 or older"),
            ],
            Self::Sex => &[
                ("male", "Male (recorded PUMS sex)"),
                ("female", "Female (recorded PUMS sex)"),
            ],
            Self::RaceEthnicity => &[
                ("hispanic", "Hispanic, any race"),
                ("white", "Non-Hispanic White alone"),
                ("black", "Non-Hispanic Black alone"),
                ("native", "Non-Hispanic American Indian/Alaska Native alone"),
                ("asian", "Non-Hispanic Asian alone"),
                (
                    "pacific",
                    "Non-Hispanic Native Hawaiian/Pacific Islander alone",
                ),
                ("other", "Non-Hispanic other race alone"),
                ("multiracial", "Non-Hispanic two or more races"),
            ],
            Self::Education => &[
                ("not_applicable", "Not applicable: under age 3"),
                ("lt_hs", "Less than high school"),
                ("hs", "High school diploma or equivalent"),
                ("some_college", "Some college or associate degree"),
                ("bachelors", "Bachelor's degree"),
                ("graduate", "Graduate degree"),
            ],
            Self::IncomeToPoverty => &[
                ("below_100", "Below 100% of poverty threshold"),
                ("100_199", "100–199% of poverty threshold"),
                ("200_299", "200–299% of poverty threshold"),
                ("300_499", "300–499% of poverty threshold"),
                ("500_plus", "500% or more of poverty threshold"),
                ("not_applicable", "Poverty ratio not applicable"),
            ],
            Self::Employment => &[
                ("employed", "Employed, including Armed Forces"),
                ("unemployed", "Unemployed"),
                ("not_in_labor_force", "Not in labor force"),
                ("not_applicable", "Not applicable: under age 16"),
            ],
            Self::Citizenship => &[
                ("citizen", "U.S. citizen"),
                ("noncitizen", "Not a U.S. citizen"),
            ],
            Self::Nativity => &[
                ("us_born", "Native born (PUMS NATIVITY=1)"),
                ("foreign_born", "Foreign born"),
            ],
            Self::MaritalStatus => &[
                ("married", "Married"),
                ("widowed", "Widowed"),
                ("divorced", "Divorced"),
                ("separated", "Separated"),
                ("never_married", "Never married or under age 15"),
            ],
            Self::Tenure => &[
                ("owner", "People in owner-occupied housing"),
                ("renter", "People in rented housing"),
                ("no_cash_rent", "People in housing occupied without rent"),
                ("not_applicable", "Group quarters: tenure not applicable"),
            ],
        }
    }
    pub fn key(self, r: &PersonRow) -> &'static str {
        match self {
            Self::Age => match r.age {
                0..=17 => "u18",
                18..=24 => "18-24",
                25..=34 => "25-34",
                35..=44 => "35-44",
                45..=54 => "45-54",
                55..=64 => "55-64",
                _ => "65+",
            },
            Self::Sex => {
                if r.sex == 1 {
                    "male"
                } else {
                    "female"
                }
            }
            Self::RaceEthnicity => {
                if r.hispanic > 1 {
                    "hispanic"
                } else {
                    match r.race {
                        1 => "white",
                        2 => "black",
                        3..=5 => "native",
                        6 => "asian",
                        7 => "pacific",
                        8 => "other",
                        _ => "multiracial",
                    }
                }
            }
            Self::Education => match r.education {
                0 => "not_applicable",
                1..=15 => "lt_hs",
                16..=17 => "hs",
                18..=20 => "some_college",
                21 => "bachelors",
                _ => "graduate",
            },
            Self::IncomeToPoverty => match r.poverty {
                None => "not_applicable",
                Some(0..=99) => "below_100",
                Some(100..=199) => "100_199",
                Some(200..=299) => "200_299",
                Some(300..=499) => "300_499",
                _ => "500_plus",
            },
            Self::Employment => match r.employment {
                1 | 2 | 4 | 5 => "employed",
                3 => "unemployed",
                6 => "not_in_labor_force",
                _ => "not_applicable",
            },
            Self::Citizenship => {
                if r.citizenship <= 4 {
                    "citizen"
                } else {
                    "noncitizen"
                }
            }
            Self::Nativity => {
                if r.nativity == 1 {
                    "us_born"
                } else {
                    "foreign_born"
                }
            }
            Self::MaritalStatus => match r.marital {
                1 => "married",
                2 => "widowed",
                3 => "divorced",
                4 => "separated",
                _ => "never_married",
            },
            Self::Tenure => match r.tenure {
                Some(1 | 2) => "owner",
                Some(3) => "renter",
                Some(4) => "no_cash_rent",
                _ => "not_applicable",
            },
        }
    }
}

/// Full-string matching is intentional. Never silently ignore a constraint,
/// unsupported year, forecast, dollar-income request, or trailing instruction.
pub fn parse_question(city: &str, question: &str) -> Result<QuerySpec, &'static str> {
    let aliases: &[&str] = match city {
        "sf" => &["san francisco", "sf"],
        "neu_york" => &["new york city", "new york", "nyc"],
        "synth_la" => &["los angeles", "la"],
        "cybercago" => &["chicago"],
        "simami" => &["miami"],
        _ => return Err("Unsupported city."),
    };
    if question.trim().is_empty() || question.len() > 512 {
        return Err("Question must contain 1–512 bytes.");
    }
    let normalized = question
        .trim()
        .trim_end_matches(['?', '.'])
        .to_ascii_lowercase()
        .replace('–', "-")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let mut q = normalized.as_str();
    for alias in aliases {
        if let Some(prefix) = q.strip_suffix(&format!(" in {alias}")) {
            q = prefix;
            break;
        }
    }
    for dimension in DIMENSIONS {
        for alias in dimension.aliases() {
            for form in [
                format!("show the {alias} distribution"),
                format!("show {alias} distribution"),
                format!("what is the {alias} distribution"),
                format!("show population by {alias}"),
                format!("show the population by {alias}"),
            ] {
                if q == form {
                    return Ok(QuerySpec {
                        dimension,
                        measure: Measure::Percentage,
                        category: None,
                    });
                }
            }
            if q == format!("show population counts by {alias}") {
                return Ok(QuerySpec {
                    dimension,
                    measure: Measure::Count,
                    category: None,
                });
            }
        }
    }
    // Each descriptor has one defined meaning. Gender identity, homeownership
    // rates, unemployment rates, and poverty rates have no implicit mapping.
    let descriptors = [
        ("under 18", Dimension::Age, "u18"),
        ("aged 18-24", Dimension::Age, "18-24"),
        ("aged 25-34", Dimension::Age, "25-34"),
        ("aged 35-44", Dimension::Age, "35-44"),
        ("aged 45-54", Dimension::Age, "45-54"),
        ("aged 55-64", Dimension::Age, "55-64"),
        ("65 or older", Dimension::Age, "65+"),
        ("male", Dimension::Sex, "male"),
        ("female", Dimension::Sex, "female"),
        ("recorded male", Dimension::Sex, "male"),
        ("recorded female", Dimension::Sex, "female"),
        ("hispanic", Dimension::RaceEthnicity, "hispanic"),
        ("non-hispanic white", Dimension::RaceEthnicity, "white"),
        ("non-hispanic black", Dimension::RaceEthnicity, "black"),
        ("non-hispanic asian", Dimension::RaceEthnicity, "asian"),
        ("employed", Dimension::Employment, "employed"),
        ("unemployed", Dimension::Employment, "unemployed"),
        (
            "not in the labor force",
            Dimension::Employment,
            "not_in_labor_force",
        ),
        ("u.s. citizens", Dimension::Citizenship, "citizen"),
        ("noncitizens", Dimension::Citizenship, "noncitizen"),
        ("foreign born", Dimension::Nativity, "foreign_born"),
        ("native born", Dimension::Nativity, "us_born"),
        ("married", Dimension::MaritalStatus, "married"),
        ("widowed", Dimension::MaritalStatus, "widowed"),
        ("divorced", Dimension::MaritalStatus, "divorced"),
        ("separated", Dimension::MaritalStatus, "separated"),
        (
            "living in owner-occupied housing",
            Dimension::Tenure,
            "owner",
        ),
        ("living in rented housing", Dimension::Tenure, "renter"),
    ];
    for (descriptor, dimension, key) in descriptors {
        for (prefix, measure) in [
            ("what percentage of residents are ", Measure::Percentage),
            ("how many residents are ", Measure::Count),
        ] {
            if q == format!("{prefix}{descriptor}") {
                return Ok(QuerySpec {
                    dimension,
                    measure,
                    category: Some(key.into()),
                });
            }
        }
    }
    Err("Unsupported or ambiguous question. Use a documented demographic distribution or population-count question; predictions and unspecified income/gender measures are unsupported.")
}

pub fn empty(status: &str, question: &str, reason: &str) -> Value {
    json!({"status":status,"question":question,"answer":null,
        "chart":{"type":"bar","title":"No demographic answer","unit":null,"series":[]},
        "query_spec":null,"geography":null,"source":{"verification_status":"Unknown"},
        "method":null,"limitations":[reason]})
}

pub fn execute(root: &Path, input: Value) -> Value {
    let question = input
        .get("question")
        .and_then(Value::as_str)
        .unwrap_or("")
        .chars()
        .take(512)
        .collect::<String>();
    let request: Request = match serde_json::from_value(input) {
        Ok(r) => r,
        Err(_) => {
            return empty(
                "unsupported",
                &question,
                "Invalid request or non-allowlisted query fields.",
            )
        }
    };
    let spec = match parse_question(&request.city, &request.question) {
        Ok(spec) => spec,
        Err(reason) => return empty("unsupported", &question, reason),
    };
    if request
        .query_spec
        .as_ref()
        .is_some_and(|provided| provided != &spec)
    {
        return empty(
            "unsupported",
            &question,
            "Query plan conflicts with the supported question. No computation was performed.",
        );
    }
    match data_source::load(root, &request.city) {
        Ok(data) => calculate(&data, &request.question, &spec),
        Err(_) => {
            let mut response = empty("unavailable", &question, "Source is Unknown, unavailable, or failed integrity verification. No answer was calculated.");
            response["query_spec"] = json!(spec);
            if let Ok(mut source) = data_source::manifest(&request.city) {
                response["geography"] = source["geographic_coverage"].clone();
                source["verification_status"] = json!("Unknown");
                source["integrity_check"] = json!("rejected");
                response["source"] = source;
            }
            response
        }
    }
}

fn calculate(data: &Dataset, question: &str, spec: &QuerySpec) -> Value {
    let total: u64 = data.rows.iter().map(|r| r.weight).sum();
    let mut totals = vec![(0u64, 0usize); spec.dimension.groups().len()];
    for row in &data.rows {
        let key = spec.dimension.key(row);
        let index = spec
            .dimension
            .groups()
            .iter()
            .position(|(k, _)| *k == key)
            .expect("exhaustive categories");
        totals[index].0 += row.weight;
        totals[index].1 += 1;
    }
    let unit = if spec.measure == Measure::Count {
        "people"
    } else {
        "percent"
    };
    let group_by = match spec.dimension {
        Dimension::Sex => "gender",
        Dimension::RaceEthnicity => "race",
        Dimension::IncomeToPoverty => "income",
        Dimension::MaritalStatus => "marital",
        _ => spec.dimension.aliases()[0],
    };
    let series: Vec<Value> = spec.dimension.groups().iter().zip(totals)
        .filter(|((key, _), _)| spec.category.as_deref().map_or(true, |category| category == *key))
        .map(|((key, label), (weight, n))| json!({"key":key,"label":label,
            "value":if spec.measure == Measure::Count { weight as f64 } else { 100.0 * weight as f64 / total as f64 },
            "weighted_population":weight,"raw_records":n,
            "map_filter":map_filter(spec.dimension, key)})).collect();
    let city = data.source["geographic_coverage"]["city_label"]
        .as_str()
        .unwrap_or("Selected");
    let title = format!(
        "{city} PUMA coverage: {} (2023 ACS 1-year)",
        spec.dimension.name()
    );
    let answer_statistics = if spec.category.is_some() {
        series[0].clone()
    } else {
        json!({"label":title,"weighted_population":total,"raw_records":data.rows.len()})
    };
    let numerator: u64 = series
        .iter()
        .map(|s| s["weighted_population"].as_u64().unwrap())
        .sum();
    let answer = if spec.category.is_some() {
        format!(
            "{}: {:.2} {unit}; survey-weighted estimate {} people from {} PUMS records.",
            series[0]["label"].as_str().unwrap(),
            series[0]["value"].as_f64().unwrap(),
            numerator,
            series[0]["raw_records"]
        )
    } else {
        format!("{title}. Full PUMS survey-weighted population estimate: {total} people from {} records. Bars show {unit} across all person records.", data.rows.len())
    };
    // Serialize the shared frontend schema only after source integrity succeeds.
    let coverage = &data.source["geographic_coverage"];
    let pumas: Vec<String> = coverage["pumas"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| format!("{:05}", p.as_u64().unwrap()))
        .collect();
    let mut source = data.source.clone();
    source["verification_status"] = json!("verified");
    source["url"] = source["official_download_url"].clone();
    source["raw_sha256"] = source["raw_source_sha256"].clone();
    source["snapshot_sha256"] = source["filtered_snapshot_sha256"].clone();
    source["license"] = Value::Null;
    let mut limitations = data.source["limitations"].as_array().unwrap().clone();
    limitations.push(json!("Map matching is unavailable where existing synthetic resident segments do not exactly represent the source category; no counts are inferred from coarser or simulated fields."));
    json!({"status":"ok","question":question,"answer":answer,"answer_statistics":answer_statistics,
        "chart":{"type":"bar","title":title,"unit":unit,"series":series},
        "query_spec":{"schema_version":"1.0","mode":"verified_data",
            "intent":if spec.category.is_none() { "distribution" } else if spec.measure == Measure::Count { "count" } else { "share" },
            "universe":"all_person_records","group_by":group_by,"weight_field":"PWGTP",
            "dimension":spec.dimension,"measure":spec.measure,"category":spec.category},
        "geography":{"city_slug":data.source["city"],"label":coverage["city_label"],
            "state_fips":coverage["state_fips"],"puma_codes":pumas,
            "coverage_type":"puma_based_approximation","exact_city_boundary":false,
            "limitations":[coverage["description"]]},"source":source,
        "method":{"claim_class":"survey_weighted_estimate","weight_field":"PWGTP",
            "estimator":"sum_of_person_weights","scope":"complete_committed_pums_snapshot",
            "numerator_weighted":numerator,"denominator_weighted":total,"rounding_digits":2,
            "population":"all complete committed person rows in the listed PUMAs",
            "weighted_population":total,"raw_records":data.rows.len(),
            "percentage_denominator":total,"denominator_includes_not_applicable":true,
            "formula":"count = sum(PWGTP); percentage = 100 * group sum(PWGTP) / all-row sum(PWGTP)",
            "model_generated_numbers":false,"synthetic_residents_used":false,
            "group_definitions":"Fixed categories from the 2023 ACS PUMS dictionary; Hispanic ethnicity takes precedence over race; tenure joins same-release housing TEN by SERIALNO.",
            "margin_of_error":null},"limitations":limitations})
}

// Only exact canonical resident categories can drive the synthetic overlay.
// Coarser education/race/employment bins, income quintiles and simulated tenure
// cannot represent every source category, so those predicates remain unavailable.
fn map_filter(dimension: Dimension, key: &str) -> Value {
    let (dimension, key) = match dimension {
        Dimension::Age => ("age", key),
        Dimension::Education if !matches!(key, "lt_hs" | "not_applicable") => ("education", key),
        Dimension::Sex => ("gender", if key == "female" { "women" } else { "men" }),
        Dimension::RaceEthnicity if !matches!(key, "other" | "multiracial") => ("race", key),
        Dimension::Citizenship => ("citizenship", key),
        Dimension::Nativity => ("nativity", key),
        Dimension::MaritalStatus => ("marital", key),
        Dimension::Employment if key == "employed" => ("employment", key),
        _ => return Value::Null,
    };
    json!({"operator":"and","clauses":[{"dimension":dimension,"key":key}]})
}

pub fn router(root: PathBuf) -> Router {
    Router::new()
        .route("/data-query", post(handler))
        .with_state(Arc::new(root))
}

async fn handler(
    State(root): State<Arc<PathBuf>>,
    payload: Result<Json<Value>, JsonRejection>,
) -> Json<Value> {
    let Json(input) = match payload {
        Ok(input) => input,
        Err(_) => {
            return Json(empty(
                "unsupported",
                "",
                "Request must be a valid JSON object.",
            ))
        }
    };
    match tokio::task::spawn_blocking(move || execute(&root, input)).await {
        Ok(response) => Json(response),
        Err(_) => Json(empty("unavailable", "", "Data query could not complete.")),
    }
}
