# Verified demographic queries

`POST /data-query` tabulates every row of the selected committed PUMS snapshot.
It does not need a simulation, map, model, or provider key. The existing poll
endpoints still return simulated estimates; this endpoint returns ACS
survey-weighted demographic estimates. Neither is an exact census count.

Run the server from the workspace root, where the manifest's snapshot and context
paths resolve. `data_query::router(root)` is also available for an independent
Axum host. Runtime packaging must include the existing `data/*_pums.csv` files
and the five `crates/sim-core/data/verified/*_context.csv` files. Deployment
configuration is outside this change's scope.

## Request contract

```json
{
  "city": "sf",
  "question": "What percentage of residents are female?",
  "query_spec": {"dimension": "sex", "measure": "percentage", "category": "female"}
}
```

`city` is required: `sf`, `synth_la`, `neu_york`, `cybercago`, or `simami`.
`question` is required, with a 512-byte limit. `query_spec` is optional and, if
provided, must exactly match the allowlisted interpretation of the question.
Unknown fields, filters, SQL, custom bins, caller-supplied numbers, and conflicting
plans are rejected. No language model runs in this path.

For every dimension below, use `Show the <dimension> distribution` for percentages
or `Show population counts by <dimension>` for weighted counts:

| Question dimension | Query plan dimension | Source fields |
| --- | --- | --- |
| age | `age` | AGEP |
| recorded sex | `sex` | SEX |
| race and ethnicity | `race_ethnicity` | RAC1P and HISP |
| education | `education` | SCHL |
| income-to-poverty group | `income_to_poverty` | POVPIP |
| employment | `employment` | ESR |
| citizenship | `citizenship` | CIT |
| nativity | `nativity` | NATIVITY |
| marital status | `marital_status` | MAR |
| housing tenure | `tenure` | Joined housing TEN |

Selected-category forms include `How many residents are female?`,
`What percentage of residents are aged 18-24?`, and
`How many residents are living in owner-occupied housing?`. The complete strict
grammar and fixed categories are in `data_query.rs`. A matching city suffix such
as `in San Francisco` is allowed. Extra constraints are never silently dropped.
Gender identity, dollar income, predictions, other years, exact municipal totals,
household counts, official poverty/unemployment rates, and arbitrary subgroup
combinations are unsupported.

## Response contract

Every response contains `status`, `question`, `answer`, `chart`, `query_spec`,
`geography`, `source`, `method`, and `limitations`. A successful `status: "ok"`
response includes a bar chart with `type`, `title`, `unit` (`people` or `percent`),
and ordered `series` entries containing `key`, `label`, `value`,
`weighted_population`, `raw_records`, and `map_filter`. The schema 1.0 response
uses a readable `answer`; `answer_statistics` preserves the selected category's
numeric values or the full geography's weighted population and raw-record total.
`query_spec` includes the frontend mode, intent, universe, group_by and PWGTP
fields. Provenance fields are copied from the validated manifest into the shared
source/geography contract, with verification status `verified`. Historical
ingestion times and license remain unknown.

Map predicates use only exact existing resident segment categories. Age bars and
education bars for high school, some college, bachelor's and graduate degrees
match directly. The synthetic education segment combines under-3 records with
less-than-high-school records, so those two source bars have null map predicates
and show Unknown map counts. Other incompatible categories (including source
poverty bands versus synthetic income quintiles and observed versus simulated
tenure) likewise do not infer a map match. This does not alter source totals.

Counts are integer sums of PWGTP; percentages are
`100 * group PWGTP / all-row PWGTP`. Not-applicable groups remain visible and
included in the denominator. Raw records are survey observations, never synthetic
resident counts. Tenure counts people living in housing of that tenure, not
households, properties, or individual property owners. Hispanic ethnicity takes
precedence over race in the mutually exclusive race/ethnicity categories.

Unsupported or ambiguous requests return `status: "unsupported"`, `answer: null`,
and an empty series. Missing, unverified, or altered data returns
`status: "unavailable"`, no answer, and source verification `Unknown`.
The server hashes the exact bytes it parses against a compile-time manifest;
editing a runtime manifest cannot bless a changed snapshot.

## Provenance and reproduction

All five original person snapshots reproduce byte-for-byte from the official
[2023 ACS 1-year archives](https://www2.census.gov/programs-surveys/acs/data/pums/2023/1-Year/):
California, New York, Illinois, and Florida person files. Matching housing files
provide TEN. The complete positive-PWGTP PUMA subset is compared in source order,
across every retained column. This establishes the release by actual source
comparison, rather than guessing from identifiers or filenames.

`data/provenance/acs_pums.json` records per-city ZIP and extracted-CSV SHA-256,
snapshot and context SHA-256, official URLs, actual verification retrieval times,
PUMAs/state, transformations, and limitations. Original historical ingestion
timestamps remain unknown. The original transform collapsed blank numbers to zero;
the context files restore original POVPIP missingness and join housing TEN within
the same state/release, preserving every person key and source order.

```sh
# Fetch public Census archives and create fresh verification receipts.
# This writes provenance/context files, never the original person snapshots.
python3 crates/sim-core/tools/verify_pums.py --raw-dir /tmp/census-archives --download --write

# Recheck using already downloaded archives and receipts, without network.
python3 crates/sim-core/tools/verify_pums.py --raw-dir /tmp/census-archives

# Snapshot hashes are always tested; supplying raw archives also audits ZIP hashes.
SIMTRA_CENSUS_RAW_DIR=/tmp/census-archives cargo test --offline --workspace
```

The verifier marks failed source comparisons Unknown and exits unsuccessfully.
Raw state ZIPs are not committed. Their hashes and retrieval receipts support
reproduction; release contents or download packaging may change upstream.

Geography is the union of the listed 2020-definition PUMAs, which can include
substantial surrounding county population. Exact city-boundary equivalence is
not established. See the [Census PUMA guidance](https://www.census.gov/programs-surveys/geography/guidance/geo-areas/pumas.html)
and [2023 data dictionary](https://www2.census.gov/programs-surveys/acs/tech_docs/pums/data_dict/PUMS_Data_Dictionary_2023.txt).
These are 2023 estimates, not current population counts. Replicate weights were
not retained, so this endpoint supplies no margins of error or confidence intervals.
