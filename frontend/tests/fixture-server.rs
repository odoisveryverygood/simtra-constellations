// Local-only integration fixture helper. See INTEGRATION-EVIDENCE.md.
#[tokio::main]
async fn main() {
    let fixture = axum::Router::new().route("/openai/v1/responses", axum::routing::post(|axum::Json(body): axum::Json<serde_json::Value>| async move {
        let dist = if body.to_string().contains("Parks") { vec![0.5, 0.3, 0.2] } else { vec![0.6, 0.4] };
        let rows = vec![serde_json::json!({"p_yes": 0.6, "dist": dist, "why": "Deterministic local fixture response; not a model prediction or observed opinion."}); 12];
        axum::Json(serde_json::json!({"output_text": serde_json::to_string(&rows).unwrap()}))
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let model_url = format!("http://{}/openai/v1", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, fixture).await.unwrap(); });
    std::env::set_var("MODEL_OFFLINE", "0");
    std::env::set_var("MODEL_API_KEY", "local-fixture");
    std::env::set_var("OPENAI_API_URL", &model_url);
    for key in ["ANTHROPIC_API_KEY", "GEMINI_API_KEY", "HYDRA_DB_KEY", "HYDRA_DB_API_KEY", "SF_PUMS_PATH", "INSFORGE_API_KEY", "INSFORGE_ADMIN_KEY", "ROCKETRIDE_WEBHOOK_URL", "ROCKETRIDE_URL", "NEWS_API_KEY", "NEWS_REFRESH_HOURS"] { std::env::remove_var(key); }
    let dir = std::env::var("SIMTRA_FIXTURE_DIR").expect("temporary fixture directory");
    let cache = format!("{dir}/cache.db");
    let store = format!("{dir}/state.db");
    let mut state = simfrancisco::api::build_state("tiles.db", Some(&cache), &store).unwrap();
    state.hydra = None; state.engine.hydra = None; state.insforge = None; state.rocketride = None;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:5188").await.unwrap();
    println!("Local fixture API listening on 5188");
    axum::serve(listener, simfrancisco::api::router(state)).await.unwrap();
}
