//! Verified, complete ACS rows. This module never builds or reads a Population.
use anyhow::{anyhow, bail, ensure, Context, Result};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{collections::HashSet, fs, path::Path};

pub const MANIFEST: &str = include_str!("../../../data/provenance/acs_pums.json");
pub const CITY_IDS: [&str; 5] = ["sf", "neu_york", "synth_la", "cybercago", "simami"];

#[derive(Clone, Debug)]
pub struct PersonRow {
    pub weight: u64,
    pub age: u8,
    pub sex: u8,
    pub race: u8,
    pub hispanic: u16,
    pub education: u8,
    pub employment: u8,
    pub citizenship: u8,
    pub nativity: u8,
    pub marital: u8,
    pub poverty: Option<u16>,
    pub tenure: Option<u8>,
}

pub struct Dataset {
    pub rows: Vec<PersonRow>,
    pub source: Value,
}

pub fn manifest(city: &str) -> Result<Value> {
    ensure!(CITY_IDS.contains(&city), "unsupported city");
    let manifest: Value = serde_json::from_str(MANIFEST)?;
    manifest["cities"]
        .as_array()
        .and_then(|cities| cities.iter().find(|entry| entry["city"] == city))
        .cloned()
        .ok_or_else(|| anyhow!("city provenance missing"))
}

pub fn sha256(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

pub fn load(root: &Path, city: &str) -> Result<Dataset> {
    let source = manifest(city)?;
    ensure!(
        source["verification_status"] == "Verified",
        "source is Unknown"
    );
    // Paths come from the compile-time manifest, never from request input.
    let snapshot =
        fs::read(root.join(source["local_snapshot"].as_str().context("snapshot path")?))?;
    let context = fs::read(root.join(source["context"]["path"].as_str().context("context path")?))?;
    from_bytes(source, &snapshot, &context)
}

/// Verify the exact bytes consumed by the parser, avoiding a hash/read race.
/// Exposed for offline integrity tests and command-line callers.
pub fn from_bytes(source: Value, snapshot: &[u8], context: &[u8]) -> Result<Dataset> {
    ensure!(
        source["verification_status"] == "Verified",
        "source is Unknown"
    );
    ensure!(
        source["provider"] == "U.S. Census Bureau" && source["dataset"] == "ACS PUMS",
        "invalid source"
    );
    ensure!(source["weight_field"] == "PWGTP", "invalid weight field");
    ensure!(
        source["vintage"] == "2023" && source["series"] == "1-year",
        "release metadata is Unknown"
    );
    let state = match source["geographic_coverage"]["state_fips"].as_str() {
        Some("06") => "ca",
        Some("36") => "ny",
        Some("17") => "il",
        Some("12") => "fl",
        _ => bail!("state metadata is Unknown"),
    };
    for (provenance, kind) in [(&source, "p"), (&source["context"]["housing_source"], "h")] {
        let expected = format!("https://www2.census.gov/programs-surveys/acs/data/pums/2023/1-Year/csv_{kind}{state}.zip");
        ensure!(
            provenance["official_download_url"] == expected,
            "official download metadata is Unknown"
        );
        chrono::DateTime::parse_from_rfc3339(
            provenance["retrieved_at"]
                .as_str()
                .context("retrieval time is Unknown")?,
        )?;
        for field in ["raw_source_sha256", "raw_csv_sha256"] {
            let hash = provenance[field]
                .as_str()
                .context("source hash is Unknown")?;
            ensure!(
                hash.len() == 64 && hex::decode(hash)?.len() == 32,
                "invalid source hash"
            );
        }
    }
    ensure!(
        source["filtered_snapshot_sha256"] == sha256(snapshot),
        "snapshot hash mismatch"
    );
    ensure!(
        source["context"]["sha256"] == sha256(context),
        "context hash mismatch"
    );
    let expected_rows = source["raw_records"]
        .as_u64()
        .context("row count missing")? as usize;
    ensure!(expected_rows > 0, "empty source");
    let pumas: HashSet<u32> = source["geographic_coverage"]["pumas"]
        .as_array()
        .context("PUMAs missing")?
        .iter()
        .map(|p| p.as_u64().map(|n| n as u32).context("invalid PUMA"))
        .collect::<Result<_>>()?;
    let mut records = std::str::from_utf8(snapshot)?.lines();
    let mut extras = std::str::from_utf8(context)?.lines();
    ensure!(
        records.next() == Some(crate::pums::KEEP_COLS.join(",").as_str()),
        "invalid snapshot header"
    );
    ensure!(
        extras.next() == Some("SERIALNO,SPORDER,POVPIP,TEN,TYPEHUGQ"),
        "invalid context header"
    );
    let mut rows = Vec::with_capacity(expected_rows);
    let mut keys = HashSet::new();
    for line in records {
        let cells: Vec<&str> = line.split(',').collect();
        ensure!(cells.len() == 18, "invalid person row");
        let extra: Vec<&str> = extras
            .next()
            .context("missing joined person row")?
            .split(',')
            .collect();
        ensure!(extra.len() == 5, "invalid context row");
        ensure!(
            cells[0] == extra[0] && cells[1] == extra[1],
            "person join mismatch"
        );
        ensure!(keys.insert((cells[0], cells[1])), "duplicate person row");
        let number =
            |i: usize| -> Result<u16> { Ok(cells[i].parse().context("invalid PUMS integer")?) };
        let puma: u32 = cells[16].parse()?;
        ensure!(pumas.contains(&puma), "row outside manifest geography");
        let weight = cells[2].parse::<u64>()?;
        ensure!((1..=9999).contains(&weight), "invalid PWGTP");
        let optional = |s: &str| -> Result<Option<u16>> {
            if s.is_empty() {
                Ok(None)
            } else {
                Ok(Some(s.parse()?))
            }
        };
        let poverty = optional(extra[2])?;
        ensure!(
            poverty.unwrap_or(0) == number(9)? && poverty.unwrap_or(0) <= 501,
            "invalid POVPIP restoration"
        );
        let tenure = optional(extra[3])?;
        match (tenure, extra[4]) {
            (Some(1..=4), "1") | (None, "2" | "3") => (),
            _ => bail!("invalid housing tenure/GQ join"),
        }
        let age = number(3)?;
        let sex = number(4)?;
        let race = number(5)?;
        let hispanic = number(6)?;
        let education = number(7)?;
        let employment = number(12)?;
        let citizenship = number(13)?;
        let marital = number(14)?;
        let nativity = number(15)?;
        ensure!(
            age <= 99 && (1..=2).contains(&sex) && (1..=9).contains(&race),
            "invalid demographics"
        );
        ensure!(
            (1..=24).contains(&hispanic) && education <= 24 && employment <= 6,
            "invalid categories"
        );
        ensure!(
            (1..=5).contains(&citizenship)
                && (1..=5).contains(&marital)
                && (1..=2).contains(&nativity),
            "invalid categories"
        );
        rows.push(PersonRow {
            weight,
            age: age as u8,
            sex: sex as u8,
            race: race as u8,
            hispanic,
            education: education as u8,
            employment: employment as u8,
            citizenship: citizenship as u8,
            nativity: nativity as u8,
            marital: marital as u8,
            poverty,
            tenure: tenure.map(|n| n as u8),
        });
    }
    ensure!(extras.next().is_none(), "extra joined person rows");
    ensure!(
        rows.len() == expected_rows && source["context"]["raw_records"] == expected_rows,
        "row count mismatch"
    );
    Ok(Dataset { rows, source })
}
