//! E7: a std-only Rust port of the token and module specifier scan of AssertLedger
//! (`src/engine/javascript-tokens.ts`, `scanModuleSpecifiers` in `src/engine/test-closure.ts`).
//!
//! The reference is the scanner of typescript@7.0.2 (`dist/ast/scanner.js`) created with
//! `createScanner(true)`: trivia skipped, standard language variant, no JSDoc mode. Text is
//! UTF-16 code units and every position is a code unit offset, as in JavaScript. Behaviors of the
//! reference are kept even where they look accidental (the runtime `ogham` constant is U+1685, an
//! identifier escape after other parts drops them, a token value outlives its token).

mod number;
mod unicode;

/// One token: its first `SyntaxKind` name, UTF-16 bounds, and the scanner's token value.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Token {
    pub kind: &'static str,
    pub start: usize,
    pub end: usize,
    pub value: Option<Vec<u16>>,
}

/// `JAVASCRIPT_TOKENIZATION_FAILED` at a code unit position.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TokenizationFailed {
    pub position: usize,
}

/// Literal module specifiers of one text, in first-seen order, and whether one is computed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SpecifierScan {
    pub specifiers: Vec<Vec<u16>>,
    pub non_literal: bool,
}

/// A code unit or code point past the text: JavaScript's `NaN` or `undefined`.
const NONE: u32 = u32::MAX;

const PRECEDING_LINE_BREAK: u32 = 1 << 0;
const SCIENTIFIC: u32 = 1 << 1;
const BINARY_SPECIFIER: u32 = 1 << 2;
const OCTAL_SPECIFIER: u32 = 1 << 3;
const CONTAINS_SEPARATOR: u32 = 1 << 4;
const CONTAINS_LEADING_ZERO: u32 = 1 << 5;
const BINARY_OR_OCTAL_SPECIFIER: u32 = BINARY_SPECIFIER | OCTAL_SPECIFIER;

const ESCAPE_STRING: u32 = 1 << 0;
const ESCAPE_REPORT_ERRORS: u32 = 1 << 1;
const ESCAPE_REGULAR_EXPRESSION: u32 = 1 << 2;
const ESCAPE_ANY_UNICODE_MODE: u32 = 1 << 4;
const ESCAPE_REPORT_INVALID: u32 = ESCAPE_REGULAR_EXPRESSION | ESCAPE_REPORT_ERRORS;

const LINE_FEED: u32 = 0x0A;
const CARRIAGE_RETURN: u32 = 0x0D;
const LINE_SEPARATOR: u32 = 0x2028;
const PARAGRAPH_SEPARATOR: u32 = 0x2029;
/// `CharacterCodes.ogham` as typescript@7.0.2 ships it at run time (`characterCodes.js`).
const OGHAM: u32 = 5765;
const REPLACEMENT_CHARACTER: u32 = 0xFFFD;

const KEYWORDS: [(&str, &str); 84] = [
    ("abstract", "AbstractKeyword"),
    ("accessor", "AccessorKeyword"),
    ("any", "AnyKeyword"),
    ("as", "AsKeyword"),
    ("asserts", "AssertsKeyword"),
    ("assert", "AssertKeyword"),
    ("bigint", "BigIntKeyword"),
    ("boolean", "BooleanKeyword"),
    ("break", "BreakKeyword"),
    ("case", "CaseKeyword"),
    ("catch", "CatchKeyword"),
    ("class", "ClassKeyword"),
    ("continue", "ContinueKeyword"),
    ("const", "ConstKeyword"),
    ("constructor", "ConstructorKeyword"),
    ("debugger", "DebuggerKeyword"),
    ("declare", "DeclareKeyword"),
    ("default", "DefaultKeyword"),
    ("defer", "DeferKeyword"),
    ("delete", "DeleteKeyword"),
    ("do", "DoKeyword"),
    ("else", "ElseKeyword"),
    ("enum", "EnumKeyword"),
    ("export", "ExportKeyword"),
    ("extends", "ExtendsKeyword"),
    ("false", "FalseKeyword"),
    ("finally", "FinallyKeyword"),
    ("for", "ForKeyword"),
    ("from", "FromKeyword"),
    ("function", "FunctionKeyword"),
    ("get", "GetKeyword"),
    ("if", "IfKeyword"),
    ("implements", "ImplementsKeyword"),
    ("import", "ImportKeyword"),
    ("in", "InKeyword"),
    ("infer", "InferKeyword"),
    ("instanceof", "InstanceOfKeyword"),
    ("interface", "InterfaceKeyword"),
    ("intrinsic", "IntrinsicKeyword"),
    ("is", "IsKeyword"),
    ("keyof", "KeyOfKeyword"),
    ("let", "LetKeyword"),
    ("module", "ModuleKeyword"),
    ("namespace", "NamespaceKeyword"),
    ("never", "NeverKeyword"),
    ("new", "NewKeyword"),
    ("null", "NullKeyword"),
    ("number", "NumberKeyword"),
    ("object", "ObjectKeyword"),
    ("package", "PackageKeyword"),
    ("private", "PrivateKeyword"),
    ("protected", "ProtectedKeyword"),
    ("public", "PublicKeyword"),
    ("override", "OverrideKeyword"),
    ("out", "OutKeyword"),
    ("readonly", "ReadonlyKeyword"),
    ("require", "RequireKeyword"),
    ("global", "GlobalKeyword"),
    ("return", "ReturnKeyword"),
    ("satisfies", "SatisfiesKeyword"),
    ("set", "SetKeyword"),
    ("static", "StaticKeyword"),
    ("string", "StringKeyword"),
    ("super", "SuperKeyword"),
    ("switch", "SwitchKeyword"),
    ("symbol", "SymbolKeyword"),
    ("this", "ThisKeyword"),
    ("throw", "ThrowKeyword"),
    ("true", "TrueKeyword"),
    ("try", "TryKeyword"),
    ("type", "TypeKeyword"),
    ("typeof", "TypeOfKeyword"),
    ("undefined", "UndefinedKeyword"),
    ("unique", "UniqueKeyword"),
    ("unknown", "UnknownKeyword"),
    ("using", "UsingKeyword"),
    ("var", "VarKeyword"),
    ("void", "VoidKeyword"),
    ("while", "WhileKeyword"),
    ("with", "WithKeyword"),
    ("yield", "YieldKeyword"),
    ("async", "AsyncKeyword"),
    ("await", "AwaitKeyword"),
    ("of", "OfKeyword"),
];

fn lookup_in_unicode_map(code: u32, map: &[u32]) -> bool {
    if code < map[0] {
        return false;
    }
    let mut lo = 0usize;
    let mut hi = map.len();
    while lo + 1 < hi {
        let mut mid = lo + (hi - lo) / 2;
        mid -= mid % 2;
        if map[mid] <= code && code <= map[mid + 1] {
            return true;
        }
        if code < map[mid] {
            hi = mid;
        } else {
            lo = mid + 2;
        }
    }
    false
}

fn is_identifier_start(ch: u32) -> bool {
    (0x41..=0x5A).contains(&ch)
        || (0x61..=0x7A).contains(&ch)
        || ch == 0x24
        || ch == 0x5F
        || (ch > 0x7F && ch != NONE && lookup_in_unicode_map(ch, &unicode::IDENTIFIER_START))
}

fn is_identifier_part(ch: u32) -> bool {
    (0x41..=0x5A).contains(&ch)
        || (0x61..=0x7A).contains(&ch)
        || (0x30..=0x39).contains(&ch)
        || ch == 0x24
        || ch == 0x5F
        || (ch > 0x7F && ch != NONE && lookup_in_unicode_map(ch, &unicode::IDENTIFIER_PART))
}

fn is_white_space_single_line(ch: u32) -> bool {
    matches!(
        ch,
        0x20 | 0x09 | 0x0B | 0x0C | 0xA0 | 0x85 | OGHAM | 0x2000
            ..=0x200B | 0x202F | 0x205F | 0x3000 | 0xFEFF
    )
}

fn is_line_break(ch: u32) -> bool {
    matches!(
        ch,
        LINE_FEED | CARRIAGE_RETURN | LINE_SEPARATOR | PARAGRAPH_SEPARATOR
    )
}

fn is_digit(ch: u32) -> bool {
    (0x30..=0x39).contains(&ch)
}

fn is_hex_digit(ch: u32) -> bool {
    is_digit(ch) || (0x41..=0x46).contains(&ch) || (0x61..=0x66).contains(&ch)
}

fn is_octal_digit(ch: u32) -> bool {
    (0x30..=0x37).contains(&ch)
}

fn char_size(ch: u32) -> i64 {
    if ch != NONE && ch >= 0x10000 { 2 } else { 1 }
}

/// `String.fromCodePoint`.
fn utf16_encode(code_point: u32) -> Vec<u16> {
    if code_point < 0x10000 {
        vec![code_point as u16]
    } else {
        let v = code_point - 0x10000;
        vec![0xD800 + (v >> 10) as u16, 0xDC00 + (v & 0x3FF) as u16]
    }
}

fn ascii(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

fn units_to_ascii(units: &[u16]) -> String {
    units
        .iter()
        .map(|&unit| char::from_u32(unit as u32).unwrap_or('\u{FFFD}'))
        .collect()
}

/// `parseInt(units, 16)` for a non-empty run of hex digits, saturated far above U+10FFFF.
fn parse_hex(units: &[u16]) -> i64 {
    let mut value: i64 = 0;
    for &unit in units {
        let digit = (unit as u8 as char).to_digit(16).unwrap_or(0) as i64;
        value = (value * 16 + digit).min(1 << 40);
    }
    value
}

struct Scanner<'a> {
    text: &'a [u16],
    pos: i64,
    end: i64,
    token_start: i64,
    token: &'static str,
    token_value: Option<Vec<u16>>,
    token_flags: u32,
}

impl<'a> Scanner<'a> {
    fn new(text: &'a [u16]) -> Self {
        Scanner {
            text,
            pos: 0,
            end: text.len() as i64,
            token_start: 0,
            token: "Unknown",
            token_value: None,
            token_flags: 0,
        }
    }

    fn reset_token_state(&mut self, position: i64) {
        self.pos = position;
        self.token_start = position;
        self.token = "Unknown";
        self.token_value = None;
        self.token_flags = 0;
    }

    /// `text.charCodeAt(p)`.
    fn cu(&self, p: i64) -> u32 {
        if p >= 0 && (p as usize) < self.text.len() {
            self.text[p as usize] as u32
        } else {
            NONE
        }
    }

    /// `text.codePointAt(p)`.
    fn cp(&self, p: i64) -> u32 {
        let unit = self.cu(p);
        if (0xD800..=0xDBFF).contains(&unit) {
            let next = self.cu(p + 1);
            if (0xDC00..=0xDFFF).contains(&next) {
                return 0x10000 + ((unit - 0xD800) << 10) + (next - 0xDC00);
            }
        }
        unit
    }

    /// `text.substring(a, b)`.
    fn sub(&self, a: i64, b: i64) -> Vec<u16> {
        let len = self.text.len() as i64;
        let (a, b) = (a.clamp(0, len), b.clamp(0, len));
        let (a, b) = if a > b { (b, a) } else { (a, b) };
        self.text[a as usize..b as usize].to_vec()
    }

    fn value_or_empty(&self) -> Vec<u16> {
        self.token_value.clone().unwrap_or_default()
    }

    fn set(&mut self, kind: &'static str) -> &'static str {
        self.token = kind;
        kind
    }

    fn advance(&mut self, by: i64, kind: &'static str) -> &'static str {
        self.pos += by;
        self.set(kind)
    }

    fn is_conflict_marker_trivia(&self, pos: i64) -> bool {
        if pos >= self.text.len() as i64 {
            return false;
        }
        let ch = self.cu(pos);
        if pos == 0 || is_line_break(self.cu(pos - 1)) {
            let len = self.text.len() as i64;
            let repeated =
                |ch: u32| pos + 6 < len && (1..=6).all(|offset| self.cu(pos + offset) == ch);
            if (ch == 0x3C || ch == 0x3E || ch == 0x3D) && repeated(ch) {
                return ch == 0x3D || self.cu(pos + 7) == 0x20;
            }
            if ch == 0x7C && repeated(ch) {
                return true;
            }
        }
        false
    }

    fn scan_conflict_marker_trivia(&self, mut pos: i64) -> i64 {
        let ch = self.cu(pos);
        let len = self.text.len() as i64;
        if ch == 0x3C || ch == 0x3E {
            while pos < len && !is_line_break(self.cu(pos)) {
                pos += 1;
            }
        } else {
            pos += 7;
            while pos < len {
                let current = self.cu(pos);
                if (current == 0x3D || current == 0x3E) && self.is_conflict_marker_trivia(pos) {
                    break;
                }
                pos += 1;
            }
        }
        pos
    }

    fn is_shebang_trivia(&self, pos: i64) -> bool {
        pos == 0 && self.cu(0) == 0x23 && self.cu(1) == 0x21
    }

    fn scan_shebang_trivia(&self, mut pos: i64) -> i64 {
        pos += 2;
        while pos < self.text.len() as i64 {
            if is_line_break(self.cu(pos)) {
                break;
            }
            pos += 1;
        }
        pos
    }

    fn scan_number_fragment(&mut self) -> Vec<u16> {
        let mut start = self.pos;
        let mut allow_separator = false;
        let mut result = Vec::new();
        loop {
            let ch = self.cu(self.pos);
            if ch == 0x5F {
                self.token_flags |= CONTAINS_SEPARATOR;
                if allow_separator {
                    allow_separator = false;
                    result.extend(self.sub(start, self.pos));
                }
                self.pos += 1;
                start = self.pos;
                continue;
            }
            if is_digit(ch) {
                allow_separator = true;
                self.pos += 1;
                continue;
            }
            break;
        }
        result.extend(self.sub(start, self.pos));
        result
    }

    fn scan_number(&mut self) -> &'static str {
        let start = self.pos;
        let main_fragment;
        if self.cu(self.pos) == 0x30 {
            self.pos += 1;
            if self.cu(self.pos) == 0x5F {
                self.token_flags |= CONTAINS_SEPARATOR;
                self.pos -= 1;
                main_fragment = self.scan_number_fragment();
            } else if !self.scan_digits() {
                self.token_flags |= CONTAINS_LEADING_ZERO;
                let value = number::decimal_to_number(&units_to_ascii(&self.value_or_empty()));
                main_fragment = ascii(&number::number_to_string(value));
            } else if self
                .token_value
                .as_ref()
                .is_none_or(|value| value.is_empty())
            {
                main_fragment = ascii("0");
            } else {
                let value = number::radix_to_number(&self.value_or_empty(), 8);
                self.token_value = Some(ascii(&number::number_to_string(value)));
                return "NumericLiteral";
            }
        } else {
            main_fragment = self.scan_number_fragment();
        }
        let mut decimal_fragment = None;
        let mut scientific_fragment = None;
        if self.cu(self.pos) == 0x2E {
            self.pos += 1;
            decimal_fragment = Some(self.scan_number_fragment());
        }
        let mut end = self.pos;
        if self.cu(self.pos) == 0x45 || self.cu(self.pos) == 0x65 {
            self.pos += 1;
            self.token_flags |= SCIENTIFIC;
            if self.cu(self.pos) == 0x2B || self.cu(self.pos) == 0x2D {
                self.pos += 1;
            }
            let pre_numeric_part = self.pos;
            let final_fragment = self.scan_number_fragment();
            if !final_fragment.is_empty() {
                let mut fragment = self.sub(end, pre_numeric_part);
                fragment.extend(final_fragment);
                scientific_fragment = Some(fragment);
                end = self.pos;
            }
        }
        let result = if self.token_flags & CONTAINS_SEPARATOR != 0 {
            let mut result = main_fragment;
            if let Some(decimal) = decimal_fragment
                .as_ref()
                .filter(|decimal| !decimal.is_empty())
            {
                result.push(0x2E);
                result.extend(decimal);
            }
            if let Some(scientific) = scientific_fragment
                .as_ref()
                .filter(|scientific| !scientific.is_empty())
            {
                result.extend(scientific);
            }
            result
        } else {
            self.sub(start, end)
        };
        let normalized = || {
            ascii(&number::number_to_string(number::decimal_to_number(
                &units_to_ascii(&result),
            )))
        };
        if self.token_flags & CONTAINS_LEADING_ZERO != 0 {
            self.token_value = Some(normalized());
            return "NumericLiteral";
        }
        if decimal_fragment.is_some() || self.token_flags & SCIENTIFIC != 0 {
            self.check_for_identifier_start_after_numeric_literal();
            self.token_value = Some(normalized());
            "NumericLiteral"
        } else {
            self.token_value = Some(result.clone());
            let kind = self.check_big_int_suffix();
            self.check_for_identifier_start_after_numeric_literal();
            kind
        }
    }

    fn check_for_identifier_start_after_numeric_literal(&mut self) {
        if !is_identifier_start(self.cp(self.pos)) {
            return;
        }
        let identifier_start = self.pos;
        let length = self.scan_identifier_parts().len();
        if !(length == 1 && self.cu(identifier_start) == 0x6E) {
            self.pos = identifier_start;
        }
    }

    fn scan_digits(&mut self) -> bool {
        let start = self.pos;
        let mut is_octal = true;
        while is_digit(self.cu(self.pos)) {
            if !is_octal_digit(self.cu(self.pos)) {
                is_octal = false;
            }
            self.pos += 1;
        }
        self.token_value = Some(self.sub(start, self.pos));
        is_octal
    }

    fn scan_hex_digits(
        &mut self,
        min_count: usize,
        scan_as_many_as_possible: bool,
        can_have_separators: bool,
    ) -> Vec<u16> {
        let mut value = Vec::new();
        while value.len() < min_count || scan_as_many_as_possible {
            let mut ch = self.cu(self.pos);
            if can_have_separators && ch == 0x5F {
                self.pos += 1;
                continue;
            }
            if (0x41..=0x46).contains(&ch) {
                ch += 0x20;
            } else if !(is_digit(ch) || (0x61..=0x66).contains(&ch)) {
                break;
            }
            value.push(ch as u16);
            self.pos += 1;
        }
        if value.len() < min_count {
            value.clear();
        }
        value
    }

    fn scan_exact_number_of_hex_digits(&mut self, count: usize) -> i64 {
        let digits = self.scan_hex_digits(count, false, false);
        if digits.is_empty() {
            -1
        } else {
            parse_hex(&digits)
        }
    }

    fn scan_string(&mut self) -> Vec<u16> {
        let quote = self.cu(self.pos);
        self.pos += 1;
        let mut result = Vec::new();
        let mut start = self.pos;
        loop {
            if self.pos >= self.end {
                result.extend(self.sub(start, self.pos));
                break;
            }
            let ch = self.cu(self.pos);
            if ch == quote {
                result.extend(self.sub(start, self.pos));
                self.pos += 1;
                break;
            }
            if ch == 0x5C {
                result.extend(self.sub(start, self.pos));
                let escaped = self.scan_escape_sequence(ESCAPE_STRING | ESCAPE_REPORT_ERRORS);
                result.extend(escaped);
                start = self.pos;
                continue;
            }
            if ch == LINE_FEED || ch == CARRIAGE_RETURN {
                result.extend(self.sub(start, self.pos));
                break;
            }
            self.pos += 1;
        }
        result
    }

    fn scan_template_and_set_token_value(
        &mut self,
        should_emit_invalid_escape_error: bool,
    ) -> &'static str {
        let started_with_backtick = self.cu(self.pos) == 0x60;
        self.pos += 1;
        let mut start = self.pos;
        let mut contents = Vec::new();
        let resulting_token;
        loop {
            if self.pos >= self.end {
                contents.extend(self.sub(start, self.pos));
                resulting_token = if started_with_backtick {
                    "NoSubstitutionTemplateLiteral"
                } else {
                    "TemplateTail"
                };
                break;
            }
            let current = self.cu(self.pos);
            if current == 0x60 {
                contents.extend(self.sub(start, self.pos));
                self.pos += 1;
                resulting_token = if started_with_backtick {
                    "NoSubstitutionTemplateLiteral"
                } else {
                    "TemplateTail"
                };
                break;
            }
            if current == 0x24 && self.pos + 1 < self.end && self.cu(self.pos + 1) == 0x7B {
                contents.extend(self.sub(start, self.pos));
                self.pos += 2;
                resulting_token = if started_with_backtick {
                    "TemplateHead"
                } else {
                    "TemplateMiddle"
                };
                break;
            }
            if current == 0x5C {
                contents.extend(self.sub(start, self.pos));
                let flags = ESCAPE_STRING
                    | if should_emit_invalid_escape_error {
                        ESCAPE_REPORT_ERRORS
                    } else {
                        0
                    };
                let escaped = self.scan_escape_sequence(flags);
                contents.extend(escaped);
                start = self.pos;
                continue;
            }
            if current == CARRIAGE_RETURN {
                contents.extend(self.sub(start, self.pos));
                self.pos += 1;
                if self.pos < self.end && self.cu(self.pos) == LINE_FEED {
                    self.pos += 1;
                }
                contents.push(LINE_FEED as u16);
                start = self.pos;
                continue;
            }
            self.pos += 1;
        }
        self.token_value = Some(contents);
        resulting_token
    }

    fn scan_escape_sequence(&mut self, flags: u32) -> Vec<u16> {
        let start = self.pos;
        self.pos += 1;
        if self.pos >= self.end {
            return Vec::new();
        }
        let ch = self.cu(self.pos);
        self.pos += 1;
        let octal = |scanner: &mut Self, first: u32| -> Vec<u16> {
            // Cases `0` (followed by a digit), `1`-`3` and `4`-`7` fall through to here.
            if (0x30..=0x33).contains(&first)
                && scanner.pos < scanner.end
                && is_octal_digit(scanner.cu(scanner.pos))
            {
                scanner.pos += 1;
            }
            if scanner.pos < scanner.end && is_octal_digit(scanner.cu(scanner.pos)) {
                scanner.pos += 1;
            }
            if flags & ESCAPE_REPORT_INVALID != 0 {
                let digits = scanner.sub(start + 1, scanner.pos);
                let code = number::radix_digits_to_decimal(&digits, 8)
                    .parse::<u32>()
                    .unwrap_or(0);
                return vec![code as u16];
            }
            scanner.sub(start, scanner.pos)
        };
        match ch {
            0x30 => {
                if self.pos >= self.end || !is_digit(self.cu(self.pos)) {
                    return vec![0];
                }
                octal(self, ch)
            }
            0x31..=0x37 => octal(self, ch),
            0x38 | 0x39 => {
                if flags & ESCAPE_REPORT_INVALID != 0 {
                    return vec![ch as u16];
                }
                self.sub(start, self.pos)
            }
            0x62 => vec![0x08],
            0x74 => vec![0x09],
            0x6E => vec![0x0A],
            0x76 => vec![0x0B],
            0x66 => vec![0x0C],
            0x72 => vec![0x0D],
            0x27 => vec![0x27],
            0x22 => vec![0x22],
            0x75 => {
                if self.pos < self.end && self.cu(self.pos) == 0x7B {
                    self.pos -= 2;
                    return self.scan_extended_unicode_escape();
                }
                while self.pos < start + 6 {
                    if !(self.pos < self.end && is_hex_digit(self.cu(self.pos))) {
                        return self.sub(start, self.pos);
                    }
                    self.pos += 1;
                }
                let escaped_value = parse_hex(&self.sub(start + 2, self.pos));
                let escaped = vec![escaped_value as u16];
                if flags & ESCAPE_ANY_UNICODE_MODE != 0
                    && (0xD800..=0xDBFF).contains(&escaped_value)
                    && self.pos + 6 < self.end
                    && self.sub(self.pos, self.pos + 2) == ascii("\\u")
                    && self.cu(self.pos + 2) != 0x7B
                {
                    let next_start = self.pos;
                    let mut next_pos = self.pos + 2;
                    while next_pos < next_start + 6 {
                        if !is_hex_digit(self.cu(next_pos)) {
                            return escaped;
                        }
                        next_pos += 1;
                    }
                    let next_value = parse_hex(&self.sub(next_start + 2, next_pos));
                    if (0xDC00..=0xDFFF).contains(&next_value) {
                        self.pos = next_pos;
                        return vec![escaped_value as u16, next_value as u16];
                    }
                }
                escaped
            }
            0x78 => {
                while self.pos < start + 4 {
                    if !(self.pos < self.end && is_hex_digit(self.cu(self.pos))) {
                        return self.sub(start, self.pos);
                    }
                    self.pos += 1;
                }
                vec![parse_hex(&self.sub(start + 2, self.pos)) as u16]
            }
            CARRIAGE_RETURN => {
                if self.pos < self.end && self.cu(self.pos) == LINE_FEED {
                    self.pos += 1;
                }
                Vec::new()
            }
            LINE_FEED | LINE_SEPARATOR | PARAGRAPH_SEPARATOR => Vec::new(),
            _ => vec![ch as u16],
        }
    }

    fn scan_extended_unicode_escape(&mut self) -> Vec<u16> {
        let start = self.pos;
        self.pos += 3;
        let digits = self.scan_hex_digits(1, true, false);
        let escaped_value = if digits.is_empty() {
            -1
        } else {
            parse_hex(&digits)
        };
        let mut invalid = !(0..=0x10FFFF).contains(&escaped_value);
        if self.pos >= self.end {
            invalid = true;
        } else if self.cu(self.pos) == 0x7D {
            self.pos += 1;
        } else {
            invalid = true;
        }
        if invalid {
            return self.sub(start, self.pos);
        }
        utf16_encode(escaped_value as u32)
    }

    fn peek_unicode_escape(&mut self) -> i64 {
        if self.pos + 5 < self.end && self.cu(self.pos + 1) == 0x75 {
            let start = self.pos;
            self.pos += 2;
            let value = self.scan_exact_number_of_hex_digits(4);
            self.pos = start;
            return value;
        }
        -1
    }

    fn peek_extended_unicode_escape(&mut self) -> i64 {
        if self.cp(self.pos + 1) == 0x75 && self.cp(self.pos + 2) == 0x7B {
            let start = self.pos;
            self.pos += 3;
            let digits = self.scan_hex_digits(1, true, false);
            let value = if digits.is_empty() {
                -1
            } else {
                parse_hex(&digits)
            };
            self.pos = start;
            return value;
        }
        -1
    }

    fn scan_identifier_parts(&mut self) -> Vec<u16> {
        let mut result = Vec::new();
        let mut start = self.pos;
        while self.pos < self.end {
            let ch = self.cp(self.pos);
            if is_identifier_part(ch) {
                self.pos += char_size(ch);
            } else if ch == 0x5C {
                let extended = self.peek_extended_unicode_escape();
                if extended >= 0 && is_identifier_part(extended as u32) {
                    // The reference drops the parts scanned since `start` here.
                    result.extend(self.scan_extended_unicode_escape());
                    start = self.pos;
                    continue;
                }
                let cooked = self.peek_unicode_escape();
                if !(cooked >= 0 && is_identifier_part(cooked as u32)) {
                    break;
                }
                result.extend(self.sub(start, self.pos));
                result.extend(utf16_encode(cooked as u32));
                self.pos += 6;
                start = self.pos;
            } else {
                break;
            }
        }
        result.extend(self.sub(start, self.pos));
        result
    }

    fn get_identifier_token(&mut self) -> &'static str {
        let value = self.value_or_empty();
        if (2..=12).contains(&value.len())
            && (0x61..=0x7A).contains(&value[0])
            && let Some((_, kind)) = KEYWORDS
                .iter()
                .find(|(text, _)| text.encode_utf16().eq(value.iter().copied()))
        {
            return self.set(kind);
        }
        self.set("Identifier")
    }

    fn scan_binary_or_octal_digits(&mut self, base: u32) -> Vec<u16> {
        let mut value = Vec::new();
        loop {
            let ch = self.cu(self.pos);
            if ch == 0x5F {
                self.pos += 1;
                continue;
            }
            if !is_digit(ch) || ch - 0x30 >= base {
                break;
            }
            value.push(ch as u16);
            self.pos += 1;
        }
        value
    }

    fn check_big_int_suffix(&mut self) -> &'static str {
        let value = self.value_or_empty();
        if self.cu(self.pos) == 0x6E {
            let mut big = value;
            big.push(0x6E);
            if self.token_flags & BINARY_OR_OCTAL_SPECIFIER != 0 {
                let radix = if self.token_flags & BINARY_SPECIFIER != 0 {
                    2
                } else {
                    8
                };
                big = ascii(&number::radix_digits_to_decimal(
                    &big[2..big.len() - 1],
                    radix,
                ));
                big.push(0x6E);
            }
            self.token_value = Some(big);
            self.pos += 1;
            return "BigIntLiteral";
        }
        let numeric = if self.token_flags & BINARY_SPECIFIER != 0 {
            number::radix_to_number(&value[2..], 2)
        } else if self.token_flags & OCTAL_SPECIFIER != 0 {
            number::radix_to_number(&value[2..], 8)
        } else if value.starts_with(&[0x30, 0x78]) {
            number::radix_to_number(&value[2..], 16)
        } else {
            number::decimal_to_number(&units_to_ascii(&value))
        };
        self.token_value = Some(ascii(&number::number_to_string(numeric)));
        "NumericLiteral"
    }

    fn scan_identifier(&mut self, start_character: u32) -> Option<&'static str> {
        let mut ch = start_character;
        if !is_identifier_start(ch) {
            return None;
        }
        self.pos += char_size(ch);
        while self.pos < self.end {
            ch = self.cp(self.pos);
            if !is_identifier_part(ch) {
                break;
            }
            self.pos += char_size(ch);
        }
        let mut value = self.sub(self.token_start, self.pos);
        if ch == 0x5C {
            value.extend(self.scan_identifier_parts());
        }
        self.token_value = Some(value);
        Some(self.get_identifier_token())
    }

    fn scan(&mut self) -> &'static str {
        self.token_flags = 0;
        loop {
            self.token_start = self.pos;
            if self.pos >= self.end {
                return self.set("EndOfFile");
            }
            let pos = self.pos;
            let ch = self.cp(pos);
            if pos == 0 && ch == 0x23 && self.is_shebang_trivia(pos) {
                self.pos = self.scan_shebang_trivia(pos);
                continue;
            }
            let next = self.cu(pos + 1);
            let after = self.cu(pos + 2);
            match ch {
                LINE_FEED | CARRIAGE_RETURN => {
                    self.token_flags |= PRECEDING_LINE_BREAK;
                    self.pos += 1;
                    continue;
                }
                0x09
                | 0x0B
                | 0x0C
                | 0x20
                | 0xA0
                | OGHAM
                | 0x2000..=0x200B
                | 0x202F
                | 0x205F
                | 0x3000
                | 0xFEFF => {
                    self.pos += 1;
                    continue;
                }
                0x21 => {
                    if next == 0x3D {
                        if after == 0x3D {
                            return self.advance(3, "ExclamationEqualsEqualsToken");
                        }
                        return self.advance(2, "ExclamationEqualsToken");
                    }
                    return self.advance(1, "ExclamationToken");
                }
                0x22 | 0x27 => {
                    let value = self.scan_string();
                    self.token_value = Some(value);
                    return self.set("StringLiteral");
                }
                0x60 => {
                    let kind = self.scan_template_and_set_token_value(false);
                    return self.set(kind);
                }
                0x25 => {
                    if next == 0x3D {
                        return self.advance(2, "PercentEqualsToken");
                    }
                    return self.advance(1, "PercentToken");
                }
                0x26 => {
                    if next == 0x26 {
                        if after == 0x3D {
                            return self.advance(3, "AmpersandAmpersandEqualsToken");
                        }
                        return self.advance(2, "AmpersandAmpersandToken");
                    }
                    if next == 0x3D {
                        return self.advance(2, "AmpersandEqualsToken");
                    }
                    return self.advance(1, "AmpersandToken");
                }
                0x28 => return self.advance(1, "OpenParenToken"),
                0x29 => return self.advance(1, "CloseParenToken"),
                0x2A => {
                    if next == 0x3D {
                        return self.advance(2, "AsteriskEqualsToken");
                    }
                    if next == 0x2A {
                        if after == 0x3D {
                            return self.advance(3, "AsteriskAsteriskEqualsToken");
                        }
                        return self.advance(2, "AsteriskAsteriskToken");
                    }
                    return self.advance(1, "AsteriskToken");
                }
                0x2B => {
                    if next == 0x2B {
                        return self.advance(2, "PlusPlusToken");
                    }
                    if next == 0x3D {
                        return self.advance(2, "PlusEqualsToken");
                    }
                    return self.advance(1, "PlusToken");
                }
                0x2C => return self.advance(1, "CommaToken"),
                0x2D => {
                    if next == 0x2D {
                        return self.advance(2, "MinusMinusToken");
                    }
                    if next == 0x3D {
                        return self.advance(2, "MinusEqualsToken");
                    }
                    return self.advance(1, "MinusToken");
                }
                0x2E => {
                    if is_digit(next) {
                        self.scan_number();
                        return self.set("NumericLiteral");
                    }
                    if next == 0x2E && after == 0x2E {
                        return self.advance(3, "DotDotDotToken");
                    }
                    return self.advance(1, "DotToken");
                }
                0x2F => {
                    if next == 0x2F {
                        self.pos += 2;
                        while self.pos < self.end && !is_line_break(self.cu(self.pos)) {
                            self.pos += 1;
                        }
                        continue;
                    }
                    if next == 0x2A {
                        self.pos += 2;
                        while self.pos < self.end {
                            let ch = self.cu(self.pos);
                            if ch == 0x2A && self.cu(self.pos + 1) == 0x2F {
                                self.pos += 2;
                                break;
                            }
                            self.pos += 1;
                            if is_line_break(ch) {
                                self.token_flags |= PRECEDING_LINE_BREAK;
                            }
                        }
                        continue;
                    }
                    if next == 0x3D {
                        return self.advance(2, "SlashEqualsToken");
                    }
                    return self.advance(1, "SlashToken");
                }
                0x30..=0x39 => {
                    if ch == 0x30 && pos + 2 < self.end {
                        let (prefix, flag, base) = match next {
                            0x58 | 0x78 => ("0x", 0, 16),
                            0x42 | 0x62 => ("0b", BINARY_SPECIFIER, 2),
                            0x4F | 0x6F => ("0o", OCTAL_SPECIFIER, 8),
                            _ => ("", 0, 0),
                        };
                        if base != 0 {
                            self.pos += 2;
                            let mut digits = if base == 16 {
                                self.scan_hex_digits(1, true, true)
                            } else {
                                self.scan_binary_or_octal_digits(base)
                            };
                            if digits.is_empty() {
                                digits = ascii("0");
                            }
                            let mut value = ascii(prefix);
                            value.extend(digits);
                            self.token_value = Some(value);
                            self.token_flags |= flag;
                            let kind = self.check_big_int_suffix();
                            return self.set(kind);
                        }
                    }
                    let kind = self.scan_number();
                    return self.set(kind);
                }
                0x3A => return self.advance(1, "ColonToken"),
                0x3B => return self.advance(1, "SemicolonToken"),
                0x3C => {
                    if self.is_conflict_marker_trivia(pos) {
                        self.pos = self.scan_conflict_marker_trivia(pos);
                        continue;
                    }
                    if next == 0x3C {
                        if after == 0x3D {
                            return self.advance(3, "LessThanLessThanEqualsToken");
                        }
                        return self.advance(2, "LessThanLessThanToken");
                    }
                    if next == 0x3D {
                        return self.advance(2, "LessThanEqualsToken");
                    }
                    return self.advance(1, "LessThanToken");
                }
                0x3D => {
                    if self.is_conflict_marker_trivia(pos) {
                        self.pos = self.scan_conflict_marker_trivia(pos);
                        continue;
                    }
                    if next == 0x3D {
                        if after == 0x3D {
                            return self.advance(3, "EqualsEqualsEqualsToken");
                        }
                        return self.advance(2, "EqualsEqualsToken");
                    }
                    if next == 0x3E {
                        return self.advance(2, "EqualsGreaterThanToken");
                    }
                    return self.advance(1, "EqualsToken");
                }
                0x3E => {
                    if self.is_conflict_marker_trivia(pos) {
                        self.pos = self.scan_conflict_marker_trivia(pos);
                        continue;
                    }
                    return self.advance(1, "GreaterThanToken");
                }
                0x3F => {
                    if next == 0x2E && !is_digit(after) {
                        return self.advance(2, "QuestionDotToken");
                    }
                    if next == 0x3F {
                        if after == 0x3D {
                            return self.advance(3, "QuestionQuestionEqualsToken");
                        }
                        return self.advance(2, "QuestionQuestionToken");
                    }
                    return self.advance(1, "QuestionToken");
                }
                0x5B => return self.advance(1, "OpenBracketToken"),
                0x5D => return self.advance(1, "CloseBracketToken"),
                0x5E => {
                    if next == 0x3D {
                        return self.advance(2, "CaretEqualsToken");
                    }
                    return self.advance(1, "CaretToken");
                }
                0x7B => return self.advance(1, "OpenBraceToken"),
                0x7C => {
                    if self.is_conflict_marker_trivia(pos) {
                        self.pos = self.scan_conflict_marker_trivia(pos);
                        continue;
                    }
                    if next == 0x7C {
                        if after == 0x3D {
                            return self.advance(3, "BarBarEqualsToken");
                        }
                        return self.advance(2, "BarBarToken");
                    }
                    if next == 0x3D {
                        return self.advance(2, "BarEqualsToken");
                    }
                    return self.advance(1, "BarToken");
                }
                0x7D => return self.advance(1, "CloseBraceToken"),
                0x7E => return self.advance(1, "TildeToken"),
                0x40 => return self.advance(1, "AtToken"),
                0x5C => {
                    let extended = self.peek_extended_unicode_escape();
                    if extended >= 0 && is_identifier_start(extended as u32) {
                        let mut value = self.scan_extended_unicode_escape();
                        value.extend(self.scan_identifier_parts());
                        self.token_value = Some(value);
                        return self.get_identifier_token();
                    }
                    let cooked = self.peek_unicode_escape();
                    if cooked >= 0 && is_identifier_start(cooked as u32) {
                        self.pos += 6;
                        let mut value = vec![cooked as u16];
                        value.extend(self.scan_identifier_parts());
                        self.token_value = Some(value);
                        return self.get_identifier_token();
                    }
                    return self.advance(1, "Unknown");
                }
                0x23 => {
                    if pos != 0 && next == 0x21 {
                        return self.advance(1, "Unknown");
                    }
                    let char_after_hash = self.cp(pos + 1);
                    if char_after_hash == 0x5C {
                        self.pos += 1;
                        let extended = self.peek_extended_unicode_escape();
                        if extended >= 0 && is_identifier_start(extended as u32) {
                            let mut value = ascii("#");
                            value.extend(self.scan_extended_unicode_escape());
                            value.extend(self.scan_identifier_parts());
                            self.token_value = Some(value);
                            return self.set("PrivateIdentifier");
                        }
                        let cooked = self.peek_unicode_escape();
                        if cooked >= 0 && is_identifier_start(cooked as u32) {
                            self.pos += 6;
                            let mut value = vec![0x23, cooked as u16];
                            value.extend(self.scan_identifier_parts());
                            self.token_value = Some(value);
                            return self.set("PrivateIdentifier");
                        }
                        self.pos -= 1;
                    }
                    if is_identifier_start(char_after_hash) {
                        self.pos += 1;
                        self.scan_identifier(char_after_hash);
                    } else {
                        self.token_value = Some(ascii("#"));
                    }
                    return self.set("PrivateIdentifier");
                }
                REPLACEMENT_CHARACTER => {
                    self.pos = self.end;
                    return self.set("NonTextFileMarkerTrivia");
                }
                _ => {
                    if let Some(kind) = self.scan_identifier(ch) {
                        return kind;
                    }
                    if is_white_space_single_line(ch) {
                        self.pos += char_size(ch);
                        continue;
                    }
                    if is_line_break(ch) {
                        self.token_flags |= PRECEDING_LINE_BREAK;
                        self.pos += char_size(ch);
                        continue;
                    }
                    return self.advance(char_size(ch), "Unknown");
                }
            }
        }
    }

    fn re_scan_template_token(&mut self, is_tagged_template: bool) -> &'static str {
        self.pos = self.token_start;
        let kind = self.scan_template_and_set_token_value(!is_tagged_template);
        self.set(kind)
    }
}

/// `scanJavaScriptTokens`: every token of a text, template expressions rescanned.
pub fn scan_javascript_tokens(source: &[u16]) -> Result<Vec<Token>, TokenizationFailed> {
    let length = source.len();
    let mut scanner = Scanner::new(source);
    let mut position: usize = 0;
    let mut template_expression_brace_depths: Vec<i64> = Vec::new();
    let mut tokens = Vec::new();
    loop {
        let mut kind = scanner.scan();
        if kind == "EndOfFile" {
            if scanner.pos as usize != length {
                return Err(TokenizationFailed { position });
            }
            return Ok(tokens);
        }
        let depths = &mut template_expression_brace_depths;
        if kind == "CloseBraceToken" && depths.last() == Some(&0) {
            kind = scanner.re_scan_template_token(false);
            if kind == "TemplateTail" {
                depths.pop();
            }
        } else if kind == "TemplateHead" {
            depths.push(0);
        } else if let (Some(depth), "OpenBraceToken") = (depths.last_mut(), kind) {
            *depth += 1;
        } else if let (Some(depth), "CloseBraceToken") = (depths.last_mut(), kind) {
            *depth -= 1;
        }
        let start = scanner.token_start;
        let end = scanner.pos;
        if start < position as i64 || start >= length as i64 || end > length as i64 {
            return Err(TokenizationFailed { position });
        }
        if end <= start {
            position = start as usize + 1;
            scanner.reset_token_state(position as i64);
            continue;
        }
        position = end as usize;
        tokens.push(Token {
            kind,
            start: start as usize,
            end: end as usize,
            value: scanner.token_value.clone(),
        });
    }
}

fn is_literal_token(token: Option<&Token>) -> bool {
    matches!(
        token.map(|token| token.kind),
        Some("StringLiteral" | "NoSubstitutionTemplateLiteral")
    )
}

/// `scanModuleSpecifiers`.
pub fn scan_module_specifiers(source: &[u16]) -> Result<SpecifierScan, TokenizationFailed> {
    let tokens = scan_javascript_tokens(source)?;
    let text = |token: Option<&Token>| token.map(|token| &source[token.start..token.end]);
    let kind = |token: Option<&Token>| token.map(|token| token.kind);
    let mut specifiers: Vec<Vec<u16>> = Vec::new();
    let mut add = |value: Option<&Vec<u16>>| {
        let value = value.cloned().unwrap_or_default();
        if !specifiers.contains(&value) {
            specifiers.push(value);
        }
    };
    let mut non_literal = false;
    let require = ascii("require");
    let module = ascii("module");
    let mock = ascii("mock");
    let from = ascii("from");
    for index in 0..tokens.len() {
        let token = &tokens[index];
        let previous = index.checked_sub(1).and_then(|i| tokens.get(i));
        let next = tokens.get(index + 1);
        let call = kind(next) == Some("OpenParenToken");
        let argument = tokens.get(index + 2);
        let closes_call = matches!(
            kind(tokens.get(index + 3)),
            Some("CloseParenToken" | "CommaToken")
        );
        let require_call = (token.kind == "Identifier" || token.kind == "RequireKeyword")
            && text(Some(token)) == Some(&require[..])
            && kind(previous) != Some("DotToken");
        let mock_module_call = (token.kind == "Identifier" || token.kind == "ModuleKeyword")
            && text(Some(token)) == Some(&module[..])
            && kind(previous) == Some("DotToken")
            && text(index.checked_sub(2).and_then(|i| tokens.get(i))) == Some(&mock[..]);
        if (require_call || mock_module_call) && call {
            if is_literal_token(argument) && closes_call {
                add(argument.and_then(|argument| argument.value.as_ref()));
            } else {
                non_literal = true;
            }
            continue;
        }
        if token.kind != "ImportKeyword" && token.kind != "ExportKeyword" {
            continue;
        }
        if token.kind == "ImportKeyword" && call {
            if is_literal_token(argument) && closes_call {
                add(argument.and_then(|argument| argument.value.as_ref()));
            } else {
                non_literal = true;
            }
            continue;
        }
        if is_literal_token(next) {
            add(next.and_then(|next| next.value.as_ref()));
            continue;
        }
        for cursor in index + 1..tokens.len() {
            let candidate = &tokens[cursor];
            if matches!(
                candidate.kind,
                "SemicolonToken" | "ImportKeyword" | "ExportKeyword"
            ) {
                break;
            }
            if text(Some(candidate)) == Some(&from[..]) && is_literal_token(tokens.get(cursor + 1))
            {
                add(tokens
                    .get(cursor + 1)
                    .and_then(|literal| literal.value.as_ref()));
                break;
            }
        }
    }
    specifiers.retain(|specifier| !specifier.is_empty());
    Ok(SpecifierScan {
        specifiers,
        non_literal,
    })
}
