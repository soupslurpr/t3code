fn main() {
    println!("cargo::rerun-if-changed=src/ei.c");
    let ei = pkg_config::Config::new()
        .atleast_version("1.1")
        .probe("libei-1.0")
        .expect("libei development headers are required");
    cc::Build::new()
        .file("src/ei.c")
        .includes(ei.include_paths)
        .flag_if_supported("-std=c11")
        .compile("t3_ei");
}
