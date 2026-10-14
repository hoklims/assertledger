use serde_json::Value;

/// Pure operation boundary for the native implementation.
pub fn dispatch(_operation: &str, _arguments: &[Value]) -> Result<Value, String> {
    Ok(Value::Null)
}

