// These fixtures deliberately leave descendants to exercise supervision cleanup.
#![allow(clippy::zombie_processes)]
use std::{
    io::{self, Write},
    process::Command,
    time::Duration,
};
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args[0].as_str() {
        "output" => {
            io::stdout().write_all(&[b'x'; 10000]).unwrap();
            io::stderr().write_all("é�".as_bytes()).unwrap();
        }
        "literal" => {
            print!("{}", args[1]);
        }
        "env" => {
            print!("{}", std::env::var(&args[1]).unwrap_or_default());
        }
        "crash" => std::process::exit(7),
        "sleep" => std::thread::sleep(Duration::from_secs(3)),
        "long-sleep" => std::thread::sleep(Duration::from_secs(30)),
        "descendant" => {
            let child = Command::new(std::env::current_exe().unwrap())
                .arg("sleep")
                .spawn()
                .unwrap();
            println!("{}", child.id());
        }
        "tree" => {
            let child = Command::new(std::env::current_exe().unwrap())
                .arg("long-sleep")
                .spawn()
                .unwrap();
            println!("{}", child.id());
            io::stdout().flush().unwrap();
            std::thread::sleep(Duration::from_secs(3));
        }
        _ => panic!("unknown fixture"),
    }
}
