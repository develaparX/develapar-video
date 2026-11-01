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
            .arg("lsof -ti :8787 | xargs kill -9 2>/dev/null || true; lsof -ti :9333 | xargs kill -9 2>/dev/null || true; pkill -f 'flow-mcp/chrome-profile' 2>/dev/null || true; pkill -f 'devideo.app/Contents/Resources/binaries/engine' 2>/dev/null || true")
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
        return find_engine_path(app);
    }

    if let Ok(mut lock) = state.lock() {
        if let Some(ref mut child) = *lock {
            if let Ok(None) = child.try_wait() {
                return find_engine_path(app);
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

    if let Some(engine_path) = find_engine_path(app) {
        println!("🚀 Launching devideo Engine from: {:?}", engine_path);

        let mut cmd = Command::new(&engine_path);
        if let Some(parent_dir) = engine_path.parent() {
            cmd.current_dir(parent_dir);
        }
        cmd.env("PATH", &full_path);
        cmd.env("FLOW_MCP_HOME", log_dir.to_string_lossy().to_string());
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
                println!("✅ Engine process running with PID {}", c.id());
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
        .env("PATH", &full_path)
        .env("FLOW_MCP_HOME", log_dir.to_string_lossy().to_string());

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

    let engine_path_str = find_engine_path(&app)
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
