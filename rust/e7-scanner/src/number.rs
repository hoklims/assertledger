//! The JavaScript number conversions the TypeScript scanner applies to numeric literal values:
//! `+text`, `parseInt(text, radix)` and `"" + number`, on the digit strings the scanner builds.

/// Digits of an unsigned integer in `radix`, as a decimal string without leading zeros.
pub(crate) fn radix_digits_to_decimal(digits: &[u16], radix: u32) -> String {
    // Little-endian limbs in base 10^9.
    let mut limbs: Vec<u64> = vec![0];
    for &unit in digits {
        let digit = (unit as u8 as char).to_digit(radix).unwrap_or(0) as u64;
        let mut carry = digit;
        for limb in limbs.iter_mut() {
            let value = *limb * radix as u64 + carry;
            *limb = value % 1_000_000_000;
            carry = value / 1_000_000_000;
        }
        while carry > 0 {
            limbs.push(carry % 1_000_000_000);
            carry /= 1_000_000_000;
        }
    }
    let mut decimal = limbs
        .last()
        .map(|limb| limb.to_string())
        .unwrap_or_default();
    for limb in limbs.iter().rev().skip(1) {
        decimal.push_str(&format!("{limb:09}"));
    }
    decimal
}

/// `+text` for the decimal strings the scanner builds: digits, `.`, an exponent, or nothing.
pub(crate) fn decimal_to_number(text: &str) -> f64 {
    if text.is_empty() {
        return 0.0;
    }
    text.parse::<f64>().unwrap_or(f64::NAN)
}

/// `parseInt(digits, radix)` for a power-of-two radix, correctly rounded like V8.
pub(crate) fn radix_to_number(digits: &[u16], radix: u32) -> f64 {
    if digits.is_empty() {
        return f64::NAN;
    }
    radix_digits_to_decimal(digits, radix)
        .parse::<f64>()
        .unwrap_or(f64::NAN)
}

/// `Number.prototype.toString()` in radix 10 (ECMA-262 Number::toString).
pub(crate) fn number_to_string(value: f64) -> String {
    if value.is_nan() {
        return "NaN".to_owned();
    }
    if value == 0.0 {
        return "0".to_owned();
    }
    if value.is_infinite() {
        return if value > 0.0 { "Infinity" } else { "-Infinity" }.to_owned();
    }
    let sign = if value < 0.0 { "-" } else { "" };
    // Rust's shortest round-trip digits, as `d.ddde±x`.
    let exponential = format!("{:e}", value.abs());
    let (mantissa, exponent) = exponential.split_once('e').unwrap_or((&exponential, "0"));
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i64;
    let n = exponent.parse::<i64>().unwrap_or(0) + 1;
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        let exponent_sign = if e < 0 { "-" } else { "+" };
        if k == 1 {
            format!("{digits}e{exponent_sign}{}", e.abs())
        } else {
            format!(
                "{}.{}e{exponent_sign}{}",
                &digits[..1],
                &digits[1..],
                e.abs()
            )
        }
    };
    format!("{sign}{body}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_like_javascript() {
        let cases = [
            (1.0, "1"),
            (0.5, "0.5"),
            (1e21, "1e+21"),
            (1e20, "100000000000000000000"),
            (1.5e-7, "1.5e-7"),
            (0.000001, "0.000001"),
            (123456789012345680000.0, "123456789012345680000"),
            (1.2345678901234568e29, "1.2345678901234568e+29"),
            (f64::INFINITY, "Infinity"),
        ];
        for (value, expected) in cases {
            assert_eq!(number_to_string(value), expected, "{value}");
        }
    }

    #[test]
    fn converts_radix_digits() {
        let units = |s: &str| s.encode_utf16().collect::<Vec<u16>>();
        assert_eq!(radix_digits_to_decimal(&units("ff"), 16), "255");
        assert_eq!(radix_digits_to_decimal(&units("0001"), 2), "1");
        assert_eq!(radix_digits_to_decimal(&units("0"), 8), "0");
        assert_eq!(
            radix_digits_to_decimal(&units("ffffffffffffffffffff"), 16),
            "1208925819614629174706175"
        );
    }
}
