use std::{fs, path::PathBuf};

use serde_json::Value;

#[test]
fn decisions_match_frozen_published_fixtures() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..").join("conformance/v1");
    let bundle: Value = serde_json::from_slice(&fs::read(root.join("bundle.json")).unwrap()).unwrap();
    let mut checked = 0;
    for case in bundle["cases"].as_array().unwrap() {
        let operation = match case["operation"].as_str().unwrap() {
            "CANONICALIZE" => "canonicalize",
            "DECIDE_EVIDENCE" => "decideEvidence",
            "REPLAY_EVIDENCE" => "replayEvidenceManifest",
            _ => continue,
        };
        let input: Value = serde_json::from_slice(&fs::read(root.join(case["inputPath"].as_str().unwrap())).unwrap()).unwrap();
        let expected: Value = serde_json::from_slice(&fs::read(root.join(case["expectedPath"].as_str().unwrap())).unwrap()).unwrap();
        let actual = if operation == "canonicalize" {
            serde_json::json!({
                "canonical": assertledger_core::dispatch("canonicalize", &[input.clone()]).unwrap(),
                "digest": assertledger_core::dispatch("sha256Canonical", &[input]).unwrap(),
            })
        } else {
            assertledger_core::dispatch(operation, &[input]).unwrap()
        };
        assert_eq!(actual, expected, "{}", case["id"].as_str().unwrap());
        checked += 1;
    }
    assert!(checked >= 10, "the published decision corpus must execute");
}

