use serde_json::Value;
use sha2::{Digest, Sha256};

/// UTF-16 strings retain lone surrogates, unlike serde_json Unicode strings.
#[derive(Clone, Debug)]
pub enum CanonicalValue {
    Null,
    Bool(bool),
    Number(f64),
    String(Vec<u16>),
    Array(Vec<CanonicalValue>),
    Object(Vec<(Vec<u16>, CanonicalValue)>),
}
impl From<&Value> for CanonicalValue {
    fn from(value: &Value) -> Self {
        match value {
            Value::Null => Self::Null,
            Value::Bool(v) => Self::Bool(*v),
            Value::Number(v) => Self::Number(v.as_f64().expect("JSON number is finite")),
            Value::String(v) => Self::String(v.encode_utf16().collect()),
            Value::Array(v) => Self::Array(v.iter().map(Self::from).collect()),
            Value::Object(v) => Self::Object(
                v.iter()
                    .map(|(k, v)| (k.encode_utf16().collect(), Self::from(v)))
                    .collect(),
            ),
        }
    }
}
fn quote(units: &[u16]) -> String {
    let mut result = String::from("\"");
    let mut index = 0;
    while index < units.len() {
        let unit = units[index];
        match unit {
            0x22 => result.push_str("\\\""),
            0x5c => result.push_str("\\\\"),
            8 => result.push_str("\\b"),
            9 => result.push_str("\\t"),
            10 => result.push_str("\\n"),
            12 => result.push_str("\\f"),
            13 => result.push_str("\\r"),
            0..=31 => result.push_str(&format!("\\u{unit:04x}")),
            0xd800..=0xdbff
                if units
                    .get(index + 1)
                    .is_some_and(|v| (0xdc00..=0xdfff).contains(v)) =>
            {
                let code =
                    0x10000 + (((unit as u32 - 0xd800) << 10) | (units[index + 1] as u32 - 0xdc00));
                result.push(char::from_u32(code).expect("surrogate pair"));
                index += 1;
            }
            0xd800..=0xdfff => result.push_str(&format!("\\u{unit:04x}")),
            _ => result.push(char::from_u32(unit as u32).expect("non-surrogate")),
        }
        index += 1;
    }
    result.push('"');
    result
}
pub fn canonicalize_value(value: &CanonicalValue) -> Result<String, String> {
    Ok(match value {
        CanonicalValue::Null => "null".into(),
        CanonicalValue::Bool(v) => v.to_string(),
        CanonicalValue::Number(v) => {
            if !v.is_finite() {
                return Err("Canonical JSON requires finite numbers".into());
            }
            ryu_js::Buffer::new().format(*v).to_owned()
        }
        CanonicalValue::String(v) => quote(v),
        CanonicalValue::Array(v) => format!(
            "[{}]",
            v.iter()
                .map(canonicalize_value)
                .collect::<Result<Vec<_>, _>>()?
                .join(",")
        ),
        CanonicalValue::Object(v) => {
            let mut entries = v.iter().collect::<Vec<_>>();
            entries.sort_by(|a, b| a.0.cmp(&b.0));
            if entries.windows(2).any(|w| w[0].0 == w[1].0) {
                return Err("Canonical JSON object has duplicate keys".into());
            }
            format!(
                "{{{}}}",
                entries
                    .into_iter()
                    .map(|(k, v)| Ok(format!("{}:{}", quote(k), canonicalize_value(v)?)))
                    .collect::<Result<Vec<_>, String>>()?
                    .join(",")
            )
        }
    })
}
pub fn canonicalize(value: &Value) -> String {
    canonicalize_value(&CanonicalValue::from(value)).expect("serde_json values are canonical JSON")
}
pub fn sha256_canonical_value(value: &CanonicalValue) -> Result<String, String> {
    Ok(format!(
        "sha256:{:x}",
        Sha256::digest(canonicalize_value(value)?.as_bytes())
    ))
}
pub fn sha256_canonical(value: &Value) -> String {
    format!(
        "sha256:{:x}",
        Sha256::digest(canonicalize(value).as_bytes())
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ecmascript_numbers_and_utf16() {
        assert_eq!(
            canonicalize_value(&CanonicalValue::Number(-0.0)).unwrap(),
            "0"
        );
        assert_eq!(
            canonicalize_value(&CanonicalValue::Number(1e21)).unwrap(),
            "1e+21"
        );
        assert_eq!(
            canonicalize_value(&CanonicalValue::Number(1e-7)).unwrap(),
            "1e-7"
        );
        assert_eq!(
            canonicalize_value(&CanonicalValue::String(vec![0xd800, 0x61, 0xdc00])).unwrap(),
            "\"\\ud800a\\udc00\""
        );
        let value = CanonicalValue::Object(vec![
            (vec![0xe000], CanonicalValue::Null),
            (vec![0xd800, 0xdc00], CanonicalValue::Null),
        ]);
        assert_eq!(
            canonicalize_value(&value).unwrap(),
            "{\"𐀀\":null,\"\u{e000}\":null}"
        );
        assert!(canonicalize_value(&CanonicalValue::Number(f64::NAN)).is_err());
    }
}
