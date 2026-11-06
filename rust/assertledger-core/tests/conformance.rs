use std::{
    fs,
    path::{Path, PathBuf},
};

use serde_json::Value;
use sha2::{Digest, Sha256};

// Same published authority as scripts/conformance-v1-lock.ts; never regenerate
// this constant from a candidate's outputs when changing the native implementation.
const FROZEN_ROOT_DIGEST: &str =
    "sha256:ba273caef39191105f3f8ab5d0c52a5c231dc4c8b6e7bd51cdbfdf1868d4d9bb";

fn walk(root: &Path, directory: &Path, paths: &mut Vec<String>) {
    for entry in fs::read_dir(directory).unwrap() {
        let path = entry.unwrap().path();
        let metadata = fs::symlink_metadata(&path).unwrap();
        if metadata.is_dir() {
            walk(root, &path, paths);
        } else {
            assert!(metadata.is_file(), "CONFORMANCE_SPECIAL_FILE_FORBIDDEN");
            paths.push(
                path.strip_prefix(root)
                    .unwrap()
                    .to_str()
                    .unwrap()
                    .replace('\\', "/"),
            );
        }
    }
}

fn verify_frozen_bytes(root: &Path) {
    let mut paths = Vec::new();
    walk(root, root, &mut paths);
    paths.sort();
    let mut hash = Sha256::new();
    for path in paths {
        let digest = format!(
            "sha256:{:x}",
            Sha256::digest(fs::read(root.join(&path)).unwrap())
        );
        hash.update(format!("{path}\0{digest}\n"));
    }
    assert_eq!(
        format!("sha256:{:x}", hash.finalize()),
        FROZEN_ROOT_DIGEST,
        "CONFORMANCE_V1_ROOT_DIGEST_MISMATCH"
    );
}

#[test]
fn decisions_match_frozen_published_fixtures() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join("conformance/v1");
    verify_frozen_bytes(&root);
    let bundle: Value =
        serde_json::from_slice(&fs::read(root.join("bundle.json")).unwrap()).unwrap();
    let mut checked = 0;
    for case in bundle["cases"].as_array().unwrap() {
        let operation = match case["operation"].as_str().unwrap() {
            "CANONICALIZE" => "canonicalize",
            "DECIDE_EVIDENCE" => "decideEvidence",
            "REPLAY_EVIDENCE" => "replayEvidenceManifest",
            "CREATE_PROFILE_V1" => "createAgenticProfile",
            "CREATE_BENCHMARK_V1" => "createAgenticBenchmark",
            "REPLAY_BENCHMARK_V1" => "replayAgenticBenchmark",
            other => panic!("Unsupported frozen corpus operation: {other}"),
        };
        let input: Value = serde_json::from_slice(
            &fs::read(root.join(case["inputPath"].as_str().unwrap())).unwrap(),
        )
        .unwrap();
        let expected: Value = serde_json::from_slice(
            &fs::read(root.join(case["expectedPath"].as_str().unwrap())).unwrap(),
        )
        .unwrap();
        let actual = if operation == "canonicalize" {
            serde_json::json!({
                "canonical": assertledger_core::dispatch("canonicalize", std::slice::from_ref(&input)).unwrap(),
                "digest": assertledger_core::dispatch("sha256Canonical", &[input]).unwrap(),
            })
        } else {
            assertledger_core::dispatch(operation, &[input]).unwrap()
        };
        assert_eq!(actual, expected, "{}", case["id"].as_str().unwrap());
        checked += 1;
    }
    assert_eq!(checked, bundle["cases"].as_array().unwrap().len());
}
