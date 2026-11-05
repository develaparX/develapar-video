use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager, RunEvent};

#[derive(serde::Serialize, Clone)]
pub struct EngineConfig {
    pub url: String,
    pub token: String,
    pub engine_path: String,
    pub log_tail: String,
    pub engine_state: String,
    pub engine_error: Option<String>,
}

#[derive(serde::Serialize, Clone)]
pub struct EngineDiagnostics {
    pub alive: bool,
    pub exit_code: Option<i32>,
    pub restarts: u32,
    pub engine_state: String,
    pub engine_error: Option<String>,
    pub log_tail: String,
}

struct SupervisorInner {
    child: Option<Child>,
    alive: bool,
    exit_code: Option<i32>,
    restarts: u32,
    restart_timestamps: Vec<std::time::Instant>,
    engine_state: String, // "downloading_runtime" | "starting" | "ready" | "failed"
    engine_error: Option<String>,
    engine_path: String,
}

pub struct EngineSupervisor(Arc<Mutex<SupervisorInner>>);

fn current_time_str() -> String {
    if let Ok(elapsed) = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
        let secs = elapsed.as_secs();
        let millis = elapsed.subsec_millis();
        format!("{}.{:03}", secs, millis)
    } else {
        "0.000".to_string()
    }
}

fn launcher_log(msg: &str) {
    let log_dir = dirs_token_path()
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."));
    let _ = std::fs::create_dir_all(&log_dir);
    let log_file = log_dir.join("tauri-launcher.log");
    let line = format!("[{}] {}\n", current_time_str(), msg);
    println!("[tauri-launcher] {}", msg);
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_file)
    {
        use std::io::Write;
        let _ = f.write_all(line.as_bytes());
    }
}

fn append_to_engine_log(line: &str) {
    let log_dir = dirs_token_path()
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."));
    let log_file = log_dir.join("engine.log");
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_file)
    {
        use std::io::Write;
        let _ = f.write_all(line.as_bytes());
    }
}

fn read_last_lines(path: &PathBuf, n: usize) -> Vec<String> {
    if let Ok(content) = std::fs::read_to_string(path) {
        content
            .lines()
            .rev()
            .take(n)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .map(|s| s.to_string())
            .collect()
    } else {
        Vec::new()
    }
}

fn get_diagnostics_log_tail() -> String {
    let log_dir = dirs_token_path()
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."));

    let engine_prev_lines = read_last_lines(&log_dir.join("engine.prev.log"), 20);
    let engine_lines = read_last_lines(&log_dir.join("engine.log"), 40);
    let launcher_lines = read_last_lines(&log_dir.join("tauri-launcher.log"), 30);

    let mut combined: Vec<String> = Vec::new();
    if !engine_prev_lines.is_empty() {
        combined.push("--- last 20 lines of engine.prev.log ---".to_string());
        combined.extend(engine_prev_lines);
    }
    if !engine_lines.is_empty() {
        combined.push("--- last 40 lines of engine.log ---".to_string());
        combined.extend(engine_lines);
    }
    if !launcher_lines.is_empty() {
        combined.push("--- last 30 lines of tauri-launcher.log ---".to_string());
        combined.extend(launcher_lines);
    }
    combined.join("\n")
}

fn is_engine_port_open() -> bool {
    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1)), 8787);
    TcpStream::connect_timeout(&addr, Duration::from_millis(250)).is_ok()
}

fn clean_windows_path(p: PathBuf) -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        let s = p.to_string_lossy().to_string();
        if let Some(stripped) = s.strip_prefix(r"\\?\") {
            return PathBuf::from(stripped);
        }
    }
    p
}

fn dirs_token_path() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        if let Ok(userprofile) = std::env::var("USERPROFILE") {
            if !userprofile.trim().is_empty() {
                return clean_windows_path(PathBuf::from(userprofile).join(".flow-mcp").join("token"));
            }
        }
        let local_app_data = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| ".".to_string());
        clean_windows_path(PathBuf::from(local_app_data).join(".flow-mcp").join("token"))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
        PathBuf::from(home).join(".flow-mcp").join("token")
    }
}

fn find_engine_mjs_path(app: &AppHandle) -> Option<PathBuf> {
    let mut search_dirs: Vec<PathBuf> = Vec::new();

    if let Ok(res_dir) = app.path().resource_dir() {
        let res_dir = clean_windows_path(res_dir);
        search_dirs.push(res_dir.join("binaries"));
        search_dirs.push(res_dir.join("resources").join("binaries"));
        search_dirs.push(res_dir.clone());
    }

    if let Ok(exe) = std::env::current_exe() {
        let exe = clean_windows_path(exe);
        if let Some(dir) = exe.parent() {
            search_dirs.push(dir.join("binaries"));
            search_dirs.push(dir.join("resources").join("binaries"));
            search_dirs.push(dir.to_path_buf());
            if let Some(parent) = dir.parent() {
                search_dirs.push(parent.join("Resources").join("binaries"));
                search_dirs.push(parent.join("Resources"));
            }
        }
    }

    for d in &["binaries", "src-tauri/binaries", "../src-tauri/binaries", "engine/dist", "../engine/dist"] {
        search_dirs.push(PathBuf::from(d));
    }

    for dir in &search_dirs {
        let candidate = clean_windows_path(dir.join("engine.mjs"));
        if candidate.exists() && candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

static BUN_DOWNLOAD_MUTEX: Mutex<()> = Mutex::new(());

fn find_or_install_bun(app: &AppHandle, mcp_home: &PathBuf) -> Option<PathBuf> {
    let bin_dir = mcp_home.join("bin");
    let local_bun_name = if cfg!(target_os = "windows") { "bun.exe" } else { "bun" };
    let local_bun = bin_dir.join(local_bun_name);

    // 1. Check bundled Bun (placed into resource_dir/binaries by Windows installer)
    let mut search_dirs: Vec<PathBuf> = Vec::new();
    if let Ok(res_dir) = app.path().resource_dir() {
        let res_dir = clean_windows_path(res_dir);
        search_dirs.push(res_dir.join("binaries"));
        search_dirs.push(res_dir.join("resources").join("binaries"));
        search_dirs.push(res_dir.clone());
    }
    if let Ok(exe) = std::env::current_exe() {
        let exe = clean_windows_path(exe);
        if let Some(dir) = exe.parent() {
            search_dirs.push(dir.join("binaries"));
            search_dirs.push(dir.join("resources").join("binaries"));
            search_dirs.push(dir.to_path_buf());
            if let Some(parent) = dir.parent() {
                search_dirs.push(parent.join("Resources").join("binaries"));
                search_dirs.push(parent.join("Resources"));
            }
        }
    }
    for d in &["binaries", "src-tauri/binaries", "../src-tauri/binaries"] {
        search_dirs.push(PathBuf::from(d));
    }
    for dir in &search_dirs {
        let candidate = clean_windows_path(dir.join(local_bun_name));
        if candidate.exists() && candidate.is_file() {
            launcher_log(&format!("Found bundled Bun at {:?}", candidate));
            return Some(candidate);
        }
    }

    // 2. Check ~/.flow-mcp/bin/bun
    if local_bun.exists() && local_bun.is_file() {
        launcher_log(&format!("Found local Bun at {:?}", local_bun));
        return Some(local_bun);
    }

    // 3. Platform specific installer directories
    #[cfg(target_os = "windows")]
    {
        if let Ok(userprofile) = std::env::var("USERPROFILE") {
            let bun_official = clean_windows_path(PathBuf::from(userprofile).join(".bun").join("bin").join("bun.exe"));
            if bun_official.exists() && bun_official.is_file() {
                launcher_log(&format!("Found official Bun Windows installation at {:?}", bun_official));
                return Some(bun_official);
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        for p in &[
            "/opt/homebrew/bin/bun",
            "/usr/local/bin/bun",
            "/usr/bin/bun",
        ] {
            let pb = PathBuf::from(p);
            if pb.exists() {
                launcher_log(&format!("Found system Bun at {:?}", pb));
                return Some(pb);
            }
        }
        if let Ok(home) = std::env::var("HOME") {
            let bun_home = PathBuf::from(home).join(".bun").join("bin").join("bun");
            if bun_home.exists() {
                launcher_log(&format!("Found ~/.bun/bin/bun at {:?}", bun_home));
                return Some(bun_home);
            }
        }
    }

    // 4. Check PATH
    let check_cmd = if cfg!(target_os = "windows") { "bun.exe" } else { "bun" };
    let mut path_cmd = Command::new(check_cmd);
    path_cmd.arg("--version");
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        path_cmd.creation_flags(0x08000000);
    }
    if let Ok(output) = path_cmd.output() {
        if output.status.success() {
            launcher_log(&format!("Found Bun in system PATH: {}", check_cmd));
            return Some(PathBuf::from(check_cmd));
        }
    }

    // 5. Download Bun (guarded by Mutex to prevent double download)
    let _guard = BUN_DOWNLOAD_MUTEX.lock().unwrap();
    if local_bun.exists() && local_bun.is_file() {
        return Some(local_bun);
    }

    let _ = std::fs::create_dir_all(&bin_dir);
    launcher_log(&format!("📦 Bun runtime not found. Bootstrapping Bun into {:?}...", bin_dir));

    #[cfg(not(target_os = "windows"))]
    {
        let is_arm = cfg!(target_arch = "aarch64");
        let zip_url = if is_arm {
            "https://github.com/oven-sh/bun/releases/latest/download/bun-darwin-aarch64.zip"
        } else {
            "https://github.com/oven-sh/bun/releases/latest/download/bun-darwin-x64.zip"
        };
        let zip_file = bin_dir.join("bun_download.zip");
        let extract_dir = bin_dir.join("bun_extract");

        let download_script = format!(
            "curl -fsSL '{}' -o '{}' && unzip -q -o '{}' -d '{}' && cp '{}/bun-darwin-'*'/bun' '{}' && chmod +x '{}'; rm -rf '{}' '{}'",
            zip_url,
            zip_file.to_string_lossy(),
            zip_file.to_string_lossy(),
            extract_dir.to_string_lossy(),
            extract_dir.to_string_lossy(),
            local_bun.to_string_lossy(),
            local_bun.to_string_lossy(),
            zip_file.to_string_lossy(),
            extract_dir.to_string_lossy()
        );

        let _ = Command::new("sh")
            .arg("-c")
            .arg(&download_script)
            .status();
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let zip_url = "https://github.com/oven-sh/bun/releases/latest/download/bun-windows-x64-baseline.zip";
        let zip_file = bin_dir.join("bun_download.zip");

        launcher_log(&format!("Invoking curl.exe directly to download Bun from {}", zip_url));
        let curl_res = Command::new("curl.exe")
            .creation_flags(0x08000000)
            .args(["-fsSL", zip_url, "-o", &zip_file.to_string_lossy()])
            .status();

        match curl_res {
            Ok(st) if st.success() => {
                launcher_log("curl.exe completed successfully. Extracting with tar.exe...");
                let tar_res = Command::new("tar.exe")
                    .creation_flags(0x08000000)
                    .args(["-xf", &zip_file.to_string_lossy(), "-C", &bin_dir.to_string_lossy()])
                    .status();

                if let Ok(t_st) = tar_res {
                    if !t_st.success() {
                        launcher_log(&format!("tar.exe extraction returned exit code {:?}", t_st.code()));
                    }
                }

                let baseline_bun = bin_dir.join("bun-windows-x64-baseline").join("bun.exe");
                if baseline_bun.exists() {
                    let _ = std::fs::copy(&baseline_bun, &local_bun);
                    let _ = std::fs::remove_dir_all(bin_dir.join("bun-windows-x64-baseline"));
                }
                let _ = std::fs::remove_file(&zip_file);
            }
            Ok(st) => {
                launcher_log(&format!("curl.exe failed with exit code {:?}", st.code()));
            }
            Err(e) => {
                launcher_log(&format!("Failed to invoke curl.exe: {}", e));
            }
        }
    }

    if local_bun.exists() && local_bun.is_file() {
        // Verify bun execution
        let mut verify_cmd = Command::new(&local_bun);
        verify_cmd.arg("--version");
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            verify_cmd.creation_flags(0x08000000);
        }
        let verify = verify_cmd.output();
        if let Ok(out) = verify {
            if out.status.success() {
                let ver = String::from_utf8_lossy(&out.stdout).trim().to_string();
                launcher_log(&format!("✅ Bun bootstrapped and verified ({}) at {:?}", ver, local_bun));
                return Some(local_bun);
            }
        }
    }

    launcher_log("⚠️ Bun bootstrapping failed or binary could not be verified");
    None
}

fn find_ffmpeg(app: &AppHandle, mcp_home: &PathBuf) -> Option<PathBuf> {
    let local_ffmpeg_name = if cfg!(target_os = "windows") { "ffmpeg.exe" } else { "ffmpeg" };
    let local_ffmpeg = mcp_home.join("bin").join(local_ffmpeg_name);
    if local_ffmpeg.exists() && local_ffmpeg.is_file() {
        return Some(local_ffmpeg);
    }

    if let Ok(exe) = std::env::current_exe() {
        let exe = clean_windows_path(exe);
        if let Some(dir) = exe.parent() {
            let bundled = dir.join(local_ffmpeg_name);
            if bundled.exists() { return Some(bundled); }
            let bundled_bin = dir.join("binaries").join(local_ffmpeg_name);
            if bundled_bin.exists() { return Some(bundled_bin); }
        }
    }

    if let Ok(res_dir) = app.path().resource_dir() {
        let res_dir = clean_windows_path(res_dir);
        let bundled = res_dir.join("binaries").join(local_ffmpeg_name);
        if bundled.exists() { return Some(bundled); }
    }

    let mut ff_cmd = Command::new(local_ffmpeg_name);
    ff_cmd.arg("-version");
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        ff_cmd.creation_flags(0x08000000);
    }
    if let Ok(output) = ff_cmd.output() {
        if output.status.success() {
            return Some(PathBuf::from(local_ffmpeg_name));
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        for p in &["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"] {
            let pb = PathBuf::from(p);
            if pb.exists() { return Some(pb); }
        }
    }

    #[cfg(target_os = "windows")]
    {
        let bin_dir = mcp_home.join("bin");
        let _ = std::fs::create_dir_all(&bin_dir);
        launcher_log(&format!("📦 ffmpeg.exe not found on Windows. Downloading directly to {:?}...", bin_dir));
        use std::os::windows::process::CommandExt;
        let zip_file = bin_dir.join("ff.zip");
        let curl_res = Command::new("curl.exe")
            .creation_flags(0x08000000)
            .args([
                "-fsSL",
                "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip",
                "-o",
                &zip_file.to_string_lossy(),
            ])
            .status();

        if curl_res.as_ref().map(|s| s.success()).unwrap_or(false) {
            let _ = Command::new("tar.exe")
                .creation_flags(0x08000000)
                .args(["-xf", &zip_file.to_string_lossy(), "-C", &bin_dir.to_string_lossy()])
                .status();

            let extracted = bin_dir.join("ffmpeg-master-latest-win64-gpl").join("bin").join("ffmpeg.exe");
            if extracted.exists() {
                let _ = std::fs::copy(&extracted, &local_ffmpeg);
                let _ = std::fs::remove_dir_all(bin_dir.join("ffmpeg-master-latest-win64-gpl"));
            }
            let _ = std::fs::remove_file(&zip_file);
        }

        if local_ffmpeg.exists() {
            launcher_log(&format!("✅ ffmpeg.exe verified at {:?}", local_ffmpeg));
            return Some(local_ffmpeg);
        }
    }

    None
}

fn find_engine_path(app: &AppHandle) -> Option<PathBuf> {
    let names = if cfg!(target_os = "windows") {
        vec![
            "engine.exe",
            "engine-x86_64-pc-windows-msvc.exe",
            "engine",
        ]
    } else {
        vec![
            "engine-aarch64-apple-darwin",
            "engine",
            "engine.exe",
        ]
    };

    let mut search_dirs: Vec<PathBuf> = Vec::new();

    // 1. Current running executable parent directory ($INSTDIR on Windows)
    if let Ok(exe) = std::env::current_exe() {
        let exe = clean_windows_path(exe);
        if let Some(dir) = exe.parent() {
            search_dirs.push(dir.to_path_buf());
            search_dirs.push(dir.join("binaries"));
            search_dirs.push(dir.join("resources"));
            search_dirs.push(dir.join("resources").join("binaries"));
            if let Some(parent) = dir.parent() {
                search_dirs.push(parent.join("Resources"));
                search_dirs.push(parent.join("Resources").join("binaries"));
            }
        }
    }

    // 2. Bundled resources directory from Tauri
    if let Ok(res_dir) = app.path().resource_dir() {
        let res_dir = clean_windows_path(res_dir);
        search_dirs.push(res_dir.clone());
        search_dirs.push(res_dir.join("binaries"));
        search_dirs.push(res_dir.join("resources"));
        search_dirs.push(res_dir.join("resources").join("binaries"));
    }

    // 3. Local dev candidates
    for d in &["binaries", "src-tauri/binaries", "../src-tauri/binaries"] {
        search_dirs.push(PathBuf::from(d));
    }

    for dir in &search_dirs {
        for name in &names {
            let candidate = clean_windows_path(dir.join(name));
            if candidate.exists() && candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn cleanup_all_associated_processes() {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = Command::new("sh")
            .arg("-c")
            .arg("lsof -ti :8787 | xargs kill -9 2>/dev/null || true; lsof -ti :9333 | xargs kill -9 2>/dev/null || true; pkill -f 'flow-mcp/chrome-profile' 2>/dev/null || true; pkill -f 'engine.mjs' 2>/dev/null || true; pkill -f 'devideo.app/Contents/Resources/binaries/engine' 2>/dev/null || true")
            .status();
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("cmd")
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .args([
                "/C",
                "taskkill /F /IM engine.exe /T 2>nul & taskkill /F /IM engine-x86_64-pc-windows-msvc.exe /T 2>nul & for /f \"tokens=5\" %a in ('netstat -aon ^| findstr :8787 ^| findstr LISTENING') do @if not \"%a\"==\"0\" taskkill /F /PID %a 2>nul",
            ])
            .status();

        let _ = Command::new("powershell")
            .creation_flags(0x08000000)
            .args([
                "-NoProfile",
                "-Command",
                "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*engine.mjs*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
            ])
            .status();
    }
}

fn spawn_engine_process(app: &AppHandle) -> Result<(Child, PathBuf), String> {
    let log_dir = dirs_token_path()
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."));
    let _ = std::fs::create_dir_all(&log_dir);
    let log_file = log_dir.join("engine.log");
    let prev_log = log_dir.join("engine.prev.log");

    // Rotate log: rename engine.log -> engine.prev.log then open with append
    if log_file.exists() {
        let _ = std::fs::rename(&log_file, &prev_log);
    }

    let mcp_bin_dir = log_dir.join("bin");
    let _ = std::fs::create_dir_all(&mcp_bin_dir);

    let path_var = std::env::var("PATH").unwrap_or_default();
    #[cfg(not(target_os = "windows"))]
    let extended_path = format!("{}:{}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin", mcp_bin_dir.to_string_lossy(), path_var);
    #[cfg(target_os = "windows")]
    let extended_path = format!("{};{};{}", mcp_bin_dir.to_string_lossy(), path_var, "C:\\Windows\\System32");

    let maybe_ffmpeg = find_ffmpeg(app, &log_dir);

    // 1. Preferred modern runtime: Bun running engine.mjs (~4 MB payload instead of 90MB compiled binary)
    if let Some(engine_mjs) = find_engine_mjs_path(app) {
        if let Some(bun_path) = find_or_install_bun(app, &log_dir) {
            launcher_log(&format!("🚀 Launching devideo Engine with Bun ({:?}) -> {:?}", bun_path, engine_mjs));

            let mut cmd = Command::new(&bun_path);
            cmd.args(["run", &engine_mjs.to_string_lossy()]);
            if let Some(parent) = engine_mjs.parent() {
                cmd.current_dir(parent);
            }
            cmd.env("PATH", &extended_path);
            cmd.env("FLOW_MCP_HOME", log_dir.to_string_lossy().to_string());
            if let Some(ref ff) = maybe_ffmpeg {
                cmd.env("FLOW_MCP_FFMPEG", ff.to_string_lossy().to_string());
            }
            cmd.stdin(std::process::Stdio::null());

            #[cfg(target_os = "windows")]
            {
                use std::os::windows::process::CommandExt;
                cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
            }

            if let Ok(f_out) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&log_file)
            {
                if let Ok(f_err) = f_out.try_clone() {
                    cmd.stderr(f_err);
                }
                cmd.stdout(f_out);
            }

            match cmd.spawn() {
                Ok(c) => {
                    launcher_log(&format!("✅ Engine process running (bun engine.mjs) with PID {}", c.id()));
                    append_to_engine_log(&format!("[tauri] engine started with PID {}\n", c.id()));
                    return Ok((c, engine_mjs));
                }
                Err(e) => {
                    let err_msg = format!("Failed to spawn bun {:?} with {:?}: {}", bun_path, engine_mjs, e);
                    launcher_log(&format!("⚠️ {}", err_msg));
                    append_to_engine_log(&format!("[tauri] {}\n", err_msg));
                    return Err(err_msg);
                }
            }
        } else {
            let err_msg = "Bun runtime not found and auto-bootstrap failed".to_string();
            launcher_log(&format!("⚠️ {}", err_msg));
            return Err(err_msg);
        }
    }

    // 2. Legacy fallback to standalone compiled binary if present
    if let Some(engine_path) = find_engine_path(app) {
        launcher_log(&format!("🚀 Launching devideo Engine legacy binary from: {:?}", engine_path));

        let mut cmd = Command::new(&engine_path);
        let mut engine_env_path = extended_path.clone();
        if let Some(parent_dir) = engine_path.parent() {
            cmd.current_dir(parent_dir);
            #[cfg(target_os = "windows")]
            {
                engine_env_path = format!("{};{}", parent_dir.to_string_lossy(), extended_path);
            }
            #[cfg(not(target_os = "windows"))]
            {
                engine_env_path = format!("{}:{}", parent_dir.to_string_lossy(), extended_path);
            }
        }
        cmd.env("PATH", &engine_env_path);
        cmd.env("FLOW_MCP_HOME", log_dir.to_string_lossy().to_string());
        if let Some(ref ff) = maybe_ffmpeg {
            cmd.env("FLOW_MCP_FFMPEG", ff.to_string_lossy().to_string());
        }
        cmd.stdin(std::process::Stdio::null());

        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }

        if let Ok(f_out) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_file)
        {
            if let Ok(f_err) = f_out.try_clone() {
                cmd.stderr(f_err);
            }
            cmd.stdout(f_out);
        }

        match cmd.spawn() {
            Ok(c) => {
                launcher_log(&format!("✅ Engine legacy process running with PID {}", c.id()));
                append_to_engine_log(&format!("[tauri] legacy engine started with PID {}\n", c.id()));
                return Ok((c, engine_path));
            }
            Err(e) => {
                let err_msg = format!("Failed to spawn legacy binary {:?}: {}", engine_path, e);
                launcher_log(&format!("⚠️ {}", err_msg));
                append_to_engine_log(&format!("[tauri] {}\n", err_msg));
                return Err(err_msg);
            }
        }
    }

    // 3. Dev fallback (only in debug builds)
    #[cfg(debug_assertions)]
    {
        launcher_log("ℹ️ Spawning engine via Bun dev fallback (debug_assertions)...");
        let mut cmd = Command::new("bun");
        cmd.args(["run", "src/server-entry.ts"])
            .current_dir("../engine")
            .env("PATH", &extended_path)
            .env("FLOW_MCP_HOME", log_dir.to_string_lossy().to_string());
        if let Some(ref ff) = maybe_ffmpeg {
            cmd.env("FLOW_MCP_FFMPEG", ff.to_string_lossy().to_string());
        }

        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000);
            cmd.stdin(std::process::Stdio::null());
        }
        #[cfg(not(target_os = "windows"))]
        {
            cmd.stdin(std::process::Stdio::piped());
        }

        if let Ok(f_out) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_file)
        {
            if let Ok(f_err) = f_out.try_clone() {
                cmd.stderr(f_err);
            }
            cmd.stdout(f_out);
        }

        if let Ok(c) = cmd.spawn() {
            launcher_log(&format!("✅ Engine dev process running with PID {}", c.id()));
            append_to_engine_log(&format!("[tauri] dev fallback engine started with PID {}\n", c.id()));
            return Ok((c, PathBuf::from("bun run src/server-entry.ts")));
        }
    }

    let err_msg = "Could not find engine.mjs or standalone engine binary to launch".to_string();
    launcher_log(&format!("⚠️ {}", err_msg));
    Err(err_msg)
}

fn start_supervisor(app: AppHandle, inner: Arc<Mutex<SupervisorInner>>) {
    std::thread::spawn(move || {
        // Step 1: Initial startup
        launcher_log("Supervisor thread started");

        let log_dir = dirs_token_path()
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| PathBuf::from("."));

        // Check if bun needs download
        let local_bun_name = if cfg!(target_os = "windows") { "bun.exe" } else { "bun" };
        let has_bun = find_engine_path(&app).is_some() || {
            // Check if bun exists before downloading
            let bin_bun = log_dir.join("bin").join(local_bun_name);
            bin_bun.exists()
        };

        if !has_bun {
            if let Ok(mut lock) = inner.lock() {
                lock.engine_state = "downloading_runtime".to_string();
            }
        }

        if is_engine_port_open() {
            launcher_log("Engine port 8787 already open on startup");
            if let Ok(mut lock) = inner.lock() {
                lock.alive = true;
                lock.engine_state = "ready".to_string();
            }
        } else {
            if let Ok(mut lock) = inner.lock() {
                if lock.engine_state != "downloading_runtime" {
                    lock.engine_state = "starting".to_string();
                }
            }

            match spawn_engine_process(&app) {
                Ok((child, path)) => {
                    if let Ok(mut lock) = inner.lock() {
                        lock.child = Some(child);
                        lock.engine_path = path.to_string_lossy().to_string();
                        lock.engine_state = "starting".to_string();
                    }
                }
                Err(err) => {
                    if let Ok(mut lock) = inner.lock() {
                        lock.engine_state = "failed".to_string();
                        lock.engine_error = Some(err);
                    }
                }
            }
        }

        // Step 2: Watchdog loop every 2 seconds
        loop {
            std::thread::sleep(Duration::from_secs(2));

            let mut should_respawn = false;
            let mut last_code: Option<i32> = None;

            if let Ok(mut lock) = inner.lock() {
                // If child process exists, check if alive
                if let Some(ref mut child) = lock.child {
                    match child.try_wait() {
                        Ok(Some(status)) => {
                            let code = status.code();
                            last_code = code;
                            lock.alive = false;
                            lock.exit_code = code;
                            lock.child = None;
                            launcher_log(&format!("Watchdog detected engine exit with code {:?}", code));
                            append_to_engine_log(&format!("[tauri] engine exited with code {:?}\n", code));

                            // Rate limit: max 5 restarts within 60s
                            let now = std::time::Instant::now();
                            lock.restart_timestamps.retain(|t| now.duration_since(*t) < Duration::from_secs(60));
                            if lock.restart_timestamps.len() < 5 {
                                lock.restarts += 1;
                                lock.restart_timestamps.push(now);
                                lock.engine_state = "starting".to_string();
                                should_respawn = true;
                            } else {
                                lock.engine_state = "failed".to_string();
                                lock.engine_error = Some(format!("Engine crashed repeatedly (exited with code {:?})", code));
                                launcher_log("Watchdog: Max restarts (5/min) reached. Halting respawn.");
                            }
                        }
                        Ok(None) => {
                            // Still running
                            if is_engine_port_open() {
                                lock.alive = true;
                                lock.engine_state = "ready".to_string();
                            }
                        }
                        Err(e) => {
                            launcher_log(&format!("Error checking child status: {}", e));
                        }
                    }
                } else if is_engine_port_open() {
                    lock.alive = true;
                    lock.engine_state = "ready".to_string();
                }
            }

            if should_respawn {
                launcher_log(&format!("Supervisor respawning engine after exit {:?}", last_code));
                match spawn_engine_process(&app) {
                    Ok((child, path)) => {
                        if let Ok(mut lock) = inner.lock() {
                            lock.child = Some(child);
                            lock.engine_path = path.to_string_lossy().to_string();
                        }
                    }
                    Err(err) => {
                        if let Ok(mut lock) = inner.lock() {
                            lock.engine_state = "failed".to_string();
                            lock.engine_error = Some(err);
                        }
                    }
                }
            }
        }
    });
}

#[tauri::command]
async fn get_engine_config(
    app: AppHandle,
    state: tauri::State<'_, EngineSupervisor>,
) -> Result<EngineConfig, String> {
    let token_path = dirs_token_path();
    let log_file = token_path
        .parent()
        .map(|p| p.join("engine.log"))
        .unwrap_or_else(|| PathBuf::from("engine.log"));

    // If port is closed and state is failed/not started, trigger a quick spawn attempt
    let (curr_state, _) = {
        let lock = state.0.lock().map_err(|e| e.to_string())?;
        (lock.engine_state.clone(), lock.engine_path.clone())
    };

    if !is_engine_port_open() && curr_state == "failed" {
        launcher_log("get_engine_config requested retry after failure");
        if let Ok((child, p)) = spawn_engine_process(&app) {
            if let Ok(mut lock) = state.0.lock() {
                lock.child = Some(child);
                lock.engine_path = p.to_string_lossy().to_string();
                lock.engine_state = "starting".to_string();
                lock.engine_error = None;
            }
        }
    }

    let mut token = String::new();

    // Poll up to 8 seconds for engine to boot, open port 8787, and write token
    for _ in 0..80 {
        if let Ok(t) = std::fs::read_to_string(&token_path) {
            let trimmed = t.trim().to_string();
            if !trimmed.is_empty() && is_engine_port_open() {
                token = trimmed;
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    if token.is_empty() {
        if let Ok(t) = std::fs::read_to_string(&token_path) {
            token = t.trim().to_string();
        }
    }

    let (engine_path_str, engine_state_str, engine_error_opt) = {
        let lock = state.0.lock().map_err(|e| e.to_string())?;
        let state_val = if is_engine_port_open() {
            "ready".to_string()
        } else {
            lock.engine_state.clone()
        };
        (lock.engine_path.clone(), state_val, lock.engine_error.clone())
    };

    let log_tail = std::fs::read_to_string(&log_file)
        .unwrap_or_default()
        .lines()
        .rev()
        .take(8)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join(" | ");

    Ok(EngineConfig {
        url: "http://127.0.0.1:8787".to_string(),
        token,
        engine_path: if engine_path_str.is_empty() { "not_found".to_string() } else { engine_path_str },
        log_tail,
        engine_state: engine_state_str,
        engine_error: engine_error_opt,
    })
}

#[tauri::command]
async fn get_engine_diagnostics(
    state: tauri::State<'_, EngineSupervisor>,
) -> Result<EngineDiagnostics, String> {
    let mut lock = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(ref mut child) = lock.child {
        if let Ok(Some(st)) = child.try_wait() {
            lock.alive = false;
            lock.exit_code = st.code();
        }
    }

    let alive = lock.alive || is_engine_port_open();
    let state_val = if is_engine_port_open() {
        "ready".to_string()
    } else {
        lock.engine_state.clone()
    };
    let log_tail = get_diagnostics_log_tail();

    Ok(EngineDiagnostics {
        alive,
        exit_code: lock.exit_code,
        restarts: lock.restarts,
        engine_state: state_val,
        engine_error: lock.engine_error.clone(),
        log_tail,
    })
}

pub fn run() {
    let supervisor_inner = Arc::new(Mutex::new(SupervisorInner {
        child: None,
        alive: false,
        exit_code: None,
        restarts: 0,
        restart_timestamps: Vec::new(),
        engine_state: "starting".to_string(),
        engine_error: None,
        engine_path: String::new(),
    }));

    let supervisor_for_setup = Arc::clone(&supervisor_inner);
    let supervisor_for_cleanup = Arc::clone(&supervisor_inner);
    let supervisor_for_window = Arc::clone(&supervisor_inner);

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(EngineSupervisor(supervisor_inner))
        .invoke_handler(tauri::generate_handler![get_engine_config, get_engine_diagnostics])
        .on_window_event(move |window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                launcher_log("🛑 Window close requested. Killing all associated processes...");
                if let Ok(mut lock) = supervisor_for_window.lock() {
                    if let Some(mut child) = lock.child.take() {
                        let _ = child.kill();
                    }
                }
                cleanup_all_associated_processes();
                window.app_handle().exit(0);
            }
        })
        .setup(move |app| {
            cleanup_all_associated_processes();
            let handle = app.handle().clone();
            start_supervisor(handle, supervisor_for_setup);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(move |_app_handle, event| {
        if let RunEvent::ExitRequested { .. } = event {
            launcher_log("🛑 Exit requested. Ensuring all associated processes are killed...");
            if let Ok(mut lock) = supervisor_for_cleanup.lock() {
                if let Some(mut child) = lock.child.take() {
                    let _ = child.kill();
                }
            }
            cleanup_all_associated_processes();
        }
    });
}
