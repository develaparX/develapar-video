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
        vec!["engine.exe", "engine"]
    } else {
        vec!["engine", "engine.exe"]
    };

    // 1. Check relative to current running executable
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for name in &names {
                let candidate = dir.join(name);
                if candidate.exists() {
                    return Some(candidate);
                }
            }
        }
    }
    // 2. Check bundled resources directory
    if let Ok(res_dir) = app.path().resource_dir() {
        for name in &names {
            let candidate = res_dir.join("binaries").join(name);
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }
    // 3. Check local dev binaries directory
    let dev_candidates = [
        "binaries/engine",
        "binaries/engine.exe",
        "src-tauri/binaries/engine",
        "src-tauri/binaries/engine.exe",
        "../src-tauri/binaries/engine",
        "../src-tauri/binaries/engine.exe",
    ];
    for c in &dev_candidates {
        let p = PathBuf::from(c);
        if p.exists() {
            return Some(p);
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

            // Ensure PATH has common locations on macOS
            let path_var = std::env::var("PATH").unwrap_or_default();
            let full_path = format!("{}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin", path_var);

            let log_dir = dirs_token_path().parent().map(|p| p.to_path_buf()).unwrap_or_else(|| PathBuf::from("."));
            let _ = std::fs::create_dir_all(&log_dir);
            let log_file = log_dir.join("engine.log");

            if let Some(engine_path) = find_engine_path(handle) {
                println!("🚀 Launching devideo Engine from: {:?}", engine_path);

                let mut cmd = Command::new(&engine_path);
                cmd.env("PATH", &full_path);
                cmd.stdin(std::process::Stdio::piped());
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
