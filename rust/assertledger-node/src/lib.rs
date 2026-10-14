//! Node-API transport; decision authority remains in the pure core.

use assertledger_core::CanonicalValue;
use napi::{Env, JsValue, Result, bindgen_prelude::Unknown, sys};
use napi_derive::napi;
use std::ptr;

fn call_builtin(
    env: sys::napi_env,
    constructor: &std::ffi::CStr,
    method: &std::ffi::CStr,
    argument: sys::napi_value,
) -> Result<sys::napi_value> {
    let mut global = ptr::null_mut();
    let mut receiver = ptr::null_mut();
    let mut function = ptr::null_mut();
    let mut result = ptr::null_mut();
    unsafe {
        checked(sys::napi_get_global(env, &mut global))?;
        checked(sys::napi_get_named_property(
            env,
            global,
            constructor.as_ptr(),
            &mut receiver,
        ))?;
        checked(sys::napi_get_named_property(
            env,
            receiver,
            method.as_ptr(),
            &mut function,
        ))?;
        checked(sys::napi_call_function(
            env,
            receiver,
            function,
            1,
            &argument,
            &mut result,
        ))?;
    }
    Ok(result)
}

fn checked(status: sys::napi_status) -> Result<()> {
    if status == sys::Status::napi_ok {
        Ok(())
    } else {
        Err(napi::Error::new(
            napi::Status::from(status),
            "Node-API value access failed",
        ))
    }
}

fn invalid(message: &str) -> napi::Error {
    napi::Error::new(napi::Status::InvalidArg, message)
}

// All handles are borrowed from the active Node callback and remain on its JS thread.
// Every FFI status is checked before reading a returned pointer or primitive value.
fn utf16(env: sys::napi_env, value: sys::napi_value) -> Result<Vec<u16>> {
    let mut length = 0;
    unsafe {
        checked(sys::napi_get_value_string_utf16(
            env,
            value,
            ptr::null_mut(),
            0,
            &mut length,
        ))?;
    }
    let mut units = vec![0; length + 1];
    unsafe {
        checked(sys::napi_get_value_string_utf16(
            env,
            value,
            units.as_mut_ptr(),
            units.len(),
            &mut length,
        ))?;
    }
    units.truncate(length);
    Ok(units)
}

fn equal(env: sys::napi_env, left: sys::napi_value, right: sys::napi_value) -> Result<bool> {
    let mut result = false;
    unsafe {
        checked(sys::napi_strict_equals(env, left, right, &mut result))?;
    }
    Ok(result)
}

fn read_value(
    env: sys::napi_env,
    value: sys::napi_value,
    ancestors: &mut Vec<sys::napi_value>,
) -> Result<CanonicalValue> {
    let mut kind = sys::ValueType::napi_undefined;
    unsafe {
        checked(sys::napi_typeof(env, value, &mut kind))?;
    }
    match kind {
        sys::ValueType::napi_null => Ok(CanonicalValue::Null),
        sys::ValueType::napi_boolean => {
            let mut boolean = false;
            unsafe {
                checked(sys::napi_get_value_bool(env, value, &mut boolean))?;
            }
            Ok(CanonicalValue::Bool(boolean))
        }
        sys::ValueType::napi_number => {
            let mut number = 0.0;
            unsafe {
                checked(sys::napi_get_value_double(env, value, &mut number))?;
            }
            if !number.is_finite() {
                return Err(invalid("Canonical JSON requires finite numbers"));
            }
            Ok(CanonicalValue::Number(number))
        }
        sys::ValueType::napi_string => Ok(CanonicalValue::String(utf16(env, value)?)),
        sys::ValueType::napi_object => {
            if ancestors.len() >= 512 {
                return Err(invalid("Native canonicalization nesting limit exceeded"));
            }
            for ancestor in ancestors.iter() {
                if equal(env, *ancestor, value)? {
                    return Err(invalid("Canonical JSON cannot contain cycles"));
                }
            }
            ancestors.push(value);
            let result = read_object(env, value, ancestors);
            ancestors.pop();
            result
        }
        sys::ValueType::napi_undefined => Err(invalid("undefined is not a canonical JSON value")),
        _ => Err(invalid("Unsupported canonical JSON value")),
    }
}

fn read_object(
    env: sys::napi_env,
    value: sys::napi_value,
    ancestors: &mut Vec<sys::napi_value>,
) -> Result<CanonicalValue> {
    let mut array = false;
    unsafe {
        checked(sys::napi_is_array(env, value, &mut array))?;
    }
    // Node-API's native IsArray does not classify Proxy arrays like JS Array.isArray.
    // Refuse the currently unsupported conversion instead of sealing object-shaped bytes.
    let js_array = call_builtin(env, c"Array", c"isArray", value)?;
    let mut array_from_js = false;
    unsafe {
        checked(sys::napi_get_value_bool(env, js_array, &mut array_from_js))?;
    }
    if array_from_js && !array {
        return Err(invalid(
            "Native canonicalization does not yet support Proxy arrays",
        ));
    }
    if array {
        let mut items = Vec::new();
        let mut index = 0;
        loop {
            let mut length = 0;
            unsafe {
                checked(sys::napi_get_array_length(env, value, &mut length))?;
            }
            if index >= length {
                break;
            }
            let mut exists = false;
            unsafe {
                checked(sys::napi_has_element(env, value, index, &mut exists))?;
            }
            if !exists {
                return Err(invalid("Canonical JSON arrays cannot contain holes"));
            }
            let mut item = ptr::null_mut();
            unsafe {
                checked(sys::napi_get_element(env, value, index, &mut item))?;
            }
            items.push(read_value(env, item, ancestors)?);
            index += 1;
        }
        return Ok(CanonicalValue::Array(items));
    }

    let prototype = call_builtin(env, c"Object", c"getPrototypeOf", value)?;
    let mut null = ptr::null_mut();
    let mut global = ptr::null_mut();
    let mut object = ptr::null_mut();
    let mut plain_prototype = ptr::null_mut();
    unsafe {
        checked(sys::napi_get_null(env, &mut null))?;
        checked(sys::napi_get_global(env, &mut global))?;
        checked(sys::napi_get_named_property(
            env,
            global,
            c"Object".as_ptr(),
            &mut object,
        ))?;
        checked(sys::napi_get_named_property(
            env,
            object,
            c"prototype".as_ptr(),
            &mut plain_prototype,
        ))?;
    }
    if !equal(env, prototype, null)? && !equal(env, prototype, plain_prototype)? {
        return Err(invalid("Canonical JSON requires plain objects"));
    }

    let mut names = ptr::null_mut();
    let mut length = 0;
    unsafe {
        checked(sys::napi_get_all_property_names(
            env,
            value,
            sys::KeyCollectionMode::own_only,
            sys::KeyFilter::enumerable | sys::KeyFilter::skip_symbols,
            sys::KeyConversion::numbers_to_strings,
            &mut names,
        ))?;
        checked(sys::napi_get_array_length(env, names, &mut length))?;
    }
    let mut entries = Vec::new();
    // Snapshot and sort the keys before reading properties, matching Object.keys().sort().
    for index in 0..length {
        let mut key = ptr::null_mut();
        unsafe {
            checked(sys::napi_get_element(env, names, index, &mut key))?;
        }
        entries.push((utf16(env, key)?, key));
    }
    entries.sort_by(|left, right| left.0.cmp(&right.0));
    let mut fields = Vec::new();
    for (units, key) in entries {
        let mut item = ptr::null_mut();
        unsafe {
            checked(sys::napi_get_property(env, value, key, &mut item))?;
        }
        fields.push((units, read_value(env, item, ancestors)?));
    }
    Ok(CanonicalValue::Object(fields))
}

#[napi]
pub fn canonicalize(env: Env, input: Unknown<'_>) -> Result<String> {
    let value = read_value(env.raw(), input.raw(), &mut Vec::new())?;
    assertledger_core::canonicalize_value(&value).map_err(napi::Error::from_reason)
}

#[napi]
pub fn sha256_canonical(env: Env, input: Unknown<'_>) -> Result<String> {
    let value = read_value(env.raw(), input.raw(), &mut Vec::new())?;
    assertledger_core::sha256_canonical_value(&value).map_err(napi::Error::from_reason)
}

#[napi]
pub fn dispatch_json(operation: String, arguments_json: String) -> Result<String> {
    let arguments: Vec<serde_json::Value> = serde_json::from_str(&arguments_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))?;
    let value =
        assertledger_core::dispatch(&operation, &arguments).map_err(napi::Error::from_reason)?;
    serde_json::to_string(&value).map_err(|error| napi::Error::from_reason(error.to_string()))
}

#[napi]
pub fn dispatch_value(env: Env, operation: String, arguments: Unknown<'_>) -> Result<String> {
    let value = read_value(env.raw(), arguments.raw(), &mut Vec::new())?;
    let encoded =
        assertledger_core::canonicalize_value(&value).map_err(napi::Error::from_reason)?;
    dispatch_json(operation, encoded)
}

#[napi]
pub async fn run_process_json(input_json: String) -> Result<String> {
    let input = serde_json::from_str(&input_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))?;
    let result = assertledger_engine::run_process(input)
        .await
        .map_err(napi::Error::from_reason)?;
    serde_json::to_string(&result).map_err(|error| napi::Error::from_reason(error.to_string()))
}
