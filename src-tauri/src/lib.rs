use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, RunEvent};

#[allow(dead_code)]
struct EngineProcess(Arc<Mutex<Option<Child>>>);

#[derive(serde::Serialize)]
pub struct EngineConfig {
    pub url: String,
    pub token: String,
}

#[tauri::command]
async fn get_engine_config() -> EngineConfig {
    let token_path = dirs_token_path();
    let mut token = String::new();

    // Poll up to 3 seconds for engine to boot and write token
    for _ in 0..30 {
        if let Ok(t) = std::fs::read_to_string(&token_path) {
            let trimmed = t.trim().to_string();
            if !trimmed.is_empty() {
                token = trimmed;
                break;
            }
        }
        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
    }

    EngineConfig {
        url: "http://127.0.0.1:8787".to_string(),
        token,
    }
}

fn dirs_token_path() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        // First check USERPROFILE (where Node/Bun homedir() writes ~/.flow-mcp)
        if let Ok(userprofile) = std::env::var("USERPROFILE") {
            let p = PathBuf::from(userprofile).join(".flow-mcp").join("token");
            if p.exists() {
                return p;
            }
        }
        let local_app_data = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| ".".to_string());
        PathBuf::from(local_app_data).join(".flow-mcp").join("token")
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
        if let Some(dir) = exe.parent() {
            search_dirs.push(dir.to_path_buf());
            search_dirs.push(dir.join("binaries"));
            search_dirs.push(dir.join("resources"));
            search_dirs.push(dir.join("resources").join("binaries"));
        }
    }

    // 2. Bundled resources directory from Tauri
    if let Ok(res_dir) = app.path().resource_dir() {
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
            let candidate = dir.join(name);
            if candidate.exists() {
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
        let _ = Command::new("cmd")
            .args(["/C", "for /f \"tokens=5\" %a in ('netstat -aon ^| findstr :8787') do taskkill /f /pid %a 2>nul & for /f \"tokens=5\" %a in ('netstat -aon ^| findstr :9333') do taskkill /f /pid %a 2>nul"])
            .status();
    }
}

pub fn run() {
    let engine_child: Arc<Mutex<Option<Child>>> = Arc::new(Mutex::new(None));
    let engine_for_setup = Arc::clone(&engine_child);
    let engine_for_cleanup = Arc::clone(&engine_child);
    let engine_for_window = Arc::clone(&engine_child);

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(EngineProcess(engine_child))
        .invoke_handler(tauri::generate_handler![get_engine_config])
        .on_window_event(move |window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                println!("🛑 Window close requested. Killing all associated processes...");
                let mut lock = engine_for_window.lock().unwrap();
                if let Some(mut child) = lock.take() {
                    let _ = child.kill();
                }
                cleanup_all_associated_processes();
                window.app_handle().exit(0);
            }
        })
        .setup(move |app| {
            // Clean any stale engine or chrome processes before launching
            cleanup_all_associated_processes();

            let handle = app.handle();
            let mut launched = false;

            let path_var = std::env::var("PATH").unwrap_or_default();
            #[cfg(not(target_os = "windows"))]
            let full_path = format!("{}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin", path_var);
            #[cfg(target_os = "windows")]
            let full_path = path_var;

            let log_dir = dirs_token_path().parent().map(|p| p.to_path_buf()).unwrap_or_else(|| PathBuf::from("."));
            let _ = std::fs::create_dir_all(&log_dir);
            let log_file = log_dir.join("engine.log");

            if let Some(engine_path) = find_engine_path(handle) {
                println!("🚀 Launching devideo Engine from: {:?}", engine_path);

                let mut cmd = Command::new(&engine_path);
                cmd.env("PATH", &full_path);
                cmd.env("FLOW_MCP_HOME", log_dir.to_string_lossy().to_string());

                #[cfg(target_os = "windows")]
                {
                    use std::os::windows::process::CommandExt;
                    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
                    cmd.stdin(std::process::Stdio::null());
                }
                #[cfg(not(target_os = "windows"))]
                {
                    cmd.stdin(std::process::Stdio::piped());
                }

                if let Ok(f_out) = std::fs::OpenOptions::new().create(true).append(true).open(&log_file) {
                    cmd.stdout(f_out);
                }
                if let Ok(f_err) = std::fs::OpenOptions::new().create(true).append(true).open(&log_file) {
                    cmd.stderr(f_err);
                }
                match cmd.spawn() {
                    Ok(c) => {
                        println!("✅ Engine process running with PID {}", c.id());
                        let mut lock = engine_for_setup.lock().unwrap();
                        *lock = Some(c);
                        launched = true;
                    }
                    Err(e) => {
                        eprintln!("⚠️ Failed to launch bundled engine binary: {}", e);
                    }
                }
            }

            if !launched {
                println!("ℹ️ Spawning engine via Bun dev fallback...");
                let mut cmd = Command::new("bun");
                cmd.args(["run", "src/server-entry.ts"])
                    .current_dir("../engine")
                    .env("PATH", &full_path)
                    .stdin(std::process::Stdio::piped());

                if let Ok(f_out) = std::fs::OpenOptions::new().create(true).append(true).open(&log_file) {
                    cmd.stdout(f_out);
                }
                if let Ok(f_err) = std::fs::OpenOptions::new().create(true).append(true).open(&log_file) {
                    cmd.stderr(f_err);
                }

                if let Ok(c) = cmd.spawn() {
                    println!("✅ Engine dev process running with PID {}", c.id());
                    let mut lock = engine_for_setup.lock().unwrap();
                    *lock = Some(c);
                } else {
                    eprintln!("⚠️ Note: Background engine not spawned (ensure engine runs separately or check permissions)");
                }
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(move |_app_handle, event| {
        match event {
            RunEvent::ExitRequested { .. } => {
                println!("🛑 Exit requested. Ensuring all associated processes are killed...");
                let mut lock = engine_for_cleanup.lock().unwrap();
                if let Some(mut child) = lock.take() {
                    let _ = child.kill();
                }
                cleanup_all_associated_processes();
            }
            _ => {}
        }
    });
}
