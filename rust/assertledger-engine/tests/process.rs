use assertledger_engine::run_process;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
fn input(args: &[&str]) -> Value {
    json!({"executable":env!("CARGO_BIN_EXE_process_fixture"),"args":args,"cwd":std::env::temp_dir(),"environment":{},"timeoutMs":1500,"maximumOutputBytes":128})
}
#[tokio::test]
async fn outputs_have_independent_budgets_and_full_digests() {
    let r = run_process(input(&["output"])).await.unwrap();
    assert_eq!(r["outcome"], "PASS");
    assert_eq!(r["stdout"]["totalBytes"], 10000);
    assert_eq!(r["stdout"]["text"].as_str().unwrap().len(), 128);
    assert_eq!(
        r["stdout"]["digest"],
        format!("sha256:{:x}", Sha256::digest([b'x'; 10000]))
    );
    assert_eq!(r["stderr"]["text"], "é�");
    assert_eq!(r["stderr"]["truncated"], false);
    let mut i = input(&["output"]);
    i["maximumOutputBytes"] = json!(1);
    let r = run_process(i).await.unwrap();
    assert_eq!(r["stderr"]["text"], "");
    assert_eq!(r["stderr"]["totalBytes"], 5);
}
#[tokio::test]
async fn literal_arguments_crashes_and_spawn_errors() {
    let text = "$(echo injected); & | >";
    let r = run_process(input(&["literal", text])).await.unwrap();
    assert_eq!(r["stdout"]["text"], text);
    let r = run_process(input(&["crash"])).await.unwrap();
    assert_eq!(r["outcome"], "PROCESS_CRASH");
    assert_eq!(r["exitCode"], 7);
    let mut i = input(&[]);
    i["executable"] = json!("assertledger-no-such-command-7381");
    let r = run_process(i).await.unwrap();
    assert_eq!(r["outcome"], "INFRA_ERROR");
    assert!(r["error"].is_string());
}
#[tokio::test]
async fn validates_inputs_and_cwd() {
    for (key, value) in [
        ("timeoutMs", json!(0)),
        ("timeoutMs", json!(9007199254740992_u64)),
        ("maximumOutputBytes", json!(1.5)),
        ("environment", json!({"A=B":"x"})),
        ("environment", json!({"A":null})),
        ("args", json!([1])),
    ] {
        let mut i = input(&["sleep"]);
        i[key] = value;
        assert!(run_process(i).await.is_err(), "{key}");
    }
    let mut i = input(&[]);
    i["cwd"] = json!(env!("CARGO_BIN_EXE_process_fixture"));
    assert_eq!(run_process(i).await.unwrap_err(), "INVALID_CWD");
}
#[tokio::test]
async fn deadlines_include_descendant_open_pipes() {
    for mode in ["sleep", "descendant"] {
        let mut i = input(&[mode]);
        i["timeoutMs"] = json!(100);
        let start = std::time::Instant::now();
        let r = run_process(i).await.unwrap();
        assert_eq!(r["outcome"], "TIMEOUT");
        assert_eq!(r["timedOut"], true);
        assert!(start.elapsed().as_millis() < 1500);
    }
}
#[tokio::test]
async fn environment_is_explicit_and_cleared() {
    // Cargo's inherited metadata is not one of libuv's required Windows names.
    assert!(std::env::var_os("CARGO_MANIFEST_DIR").is_some());
    let r = run_process(input(&["env", "CARGO_MANIFEST_DIR"]))
        .await
        .unwrap();
    assert_eq!(r["stdout"]["text"], "");
    let mut i = input(&["env", "ASSERTLEDGER_EXPLICIT"]);
    i["environment"] = json!({"ASSERTLEDGER_EXPLICIT":"native-value"});
    let r = run_process(i).await.unwrap();
    assert_eq!(r["stdout"]["text"], "native-value");
    #[cfg(windows)]
    {
        let mut i = input(&["env", "PATH"]);
        i["environment"] = json!({"path":"explicit-path"});
        assert_eq!(
            run_process(i).await.unwrap()["stdout"]["text"],
            "explicit-path"
        );
    }
}
#[tokio::test]
async fn timeout_terminates_live_parent_descendants() {
    let mut i = input(&["tree"]);
    i["timeoutMs"] = json!(500);
    let r = run_process(i).await.unwrap();
    assert_eq!(r["outcome"], "TIMEOUT");
    let pid: u32 = r["stdout"]["text"]
        .as_str()
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    #[cfg(windows)]
    {
        // Windows tree cleanup can complete after the bounded public grace period.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(6);
        loop {
            let output = std::process::Command::new("tasklist.exe")
                .args(["/FI", &format!("PID eq {pid}"), "/NH"])
                .output()
                .unwrap();
            let exists = String::from_utf8_lossy(&output.stdout)
                .split_whitespace()
                .any(|word| word == pid.to_string());
            if !exists {
                break;
            }
            if std::time::Instant::now() >= deadline {
                // Clean only this fixture descendant before reporting the failure.
                let _ = std::process::Command::new("taskkill.exe")
                    .args(["/PID", &pid.to_string(), "/F", "/T"])
                    .output();
                panic!("fixture descendant survived bounded native cleanup");
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
    }
    #[cfg(unix)]
    {
        // ps works on both Linux and macOS; /proc alone would silently omit macOS.
        let output = std::process::Command::new("ps")
            .args(["-o", "stat=", "-p", &pid.to_string()])
            .output()
            .unwrap();
        let state = String::from_utf8_lossy(&output.stdout);
        assert!(
            state.trim().is_empty() || state.trim().starts_with('Z'),
            "descendant is still running: {state}"
        );
    }
}
