//! Operating-system boundary for native process supervision.

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    process::{ExitStatus, Stdio},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
};

struct Capture {
    hash: Sha256,
    bytes: Vec<u8>,
    total: u64,
    maximum: usize,
}
impl Capture {
    fn new(maximum: usize) -> Self {
        Self {
            hash: Sha256::new(),
            bytes: Vec::new(),
            total: 0,
            maximum,
        }
    }
    fn add(&mut self, bytes: &[u8]) {
        self.hash.update(bytes);
        self.total += bytes.len() as u64;
        self.bytes
            .extend_from_slice(&bytes[..bytes.len().min(self.maximum - self.bytes.len())]);
    }
    fn finish(&self) -> Value {
        let decoded = String::from_utf8_lossy(&self.bytes);
        let mut text = String::new();
        for character in decoded.chars() {
            if text.len() + character.len_utf8() > self.maximum {
                break;
            }
            text.push(character);
        }
        json!({"text":text,"totalBytes":self.total,"truncated":self.total>self.bytes.len() as u64,"digest":format!("sha256:{:x}",self.hash.clone().finalize())})
    }
}
async fn drain(mut stream: impl AsyncRead + Unpin, capture: Arc<Mutex<Capture>>) {
    let mut buffer = [0; 8192];
    loop {
        match stream.read(&mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(n) => capture.lock().unwrap().add(&buffer[..n]),
        }
    }
}
fn positive(input: &Value, key: &str, error: &str) -> Result<u64, String> {
    input[key]
        .as_f64()
        .filter(|n| n.is_finite() && *n > 0.0 && *n <= 9_007_199_254_740_991.0 && n.fract() == 0.0)
        .map(|n| n as u64)
        .ok_or_else(|| error.into())
}
fn string<'a>(input: &'a Value, key: &str, error: &str) -> Result<&'a str, String> {
    input[key]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| error.into())
}
#[cfg(unix)]
fn signal(status: Option<ExitStatus>) -> Option<String> {
    use std::os::unix::process::ExitStatusExt;
    status.and_then(|s| s.signal()).map(|s| match s {
        libc::SIGKILL => "SIGKILL".into(),
        libc::SIGTERM => "SIGTERM".into(),
        libc::SIGABRT => "SIGABRT".into(),
        libc::SIGSEGV => "SIGSEGV".into(),
        libc::SIGINT => "SIGINT".into(),
        libc::SIGPIPE => "SIGPIPE".into(),
        _ => format!("SIG{s}"),
    })
}
#[cfg(windows)]
fn signal(_status: Option<ExitStatus>) -> Option<String> {
    None
}

/// Executes an executable plus literal argv with an explicit environment. This is
/// trusted-local supervision, not a containment or sandbox boundary.
pub async fn run_process(input: Value) -> Result<Value, String> {
    if !input.is_object() {
        return Err("INVALID_PROCESS_INPUT".into());
    }
    let environment = input["environment"]
        .as_object()
        .ok_or("INVALID_ENVIRONMENT")?;
    if environment
        .iter()
        .any(|(key, value)| key.contains('=') || !value.is_string())
    {
        return Err("INVALID_ENVIRONMENT".into());
    }
    let args = input["args"].as_array().ok_or("INVALID_ARGS")?;
    let args: Vec<&str> = args
        .iter()
        .map(|a| a.as_str().ok_or("INVALID_ARGS"))
        .collect::<Result<_, _>>()?;
    let executable = string(&input, "executable", "INVALID_EXECUTABLE")?;
    let cwd = string(&input, "cwd", "INVALID_CWD")?;
    let timeout = positive(&input, "timeoutMs", "INVALID_TIMEOUT_MS")?;
    let maximum = usize::try_from(positive(
        &input,
        "maximumOutputBytes",
        "INVALID_MAXIMUM_OUTPUT_BYTES",
    )?)
    .map_err(|_| "INVALID_MAXIMUM_OUTPUT_BYTES")?;
    let cwd = std::fs::canonicalize(cwd).map_err(|e| e.to_string())?;
    if !cwd.is_dir() {
        return Err("INVALID_CWD".into());
    }
    let started = Instant::now();
    let stdout = Arc::new(Mutex::new(Capture::new(maximum)));
    let stderr = Arc::new(Mutex::new(Capture::new(maximum)));
    let mut command = Command::new(executable);
    command
        .args(args)
        .current_dir(cwd)
        .env_clear()
        .envs(environment.iter().map(|(k, v)| (k, v.as_str().unwrap())))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    #[cfg(unix)]
    command.process_group(0);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return Ok(
                json!({"outcome":"INFRA_ERROR","exitCode":null,"signal":null,"timedOut":false,"durationMs":started.elapsed().as_millis(),"stdout":stdout.lock().unwrap().finish(),"stderr":stderr.lock().unwrap().finish(),"error":error.to_string()}),
            );
        }
    };
    let pid = child.id();
    let mut out = tokio::spawn(drain(child.stdout.take().unwrap(), stdout.clone()));
    let mut err = tokio::spawn(drain(child.stderr.take().unwrap(), stderr.clone()));
    let mut status = None;
    let mut wait_error = None;
    let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout);
    let completed = tokio::time::timeout_at(deadline, async {
        match child.wait().await {
            Ok(s) => status = Some(s),
            Err(e) => wait_error = Some(e.to_string()),
        };
        let _ = tokio::join!(&mut out, &mut err);
    })
    .await
    .is_ok();
    if !completed {
        let grace = tokio::time::Instant::now() + Duration::from_millis(250);
        #[cfg(unix)]
        if let Some(pid) = pid {
            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
        }
        #[cfg(windows)]
        if let Some(pid) = pid {
            let mut killer = Command::new("taskkill.exe");
            killer
                .args(["/pid", &pid.to_string(), "/T", "/F"])
                .creation_flags(0x08000000)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .kill_on_drop(true);
            if let Ok(mut killer) = killer.spawn()
                && tokio::time::timeout_at(grace, killer.wait()).await.is_err()
            {
                // Preserve the parent for taskkill tree enumeration, while bounding
                // the public response and closing the captured streams immediately.
                out.abort();
                err.abort();
                tokio::spawn(async move {
                    let _ = tokio::time::timeout(Duration::from_secs(5), killer.wait()).await;
                    let _ = child.start_kill();
                    let _ = tokio::time::timeout(Duration::from_millis(250), child.wait()).await;
                });
                return Ok(
                    json!({"outcome":"TIMEOUT","exitCode":status.and_then(|s|s.code()),"signal":signal(status),"timedOut":true,"durationMs":started.elapsed().as_millis(),"stdout":stdout.lock().unwrap().finish(),"stderr":stderr.lock().unwrap().finish()}),
                );
            }
        }
        let _ = child.start_kill();
        // Completed JoinHandles cannot be polled twice. Drain only pending readers.
        let _ = tokio::time::timeout_at(grace, async {
            if status.is_none()
                && let Ok(s) = child.wait().await
            {
                status = Some(s);
            }
            if !out.is_finished() {
                let _ = (&mut out).await;
            }
            if !err.is_finished() {
                let _ = (&mut err).await;
            }
        })
        .await;
        out.abort();
        err.abort();
    }
    let outcome = if !completed {
        "TIMEOUT"
    } else if wait_error.is_some() {
        "INFRA_ERROR"
    } else if status.and_then(|s| s.code()) == Some(0) {
        "PASS"
    } else {
        "PROCESS_CRASH"
    };
    let mut result = json!({"outcome":outcome,"exitCode":status.and_then(|s|s.code()),"signal":signal(status),"timedOut":!completed,"durationMs":started.elapsed().as_millis(),"stdout":stdout.lock().unwrap().finish(),"stderr":stderr.lock().unwrap().finish()});
    if let Some(error) = wait_error {
        result["error"] = json!(error);
    }
    Ok(result)
}
