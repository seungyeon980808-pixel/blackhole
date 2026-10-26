fn main() {
    // macOS speech helper (mac-stt/main.swift), embedded into the app binary. Without a Swift
    // compiler the helper is empty and speech falls back to the phone transcript or waits.
    let out = std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("blackhole-stt");
    let target = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    println!("cargo:rerun-if-changed=mac-stt/main.swift");
    println!("cargo:rerun-if-changed=mac-stt/Info.plist");
    let mut built = false;
    if target == "macos" {
        built = std::process::Command::new("swiftc")
            .args(["-O", "mac-stt/main.swift", "-o"])
            .arg(&out)
            .args(["-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", "mac-stt/Info.plist"])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if !built {
            println!("cargo:warning=swiftc failed: macOS speech helper not built");
        }
    }
    if !built {
        std::fs::write(&out, b"").unwrap();
    }
    tauri_build::build()
}
