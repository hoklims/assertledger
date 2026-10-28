//! Differential replay CLI: `assertledger-e7-scanner tokens|specifiers < records`.
//!
//! stdin holds records of a `u32` little-endian code unit count followed by that many `u16`
//! little-endian code units. Each record answers on stdout, units written as 4-digit hex:
//! `tokens` prints `T kind start end text value|-` per token then `E`; `specifiers` prints
//! `S value` per specifier then `N 0|1`. A tokenization failure prints `X position` instead.

use std::io::{self, Read, Write};
use std::process::ExitCode;

use assertledger_e7_scanner::{scan_javascript_tokens, scan_module_specifiers};

fn hex(units: &[u16]) -> String {
    if units.is_empty() {
        return "~".to_owned();
    }
    units.iter().map(|unit| format!("{unit:04x}")).collect()
}

fn main() -> ExitCode {
    let mode = std::env::args().nth(1).unwrap_or_default();
    if mode != "tokens" && mode != "specifiers" {
        eprintln!("usage: assertledger-e7-scanner tokens|specifiers < records");
        return ExitCode::from(64);
    }
    let mut input = Vec::new();
    if let Err(error) = io::stdin().lock().read_to_end(&mut input) {
        eprintln!("cannot read stdin: {error}");
        return ExitCode::from(74);
    }
    let stdout = io::stdout();
    let mut out = io::BufWriter::new(stdout.lock());
    let mut offset = 0usize;
    while offset < input.len() {
        let Some(header) = input.get(offset..offset + 4) else {
            eprintln!("truncated record header at byte {offset}");
            return ExitCode::from(65);
        };
        let count = u32::from_le_bytes([header[0], header[1], header[2], header[3]]) as usize;
        offset += 4;
        let Some(body) = input.get(offset..offset + count * 2) else {
            eprintln!("truncated record body at byte {offset}");
            return ExitCode::from(65);
        };
        offset += count * 2;
        let source: Vec<u16> = body
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| u16::from_le_bytes(*pair))
            .collect();
        let written = if mode == "tokens" {
            match scan_javascript_tokens(&source) {
                Ok(tokens) => tokens
                    .iter()
                    .try_for_each(|token| {
                        let value = token.value.as_deref().map_or_else(|| "-".to_owned(), hex);
                        writeln!(
                            out,
                            "T {} {} {} {} {value}",
                            token.kind,
                            token.start,
                            token.end,
                            hex(&source[token.start..token.end])
                        )
                    })
                    .and_then(|()| writeln!(out, "E")),
                Err(failure) => writeln!(out, "X {}", failure.position),
            }
        } else {
            match scan_module_specifiers(&source) {
                Ok(scan) => scan
                    .specifiers
                    .iter()
                    .try_for_each(|specifier| writeln!(out, "S {}", hex(specifier)))
                    .and_then(|()| writeln!(out, "N {}", u8::from(scan.non_literal))),
                Err(failure) => writeln!(out, "X {}", failure.position),
            }
        };
        if let Err(error) = written {
            eprintln!("cannot write stdout: {error}");
            return ExitCode::from(74);
        }
    }
    if let Err(error) = out.flush() {
        eprintln!("cannot write stdout: {error}");
        return ExitCode::from(74);
    }
    ExitCode::SUCCESS
}
