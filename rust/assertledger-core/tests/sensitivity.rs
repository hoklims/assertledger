use assertledger_core::{
    decide_evidence, dispatch, replay_evidence_manifest, seal_manifest_artifact, select_candidates,
    verify_manifest_integrity,
};
use serde_json::{Value, json};

fn evidence() -> Value {
    serde_json::from_str(include_str!(
        "../../../conformance/v1/inputs/decide-verified.json"
    ))
    .unwrap()
}
fn target(input: &mut Value) -> &mut Value {
    input["observations"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|o| o["candidateId"] == "candidate" && o["worldId"] == "target")
        .unwrap()
}
#[test]
fn only_attributed_assertion_failures_kill() {
    for outcome in [
        "PASS",
        "COLLECTION_FAILURE",
        "COMPILE_FAILURE",
        "PROCESS_CRASH",
        "NO_TEST_DISCOVERED",
        "TIMEOUT",
        "INFRA_ERROR",
    ] {
        let mut input = evidence();
        target(&mut input)["outcome"] = json!(outcome);
        let result = decide_evidence(&input);
        assert_eq!(
            result["candidates"][0]["killedTargetIds"],
            json!([]),
            "{outcome}"
        );
        assert_ne!(result["decision"]["status"], "VERIFIED", "{outcome}");
        assert_eq!(
            result["candidates"][0]["status"],
            if ["TIMEOUT", "INFRA_ERROR"].contains(&outcome) {
                "INCONCLUSIVE"
            } else {
                "WEAK_ORACLE"
            }
        );
    }
    let mut input = evidence();
    target(&mut input)["attributed"] = json!(false);
    assert_eq!(
        decide_evidence(&input)["candidates"][0]["status"],
        "INVALID"
    );
}
#[test]
fn completeness_stability_discovery_and_controls() {
    let mut input = evidence();
    input["observations"].as_array_mut().unwrap().pop();
    let result = decide_evidence(&input);
    assert_eq!(result["candidates"][0]["status"], "INCONCLUSIVE");
    assert_eq!(result["candidates"][0]["gates"][1]["status"], "NOT_RUN");
    let mut input = evidence();
    let original = input["observations"].as_array().unwrap().clone();
    input["policy"]["requiredAttempts"] = json!(2);
    for mut run in original {
        run["attempt"] = json!(2);
        run["runId"] = json!(format!("{}:second", run["runId"].as_str().unwrap()));
        if run["candidateId"] == "candidate" && run["worldId"] == "target" {
            run["outcome"] = json!("PASS");
        }
        input["observations"].as_array_mut().unwrap().push(run);
    }
    assert_eq!(
        decide_evidence(&input)["candidates"][0]["status"],
        "UNSTABLE"
    );
    let mut input = evidence();
    let t = target(&mut input);
    t["outcome"] = json!("TIMEOUT");
    t["attributed"] = json!(false);
    t["candidateTestsDiscovered"] = json!(0);
    assert_eq!(
        decide_evidence(&input)["candidates"][0]["reasonCodes"],
        json!(["CANDIDATE_EXECUTION_INCONCLUSIVE"])
    );
    let mut input = evidence();
    input["observations"][0]["outcome"] = json!("COMPILE_FAILURE");
    assert_eq!(
        decide_evidence(&input)["decision"]["reasonCodes"],
        json!(["CONTROL_EVIDENCE_INVALID"])
    );
}
#[test]
fn projections_ignore_telemetry_only_for_decision_digest() {
    let input = evidence();
    let original = decide_evidence(&input);
    let mut changed = input.clone();
    target(&mut changed)["durationMs"] = json!(123.25);
    target(&mut changed)["exitCode"] = Value::Null;
    let changed = decide_evidence(&changed);
    assert_eq!(original["decisionDigest"], changed["decisionDigest"]);
    assert_ne!(original["artifactDigest"], changed["artifactDigest"]);
    assert_eq!(replay_evidence_manifest(&changed)["valid"], true);
    let mut forged = original.clone();
    forged["decision"]["status"] = json!("REJECTED");
    let forged = seal_manifest_artifact(&forged).unwrap();
    assert_eq!(
        verify_manifest_integrity(&forged)["artifactDigestValid"],
        true
    );
    assert_eq!(
        replay_evidence_manifest(&forged)["decisionSemanticsValid"],
        false
    );
    let mut reordered = input;
    reordered["worlds"].as_array_mut().unwrap().reverse();
    reordered["observations"].as_array_mut().unwrap().reverse();
    assert_eq!(decide_evidence(&reordered), original);
}
#[test]
fn selection_is_marginal_coverage_then_size_digest_id() {
    let candidates = json!([
        {"id":"big","digest":"b","sizeBytes":10,"status":"ELIGIBLE","killedTargetIds":["x","y","y"]},
        {"id":"first","digest":"a","sizeBytes":5,"status":"ELIGIBLE","killedTargetIds":["x","y"]},
        {"id":"extra","digest":"b","sizeBytes":1,"status":"ELIGIBLE","killedTargetIds":["z"]},
        {"id":"bad","digest":"a","sizeBytes":0,"status":"INVALID","killedTargetIds":["q","r","s"]}
    ]);
    assert_eq!(
        select_candidates(&candidates, &json!(3)),
        json!(["first", "extra"])
    );
    assert_eq!(select_candidates(&candidates, &json!(0)), json!([]));
    assert_eq!(select_candidates(&candidates, &json!(1.5)), json!([]));
}
#[test]
fn all_schema_versions_require_and_project_their_context() {
    for version in ["1.0.0", "2.0.0", "3.0.0", "4.0.0", "5.0.0"] {
        let mut input = evidence();
        input["schemaVersion"] = json!(version);
        input["evidenceContext"]["execution"]["backend"] =
            json!({"kind":"native","extra":"preserved"});
        input["evidenceContext"]["repository"] = json!({"includeDependencies":false,"omittedLinks":[],"git":null,"snapshot":"repository","include":[],"preservedLinkCount":2,"unboundedClosureEdges":[],"extra":"discarded"});
        input["extra"] = json!("discarded");
        let result = decide_evidence(&input);
        assert_eq!(result["decision"]["status"], "VERIFIED", "{version}");
        assert!(result.get("extra").is_none());
        assert_eq!(
            result["evidenceContext"]["execution"]
                .get("backend")
                .is_some(),
            version != "1.0.0"
        );
        assert_eq!(
            result["evidenceContext"].get("repository").is_some(),
            ["4.0.0", "5.0.0"].contains(&version)
        );
        if version == "4.0.0" {
            assert!(
                result["evidenceContext"]["repository"]
                    .get("snapshot")
                    .is_none()
            );
        }
        assert_eq!(replay_evidence_manifest(&result)["valid"], true);
        if version != "1.0.0" {
            input["evidenceContext"]["execution"]
                .as_object_mut()
                .unwrap()
                .remove("backend");
            assert_eq!(
                decide_evidence(&input)["decision"]["status"],
                "ENGINE_ERROR"
            );
        }
    }
}
#[test]
fn invalid_inputs_have_one_deterministic_manifest() {
    let invalid = decide_evidence(&Value::Null);
    assert_eq!(invalid["decision"]["status"], "ENGINE_ERROR");
    assert_eq!(verify_manifest_integrity(&invalid)["valid"], true);
    assert_eq!(
        replay_evidence_manifest(&invalid)["decisionSemanticsValid"],
        false
    );
    let mut inputs = Vec::new();
    let mut input = evidence();
    input["policy"]["requiredAttempts"] = json!(1001);
    inputs.push(input);
    let mut input = evidence();
    input["candidates"][0]["sizeBytes"] = json!(9_007_199_254_740_992_u64);
    inputs.push(input);
    let mut input = evidence();
    input["evidenceContext"]["engine"]["name"] = json!("😀".repeat(65));
    inputs.push(input);
    let mut input = evidence();
    input["observations"][0]["candidateTestsDiscovered"] = json!(10);
    inputs.push(input);
    let mut input = evidence();
    input["observations"][0]["runId"] = input["observations"][1]["runId"].clone();
    inputs.push(input);
    let mut input = evidence();
    input["schemaVersion"] = json!("5.0.0");
    input["evidenceContext"]["execution"]["backend"] = json!({});
    input["evidenceContext"]["repository"] = json!({"includeDependencies":true,"omittedLinks":["b","a"],"git":null,"snapshot":"repository","include":[],"preservedLinkCount":0,"unboundedClosureEdges":[]});
    inputs.push(input);
    for input in inputs {
        assert_eq!(decide_evidence(&input), invalid);
    }
    assert!(dispatch("notImplemented", &[Value::Null]).is_err());
}
