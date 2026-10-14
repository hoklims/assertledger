use assertledger_core::{
    create_agentic_benchmark, create_agentic_profile, decide_evidence, replay_agentic_benchmark,
    replay_agentic_profile, seal_manifest_artifact, sha256_canonical,
};
use serde_json::{Value, json};
fn profile() -> Value {
    serde_json::from_str(include_str!(
        "../../../conformance/v1/inputs/create-profile-v1-qualified.json"
    ))
    .unwrap()
}
fn benchmark() -> Value {
    serde_json::from_str(include_str!(
        "../../../conformance/v1/inputs/create-benchmark-v1-measured.json"
    ))
    .unwrap()
}
fn seal(v: &mut Value, key: &str) {
    v.as_object_mut().unwrap().remove(key);
    v[key] = json!(sha256_canonical(v));
}
#[test]
fn profile_valid_replay_and_resealed_forgery() {
    let report = create_agentic_profile(&profile()).unwrap();
    assert_eq!(replay_agentic_profile(&report)["valid"], true);
    let mut forged = report.clone();
    forged["candidates"][0]["latency"]["p95Ms"] = json!(0);
    seal(&mut forged, "reportDigest");
    let replay = replay_agentic_profile(&forged);
    assert_eq!(replay["reportDigestValid"], true);
    assert_eq!(replay["schemaValid"], true);
    assert_eq!(replay["semanticsValid"], false);
    let mut malformed = report;
    malformed["candidates"][0]["unexpected"] = json!(true);
    seal(&mut malformed, "reportDigest");
    assert_eq!(replay_agentic_profile(&malformed)["schemaValid"], false);
}
#[test]
fn profile_rejects_strict_shape_source_and_policy_failures() {
    let mut input = profile();
    input["unexpected"] = json!(true);
    assert_eq!(
        create_agentic_profile(&input).unwrap_err(),
        "AGENTIC_PROFILE_REQUEST_INVALID"
    );
    let mut input = profile();
    input["policy"]["lanes"] = json!([
        {"id":"larger","maximumReferenceP95Ms":20},
        {"id":"smaller","maximumReferenceP95Ms":10}
    ]);
    assert_eq!(
        create_agentic_profile(&input).unwrap_err(),
        "AGENTIC_PROFILE_POLICY_INVALID"
    );
    let mut input = profile();
    input["manifest"]["observations"][0]["durationMs"] = json!(456);
    assert_eq!(
        create_agentic_profile(&input).unwrap_err(),
        "AGENTIC_PROFILE_SOURCE_INVALID"
    );
    let mut input = profile();
    input["manifest"]["evidenceContext"]["adapter"]["name"] = json!("bun-test");
    assert_eq!(
        create_agentic_profile(&input).unwrap_err(),
        "EVIDENCE_MANIFEST_INCONSISTENT"
    );
    let mut input = profile();
    input["policy"]["minimumTimingSamples"] = json!(2);
    assert_eq!(
        create_agentic_profile(&input).unwrap()["status"],
        "INSUFFICIENT_TIMING_EVIDENCE"
    );
    let mut input = profile();
    input["policy"]["lanes"] = json!([{"id":"tiny","maximumReferenceP95Ms":1}]);
    let report = create_agentic_profile(&input).unwrap();
    assert_eq!(report["status"], "BUDGET_MISSED");
    assert_eq!(report["candidates"][0]["paretoFrontier"], true);
    assert_eq!(report["portfolios"][0]["selectedCandidateIds"], json!([]));
}
#[test]
fn benchmark_valid_replay_sorting_and_forgery() {
    let request = benchmark();
    let artifact = create_agentic_benchmark(&request).unwrap();
    assert_eq!(replay_agentic_benchmark(&artifact)["valid"], true);
    let mut reordered = request;
    reordered["runs"].as_array_mut().unwrap().reverse();
    assert_eq!(create_agentic_benchmark(&reordered).unwrap(), artifact);
    let mut forged = artifact.clone();
    forged["summaries"][0]["wall"]["total"]["p95Us"] = json!(1);
    seal(&mut forged, "artifactDigest");
    let replay = replay_agentic_benchmark(&forged);
    assert_eq!(replay["artifactDigestValid"], true);
    assert_eq!(replay["summarySemanticsValid"], false);
    let mut malformed = artifact;
    malformed["runs"][0]["unexpected"] = json!(true);
    assert_eq!(replay_agentic_benchmark(&malformed)["schemaValid"], false);
}
#[test]
fn benchmark_preserves_cpu_availability_and_failures() {
    let mut request = benchmark();
    request["runs"][0]["cpuTimeUs"] = json!(5);
    let artifact = create_agentic_benchmark(&request).unwrap();
    assert_eq!(artifact["summaries"][0]["cpu"]["availability"], "PARTIAL");
    assert!(artifact["summaries"][0]["cpu"]["quantiles"].is_null());
    for run in request["runs"].as_array_mut().unwrap() {
        run["cpuTimeUs"] = json!(5);
    }
    let artifact = create_agentic_benchmark(&request).unwrap();
    assert_eq!(artifact["summaries"][0]["cpu"]["availability"], "COMPLETE");
    assert_eq!(artifact["summaries"][0]["cpu"]["quantiles"]["p95Us"], 5);
    let mut request = benchmark();
    let run = &mut request["runs"][3];
    assert_eq!(run["role"], "WARMUP");
    run["status"] = json!("INCOMPLETE");
    run["outcome"] = json!("TIMEOUT");
    run["phases"] = Value::Null;
    run["totalUs"] = Value::Null;
    run["cpuTimeUs"] = Value::Null;
    let artifact = create_agentic_benchmark(&request).unwrap();
    assert_eq!(artifact["summaries"][1]["status"], "OBSERVED_RUN_FAILURE");
    assert_eq!(artifact["summaries"][1]["counters"]["failed"], 1);
    assert_eq!(artifact["summaries"][1]["counters"]["accepted"], 3);
    assert_eq!(replay_agentic_benchmark(&artifact)["valid"], true);
}
#[test]
fn benchmark_rejects_contract_and_binding_failures() {
    let mut request = benchmark();
    request["unexpected"] = json!(true);
    assert_eq!(
        create_agentic_benchmark(&request).unwrap_err(),
        "AGENTIC_BENCHMARK_REQUEST_INVALID"
    );
    let mut request = benchmark();
    request["policy"]["maximumExecutions"] = json!(1);
    assert_eq!(
        create_agentic_benchmark(&request).unwrap_err(),
        "AGENTIC_BENCHMARK_EXECUTION_BUDGET_EXCEEDED"
    );
    let mut request = benchmark();
    let tool = request["fingerprint"]["tools"][0].clone();
    request["fingerprint"]["tools"]
        .as_array_mut()
        .unwrap()
        .push(tool);
    assert_eq!(
        create_agentic_benchmark(&request).unwrap_err(),
        "AGENTIC_BENCHMARK_DUPLICATE_TOOL_ROLE"
    );
    let mut request = benchmark();
    request["runs"][0]["role"] = json!("WARMUP");
    assert_eq!(
        create_agentic_benchmark(&request).unwrap_err(),
        "AGENTIC_BENCHMARK_COLD_WARMUP_FORBIDDEN"
    );
    let mut request = benchmark();
    request["runs"][0]["phases"]
        .as_array_mut()
        .unwrap()
        .reverse();
    assert_eq!(
        create_agentic_benchmark(&request).unwrap_err(),
        "AGENTIC_BENCHMARK_TIMING_INVALID"
    );
    let mut request = benchmark();
    request["runs"][0]["ordinal"] = json!(2);
    assert_eq!(
        create_agentic_benchmark(&request).unwrap_err(),
        "AGENTIC_BENCHMARK_ORDINALS_INVALID"
    );
    let mut request = benchmark();
    request["runs"][0]["candidateDigest"] = json!(format!("sha256:{}", "0".repeat(64)));
    assert_eq!(
        create_agentic_benchmark(&request).unwrap_err(),
        "AGENTIC_BENCHMARK_CANDIDATE_DIGEST_MISMATCH"
    );
    let mut request = benchmark();
    request["runs"].as_array_mut().unwrap().pop();
    assert_eq!(
        create_agentic_benchmark(&request).unwrap_err(),
        "AGENTIC_BENCHMARK_RUN_PLAN_INVALID"
    );
    let mut request = benchmark();
    request["referenceWorldId"] = json!("target");
    assert_eq!(
        create_agentic_benchmark(&request).unwrap_err(),
        "AGENTIC_BENCHMARK_SOURCE_BINDING_INVALID"
    );
}

#[test]
fn profile_portfolio_uses_marginal_weight_per_cost() {
    let mut request = profile();
    let source = request["manifest"].clone();
    let mut input = source.clone();
    input["policy"]["minimumTargetWeightPermille"] = json!(500);
    input["policy"]["maximumSelectedCandidates"] = json!(2);
    let mut second = input["candidates"][0].clone();
    second["id"] = json!("second");
    second["sizeBytes"] = json!(200);
    input["candidates"].as_array_mut().unwrap().push(second);
    let observations = input["observations"].as_array().unwrap().clone();
    for id in ["left", "right"] {
        let mut world = input["worlds"]
            .as_array()
            .unwrap()
            .iter()
            .find(|w| w["kind"] == "TARGET")
            .unwrap()
            .clone();
        world["id"] = json!(id);
        world["required"] = json!(false);
        input["worlds"].as_array_mut().unwrap().push(world);
        let mut context = input["evidenceContext"]["worlds"]
            .as_array()
            .unwrap()
            .iter()
            .find(|w| w["id"] == "target")
            .unwrap()
            .clone();
        context["id"] = json!(id);
        input["evidenceContext"]["worlds"]
            .as_array_mut()
            .unwrap()
            .push(context);
        for original in observations.iter().filter(|o| o["worldId"] == "target") {
            let mut run = original.clone();
            run["worldId"] = json!(id);
            run["runId"] = json!(format!("{}:{id}", run["runId"].as_str().unwrap()));
            if !run["candidateId"].is_null() && id == "right" {
                run["outcome"] = json!("PASS");
            }
            input["observations"].as_array_mut().unwrap().push(run);
        }
    }
    let first_runs = input["observations"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|o| o["candidateId"] == "candidate")
        .cloned()
        .collect::<Vec<_>>();
    for mut run in first_runs {
        run["candidateId"] = json!("second");
        run["runId"] = json!(format!("second:{}", run["runId"].as_str().unwrap()));
        if run["worldId"] == "reference" {
            run["durationMs"] = json!(5);
        }
        if run["worldId"] == "left" {
            run["outcome"] = json!("PASS");
        }
        if run["worldId"] == "right" {
            run["outcome"] = json!("ASSERTION_FAILURE");
        }
        input["observations"].as_array_mut().unwrap().push(run);
    }
    let mut manifest = decide_evidence(&input);
    for key in ["adapter", "isolation", "limitations"] {
        manifest[key] = source[key].clone();
    }
    request["manifest"] = seal_manifest_artifact(&manifest).unwrap();
    let report = create_agentic_profile(&request).unwrap();
    assert_eq!(
        report["qualifiedCandidateIds"],
        json!(["candidate", "second"])
    );
    assert_eq!(report["candidates"][0]["marginalTargetWeight"], 20);
    assert_eq!(report["candidates"][1]["marginalTargetWeight"], 10);
    assert_eq!(
        report["portfolios"][0]["selectedCandidateIds"],
        json!(["second", "candidate"])
    );
    assert_eq!(report["portfolios"][0]["totalReferenceP95Ms"], 15);
    assert_eq!(report["portfolios"][0]["targetWeight"], 30);
    assert_eq!(replay_agentic_profile(&report)["valid"], true);
}
