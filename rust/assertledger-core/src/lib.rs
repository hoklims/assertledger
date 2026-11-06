//! Pure evidence kernel for JSON inputs. The JSON dispatcher cannot represent
//! undefined, sparse arrays, cyclic references, object prototypes or lone UTF-16
//! surrogates. Native bindings must validate those JavaScript properties before
//! conversion; use `CanonicalValue` for lossless string canonicalization.
//! V1 profiles and benchmarks are supported; later versions and corpus operations
//! are intentionally unsupported here.
mod benchmark;
mod canonical;
mod evidence;
mod profile_contracts;
mod profiles;
pub use benchmark::{create_agentic_benchmark, replay_agentic_benchmark};
pub use canonical::{
    CanonicalValue, canonicalize, canonicalize_value, sha256_canonical, sha256_canonical_value,
};
pub use evidence::{
    decide_evidence, replay_evidence_manifest, seal_manifest_artifact, select_candidates,
    verify_decision_digest, verify_manifest_integrity,
};
pub use profiles::{create_agentic_profile, replay_agentic_profile};
use serde_json::{Value, json};

/// Pure JSON boundary. Unsupported operations fail explicitly.
pub fn dispatch(operation: &str, arguments: &[Value]) -> Result<Value, String> {
    let first = arguments
        .first()
        .ok_or_else(|| "Operation requires an argument".to_owned())?;
    match operation {
        "canonicalize" => Ok(json!(canonicalize(first))),
        "sha256Canonical" => Ok(json!(sha256_canonical(first))),
        "decideEvidence" => Ok(decide_evidence(first)),
        "sealManifestArtifact" => seal_manifest_artifact(first),
        "selectCandidates" => Ok(select_candidates(
            first,
            arguments.get(1).unwrap_or(&Value::Null),
        )),
        "verifyDecisionDigest" => Ok(verify_decision_digest(first)),
        "verifyManifestIntegrity" => Ok(verify_manifest_integrity(first)),
        "replayEvidenceManifest" => Ok(replay_evidence_manifest(first)),
        "createAgenticProfile" => create_agentic_profile(first),
        "replayAgenticProfile" => Ok(replay_agentic_profile(first)),
        "createAgenticBenchmark" => create_agentic_benchmark(first),
        "replayAgenticBenchmark" => Ok(replay_agentic_benchmark(first)),
        _ => Err(format!("Unsupported operation: {operation}")),
    }
}
