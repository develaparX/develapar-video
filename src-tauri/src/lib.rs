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
fn get_engine_config() -> EngineConfig {
    let token_path = dirs_token_path();
    let token = std::fs::read_to_string(&token_path)
        .unwrap_or_default()
        .trim()
        .to_string();

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

pub fn run() {
    let engine_child: Arc<Mutex<Option<Child>>> = Arc::new(Mutex::new(None));
    let engine_for_setup = Arc::clone(&engine_child);
    let engine_for_cleanup = Arc::clone(&engine_child);

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .manage(EngineProcess(engine_child))
        .invoke_handler(tauri::generate_handler![get_engine_config])
        .setup(move |app| {
            let handle = app.handle();
            let mut launched = false;

            if let Some(engine_path) = find_engine_path(handle) {
                println!("🚀 Launching Develapar Video Engine from: {:?}", engine_path);
                match Command::new(&engine_path).spawn() {
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
                let child = Command::new("bun")
                    .args(["run", "src/server-entry.ts"])
                    .current_dir("../engine")
                    .spawn()
                    .or_else(|_| {
                        Command::new("node")
                            .args(["dist/server-entry.js"])
                            .current_dir("../engine")
                            .spawn()
                    });

                if let Ok(c) = child {
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
        if let RunEvent::ExitRequested { .. } = event {
            let mut lock = engine_for_cleanup.lock().unwrap();
            if let Some(mut child) = lock.take() {
                println!("🛑 Stopping Develapar Video Engine...");
                let _ = child.kill();
            }
        }
    });
}
