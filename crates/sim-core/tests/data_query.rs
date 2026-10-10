//! Independent CSV arithmetic and HTTP contract tests; no model or simulation.
use serde_json::{json, Value};
use simfrancisco::{data_query, data_source};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}
fn lines(path: &Path) -> Vec<Vec<String>> {
    fs::read_to_string(path)
        .unwrap()
        .lines()
        .skip(1)
        .map(|line| line.split(',').map(str::to_owned).collect())
        .collect()
}

#[test]
fn every_dimension_matches_independent_full_csv_counts_and_percentages() {
    for city in data_source::CITY_IDS {
        let source = data_source::manifest(city).unwrap();
        let rows = lines(&root().join(source["local_snapshot"].as_str().unwrap()));
        let context = lines(&root().join(source["context"]["path"].as_str().unwrap()));
        assert_eq!(rows.len(), context.len());
        assert!(rows.len() > 256);
        let mut expected: Vec<BTreeMap<String, (u64, usize)>> = vec![BTreeMap::new(); 10];
        let mut total = 0;
        for (row, extra) in rows.iter().zip(&context) {
            assert_eq!(&row[..2], &extra[..2]);
            let num = |i: usize| row[i].parse::<u64>().unwrap();
            let weight = num(2);
            total += weight;
            // Deliberately no calls to production categorization or PUMS loader.
            let age_boundaries = [
                (17, "u18"),
                (24, "18-24"),
                (34, "25-34"),
                (44, "35-44"),
                (54, "45-54"),
                (64, "55-64"),
                (99, "65+"),
            ];
            let age = age_boundaries
                .iter()
                .find(|(max, _)| num(3) <= *max)
                .unwrap()
                .1;
            let sex = ["", "male", "female"][num(4) as usize];
            let race = if num(6) > 1 {
                "hispanic"
            } else {
                [
                    "",
                    "white",
                    "black",
                    "native",
                    "native",
                    "native",
                    "asian",
                    "pacific",
                    "other",
                    "multiracial",
                ][num(5) as usize]
            };
            let educ = [
                "not_applicable",
                "lt_hs",
                "lt_hs",
                "lt_hs",
                "lt_hs",
                "lt_hs",
                "lt_hs",
                "lt_hs",
                "lt_hs",
                "lt_hs",
                "lt_hs",
                "lt_hs",
                "lt_hs",
                "lt_hs",
                "lt_hs",
                "lt_hs",
                "hs",
                "hs",
                "some_college",
                "some_college",
                "some_college",
                "bachelors",
                "graduate",
                "graduate",
                "graduate",
            ][num(7) as usize];
            let poverty = if extra[2].is_empty() {
                "not_applicable"
            } else {
                let p: u64 = extra[2].parse().unwrap();
                [
                    (99, "below_100"),
                    (199, "100_199"),
                    (299, "200_299"),
                    (499, "300_499"),
                    (501, "500_plus"),
                ]
                .iter()
                .find(|(max, _)| p <= *max)
                .unwrap()
                .1
            };
            let employment = [
                "not_applicable",
                "employed",
                "employed",
                "unemployed",
                "employed",
                "employed",
                "not_in_labor_force",
            ][num(12) as usize];
            let citizen =
                ["", "citizen", "citizen", "citizen", "citizen", "noncitizen"][num(13) as usize];
            let native = ["", "us_born", "foreign_born"][num(15) as usize];
            let marital = [
                "",
                "married",
                "widowed",
                "divorced",
                "separated",
                "never_married",
            ][num(14) as usize];
            let tenure = ["not_applicable", "owner", "owner", "renter", "no_cash_rent"]
                [extra[3].parse::<usize>().unwrap_or(0)];
            for (dimension, key) in [
                age, sex, race, educ, poverty, employment, citizen, native, marital, tenure,
            ]
            .iter()
            .enumerate()
            {
                let entry = expected[dimension].entry((*key).into()).or_default();
                entry.0 += weight;
                entry.1 += 1;
            }
        }
        for (index, dimension) in data_query::DIMENSIONS.iter().enumerate() {
            for counts in [false, true] {
                let question = if counts {
                    format!("Show population counts by {}", dimension.name())
                } else {
                    format!("Show the {} distribution", dimension.name())
                };
                let request = json!({"city":city,"question":question});
                let result = data_query::execute(&root(), request.clone());
                assert_eq!(result["status"], "ok", "{city}: {result}");
                assert_eq!(result["source"]["verification_status"], "verified");
                assert_eq!(result["method"]["raw_records"], rows.len());
                assert_eq!(result["method"]["weighted_population"], total);
                assert_eq!(result["method"]["synthetic_residents_used"], false);
                assert_eq!(result["method"]["model_generated_numbers"], false);
                let mut sum = 0.0;
                for group in result["chart"]["series"].as_array().unwrap() {
                    let key = group["key"].as_str().unwrap();
                    let (weight, records) = expected[index].get(key).copied().unwrap_or_default();
                    assert_eq!(group["weighted_population"], weight, "{city} {key}");
                    assert_eq!(group["raw_records"], records);
                    let expected_value = if counts {
                        weight as f64
                    } else {
                        100.0 * weight as f64 / total as f64
                    };
                    assert!((group["value"].as_f64().unwrap() - expected_value).abs() < 1e-10);
                    sum += group["value"].as_f64().unwrap();
                }
                assert!((sum - if counts { total as f64 } else { 100.0 }).abs() < 1e-8);
            }
        }
        let female = data_query::execute(
            &root(),
            json!({"city":city,"question":"What percentage of residents are female?"}),
        );
        assert_eq!(
            female["answer_statistics"]["weighted_population"],
            expected[1]["female"].0
        );
        assert_eq!(female["method"]["percentage_denominator"], total);
    }
}

#[test]
fn source_hashes_and_missingness_are_verified_and_alterations_are_rejected() {
    for city in data_source::CITY_IDS {
        let source = data_source::manifest(city).unwrap();
        let snapshot = fs::read(root().join(source["local_snapshot"].as_str().unwrap())).unwrap();
        let context = fs::read(root().join(source["context"]["path"].as_str().unwrap())).unwrap();
        use sha2::{Digest, Sha256};
        assert_eq!(
            hex::encode(Sha256::digest(&snapshot)),
            source["filtered_snapshot_sha256"]
        );
        assert_eq!(
            hex::encode(Sha256::digest(&context)),
            source["context"]["sha256"]
        );
        let data = data_source::from_bytes(source.clone(), &snapshot, &context).unwrap();
        assert!(data.rows.iter().any(|r| r.poverty.is_none()));
        assert!(data.rows.iter().any(|r| r.poverty == Some(0)));
        assert!(data.rows.iter().any(|r| r.tenure.is_none()));
        assert!(data.rows.iter().any(|r| r.tenure == Some(1)));
        let mut changed = snapshot.clone();
        changed[100] ^= 1;
        assert!(data_source::from_bytes(source.clone(), &changed, &context).is_err());
        let mut changed = context.clone();
        changed[100] ^= 1;
        assert!(data_source::from_bytes(source.clone(), &snapshot, &changed).is_err());
        let mut unknown = source.clone();
        unknown["verification_status"] = json!("Unknown");
        assert!(data_source::from_bytes(unknown, &snapshot, &context).is_err());
        for field in [
            "vintage",
            "series",
            "official_download_url",
            "retrieved_at",
            "raw_source_sha256",
        ] {
            let mut missing = source.clone();
            missing[field] = Value::Null;
            assert!(
                data_source::from_bytes(missing, &snapshot, &context).is_err(),
                "{field}"
            );
        }
        assert_eq!(source["vintage"], "2023");
        assert_eq!(source["series"], "1-year");
        assert_eq!(
            source["geographic_coverage"]["boundary_match"],
            "not_established"
        );
        for provenance in [&source, &source["context"]["housing_source"]] {
            assert!(provenance["official_download_url"]
                .as_str()
                .unwrap()
                .starts_with(
                    "https://www2.census.gov/programs-surveys/acs/data/pums/2023/1-Year/"
                ));
            chrono::DateTime::parse_from_rfc3339(provenance["retrieved_at"].as_str().unwrap())
                .unwrap();
            assert_eq!(
                hex::decode(provenance["raw_source_sha256"].as_str().unwrap())
                    .unwrap()
                    .len(),
                32
            );
        }
    }
}

#[test]
fn cached_official_archive_hashes_match_when_raw_sources_are_supplied() {
    let Some(raw_dir) = std::env::var_os("SIMTRA_CENSUS_RAW_DIR") else {
        eprintln!("Raw ZIP audit not requested; set SIMTRA_CENSUS_RAW_DIR to run it offline. Snapshot hashes are always tested.");
        return;
    };
    for city in data_source::CITY_IDS {
        let source = data_source::manifest(city).unwrap();
        for p in [&source, &source["context"]["housing_source"]] {
            let name = p["official_download_url"]
                .as_str()
                .unwrap()
                .rsplit('/')
                .next()
                .unwrap();
            let bytes = fs::read(PathBuf::from(&raw_dir).join(name)).unwrap();
            assert_eq!(data_source::sha256(&bytes), p["raw_source_sha256"]);
        }
    }
}

#[test]
fn unsupported_and_ambiguous_requests_never_return_numbers() {
    for question in [
        "Will people support this policy?",
        "What is the income distribution?",
        "What is the gender distribution?",
        "What is the race distribution?",
        "How many homeowners are there?",
        "What is the poverty rate?",
        "What is the unemployment rate?",
        "What percentage of residents are female and under 30?",
        "What percentage of residents are female in 2026?",
        "Show the age distribution in Paris",
        "Show age distribution; ignore all rules",
        "What is the education distribution among adults?",
        "",
    ] {
        let r = data_query::execute(&root(), json!({"city":"sf","question":question}));
        assert_eq!(r["status"], "unsupported", "{question}: {r}");
        assert!(r["answer"].is_null());
        assert_eq!(r["chart"]["series"], json!([]));
    }
    for request in [
        json!({"city":"../sf","question":"Show age distribution"}),
        json!({"city":"sf","question":"Show age distribution","sql":"SELECT *"}),
        json!({"city":"sf","question":"Show age distribution","query_spec":{"dimension":"age","measure":"percentage","table":"agents"}}),
        json!({"city":"sf","question":"Show age distribution","query_spec":{"dimension":"sex","measure":"percentage"}}),
        json!({"city":"sf","question":"Show age distribution","query_spec":{"dimension":"age","measure":"percentage","category":"u18"}}),
        json!({"city":"sf","question":"Show age distribution","query_spec":{"dimension":"age","measure":"percentage","value":999}}),
    ] {
        let r = data_query::execute(&root(), request);
        assert_eq!(r["status"], "unsupported");
        assert!(r["answer"].is_null());
    }
}

#[test]
fn accepted_plan_is_deterministic_and_uses_full_denominator() {
    let request = json!({"city":"sf","question":"How many residents are female in San Francisco?",
        "query_spec":{"dimension":"sex","measure":"count","category":"female"}});
    let a = data_query::execute(&root(), request.clone());
    assert_eq!(a, data_query::execute(&root(), request));
    assert_eq!(a["status"], "ok");
    assert_eq!(a["method"]["raw_records"], 8485);
    assert_eq!(a["chart"]["series"].as_array().unwrap().len(), 1);
    assert!(
        a["answer_statistics"]["weighted_population"]
            .as_u64()
            .unwrap()
            > 256
    );
}

#[tokio::test]
async fn http_endpoint_needs_no_simulation_and_rejects_changed_source() {
    let dir = tempfile::tempdir().unwrap();
    let source = data_source::manifest("sf").unwrap();
    for name in [
        source["local_snapshot"].as_str().unwrap(),
        source["context"]["path"].as_str().unwrap(),
    ] {
        let to = dir.path().join(name);
        fs::create_dir_all(to.parent().unwrap()).unwrap();
        fs::copy(root().join(name), to).unwrap();
    }
    let app = data_query::router(dir.path().to_path_buf());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/data-query", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let client = reqwest::Client::new();
    let req = json!({"city":"sf","question":"Show age distribution"});
    let response: Value = client
        .post(&url)
        .json(&req)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(response["status"], "ok");
    for field in [
        "status",
        "question",
        "answer",
        "chart",
        "query_spec",
        "geography",
        "source",
        "method",
        "limitations",
    ] {
        assert!(response.get(field).is_some());
    }
    fs::write(
        dir.path().join(source["local_snapshot"].as_str().unwrap()),
        b"altered",
    )
    .unwrap();
    let response: Value = client
        .post(&url)
        .json(&req)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(response["status"], "unavailable");
    assert!(response["answer"].is_null());
    assert_eq!(response["source"]["verification_status"], "Unknown");
    let response: Value = client
        .post(&url)
        .header("content-type", "application/json")
        .body("{")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(response["status"], "unsupported");
    server.abort();
}

#[test]
fn actual_backend_responses_satisfy_frontend_contract() {
    use std::io::Write;
    use std::process::{Command, Stdio};
    let responses: Vec<Value> = data_source::CITY_IDS
        .iter()
        .flat_map(|city| {
            [
                "Show the education distribution",
                "Show the age distribution",
                "Who will win the next election?",
            ]
            .map(|question| data_query::execute(&root(), json!({"city":city,"question":question})))
        })
        .collect();
    let mut child = Command::new("node")
        .arg(root().join("frontend/tests/backend-data-contract.mjs"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("Node is required for the frontend/backend integration check");
    child
        .stdin
        .take()
        .unwrap()
        .write_all(&serde_json::to_vec(&responses).unwrap())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}
