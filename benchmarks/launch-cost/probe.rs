use std::io::{self, Write};

fn main() -> io::Result<()> {
    let mut arguments = std::env::args_os().skip(1);
    if arguments.next().as_deref() == Some(std::ffi::OsStr::new("--echo-argv")) {
        let mut output = io::stdout().lock();
        for argument in arguments {
            output.write_all(argument.as_encoded_bytes())?;
            output.write_all(&[0])?;
        }
    }
    Ok(())
}
