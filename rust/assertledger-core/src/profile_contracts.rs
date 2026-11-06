//! Validator for the pinned generated v1 schemas, with ECMAScript UTF-16 lengths.
//! No I/O occurs at runtime: schemas are embedded unchanged at compile time.
use serde_json::Value;
use std::collections::HashSet;

pub(crate) fn validate(value: &Value, schema_name: &str, code: &str) -> Result<(), String> {
    let bytes = match schema_name {
        "profile-request" => include_str!("../../../schemas/agentic-profile-request.v1.json"),
        "profile-report" => include_str!("../../../schemas/agentic-profile-report.v1.json"),
        "benchmark-request" => include_str!("../../../schemas/agentic-benchmark-request.v1.json"),
        "benchmark-artifact" => include_str!("../../../schemas/agentic-benchmark-artifact.v1.json"),
        _ => return Err("Unknown embedded schema".into()),
    };
    let schema: Value = serde_json::from_str(bytes).expect("Pinned schema is valid JSON");
    if matches_schema(value, &schema, &schema) {
        Ok(())
    } else {
        Err(code.into())
    }
}
fn matches_schema(value: &Value, schema: &Value, root: &Value) -> bool {
    if let Some(b) = schema.as_bool() {
        return b;
    }
    // This is a pinned-schema validator, not a general JSON Schema engine.
    // New vocabulary must never silently weaken an embedded contract.
    let Some(map) = schema.as_object() else {
        return false;
    };
    if map.keys().any(|key| {
        !matches!(
            key.as_str(),
            "$schema"
                | "$id"
                | "$defs"
                | "$ref"
                | "type"
                | "properties"
                | "required"
                | "additionalProperties"
                | "title"
                | "description"
                | "anyOf"
                | "oneOf"
                | "const"
                | "enum"
                | "minimum"
                | "maximum"
                | "minLength"
                | "maxLength"
                | "pattern"
                | "minItems"
                | "maxItems"
                | "prefixItems"
                | "items"
                | "propertyNames"
        )
    }) {
        return false;
    }
    if let Some(reference) = schema["$ref"].as_str() {
        let Some(pointer) = reference.strip_prefix('#') else {
            return false;
        };
        return root
            .pointer(pointer)
            .is_some_and(|target| matches_schema(value, target, root));
    }
    for (key, exactly_one) in [("anyOf", false), ("oneOf", true)] {
        if let Some(branches) = schema[key].as_array() {
            let count = branches
                .iter()
                .filter(|s| matches_schema(value, s, root))
                .count();
            if count == 0 || (exactly_one && count != 1) {
                return false;
            }
        }
    }
    if let Some(expected) = schema.get("const")
        && value != expected
    {
        return false;
    }
    if let Some(values) = schema["enum"].as_array()
        && !values.contains(value)
    {
        return false;
    }
    if let Some(kind) = schema["type"].as_str() {
        let valid = match kind {
            "null" => value.is_null(),
            "boolean" => value.is_boolean(),
            "object" => value.is_object(),
            "array" => value.is_array(),
            "string" => value.is_string(),
            "number" => value.as_f64().is_some_and(f64::is_finite),
            "integer" => value.as_f64().is_some_and(|n| {
                n.is_finite() && n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0
            }),
            _ => false,
        };
        if !valid {
            return false;
        }
    }
    if let Some(n) = value.as_f64()
        && (schema["minimum"].as_f64().is_some_and(|min| n < min)
            || schema["maximum"].as_f64().is_some_and(|max| n > max))
    {
        return false;
    }
    if let Some(s) = value.as_str() {
        let length = s.encode_utf16().count() as u64;
        if schema["minLength"].as_u64().is_some_and(|min| length < min)
            || schema["maxLength"].as_u64().is_some_and(|max| length > max)
        {
            return false;
        }
        if let Some(pattern) = schema["pattern"].as_str()
            && !regex::Regex::new(pattern).is_ok_and(|re| re.is_match(s))
        {
            return false;
        }
    }
    if let Some(values) = value.as_array() {
        let length = values.len() as u64;
        if schema["minItems"].as_u64().is_some_and(|min| length < min)
            || schema["maxItems"].as_u64().is_some_and(|max| length > max)
        {
            return false;
        }
        let prefix = schema["prefixItems"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        for (index, item) in values.iter().enumerate() {
            let constraint = prefix.get(index).or_else(|| schema.get("items"));
            if constraint.is_some_and(|s| !matches_schema(item, s, root)) {
                return false;
            }
        }
    }
    if let Some(map) = value.as_object() {
        if schema["required"].as_array().is_some_and(|required| {
            required
                .iter()
                .any(|k| !map.contains_key(k.as_str().unwrap()))
        }) {
            return false;
        }
        for (key, item) in map {
            if let Some(names) = schema.get("propertyNames")
                && !matches_schema(&Value::String(key.clone()), names, root)
            {
                return false;
            }
            if let Some(property) = schema["properties"].get(key) {
                if !matches_schema(item, property, root) {
                    return false;
                }
            } else if let Some(additional) = schema.get("additionalProperties")
                && !matches_schema(item, additional, root)
            {
                return false;
            }
        }
    }
    true
}

pub(crate) fn manifest_consistent(manifest: &Value) -> Result<(), String> {
    let error = || "EVIDENCE_MANIFEST_INCONSISTENT".to_owned();
    let engine = manifest["decision"]["status"] == "ENGINE_ERROR";
    if engine
        != (manifest["repositoryDigest"] == "invalid"
            || manifest["policy"]["policyVersion"] == "invalid")
    {
        return Err(error());
    }
    if !engine {
        if manifest["adapter"]["kind"] != manifest["evidenceContext"]["adapter"]["name"]
            || manifest["isolation"]["level"]
                != manifest["evidenceContext"]["execution"]["isolation"]
            || !manifest["evidenceContext"]["adapter"]["configuration"].is_object()
            || manifest["evidenceContext"]["adapter"]["configuration"]["kind"]
                != manifest["adapter"]["kind"]
        {
            return Err(error());
        }
        if manifest["adapter"]["kind"] == "testforge-command"
            && (manifest["adapter"]["protocolVersion"]
                != manifest["evidenceContext"]["adapter"]["version"]
                || manifest["evidenceContext"]["adapter"]["configuration"]["protocolVersion"]
                    != manifest["adapter"]["protocolVersion"])
        {
            return Err(error());
        }
    }
    let worlds = manifest["worlds"].as_array().ok_or_else(error)?;
    let candidates = manifest["candidates"].as_array().ok_or_else(error)?;
    let observations = manifest["observations"].as_array().ok_or_else(error)?;
    let unique = |values: &[Value], key: &str| {
        values
            .iter()
            .map(|v| v[key].as_str().unwrap_or(""))
            .collect::<HashSet<_>>()
            .len()
            == values.len()
    };
    if !unique(worlds, "id") || !unique(candidates, "id") || !unique(observations, "runId") {
        return Err(error());
    }
    let context = a(&manifest["evidenceContext"]["worlds"]);
    let has = |values: &[Value], id: &Value, key: &str| values.iter().any(|v| v[key] == *id);
    if !unique(context, "id")
        || context.len() != worlds.len()
        || context.iter().any(|w| !has(worlds, &w["id"], "id"))
        || a(&manifest["decision"]["selectedCandidateIds"])
            .iter()
            .any(|id| !has(candidates, id, "id"))
        || observations.iter().any(|o| {
            !has(worlds, &o["worldId"], "id")
                || n(&o["candidateTestsDiscovered"]) > n(&o["testsDiscovered"])
                || (!o["candidateId"].is_null() && !has(candidates, &o["candidateId"], "id"))
        })
        || candidates.iter().any(|c| {
            a(&c["killedTargetIds"])
                .iter()
                .any(|id| !has(worlds, id, "id"))
                || a(&c["gates"]).iter().any(|g| {
                    a(&g["evidenceRunIds"])
                        .iter()
                        .any(|id| !has(observations, id, "runId"))
                })
        })
    {
        return Err(error());
    }
    Ok(())
}
pub(crate) fn n(v: &Value) -> f64 {
    v.as_f64().unwrap()
}
pub(crate) fn s(v: &Value) -> &str {
    v.as_str().unwrap()
}
pub(crate) fn a(v: &Value) -> &[Value] {
    v.as_array().unwrap()
}
pub(crate) fn ordinal(a: &str, b: &str) -> std::cmp::Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}
pub(crate) fn normalize(v: &mut Value) {
    match v {
        Value::Number(num) if num.is_f64() => {
            let number = num.as_f64().unwrap();
            if number.fract() == 0.0 && number.abs() <= 9_007_199_254_740_991.0 {
                *v = serde_json::json!(number as i64);
            }
        }
        Value::Array(values) => values.iter_mut().for_each(normalize),
        Value::Object(values) => values.values_mut().for_each(normalize),
        _ => {}
    }
}
