use crate::profile_contracts::{a, manifest_consistent, n, normalize, ordinal, s, validate};
use crate::{canonicalize, replay_evidence_manifest, sha256_canonical};
use serde_json::{Value, json};
use std::{cmp::Ordering, collections::HashSet};

fn policy_valid(p: &Value) -> Result<(), String> {
    let mut ids = HashSet::new();
    let mut previous = 0.0;
    for lane in a(&p["lanes"]) {
        let budget = n(&lane["maximumReferenceP95Ms"]);
        if !ids.insert(s(&lane["id"])) || budget <= previous {
            return Err("AGENTIC_PROFILE_POLICY_INVALID".into());
        }
        previous = budget;
    }
    Ok(())
}
fn rank(sorted: &[f64], percentile: f64) -> Value {
    sorted
        .get((percentile * sorted.len() as f64).ceil() as usize - 1)
        .map(|v| json!(v))
        .unwrap_or(Value::Null)
}
fn observed_rank(sorted: &[f64], percentile: f64) -> Value {
    if sorted.is_empty() {
        Value::Null
    } else {
        rank(sorted, percentile)
    }
}
pub fn create_agentic_profile(request: &Value) -> Result<Value, String> {
    validate(
        request,
        "profile-request",
        "AGENTIC_PROFILE_REQUEST_INVALID",
    )?;
    let manifest = &request["manifest"];
    let policy = &request["policy"];
    manifest_consistent(manifest)?;
    policy_valid(policy)?;
    if replay_evidence_manifest(manifest)["valid"] != true {
        return Err("AGENTIC_PROFILE_SOURCE_INVALID".into());
    }
    let worlds = a(&manifest["worlds"]);
    let targets = worlds
        .iter()
        .filter(|w| w["kind"] == "TARGET")
        .collect::<Vec<_>>();
    let total = targets.iter().map(|w| n(&w["weight"])).sum::<f64>();
    let required = targets
        .iter()
        .filter(|w| w["required"] == true)
        .map(|w| s(&w["id"]))
        .collect::<HashSet<_>>();
    let weight_of = |id: &Value| {
        targets
            .iter()
            .find(|w| w["id"] == *id)
            .map(|w| n(&w["weight"]))
            .unwrap_or(0.0)
    };
    let selected = a(&manifest["decision"]["selectedCandidateIds"]);
    let source_candidates = a(&manifest["candidates"]);
    let mut covered = HashSet::<String>::new();
    let mut marginal = std::collections::HashMap::new();
    for id in selected {
        let mut weight = 0.0;
        if let Some(c) = source_candidates.iter().find(|c| c["id"] == *id) {
            for target in a(&c["killedTargetIds"]) {
                if covered.insert(s(target).to_owned()) {
                    weight += weight_of(target);
                }
            }
        }
        marginal.insert(s(id), weight);
    }
    let mut candidates=source_candidates.iter().map(|c| {
        let observations=a(&manifest["observations"]).iter().filter(|o|o["candidateId"]==c["id"]).collect::<Vec<_>>();
        let mut durations=observations.iter().filter(|o|worlds.iter().any(|w|w["kind"]=="REFERENCE" && w["id"]==o["worldId"])).filter_map(|o|o["durationMs"].as_f64()).collect::<Vec<_>>(); durations.sort_by(f64::total_cmp);
        let p95=observed_rank(&durations,0.95); let total_duration=observations.iter().map(|o|o["durationMs"].as_f64().unwrap_or(0.0)).sum::<f64>();
        let qualified=manifest["decision"]["status"]=="VERIFIED" && selected.contains(&c["id"]) && c["status"]=="ELIGIBLE";
        let timing=durations.len() as f64>=n(&policy["minimumTimingSamples"]);
        let lanes=if qualified && timing && !p95.is_null() {a(&policy["lanes"]).iter().filter(|l|n(&p95)<=n(&l["maximumReferenceP95Ms"])).map(|l|l["id"].clone()).collect::<Vec<_>>()} else {vec![]};
        let classification=if !qualified {"NOT_QUALIFIED"} else if !timing {"INSUFFICIENT_TIMING_EVIDENCE"} else if lanes.is_empty() {"BUDGET_MISSED"} else {"QUALIFIED"};
        let mut killed=a(&c["killedTargetIds"]).to_vec(); killed.sort_by(|a,b|ordinal(s(a),s(b)));
        json!({"id":c["id"],"evidenceStatus":c["status"],"classification":classification,"satisfiedLaneIds":lanes,"bestLaneId":lanes.first(),"targetWeightKilled":c["targetWeightKilled"],"totalTargetWeight":total,"targetWeightPermille":if total==0.0 {0.0} else {(n(&c["targetWeightKilled"])*1000.0/total).floor()},"requiredTargetsKilled":killed.iter().filter(|id|required.contains(s(id))).count(),"requiredTargetsTotal":required.len(),"killedTargetIds":killed,"marginalTargetWeight":marginal.get(s(&c["id"])).copied().unwrap_or(0.0),"consistency":{"claim":if a(&c["gates"]).iter().any(|g|g["name"]=="STABILITY" && g["status"]=="PASSED") {"OBSERVED_CONSISTENT"} else {"OBSERVED_INCONSISTENT"},"attempts":manifest["policy"]["requiredAttempts"]},"latency":{"kind":"RECORDED_REFERENCE_WALL_TIME","samples":durations.len(),"minimumMs":durations.first(),"p50Ms":observed_rank(&durations,0.5),"p95Ms":p95,"maximumMs":durations.last(),"totalCandidateDurationMs":total_duration},"paretoFrontier":false,"sizeBytes":c["sizeBytes"],"digest":c["digest"]})
    }).collect::<Vec<_>>();
    candidates.sort_by(|a, b| ordinal(s(&a["id"]), s(&b["id"])));
    let considered = |c: &Value| {
        ["QUALIFIED", "BUDGET_MISSED"].contains(&s(&c["classification"]))
            && !c["latency"]["p95Ms"].is_null()
    };
    let dominates = |other: &Value, c: &Value| {
        let pairs = [
            ("targetWeightKilled", false),
            ("requiredTargetsKilled", false),
            ("sizeBytes", true),
        ];
        let mut better = false;
        for (key, lower) in pairs {
            let left = n(&other[key]);
            let right = n(&c[key]);
            if (lower && left > right) || (!lower && left < right) {
                return false;
            }
            better |= left != right;
        }
        for key in ["p95Ms", "totalCandidateDurationMs"] {
            let left = n(&other["latency"][key]);
            let right = n(&c["latency"][key]);
            if left > right {
                return false;
            }
            better |= left < right;
        }
        better
    };
    for index in 0..candidates.len() {
        if considered(&candidates[index]) {
            let frontier = !candidates.iter().any(|other| {
                other["id"] != candidates[index]["id"]
                    && considered(other)
                    && dominates(other, &candidates[index])
            });
            candidates[index]["paretoFrontier"] = json!(frontier);
        }
    }
    let portfolios=a(&policy["lanes"]).iter().map(|lane| {
        let budget=n(&lane["maximumReferenceP95Ms"]); let mut spent=0.0; let mut selected=Vec::<Value>::new(); let mut targets=HashSet::<String>::new();
        loop {
            let mut choices=candidates.iter().filter(|c|c["classification"]=="QUALIFIED" && a(&c["satisfiedLaneIds"]).contains(&lane["id"]) && !selected.contains(&c["id"]) && !c["latency"]["p95Ms"].is_null() && n(&c["latency"]["p95Ms"])<=budget-spent).map(|c|(c,a(&c["killedTargetIds"]).iter().filter(|id|!targets.contains(s(id))).map(&weight_of).sum::<f64>())).filter(|(_,weight)|*weight>0.0).collect::<Vec<_>>();
            choices.sort_by(|(left,lw),(right,rw)| {
                let lc=n(&left["latency"]["p95Ms"]); let rc=n(&right["latency"]["p95Ms"]);
                let ratio=if lc==0.0 && rc!=0.0 {Ordering::Less} else if rc==0.0 && lc!=0.0 {Ordering::Greater} else if lc!=0.0 && rc!=0.0 {(rw*lc).total_cmp(&(lw*rc))} else {Ordering::Equal};
                ratio.then_with(||rw.total_cmp(lw)).then_with(||lc.total_cmp(&rc)).then_with(||n(&left["sizeBytes"]).total_cmp(&n(&right["sizeBytes"]))).then_with(||ordinal(s(&left["digest"]),s(&right["digest"]))).then_with(||ordinal(s(&left["id"]),s(&right["id"])))
            });
            let Some((choice,_))=choices.first() else {break;}; selected.push(choice["id"].clone()); spent+=n(&choice["latency"]["p95Ms"]); for id in a(&choice["killedTargetIds"]) {targets.insert(s(id).to_owned());}
        }
        let weight=targets.iter().map(|id|weight_of(&json!(id))).sum::<f64>();
        json!({"laneId":lane["id"],"budgetMs":budget,"selectedCandidateIds":selected,"totalReferenceP95Ms":spent,"targetWeight":weight,"targetWeightPermille":if total==0.0 {0.0} else {(weight*1000.0/total).floor()},"requiredTargetsKilled":targets.iter().filter(|id|required.contains(id.as_str())).count(),"requiredTargetsTotal":required.len()})
    }).collect::<Vec<_>>();
    for c in &mut candidates {
        c.as_object_mut().unwrap().remove("sizeBytes");
        c.as_object_mut().unwrap().remove("digest");
    }
    let qualified = candidates
        .iter()
        .filter(|c| c["classification"] == "QUALIFIED")
        .map(|c| c["id"].clone())
        .collect::<Vec<_>>();
    let status = if !qualified.is_empty() {
        "QUALIFIED"
    } else if candidates
        .iter()
        .any(|c| c["classification"] == "INSUFFICIENT_TIMING_EVIDENCE")
    {
        "INSUFFICIENT_TIMING_EVIDENCE"
    } else if candidates
        .iter()
        .any(|c| c["classification"] == "BUDGET_MISSED")
    {
        "BUDGET_MISSED"
    } else {
        "NOT_QUALIFIED"
    };
    let mut report = json!({"schemaVersion":"1.0.0","sourceManifest":manifest,"sourceArtifactDigest":manifest["artifactDigest"],"policy":policy,"policyDigest":sha256_canonical(policy),"status":status,"candidates":candidates,"portfolios":portfolios,"qualifiedCandidateIds":qualified,"limitations":["Profile strength is limited to the declared worlds and recorded attempts.","RECORDED_REFERENCE_WALL_TIME is local operational evidence, not a portable cold/warm benchmark.","Observed consistency does not prove permanent absence of flakiness."]});
    normalize(&mut report);
    report["reportDigest"] = json!(sha256_canonical(&report));
    Ok(report)
}
pub fn replay_agentic_profile(report: &Value) -> Value {
    let invalid = json!({"valid":false,"schemaValid":false,"sourceManifestValid":false,"policyDigestValid":false,"reportDigestValid":false,"semanticsValid":false});
    if validate(report, "profile-report", "AGENTIC_PROFILE_REPORT_INVALID").is_err()
        || manifest_consistent(&report["sourceManifest"]).is_err()
        || policy_valid(&report["policy"]).is_err()
    {
        return invalid;
    }
    let candidates = a(&report["candidates"]);
    if candidates
        .iter()
        .map(|c| s(&c["id"]))
        .collect::<HashSet<_>>()
        .len()
        != candidates.len()
        || a(&report["qualifiedCandidateIds"])
            .iter()
            .any(|id| !candidates.iter().any(|c| c["id"] == *id))
    {
        return invalid;
    }
    let source = replay_evidence_manifest(&report["sourceManifest"])["valid"] == true;
    let policy = report["policyDigest"] == sha256_canonical(&report["policy"]);
    let mut projection = report.clone();
    projection.as_object_mut().unwrap().remove("reportDigest");
    let digest = report["reportDigest"] == sha256_canonical(&projection);
    let semantics=create_agentic_profile(&json!({"schemaVersion":"1.0.0","manifest":report["sourceManifest"],"policy":report["policy"]})).is_ok_and(|expected|canonicalize(report)==canonicalize(&expected));
    json!({"valid":source && policy && digest && semantics,"schemaValid":true,"sourceManifestValid":source,"policyDigestValid":policy,"reportDigestValid":digest,"semanticsValid":semantics})
}
