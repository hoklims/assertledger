use crate::profile_contracts::{a, manifest_consistent, n, normalize, ordinal, s, validate};
use crate::{canonicalize, replay_evidence_manifest, sha256_canonical};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
const PHASES: [&str; 4] = [
    "PREPARATION",
    "STARTUP",
    "COMPILE_OR_COLLECTION",
    "EXECUTION",
];

fn inputs_valid(request: &Value) -> Result<(), String> {
    let manifest = &request["sourceManifest"];
    manifest_consistent(manifest)?;
    let selected = a(&manifest["decision"]["selectedCandidateIds"])
        .iter()
        .map(|id| a(&manifest["candidates"]).iter().find(|c| c["id"] == *id))
        .collect::<Vec<_>>();
    if selected.iter().any(Option::is_none) {
        return Err("AGENTIC_BENCHMARK_SOURCE_BINDING_INVALID".into());
    }
    let selected = selected.into_iter().flatten().collect::<Vec<_>>();
    let policy = &request["policy"];
    let planned = n(&policy["coldMeasuredSamples"])
        + n(&policy["warmupSamples"])
        + n(&policy["warmMeasuredSamples"]);
    if selected.len() as f64 * planned > n(&policy["maximumExecutions"]) {
        return Err("AGENTIC_BENCHMARK_EXECUTION_BUDGET_EXCEEDED".into());
    }
    let mut roles = HashSet::new();
    for tool in a(&request["fingerprint"]["tools"]) {
        if !roles.insert(s(&tool["role"])) {
            return Err("AGENTIC_BENCHMARK_DUPLICATE_TOOL_ROLE".into());
        }
    }
    let mut groups = HashMap::<String, Vec<f64>>::new();
    for run in a(&request["runs"]) {
        if run["regime"] == "COLD" && run["role"] == "WARMUP" {
            return Err("AGENTIC_BENCHMARK_COLD_WARMUP_FORBIDDEN".into());
        }
        if run["status"] == "COMPLETE" {
            let phases = a(&run["phases"]);
            let total = phases.iter().map(|p| n(&p["durationUs"])).sum::<f64>();
            if phases
                .iter()
                .enumerate()
                .any(|(index, p)| p["phase"] != PHASES[index])
                || total > 9_007_199_254_740_991.0
                || n(&run["totalUs"]) != total
            {
                return Err("AGENTIC_BENCHMARK_TIMING_INVALID".into());
            }
        }
        groups
            .entry(format!(
                "{}\0{}\0{}",
                s(&run["candidateId"]),
                s(&run["regime"]),
                s(&run["role"])
            ))
            .or_default()
            .push(n(&run["ordinal"]));
    }
    for ordinals in groups.values_mut() {
        ordinals.sort_by(f64::total_cmp);
        if ordinals
            .iter()
            .enumerate()
            .any(|(index, v)| *v != (index + 1) as f64)
        {
            return Err("AGENTIC_BENCHMARK_ORDINALS_INVALID".into());
        }
    }
    for run in a(&request["runs"]) {
        let candidate = selected.iter().find(|c| c["id"] == run["candidateId"]);
        if candidate.is_none_or(|c| c["status"] != "ELIGIBLE") {
            return Err("AGENTIC_BENCHMARK_SUBJECT_INVALID".into());
        }
        if candidate.unwrap()["digest"] != run["candidateDigest"] {
            return Err("AGENTIC_BENCHMARK_CANDIDATE_DIGEST_MISMATCH".into());
        }
    }
    for candidate in selected {
        if candidate["status"] != "ELIGIBLE" {
            return Err("AGENTIC_BENCHMARK_SUBJECT_INVALID".into());
        }
        let runs = a(&request["runs"])
            .iter()
            .filter(|r| r["candidateId"] == candidate["id"])
            .collect::<Vec<_>>();
        if runs.iter().filter(|r| r["regime"] == "COLD").count() as f64
            != n(&policy["coldMeasuredSamples"])
            || runs
                .iter()
                .filter(|r| r["regime"] == "WARM" && r["role"] == "WARMUP")
                .count() as f64
                != n(&policy["warmupSamples"])
            || runs
                .iter()
                .filter(|r| r["regime"] == "WARM" && r["role"] == "MEASUREMENT")
                .count() as f64
                != n(&policy["warmMeasuredSamples"])
        {
            return Err("AGENTIC_BENCHMARK_RUN_PLAN_INVALID".into());
        }
    }
    Ok(())
}
fn binding_valid(request: &Value) -> bool {
    let m = &request["sourceManifest"];
    m["decision"]["status"] == "VERIFIED"
        && a(&m["worlds"]).iter().any(|w| {
            w["id"] == request["referenceWorldId"]
                && w["kind"] == "REFERENCE"
                && w["required"] == true
        })
        && a(&m["evidenceContext"]["worlds"])
            .iter()
            .any(|w| w["id"] == request["referenceWorldId"])
        && a(&m["decision"]["selectedCandidateIds"]).iter().all(|id| {
            a(&m["candidates"])
                .iter()
                .any(|c| c["id"] == *id && c["status"] == "ELIGIBLE")
        })
}
fn scope(request: &Value) -> Result<Value, String> {
    let world = a(&request["sourceManifest"]["evidenceContext"]["worlds"])
        .iter()
        .find(|w| w["id"] == request["referenceWorldId"])
        .ok_or("AGENTIC_BENCHMARK_REFERENCE_WORLD_INVALID")?;
    Ok(
        json!({"environmentId":request["fingerprint"]["environmentId"],"fingerprintDigest":sha256_canonical(&request["fingerprint"]),"protocolDigest":sha256_canonical(&request["protocol"]),"sourceDecisionDigest":request["sourceManifest"]["decisionDigest"],"referenceWorldId":request["referenceWorldId"],"referenceWorldDigest":world["digest"]}),
    )
}
fn run_cmp(left: &Value, right: &Value) -> std::cmp::Ordering {
    let regime = |v: &Value| if v["regime"] == "COLD" { 0 } else { 1 };
    let role = |v: &Value| if v["role"] == "WARMUP" { 0 } else { 1 };
    ordinal(s(&left["candidateId"]), s(&right["candidateId"]))
        .then_with(|| regime(left).cmp(&regime(right)))
        .then_with(|| role(left).cmp(&role(right)))
        .then_with(|| n(&left["ordinal"]).total_cmp(&n(&right["ordinal"])))
}
fn quantiles(mut values: Vec<f64>) -> Value {
    if values.is_empty() {
        return Value::Null;
    }
    values.sort_by(f64::total_cmp);
    let len = values.len();
    json!({"minimumUs":values[0],"p50Us":values[(0.5*len as f64).ceil() as usize-1],"p95Us":values[(0.95*len as f64).ceil() as usize-1],"maximumUs":values[len-1]})
}
fn summaries(request: &Value) -> Value {
    let manifest = &request["sourceManifest"];
    let selected = a(&manifest["decision"]["selectedCandidateIds"]);
    let mut candidates = a(&manifest["candidates"])
        .iter()
        .filter(|c| selected.contains(&c["id"]))
        .collect::<Vec<_>>();
    candidates.sort_by(|a, b| ordinal(s(&a["id"]), s(&b["id"])));
    let mut result = Vec::new();
    for candidate in candidates {
        for regime in ["COLD", "WARM"] {
            let runs = a(&request["runs"])
                .iter()
                .filter(|r| r["candidateId"] == candidate["id"] && r["regime"] == regime)
                .collect::<Vec<_>>();
            let measured = runs
                .iter()
                .filter(|r| r["role"] == "MEASUREMENT")
                .copied()
                .collect::<Vec<_>>();
            let accepted = measured
                .iter()
                .filter(|r| r["status"] == "COMPLETE")
                .copied()
                .collect::<Vec<_>>();
            let failed = runs.iter().filter(|r| r["status"] == "INCOMPLETE").count();
            let status = if failed > 0 {
                "OBSERVED_RUN_FAILURE"
            } else if (accepted.len() as f64)
                < n(&request["policy"]["minimumMeasuredSamplesPerRegime"])
            {
                "INSUFFICIENT_SAMPLES"
            } else {
                "MEASURED"
            };
            let cpu = accepted
                .iter()
                .filter_map(|r| r["cpuTimeUs"].as_f64())
                .collect::<Vec<_>>();
            let availability = if cpu.is_empty() {
                "UNAVAILABLE"
            } else if cpu.len() == accepted.len() {
                "COMPLETE"
            } else {
                "PARTIAL"
            };
            let phases = PHASES
                .iter()
                .map(|name| {
                    (
                        (*name).to_owned(),
                        quantiles(
                            accepted
                                .iter()
                                .map(|r| {
                                    n(&a(&r["phases"])
                                        .iter()
                                        .find(|p| p["phase"] == *name)
                                        .unwrap()["durationUs"])
                                })
                                .collect(),
                        ),
                    )
                })
                .collect::<serde_json::Map<_, _>>();
            result.push(json!({"candidateId":candidate["id"],"candidateDigest":candidate["digest"],"regime":regime,"status":status,"counters":{"planned":request["policy"][if regime=="COLD" {"coldMeasuredSamples"} else {"warmMeasuredSamples"}],"recorded":measured.len(),"accepted":accepted.len(),"failed":failed,"warmup":runs.iter().filter(|r|r["role"]=="WARMUP").count()},"wall":{"total":quantiles(accepted.iter().map(|r|n(&r["totalUs"])).collect()),"phases":phases},"cpu":{"availability":availability,"quantiles":if availability=="COMPLETE" {quantiles(cpu)} else {Value::Null}}}));
        }
    }
    json!(result)
}
pub fn create_agentic_benchmark(request: &Value) -> Result<Value, String> {
    validate(
        request,
        "benchmark-request",
        "AGENTIC_BENCHMARK_REQUEST_INVALID",
    )?;
    inputs_valid(request)?;
    if replay_evidence_manifest(&request["sourceManifest"])["valid"] != true {
        return Err("AGENTIC_BENCHMARK_SOURCE_INVALID".into());
    }
    if !binding_valid(request) {
        return Err("AGENTIC_BENCHMARK_SOURCE_BINDING_INVALID".into());
    }
    let mut runs = a(&request["runs"]).to_vec();
    runs.sort_by(run_cmp);
    let mut normalized = request.clone();
    normalized["runs"] = json!(runs);
    let mut artifact = json!({"schemaVersion":"1.0.0","sourceManifest":request["sourceManifest"],"sourceArtifactDigest":request["sourceManifest"]["artifactDigest"],"sourceDecisionDigest":request["sourceManifest"]["decisionDigest"],"referenceWorldId":request["referenceWorldId"],"policy":request["policy"],"protocol":request["protocol"],"fingerprint":request["fingerprint"],"policyDigest":sha256_canonical(&request["policy"]),"protocolDigest":sha256_canonical(&request["protocol"]),"fingerprintDigest":sha256_canonical(&request["fingerprint"]),"comparisonScopeDigest":sha256_canonical(&scope(request)?),"runs":runs,"summaries":summaries(&normalized),"limitations":["UNSANDBOXED measurements are trusted-local operational evidence.","Benchmark comparisons are valid only within the declared comparison scope.","Observed timings do not alter the source TestForge VERIFIED decision."]});
    normalize(&mut artifact);
    artifact["artifactDigest"] = json!(sha256_canonical(&artifact));
    Ok(artifact)
}
pub fn replay_agentic_benchmark(artifact: &Value) -> Value {
    let invalid = json!({"valid":false,"schemaValid":false,"sourceManifestValid":false,"sourceBindingValid":false,"policyDigestValid":false,"protocolDigestValid":false,"fingerprintDigestValid":false,"comparisonScopeDigestValid":false,"artifactDigestValid":false,"summarySemanticsValid":false});
    if validate(
        artifact,
        "benchmark-artifact",
        "AGENTIC_BENCHMARK_ARTIFACT_INVALID",
    )
    .is_err()
    {
        return invalid;
    }
    let request = json!({"schemaVersion":artifact["schemaVersion"],"sourceManifest":artifact["sourceManifest"],"referenceWorldId":artifact["referenceWorldId"],"policy":artifact["policy"],"protocol":artifact["protocol"],"fingerprint":artifact["fingerprint"],"runs":artifact["runs"]});
    if inputs_valid(&request).is_err() {
        return invalid;
    }
    let mut summary_keys = HashSet::new();
    if a(&artifact["summaries"])
        .iter()
        .any(|v| !summary_keys.insert((s(&v["candidateId"]), s(&v["regime"]))))
    {
        return invalid;
    }
    let source = replay_evidence_manifest(&artifact["sourceManifest"])["valid"] == true;
    let binding = binding_valid(&request)
        && artifact["sourceArtifactDigest"] == artifact["sourceManifest"]["artifactDigest"]
        && artifact["sourceDecisionDigest"] == artifact["sourceManifest"]["decisionDigest"];
    let policy = artifact["policyDigest"] == sha256_canonical(&artifact["policy"]);
    let protocol = artifact["protocolDigest"] == sha256_canonical(&artifact["protocol"]);
    let fingerprint = artifact["fingerprintDigest"] == sha256_canonical(&artifact["fingerprint"]);
    let comparison = scope(&request)
        .is_ok_and(|scope| artifact["comparisonScopeDigest"] == sha256_canonical(&scope));
    let mut projection = artifact.clone();
    projection.as_object_mut().unwrap().remove("artifactDigest");
    let digest = artifact["artifactDigest"] == sha256_canonical(&projection);
    let semantics = create_agentic_benchmark(&request).is_ok_and(|expected| {
        ["runs", "summaries", "limitations"]
            .iter()
            .all(|key| canonicalize(&artifact[*key]) == canonicalize(&expected[*key]))
    });
    json!({"valid":source && binding && policy && protocol && fingerprint && comparison && digest && semantics,"schemaValid":true,"sourceManifestValid":source,"sourceBindingValid":binding,"policyDigestValid":policy,"protocolDigestValid":protocol,"fingerprintDigestValid":fingerprint,"comparisonScopeDigestValid":comparison,"artifactDigestValid":digest,"summarySemanticsValid":semantics})
}
