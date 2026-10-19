use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const VERSION_SYMBOL: &str = "github.com/outof0/anypick/go/internal/buildinfo.Version";

fn main() {
    println!("cargo:rerun-if-env-changed=ANYPICK_CORE_SIDECAR");
    println!("cargo:rerun-if-env-changed=GO");
    println!("cargo:rerun-if-changed=../../go");
    prepare_core_sidecar().expect("failed to prepare the bundled AnyPick core sidecar");
    tauri_build::build()
}

fn prepare_core_sidecar() -> Result<(), String> {
    let manifest_dir =
        PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").ok_or("CARGO_MANIFEST_DIR is not set")?);
    let target = env::var("TARGET").map_err(|_| "TARGET is not set")?;
    let (goos, goarch, extension) = go_target(&target)?;
    let destination = manifest_dir
        .join("binaries")
        .join(format!("anypick-core-{target}{extension}"));
    // Only cfg(test) code consumes this path. Integration tests must launch
    // the helper this build bundles, rather than a fixture or a PATH binary.
    println!(
        "cargo:rustc-env=ANYPICK_TEST_SIDECAR={}",
        destination.display()
    );
    fs::create_dir_all(destination.parent().expect("sidecar parent"))
        .map_err(|error| format!("create sidecar directory: {error}"))?;

    if let Some(source) = env::var_os("ANYPICK_CORE_SIDECAR") {
        copy_sidecar(Path::new(&source), &destination)?;
        return Ok(());
    }

    // manifest_dir is <repo>/src/tauri/app, so three levels up is the
    // repository root. The engine lives under src/, not at the root: joining
    // "go" directly here would look for <repo>/go and fail.
    let repository = manifest_dir
        .ancestors()
        .nth(3)
        .ok_or("cannot resolve the repository root")?;
    let go_dir = repository.join("src").join("go");
    let go = env::var_os("GO").unwrap_or_else(|| "go".into());
    let link_flags = format!(
        "-s -w -X {VERSION_SYMBOL}={}",
        env::var("CARGO_PKG_VERSION").map_err(|_| "CARGO_PKG_VERSION is not set")?
    );
    let status = Command::new(go)
        .current_dir(&go_dir)
        .env("CGO_ENABLED", "0")
        .env("GOOS", goos)
        .env("GOARCH", goarch)
        .args(["build", "-trimpath", "-ldflags", &link_flags, "-o"])
        .arg(&destination)
        .arg("./cmd/anypick")
        .status()
        .map_err(|error| format!("start Go compiler: {error}"))?;
    if !status.success() {
        return Err(format!("Go compiler exited with {status}"));
    }
    Ok(())
}

fn copy_sidecar(source: &Path, destination: &Path) -> Result<(), String> {
    if !source.is_absolute() || !source.is_file() {
        return Err("ANYPICK_CORE_SIDECAR must name an absolute regular file".into());
    }
    fs::copy(source, destination)
        .map(|_| ())
        .map_err(|error| format!("copy prebuilt AnyPick core: {error}"))
}

fn go_target(target: &str) -> Result<(&'static str, &'static str, &'static str), String> {
    let goos = if target.contains("windows") {
        "windows"
    } else if target.contains("linux") {
        "linux"
    } else if target.contains("darwin") {
        "darwin"
    } else {
        return Err(format!("unsupported desktop target triple {target:?}"));
    };
    let goarch = if target.starts_with("x86_64-") {
        "amd64"
    } else if target.starts_with("aarch64-") {
        "arm64"
    } else {
        return Err(format!(
            "unsupported desktop target architecture {target:?}"
        ));
    };
    let extension = if goos == "windows" { ".exe" } else { "" };
    Ok((goos, goarch, extension))
}
