use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager, RunEvent};

#[allow(dead_code)]
struct EngineProcess(Arc<Mutex<Option<Child>>>);

#[derive(serde::Serialize)]
pub struct EngineConfig {
    pub url: String,
    pub token: String,
    pub engine_path: String,
    pub log_tail: String,
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

fn find_or_install_bun(mcp_home: &PathBuf) -> Option<PathBuf> {
    let bin_dir = mcp_home.join("bin");
    let local_bun_name = if cfg!(target_os = "windows") { "bun.exe" } else { "bun" };
    let local_bun = bin_dir.join(local_bun_name);

    if local_bun.exists() && local_bun.is_file() {
        return Some(local_bun);
    }

    let check_cmd = if cfg!(target_os = "windows") { "bun.exe" } else { "bun" };
    if let Ok(output) = Command::new(check_cmd).arg("--version").output() {
        if output.status.success() {
            return Some(PathBuf::from(check_cmd));
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
                return Some(pb);
            }
        }
        if let Ok(home) = std::env::var("HOME") {
            let bun_home = PathBuf::from(home).join(".bun").join("bin").join("bun");
            if bun_home.exists() {
                return Some(bun_home);
            }
        }
    }

    let _ = std::fs::create_dir_all(&bin_dir);
    println!("📦 Bun runtime not found. Bootstrapping Bun into {:?}...", bin_dir);

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
        let download_cmd = format!(
            "curl.exe -fsSL \"{}\" -o \"{}\" && tar.exe -xf \"{}\" -C \"{}\" && copy /Y \"{}\\bun-windows-x64-baseline\\bun.exe\" \"{}\" & del /Q \"{}\"",
            zip_url,
            zip_file.to_string_lossy(),
            zip_file.to_string_lossy(),
            bin_dir.to_string_lossy(),
            bin_dir.to_string_lossy(),
            local_bun.to_string_lossy(),
            zip_file.to_string_lossy()
        );
        let _ = Command::new("cmd")
            .creation_flags(0x08000000)
            .args(["/C", &download_cmd])
            .status();
    }

    if local_bun.exists() && local_bun.is_file() {
        println!("✅ Bun bootstrapped successfully at {:?}", local_bun);
        return Some(local_bun);
    }

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

    if let Ok(output) = Command::new(local_ffmpeg_name).arg("-version").output() {
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
        println!("📦 ffmpeg.exe not found on Windows. Downloading minimal build to {:?}...", bin_dir);
        use std::os::windows::process::CommandExt;
        let _ = Command::new("cmd")
            .creation_flags(0x08000000)
            .args([
                "/C",
                &format!(
                    "curl.exe -fsSL \"https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip\" -o \"{}\\ff.zip\" && tar.exe -xf \"{}\\ff.zip\" -C \"{}\" && copy /Y \"{}\\ffmpeg-master-latest-win64-gpl\\bin\\ffmpeg.exe\" \"{}\" & del /Q \"{}\\ff.zip\"",
                    bin_dir.to_string_lossy(),
                    bin_dir.to_string_lossy(),
                    bin_dir.to_string_lossy(),
                    bin_dir.to_string_lossy(),
                    local_ffmpeg.to_string_lossy(),
                    bin_dir.to_string_lossy()
                ),
            ])
            .status();

        if local_ffmpeg.exists() {
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
    }
}

fn spawn_engine(app: &AppHandle, state: &Arc<Mutex<Option<Child>>>) -> Option<PathBuf> {
    if is_engine_port_open() {
        return find_engine_mjs_path(app).or_else(|| find_engine_path(app));
    }

    if let Ok(mut lock) = state.lock() {
        if let Some(ref mut child) = *lock {
            if let Ok(None) = child.try_wait() {
                return find_engine_mjs_path(app).or_else(|| find_engine_path(app));
            }
        }
    }

    let path_var = std::env::var("PATH").unwrap_or_default();
    #[cfg(not(target_os = "windows"))]
    let full_path = format!("{}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin", path_var);
    #[cfg(target_os = "windows")]
    let full_path = path_var;

    let log_dir = dirs_token_path()
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."));
    let _ = std::fs::create_dir_all(&log_dir);
    let log_file = log_dir.join("engine.log");

    let mcp_bin_dir = log_dir.join("bin");
    let _ = std::fs::create_dir_all(&mcp_bin_dir);

    #[cfg(not(target_os = "windows"))]
    let extended_path = format!("{}:{}", mcp_bin_dir.to_string_lossy(), full_path);
    #[cfg(target_os = "windows")]
    let extended_path = format!("{};{}", mcp_bin_dir.to_string_lossy(), full_path);

    let maybe_ffmpeg = find_ffmpeg(app, &log_dir);

    // 1. Preferred modern runtime: Bun running engine.mjs (~4 MB payload instead of 90MB compiled binary)
    if let Some(engine_mjs) = find_engine_mjs_path(app) {
        if let Some(bun_path) = find_or_install_bun(&log_dir) {
            println!("🚀 Launching devideo Engine with Bun ({:?}) -> {:?}", bun_path, engine_mjs);

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
                .write(true)
                .truncate(true)
                .open(&log_file)
            {
                if let Ok(f_err) = f_out.try_clone() {
                    cmd.stderr(f_err);
                }
                cmd.stdout(f_out);
            }

            match cmd.spawn() {
                Ok(c) => {
                    println!("✅ Engine process running (bun engine.mjs) with PID {}", c.id());
                    if let Ok(mut lock) = state.lock() {
                        *lock = Some(c);
                    }
                    return Some(engine_mjs);
                }
                Err(e) => {
                    let err_msg = format!("Failed to spawn bun {:?} with {:?}: {}\n", bun_path, engine_mjs, e);
                    eprintln!("⚠️ {}", err_msg);
                    let _ = std::fs::write(&log_file, err_msg);
                }
            }
        }
    }

    // 2. Legacy fallback to standalone compiled binary if present
    if let Some(engine_path) = find_engine_path(app) {
        println!("🚀 Launching devideo Engine legacy binary from: {:?}", engine_path);

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
            .write(true)
            .truncate(true)
            .open(&log_file)
        {
            if let Ok(f_err) = f_out.try_clone() {
                cmd.stderr(f_err);
            }
            cmd.stdout(f_out);
        }

        match cmd.spawn() {
            Ok(c) => {
                println!("✅ Engine legacy process running with PID {}", c.id());
                if let Ok(mut lock) = state.lock() {
                    *lock = Some(c);
                }
                return Some(engine_path);
            }
            Err(e) => {
                let err_msg = format!("Failed to spawn {:?}: {}\n", engine_path, e);
                eprintln!("⚠️ {}", err_msg);
                let _ = std::fs::write(&log_file, err_msg);
            }
        }
    }

    println!("ℹ️ Spawning engine via Bun dev fallback...");
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
        println!("✅ Engine dev process running with PID {}", c.id());
        if let Ok(mut lock) = state.lock() {
            *lock = Some(c);
        }
        return Some(PathBuf::from("bun run src/server-entry.ts"));
    }

    None
}

#[tauri::command]
async fn get_engine_config(
    app: AppHandle,
    state: tauri::State<'_, EngineProcess>,
) -> Result<EngineConfig, String> {
    let token_path = dirs_token_path();
    let log_file = token_path
        .parent()
        .map(|p| p.join("engine.log"))
        .unwrap_or_else(|| PathBuf::from("engine.log"));

    let engine_path_str = find_engine_mjs_path(&app)
        .or_else(|| find_engine_path(&app))
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| "not_found".to_string());

    if !is_engine_port_open() {
        spawn_engine(&app, &state.0);
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
        engine_path: engine_path_str,
        log_tail,
    })
}

pub fn run() {
    let engine_child: Arc<Mutex<Option<Child>>> = Arc::new(Mutex::new(None));
    let engine_for_setup = Arc::clone(&engine_child);
    let engine_for_cleanup = Arc::clone(&engine_child);
    let engine_for_window = Arc::clone(&engine_child);

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(EngineProcess(engine_child))
        .invoke_handler(tauri::generate_handler![get_engine_config])
        .on_window_event(move |window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                println!("🛑 Window close requested. Killing all associated processes...");
                if let Ok(mut lock) = engine_for_window.lock() {
                    if let Some(mut child) = lock.take() {
                        let _ = child.kill();
                    }
                }
                cleanup_all_associated_processes();
                window.app_handle().exit(0);
            }
        })
        .setup(move |app| {
            cleanup_all_associated_processes();
            let handle = app.handle();
            spawn_engine(handle, &engine_for_setup);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(move |_app_handle, event| {
        if let RunEvent::ExitRequested { .. } = event {
            println!("🛑 Exit requested. Ensuring all associated processes are killed...");
            if let Ok(mut lock) = engine_for_cleanup.lock() {
                if let Some(mut child) = lock.take() {
                    let _ = child.kill();
                }
            }
            cleanup_all_associated_processes();
        }
    });
}
