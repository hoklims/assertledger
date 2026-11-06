use crate::{canonicalize, sha256_canonical};
use serde_json::{Map, Value, json};
use std::cmp::Ordering;
use std::collections::HashSet;

type Check<T> = Result<T, String>;
const SAFE: f64 = 9_007_199_254_740_991.0;
fn ordinal(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}
fn obj(v: &Value) -> Check<&Map<String, Value>> {
    v.as_object().ok_or_else(|| "Expected object".into())
}
fn arr(v: &Value) -> Check<&Vec<Value>> {
    v.as_array().ok_or_else(|| "Expected array".into())
}
fn string(v: &Value) -> Check<&str> {
    v.as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "Expected non-empty string".into())
}
fn bounded(v: &Value, max: usize) -> Check<&str> {
    let s = string(v)?;
    if s.encode_utf16().count() > max {
        return Err("String exceeds bounds".into());
    }
    Ok(s)
}
fn digest(v: &Value) -> Check<&str> {
    let s = string(v)?;
    if s.len() != 71
        || !s.starts_with("sha256:")
        || !s[7..]
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err("Expected SHA-256 digest".into());
    }
    Ok(s)
}
fn identifier(v: &Value) -> Check<&str> {
    let s = bounded(v, 128)?;
    if !s.bytes().next().is_some_and(|b| b.is_ascii_alphanumeric())
        || !s
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
    {
        return Err("Expected portable ASCII identifier".into());
    }
    Ok(s)
}
fn safe_integer(v: &Value) -> Option<f64> {
    v.as_f64()
        .filter(|n| n.is_finite() && n.fract() == 0.0 && n.abs() <= SAFE)
}
fn integer(v: &Value, min: f64) -> Check<f64> {
    safe_integer(v)
        .filter(|n| *n >= min)
        .ok_or_else(|| "Expected safe integer".into())
}
fn boolean(v: &Value) -> Check<bool> {
    v.as_bool().ok_or_else(|| "Expected boolean".into())
}
fn field(v: &Value, key: &str) -> Check<Value> {
    obj(v)?
        .get(key)
        .cloned()
        .ok_or_else(|| format!("Missing {key}"))
}
fn strings(v: &Value, max_items: usize, max_length: usize, require_sorted: bool) -> Check<Value> {
    let values = arr(v)?;
    if values.len() > max_items {
        return Err("Array exceeds bounds".into());
    }
    let mut strings = values
        .iter()
        .map(|s| bounded(s, max_length).map(str::to_owned))
        .collect::<Check<Vec<_>>>()?;
    if require_sorted
        && strings
            .windows(2)
            .any(|w| ordinal(&w[0], &w[1]) != Ordering::Less)
    {
        return Err("Paths must be sorted unique".into());
    }
    strings.sort_by(|a, b| ordinal(a, b));
    strings.dedup();
    Ok(json!(strings))
}
fn sort_ids(values: &mut [Value]) {
    values.sort_by(|a, b| {
        ordinal(
            a["id"].as_str().unwrap_or(""),
            b["id"].as_str().unwrap_or(""),
        )
    });
}
fn unique(values: &[Value], key: &str) -> Check<()> {
    if values.iter().map(|v| &v[key]).collect::<HashSet<_>>().len() != values.len() {
        return Err(format!("Duplicate {key}"));
    }
    Ok(())
}
fn observations_cmp(a: &Value, b: &Value) -> Ordering {
    ordinal(
        a["candidateId"].as_str().unwrap_or(""),
        b["candidateId"].as_str().unwrap_or(""),
    )
    .then_with(|| {
        ordinal(
            a["worldId"].as_str().unwrap_or(""),
            b["worldId"].as_str().unwrap_or(""),
        )
    })
    .then_with(|| {
        a["attempt"]
            .as_f64()
            .unwrap_or(0.0)
            .total_cmp(&b["attempt"].as_f64().unwrap_or(0.0))
    })
    .then_with(|| {
        ordinal(
            a["runId"].as_str().unwrap_or(""),
            b["runId"].as_str().unwrap_or(""),
        )
    })
}

fn parse_repository(v: &Value, version: &str) -> Check<Value> {
    obj(v)?;
    let include_dependencies = boolean(&v["includeDependencies"])?;
    let links = strings(&v["omittedLinks"], 10_000, 1_024, true)?;
    let git = field(v, "git")?;
    let parsed_git = if git.is_null() {
        Value::Null
    } else {
        obj(&git)?;
        let tree = string(&git["treeId"])?;
        if git["mode"] != "synthesized"
            || ![40, 64].contains(&tree.len())
            || !tree
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err("Invalid synthesized tree record".into());
        }
        json!({"mode":"synthesized","treeId":tree,"gitVersion":bounded(&git["gitVersion"],256)?})
    };
    let mut result =
        json!({"includeDependencies":include_dependencies,"omittedLinks":links,"git":parsed_git});
    if version == "5.0.0" {
        if v["snapshot"] != "repository" && v["snapshot"] != "test-closure" {
            return Err("Invalid snapshot extent".into());
        }
        let include = strings(&v["include"], 1_000, 1_024, true)?;
        let count = integer(&v["preservedLinkCount"], 0.0)?;
        if count > 10_000_000.0 {
            return Err("Invalid preservedLinkCount".into());
        }
        let edges = arr(&v["unboundedClosureEdges"])?;
        if edges.len() > 10_000 {
            return Err("Closure edges exceed bounds".into());
        }
        let mut parsed = Vec::new();
        let mut keys = Vec::new();
        for edge in edges {
            let map = obj(edge)?;
            if map.len() != 2 || !map.contains_key("file") || !map.contains_key("reason") {
                return Err("Invalid closure edge".into());
            }
            let file = bounded(&edge["file"], 1_024)?;
            let reason = string(&edge["reason"])?;
            if ![
                "NON_LITERAL_MODULE_SPECIFIER",
                "ABSOLUTE_MODULE_SPECIFIER",
                "MODULE_OUTSIDE_REPOSITORY",
                "TEST_PRELOAD_UNREADABLE",
            ]
            .contains(&reason)
            {
                return Err("Invalid closure reason".into());
            }
            keys.push(format!("{file}\0{reason}"));
            parsed.push(json!({"file":file,"reason":reason}));
        }
        if keys
            .windows(2)
            .any(|w| ordinal(&w[0], &w[1]) != Ordering::Less)
        {
            return Err("Closure edges must be sorted unique".into());
        }
        if v["snapshot"] == "repository" && (!arr(&include)?.is_empty() || !parsed.is_empty()) {
            return Err("Repository snapshot cannot have include paths or closure edges".into());
        }
        result["snapshot"] = v["snapshot"].clone();
        result["include"] = include;
        result["preservedLinkCount"] = json!(count);
        result["unboundedClosureEdges"] = json!(parsed);
    }
    Ok(result)
}

fn parse_context(v: &Value, version: &str) -> Check<Value> {
    obj(v)?;
    obj(&v["engine"])?;
    obj(&v["adapter"])?;
    obj(&v["execution"])?;
    let raw_worlds = arr(&v["worlds"])?;
    if raw_worlds.is_empty() {
        return Err("Context worlds must be non-empty".into());
    }
    let mut worlds=raw_worlds.iter().map(|w| { obj(w)?; Ok(json!({"id":identifier(&w["id"])? ,"provenance":bounded(&w["provenance"],1_024)?,"digest":digest(&w["digest"])?})) }).collect::<Check<Vec<_>>>()?;
    sort_ids(&mut worlds);
    unique(&worlds, "id")?;
    let mut result = json!({
        "engine":{"name":bounded(&v["engine"]["name"],128)?,"version":bounded(&v["engine"]["version"],128)?},
        "adapter":{"name":bounded(&v["adapter"]["name"],128)?,"version":bounded(&v["adapter"]["version"],128)?,"configuration":field(&v["adapter"],"configuration")?},
        "execution":{"isolation":bounded(&v["execution"]["isolation"],128)?,"environmentAllowlist":strings(&v["execution"]["environmentAllowlist"],100,128,false)?,"budgets":field(&v["execution"],"budgets")?,"candidateRoots":strings(&v["execution"]["candidateRoots"],100,512,false)?},
        "worlds":worlds
    });
    if version != "1.0.0" {
        obj(&v["execution"]["backend"])?;
        result["execution"]["backend"] = v["execution"]["backend"].clone();
    }
    if version == "4.0.0" || version == "5.0.0" {
        result["repository"] = parse_repository(&v["repository"], version)?;
    }
    Ok(result)
}

fn parse_input(input: &Value) -> Check<Value> {
    obj(input)?;
    let version = string(&input["schemaVersion"])?;
    if !["1.0.0", "2.0.0", "3.0.0", "4.0.0", "5.0.0"].contains(&version) {
        return Err("Unsupported schemaVersion".into());
    }
    let p = &input["policy"];
    obj(p)?;
    if p["policyVersion"] != "1.0.0" {
        return Err("Unsupported policyVersion".into());
    }
    let attempts = integer(&p["requiredAttempts"], 1.0)?;
    let minimum = integer(&p["minimumTargetWeightPermille"], 1.0)?;
    let maximum = integer(&p["maximumSelectedCandidates"], 1.0)?;
    if attempts > 1_000.0
        || minimum > 1_000.0
        || maximum > 1_000.0
        || p["acceptedTargetOutcomes"] != json!(["ASSERTION_FAILURE"])
    {
        return Err("Invalid policy".into());
    }
    let policy = json!({"policyVersion":"1.0.0","requiredAttempts":attempts,"minimumTargetWeightPermille":minimum,"maximumSelectedCandidates":maximum,"acceptedTargetOutcomes":["ASSERTION_FAILURE"]});
    let raw_worlds = arr(&input["worlds"])?;
    if raw_worlds.is_empty() {
        return Err("worlds must be non-empty".into());
    }
    let mut worlds=raw_worlds.iter().map(|w| {
        obj(w)?; let kind=string(&w["kind"])?;
        if !["REFERENCE","TARGET","NEUTRAL"].contains(&kind) {return Err("Invalid world kind".into());}
        let weight=integer(&w["weight"],0.0)?;
        if weight>1_000_000.0 || (kind=="TARGET" && weight<1.0) || (kind!="TARGET" && weight!=0.0) {return Err("Invalid world weight".into());}
        Ok(json!({"id":identifier(&w["id"])? ,"kind":kind,"required":boolean(&w["required"])? ,"weight":weight}))
    }).collect::<Check<Vec<_>>>()?;
    sort_ids(&mut worlds);
    unique(&worlds, "id")?;
    for kind in ["REFERENCE", "TARGET", "NEUTRAL"] {
        if !worlds
            .iter()
            .any(|w| w["kind"] == kind && w["required"] == true)
        {
            return Err("Required world missing".into());
        }
    }
    let context = parse_context(&input["evidenceContext"], version)?;
    if arr(&context["worlds"])?.len() != worlds.len()
        || arr(&context["worlds"])?
            .iter()
            .any(|w| !worlds.iter().any(|x| x["id"] == w["id"]))
    {
        return Err("Context worlds must exactly match decision worlds".into());
    }
    let mut candidates=arr(&input["candidates"])?.iter().map(|c| {obj(c)?; Ok(json!({"id":identifier(&c["id"])? ,"digest":digest(&c["digest"])? ,"sizeBytes":integer(&c["sizeBytes"],0.0)?}))}).collect::<Check<Vec<_>>>()?;
    if candidates.is_empty() {
        return Err("Candidates must be non-empty".into());
    }
    sort_ids(&mut candidates);
    unique(&candidates, "id")?;
    let mut observations=arr(&input["observations"])?.iter().map(|o| {
        obj(o)?; let candidate=field(o,"candidateId")?;
        if !candidate.is_null() && (!candidate.is_string() || !candidates.iter().any(|c|c["id"]==candidate)) {return Err("Unknown candidateId".into());}
        let world=string(&o["worldId"])?; if !worlds.iter().any(|w|w["id"]==world) {return Err("Unknown worldId".into());}
        let discovered=integer(&o["testsDiscovered"],0.0)?; let candidate_discovered=integer(&o["candidateTestsDiscovered"],0.0)?;
        if candidate_discovered>discovered {return Err("candidateTestsDiscovered exceeds testsDiscovered".into());}
        let outcome=bounded(&o["outcome"],64)?;
        if !["PASS","ASSERTION_FAILURE","COLLECTION_FAILURE","COMPILE_FAILURE","PROCESS_CRASH","TIMEOUT","INFRA_ERROR","NO_TEST_DISCOVERED"].contains(&outcome) {return Err("Invalid outcome".into());}
        let mut result=json!({"runId":bounded(&o["runId"],512)?,"candidateId":candidate,"worldId":world,"attempt":integer(&o["attempt"],1.0)?,"outcome":outcome,"testsDiscovered":discovered,"candidateTestsDiscovered":candidate_discovered,"attributed":boolean(&o["attributed"])?});
        if let Some(d)=obj(o)?.get("durationMs") { if !d.as_f64().is_some_and(|n|n.is_finite() && n>=0.0) {return Err("Invalid durationMs".into());} result["durationMs"]=d.clone(); }
        if let Some(e)=obj(o)?.get("exitCode") { if !e.is_null() { integer(e,0.0)?; } result["exitCode"]=e.clone(); }
        for key in ["stdoutDigest","stderrDigest"] { if let Some(d)=obj(o)?.get(key) { digest(d)?; result[key]=d.clone(); } }
        Ok(result)
    }).collect::<Check<Vec<_>>>()?;
    observations.sort_by(observations_cmp);
    unique(&observations, "runId")?;
    Ok(
        json!({"schemaVersion":version,"repositoryDigest":digest(&input["repositoryDigest"])? ,"evidenceContext":context,"policy":policy,"worlds":worlds,"candidates":candidates,"observations":observations}),
    )
}

fn runs<'a>(input: &'a Value, candidate: &Value, world: &Value) -> Vec<&'a Value> {
    input["observations"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r["candidateId"] == *candidate && r["worldId"] == *world)
        .collect()
}
fn complete(runs: &[&Value], attempts: usize) -> bool {
    runs.len() == attempts
        && (1..=attempts).all(|a| {
            runs.iter()
                .filter(|r| r["attempt"].as_f64() == Some(a as f64))
                .count()
                == 1
        })
}
fn stable(runs: &[&Value], attempts: usize) -> bool {
    complete(runs, attempts) && runs.iter().all(|r| r["outcome"] == runs[0]["outcome"])
}
fn inconclusive(r: &Value) -> bool {
    r["outcome"] == "TIMEOUT" || r["outcome"] == "INFRA_ERROR"
}
fn gate(name: &str, passed: bool, runs: &[&Value], reason: &str) -> Value {
    let mut ids = runs
        .iter()
        .map(|r| r["runId"].as_str().unwrap())
        .collect::<Vec<_>>();
    ids.sort_by(|a, b| ordinal(a, b));
    json!({"name":name,"status":if passed {"PASSED"} else {"FAILED"},"evidenceRunIds":ids,"reasonCodes":if passed {vec![]} else {vec![reason]}})
}
fn assessment(
    candidate: &Value,
    status: &str,
    killed: Vec<Value>,
    weight: f64,
    gates: Vec<Value>,
    reason: &str,
) -> Value {
    let mut v = candidate.clone();
    v["status"] = json!(status);
    v["killedTargetIds"] = json!(killed);
    v["targetWeightKilled"] = json!(weight);
    v["gates"] = json!(gates);
    v["reasonCodes"] = json!([reason]);
    v
}
fn early(candidate: &Value, status: &str, mut gates: Vec<Value>, reason: &str) -> Value {
    for name in [
        "COMPLETENESS",
        "STABILITY",
        "DISCOVERY",
        "REFERENCE",
        "NEUTRAL",
        "TARGET_STRENGTH",
    ]
    .iter()
    .skip(gates.len())
    {
        gates.push(json!({"name":name,"status":"NOT_RUN","evidenceRunIds":[],"reasonCodes":["PREREQUISITE_GATE_FAILED"]}));
    }
    assessment(candidate, status, vec![], 0.0, gates, reason)
}
fn assess(input: &Value, candidate: &Value) -> Value {
    let worlds = input["worlds"].as_array().unwrap();
    let attempts = input["policy"]["requiredAttempts"].as_f64().unwrap() as usize;
    let world_runs = worlds
        .iter()
        .map(|w| (w, runs(input, &candidate["id"], &w["id"])))
        .collect::<Vec<_>>();
    let mut all = world_runs
        .iter()
        .flat_map(|(_, r)| r.iter().copied())
        .collect::<Vec<_>>();
    all.sort_by(|a, b| observations_cmp(a, b));
    let completed = world_runs.iter().all(|(_, r)| complete(r, attempts));
    let mut gates = vec![gate(
        "COMPLETENESS",
        completed,
        &all,
        "CANDIDATE_EVIDENCE_INCOMPLETE",
    )];
    if !completed {
        return early(
            candidate,
            "INCONCLUSIVE",
            gates,
            "CANDIDATE_EVIDENCE_INCOMPLETE",
        );
    }
    let stability = world_runs.iter().all(|(_, r)| stable(r, attempts));
    gates.push(gate("STABILITY", stability, &all, "OBSERVATIONS_DIVERGE"));
    if !stability {
        return early(candidate, "UNSTABLE", gates, "OBSERVATIONS_DIVERGE");
    }
    let undiscovered = all
        .iter()
        .filter(|r| {
            !(r["candidateTestsDiscovered"].as_f64().unwrap() >= 1.0 && r["attributed"] == true)
        })
        .collect::<Vec<_>>();
    let discovery = undiscovered.is_empty();
    let unknown = !discovery && undiscovered.iter().all(|r| inconclusive(r));
    let reason = if unknown {
        "CANDIDATE_EXECUTION_INCONCLUSIVE"
    } else {
        "CANDIDATE_DISCOVERY_INVALID"
    };
    gates.push(gate("DISCOVERY", discovery, &all, reason));
    if !discovery {
        return early(
            candidate,
            if unknown { "INCONCLUSIVE" } else { "INVALID" },
            gates,
            reason,
        );
    }
    let by_kind = |kind: &str| {
        world_runs
            .iter()
            .filter(|(w, _)| w["kind"] == kind)
            .flat_map(|(_, r)| r.iter().copied())
            .collect::<Vec<_>>()
    };
    let reference = by_kind("REFERENCE");
    let reference_pass = reference.iter().all(|r| r["outcome"] == "PASS");
    gates.push(gate(
        "REFERENCE",
        reference_pass,
        &reference,
        "REFERENCE_NOT_GREEN",
    ));
    let neutral = by_kind("NEUTRAL");
    let neutral_pass = neutral.iter().all(|r| r["outcome"] == "PASS");
    gates.push(gate("NEUTRAL", neutral_pass, &neutral, "NEUTRAL_NOT_GREEN"));
    let killed = world_runs
        .iter()
        .filter(|(w, r)| {
            w["kind"] == "TARGET"
                && r.iter()
                    .all(|r| r["attributed"] == true && r["outcome"] == "ASSERTION_FAILURE")
        })
        .map(|(w, _)| *w)
        .collect::<Vec<_>>();
    let mut ids = killed.iter().map(|w| w["id"].clone()).collect::<Vec<_>>();
    ids.sort_by(|a, b| ordinal(a.as_str().unwrap(), b.as_str().unwrap()));
    let weight = killed
        .iter()
        .map(|w| w["weight"].as_f64().unwrap())
        .sum::<f64>();
    let targets = worlds
        .iter()
        .filter(|w| w["kind"] == "TARGET")
        .collect::<Vec<_>>();
    let total = targets
        .iter()
        .map(|w| w["weight"].as_f64().unwrap())
        .sum::<f64>();
    let target_pass = targets
        .iter()
        .filter(|w| w["required"] == true)
        .all(|w| ids.contains(&w["id"]))
        && total > 0.0
        && weight * 1000.0
            >= total
                * input["policy"]["minimumTargetWeightPermille"]
                    .as_f64()
                    .unwrap();
    let target_runs = by_kind("TARGET");
    let target_unknown = target_runs.iter().any(|r| inconclusive(r));
    gates.push(gate(
        "TARGET_STRENGTH",
        target_pass,
        &target_runs,
        if target_unknown {
            "CANDIDATE_EXECUTION_INCONCLUSIVE"
        } else {
            "TARGET_STRENGTH_INSUFFICIENT"
        },
    ));
    let (status, reason) = if all.iter().any(|r| inconclusive(r)) {
        ("INCONCLUSIVE", "CANDIDATE_EXECUTION_INCONCLUSIVE")
    } else if !reference_pass {
        ("INVALID", "REFERENCE_NOT_GREEN")
    } else if !neutral_pass {
        ("INVALID", "NEUTRAL_NOT_GREEN")
    } else if target_pass {
        ("ELIGIBLE", "POLICY_SATISFIED")
    } else {
        ("WEAK_ORACLE", "TARGET_STRENGTH_INSUFFICIENT")
    };
    assessment(candidate, status, ids, weight, gates, reason)
}

pub fn select_candidates(assessments: &Value, maximum: &Value) -> Value {
    let Some(max) = safe_integer(maximum).filter(|n| *n > 0.0) else {
        return json!([]);
    };
    let Some(items) = assessments.as_array() else {
        return json!([]);
    };
    let mut eligible = items
        .iter()
        .filter_map(|raw| {
            if !raw.is_object()
                || raw["status"] != "ELIGIBLE"
                || !raw["id"].is_string()
                || !raw["digest"].is_string()
                || safe_integer(&raw["sizeBytes"]).is_none()
            {
                return None;
            }
            let killed = raw["killedTargetIds"].as_array()?;
            if killed.iter().any(|v| !v.is_string()) {
                return None;
            }
            let mut normalized = raw.clone();
            let mut ids = killed.clone();
            ids.sort_by(|a, b| ordinal(a.as_str().unwrap(), b.as_str().unwrap()));
            ids.dedup();
            normalized["killedTargetIds"] = json!(ids);
            Some(normalized)
        })
        .collect::<Vec<_>>();
    let mut selected = Vec::new();
    let mut covered = HashSet::<String>::new();
    while (selected.len() as f64) < max && !eligible.is_empty() {
        let marginal = |v: &Value| {
            v["killedTargetIds"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|id| !covered.contains(id.as_str().unwrap()))
                .count()
        };
        eligible.sort_by(|a, b| {
            marginal(b)
                .cmp(&marginal(a))
                .then_with(|| {
                    a["sizeBytes"]
                        .as_f64()
                        .unwrap()
                        .total_cmp(&b["sizeBytes"].as_f64().unwrap())
                })
                .then_with(|| ordinal(a["digest"].as_str().unwrap(), b["digest"].as_str().unwrap()))
                .then_with(|| ordinal(a["id"].as_str().unwrap(), b["id"].as_str().unwrap()))
        });
        if marginal(&eligible[0]) == 0 {
            break;
        }
        let best = eligible.remove(0);
        selected.push(best["id"].clone());
        for id in best["killedTargetIds"].as_array().unwrap() {
            covered.insert(id.as_str().unwrap().to_owned());
        }
    }
    json!(selected)
}

fn decision_projection(manifest: &Value) -> Check<Value> {
    obj(manifest)?;
    let mut worlds = arr(&manifest["worlds"])?.clone();
    let mut candidates = arr(&manifest["candidates"])?.clone();
    // JS comparators access each object's id; malformed comparator arguments fail closed.
    for item in worlds.iter().chain(&candidates) {
        obj(item)?;
    }
    sort_ids(&mut worlds);
    sort_ids(&mut candidates);
    let mut observations = arr(&manifest["observations"])?.clone();
    for run in &observations {
        obj(run)?;
    }
    observations.sort_by(observations_cmp);
    for run in &mut observations {
        for key in ["durationMs", "exitCode", "stdoutDigest", "stderrDigest"] {
            run.as_object_mut().unwrap().remove(key);
        }
    }
    Ok(
        json!({"schemaVersion":field(manifest,"schemaVersion")?,"repositoryDigest":field(manifest,"repositoryDigest")?,"evidenceContext":field(manifest,"evidenceContext")?,"policy":field(manifest,"policy")?,"worlds":worlds,"candidates":candidates,"observations":observations,"decision":field(manifest,"decision")?}),
    )
}
pub fn seal_manifest_artifact(manifest: &Value) -> Check<Value> {
    let mut artifact = obj(manifest)?.clone();
    artifact.remove("artifactDigest");
    let hash = sha256_canonical(&json!(artifact));
    artifact.insert("artifactDigest".into(), json!(hash));
    Ok(json!(artifact))
}
fn normalize_numbers(value: &mut Value) {
    match value {
        Value::Number(n) => {
            if n.is_f64()
                && let Some(v) = n.as_f64().filter(|v| v.fract() == 0.0 && v.abs() <= SAFE)
            {
                *value = json!(v as i64);
            }
        }
        Value::Array(values) => values.iter_mut().for_each(normalize_numbers),
        Value::Object(values) => values.values_mut().for_each(normalize_numbers),
        _ => {}
    }
}
fn finish(mut base: Value) -> Value {
    normalize_numbers(&mut base);
    base["decisionDigest"] = json!(sha256_canonical(&decision_projection(&base).unwrap()));
    seal_manifest_artifact(&base).unwrap()
}
fn invalid_manifest() -> Value {
    finish(
        json!({"schemaVersion":"1.0.0","repositoryDigest":"invalid","evidenceContext":{"engine":{"name":"invalid","version":"invalid"},"adapter":{"name":"invalid","version":"invalid","configuration":{}},"execution":{"isolation":"invalid","environmentAllowlist":[],"budgets":{},"candidateRoots":[]},"worlds":[]},"policy":{"policyVersion":"invalid","requiredAttempts":1,"minimumTargetWeightPermille":1000,"maximumSelectedCandidates":0,"acceptedTargetOutcomes":[]},"worlds":[],"candidates":[],"observations":[],"decision":{"status":"ENGINE_ERROR","selectedCandidateIds":[],"reasonCodes":["EVIDENCE_INPUT_INVALID"]}}),
    )
}
pub fn decide_evidence(input: &Value) -> Value {
    let Ok(mut evidence) = parse_input(input) else {
        return invalid_manifest();
    };
    let candidates = evidence["candidates"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| assess(&evidence, c))
        .collect::<Vec<_>>();
    let attempts = evidence["policy"]["requiredAttempts"].as_f64().unwrap() as usize;
    let controls = evidence["worlds"].as_array().unwrap().iter().all(|w| {
        let r = runs(&evidence, &Value::Null, &w["id"]);
        stable(&r, attempts)
            && r.iter().all(|r| {
                r["outcome"] == "PASS"
                    && r["candidateTestsDiscovered"].as_f64() == Some(0.0)
                    && r["attributed"] == false
            })
    });
    let unknown = candidates
        .iter()
        .any(|c| c["status"] == "UNSTABLE" || c["status"] == "INCONCLUSIVE");
    let selected = if controls {
        select_candidates(
            &json!(candidates),
            &evidence["policy"]["maximumSelectedCandidates"],
        )
    } else {
        json!([])
    };
    let (status, reason) = if !controls {
        ("INCONCLUSIVE", "CONTROL_EVIDENCE_INVALID")
    } else if !selected.as_array().unwrap().is_empty() {
        ("VERIFIED", "POLICY_SATISFIED")
    } else if unknown {
        ("INCONCLUSIVE", "CANDIDATE_EVIDENCE_INCONCLUSIVE")
    } else {
        ("REJECTED", "NO_ELIGIBLE_CANDIDATE")
    };
    evidence["candidates"] = json!(candidates);
    evidence["decision"] =
        json!({"status":status,"selectedCandidateIds":selected,"reasonCodes":[reason]});
    finish(evidence)
}
pub fn verify_decision_digest(manifest: &Value) -> Value {
    let valid = manifest["decisionDigest"]
        .as_str()
        .is_some_and(|d| decision_projection(manifest).is_ok_and(|p| sha256_canonical(&p) == d));
    json!({"valid":valid})
}
pub fn verify_manifest_integrity(manifest: &Value) -> Value {
    let decision = verify_decision_digest(manifest)["valid"] == true;
    let artifact = manifest["artifactDigest"].as_str().is_some_and(|d| {
        obj(manifest).is_ok_and(|m| {
            let mut p = m.clone();
            p.remove("artifactDigest");
            sha256_canonical(&json!(p)) == d
        })
    });
    json!({"valid":decision && artifact,"decisionDigestValid":decision,"artifactDigestValid":artifact})
}
fn replay_semantics(candidates: &Value) -> Check<Value> {
    let mut values=arr(candidates)?.iter().map(|raw| {obj(raw)?; Ok(json!({"id":string(&raw["id"])? ,"digest":string(&raw["digest"])? ,"sizeBytes":integer(&raw["sizeBytes"],0.0)? ,"status":string(&raw["status"])? ,"killedTargetIds":field(raw,"killedTargetIds")?,"targetWeightKilled":integer(&raw["targetWeightKilled"],0.0)?,"gates":field(raw,"gates")?,"reasonCodes":field(raw,"reasonCodes")?}))}).collect::<Check<Vec<_>>>()?;
    sort_ids(&mut values);
    Ok(json!(values))
}
pub fn replay_evidence_manifest(manifest: &Value) -> Value {
    let integrity = verify_manifest_integrity(manifest);
    let semantics=(|| -> Check<bool> {
        obj(manifest)?; obj(&manifest["evidenceContext"])?; obj(&manifest["policy"])?; arr(&manifest["worlds"])?; arr(&manifest["observations"])?; obj(&manifest["decision"])?;
        let candidates=arr(&manifest["candidates"])?.iter().map(|raw| {obj(raw)?; Ok(json!({"id":string(&raw["id"])? ,"digest":string(&raw["digest"])? ,"sizeBytes":integer(&raw["sizeBytes"],0.0)?}))}).collect::<Check<Vec<_>>>()?;
        let mut input=manifest.clone(); input["candidates"]=json!(candidates); let replayed=decide_evidence(&input);
        Ok(replayed["decision"]["status"]!="ENGINE_ERROR" && replayed["decisionDigest"]==manifest["decisionDigest"] && canonicalize(&json!({"candidates":replay_semantics(&replayed["candidates"])? ,"decision":replayed["decision"]}))==canonicalize(&json!({"candidates":replay_semantics(&manifest["candidates"])? ,"decision":manifest["decision"]})))
    })().unwrap_or(false);
    json!({"valid":integrity["valid"]==true && semantics,"decisionDigestValid":integrity["decisionDigestValid"],"artifactDigestValid":integrity["artifactDigestValid"],"decisionSemanticsValid":semantics})
}
