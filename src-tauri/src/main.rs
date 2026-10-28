#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{atomic::{AtomicU64, Ordering}, Arc, Mutex},
};
use tauri::{Emitter, Manager};
use training_room::{domain::planning::text, service::Service, updater::Updater, Result};
use training_room::resources::repository::Resources;

struct Desktop {
    service: Service,
    updater: Updater,
}
type Shared = Arc<Mutex<Desktop>>;

fn resource_status(shared: &Shared, app: &tauri::AppHandle, phase: &str, message: &str) {
    if let Ok(mut desktop) = shared.lock() {
        desktop.service.resource_update = json!({"phase":phase,"message":message});
        desktop.service.invalidate(false);
        let _ = app.emit_to("main", "resource:state-changed", &desktop.service.resource_update);
    }
}

fn update_game_resources(shared: &Shared, app: &tauri::AppHandle, gate: &Mutex<()>) -> Result<()> {
    // Manual checks and the automatic worker share one flight, including the disk transaction.
    let _flight = gate.try_lock().map_err(|_| "游戏资源正在后台检查或更新，请稍候。")?;
    resource_status(shared, app, "checking", "正在后台检查游戏资源…");
    let result: Result<bool> = (|| {
        let current = shared.lock().map_err(|_| "应用状态锁不可用")?
            .service.resources.active.manifest.clone();
        let Some((manifest, bytes)) = Resources::download_update(&current, env!("CARGO_PKG_VERSION"))? else {
            return Ok(false);
        };
        resource_status(shared, app, "installing", "正在校验并应用游戏资源…");
        shared.lock().map_err(|_| "应用状态锁不可用")?.service.install_resources(&bytes, &manifest)?;
        Ok(true)
    })();
    match result {
        Ok(changed) => {
            resource_status(shared, app, if changed { "updated" } else { "current" },
                if changed { "游戏资源已自动更新，当前页面已使用最新资源。" } else { "当前已是最新兼容资源。" });
            if changed { let _ = app.emit_to("main", "app:state-changed", ()); }
            Ok(())
        }
        Err(error) => {
            if let Ok(desktop) = shared.lock() { desktop.service.store.log("game-data-update-failure", &error); }
            resource_status(shared, app, "error", &format!("资源检查或更新失败，继续使用已安装资源，下次自动重试。{error}"));
            Err(error)
        }
    }
}
#[derive(Deserialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Request {
    GetState {},
    StartQrLogin {},
    FinishQrLogin { scan_id: String },
    CancelQrLogin {},
    GetBindings {},
    Logout {},
    RefreshAccount { uid: Option<String> },
    UpdateGameData {},
    UpdateSettings { settings: Value },
    ClearCache {},
    MaterialDetail { item_id: String },
    GetUpdateState {},
    CheckForUpdates {},
    DownloadUpdate {},
    InstallUpdate {},
}
fn required(value: &str, label: &str, max: usize) -> Result<()> {
    if value.is_empty()
        || value.encode_utf16().count() > max
        || value.chars().any(|c| c <= '\u{1f}')
    {
        Err(format!("{label}格式无效"))
    } else {
        Ok(())
    }
}
fn trusted(url: &url::Url) -> bool {
    url.scheme() == "http"
        && url.host_str() == Some("tauri.localhost")
        && url.path() == "/dist/renderer/index.html"
}
fn theme(value: &str) -> Option<tauri::Theme> {
    match value {
        "black" => Some(tauri::Theme::Dark),
        "light" => Some(tauri::Theme::Light),
        _ => None,
    }
}

#[tauri::command]
async fn training_room(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    shared: tauri::State<'_, Shared>,
    login_generation: tauri::State<'_, Arc<AtomicU64>>,
    resource_gate: tauri::State<'_, Arc<Mutex<()>>>,
    request: Request,
) -> Result<Value> {
    if window.label() != "main" || !trusted(&window.url().map_err(|e| e.to_string())?) {
        return Err("拒绝来自非应用主窗口的 IPC 请求".into());
    }
    let login_generation = login_generation.inner().clone();
    if matches!(request, Request::StartQrLogin {} | Request::CancelQrLogin {}) {
        login_generation.fetch_add(1, Ordering::SeqCst);
    }
    // Cancellation must bypass the service lock held by the polling request.
    if matches!(request, Request::CancelQrLogin {}) { return Ok(Value::Null); }
    let generation = login_generation.load(Ordering::SeqCst);
    let shared = shared.inner().clone();
    let resource_gate = resource_gate.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        if matches!(request, Request::UpdateGameData {}) {
            update_game_resources(&shared, &app, &resource_gate)?;
            return shared.lock().map_err(|_| "应用状态锁不可用")?.service.state();
        }
        // ponytail: one serialized service barrier, split only if measured independent work needs concurrency.
        let mut desktop = shared.lock().map_err(|_| "应用状态锁不可用")?;
        let update = |state: &Value| {
            let _ = app.emit_to("main", "update:state-changed", state);
        };
        match request {
            Request::GetState {} => desktop.service.state(),
            Request::StartQrLogin {} => {
                desktop.service.store.log("qr-login-start", "");
                desktop.service.skland.start_qr()
            }
            Request::FinishQrLogin { scan_id } => {
                required(&scan_id, "扫码标识", 128)?;
                let service = &mut desktop.service;
                let result = service.skland.finish_qr(&mut service.store, &scan_id, &|| login_generation.load(Ordering::SeqCst) != generation)?;
                service.invalidate(false);
                service.store.log("qr-login-success", "");
                let _ = app.emit_to("main", "app:state-changed", ());
                Ok(result)
            }
            Request::GetBindings {} => {
                let service = &mut desktop.service;
                service.skland.bindings(&mut service.store)
            }
            Request::CancelQrLogin {} => Ok(Value::Null),
            Request::Logout {} => desktop.service.logout(),
            Request::RefreshAccount { uid } => {
                if let Some(uid) = &uid {
                    required(uid, "角色 UID", 64)?;
                }
                desktop.service.refresh_account(uid)
            }
            Request::UpdateGameData {} => unreachable!(),
            Request::UpdateSettings { settings } => {
                let result = desktop.service.update_settings(settings)?;
                window
                    .set_theme(theme(text(&result["settings"]["theme"])))
                    .map_err(|e| e.to_string())?;
                Ok(result)
            }
            Request::ClearCache {} => desktop.service.clear_cache(),
            Request::MaterialDetail { item_id } => {
                required(&item_id, "材料标识", 128)?;
                desktop.service.material_detail(&item_id)
            }
            Request::GetUpdateState {} => Ok(desktop.updater.state.clone()),
            Request::CheckForUpdates {} => Ok(desktop.updater.check(update)),
            Request::DownloadUpdate {} => Ok(desktop.updater.download(update)),
            Request::InstallUpdate {} => {
                if desktop.updater.install(update)? {
                    let app = app.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(200));
                        app.exit(0);
                    });
                }
                Ok(desktop.updater.state.clone())
            }
        }
    })
    .await
    .map_err(|e| format!("后台任务失败：{e}"))?
}

fn main() {
    let result=tauri::Builder::default()
        .manage(Arc::new(AtomicU64::new(0)))
        .manage(Arc::new(Mutex::new(())))
        .invoke_handler(tauri::generate_handler![training_room])
        .register_uri_scheme_protocol("atr-resource",|context,request|{
            let result=(||->Result<(Vec<u8>,bool)>{
                if request.method()!="GET"{return Err("Invalid resource method".into());}
                let path=percent_encoding::percent_decode_str(request.uri().path()).decode_utf8().map_err(|e|e.to_string())?;
                let (version,name)=path.trim_start_matches('/').split_once('/').ok_or("Invalid resource path")?;
                let state=context.app_handle().state::<Arc<std::sync::RwLock<training_room::resources::repository::Assets>>>();
                let assets=state.read().map_err(|_|"Invalid resource state")?;
                Ok((assets.read(version,name)?,name.ends_with(".svg")))
            })();
            match result{
                Ok((bytes,svg))=>tauri::http::Response::builder().header("Content-Type",if svg{"image/svg+xml"}else{"image/png"}).header("Cache-Control","no-store").header("Access-Control-Allow-Origin","http://tauri.localhost").body(bytes).unwrap(),
                Err(error)=>tauri::http::Response::builder().status(if error=="Resource not found"{404}else{400}).body(error.into_bytes()).unwrap(),
            }
        })
        .setup(|app|{
            let root=if cfg!(any(debug_assertions, feature = "qa")){std::env::var_os("ATR_USER_DATA").map(PathBuf::from)}else{None}.unwrap_or_else(||PathBuf::from(std::env::var_os("APPDATA").expect("Windows APPDATA missing")).join("arknights-training-room"));
            let bundled=if cfg!(any(debug_assertions, feature = "qa")){std::env::var_os("ATR_RESOURCE_BUNDLED_DIR").map(PathBuf::from).unwrap_or_else(||PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../dist/resource/snapshot"))}else{app.path().resource_dir()?.join("training-room-resource")};
            let mut service=Service::initialize(root.clone(),&bundled,env!("CARGO_PKG_VERSION")).map_err(std::io::Error::other)?;
            app.manage(service.resources.assets.clone());
            let saved_theme=text(&service.settings["theme"]).to_string();let refresh=service.automatic_refresh();
            let updater=Updater::new(env!("CARGO_PKG_VERSION"),root.join("updates"));
            let startup=json!({"cacheKey":service.startup_cache_key(),"updateState":updater.state,"resourceUpdate":service.resource_update});
            let shared=Arc::new(Mutex::new(Desktop{service,updater}));app.manage(shared.clone());
            let dark=match saved_theme.as_str(){"black"=>true,"light"=>false,_=>training_room::platform::window::system_dark()};
            let background=if dark{tauri::webview::Color(15,15,15,255)}else{tauri::webview::Color(223,231,237,255)};
            let app_handle=app.handle().clone();let refresh_state=shared.clone();
            let mut builder=tauri::WebviewWindowBuilder::new(app,"main",tauri::WebviewUrl::App("dist/renderer/index.html".into()))
                .title("训练室").inner_size(1360.0,800.0).resizable(false).maximizable(false).minimizable(true).fullscreen(false).visible(false)
                .icon(tauri::image::Image::from_bytes(include_bytes!("../../build/icon.png"))?)?
                .theme(theme(&saved_theme)).background_color(background).data_directory(root.join("webview2"))
                .devtools(cfg!(any(debug_assertions, feature = "qa"))).disable_drag_drop_handler()
                .initialization_script(format!("history.replaceState(null, '', location.pathname + '?theme={}'); window.__ATR_STARTUP__={startup};",saved_theme))
                .on_navigation(trusted).on_new_window(|_,_|tauri::webview::NewWindowResponse::Deny)
                .on_permission_request(|_,_|tauri::webview::PermissionResponse::Deny)
                .on_page_load(move|window,payload|{
                    if payload.event()==tauri::webview::PageLoadEvent::Finished{
                        if !cfg!(any(debug_assertions, feature = "qa"))||std::env::var_os("ATR_QA_HIDDEN").is_none(){let _=window.show();}
                        if refresh{let state=refresh_state.clone();let app=app_handle.clone();tauri::async_runtime::spawn_blocking(move||{if let Ok(mut state)=state.lock(){let _=state.service.refresh_account(None);}let _=app.emit_to("main","app:state-changed",());});}
                    }
                });
            if cfg!(any(debug_assertions, feature = "qa")){if let Ok(port)=std::env::var("ATR_QA_PORT"){if let Ok(port)=port.parse::<u16>(){builder=builder.additional_browser_args(&format!("--remote-debugging-port={port} --disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection"));}}}
            let window=builder.build()?;
            let policy_app = app.handle().clone();
            window.with_webview(move |view| {
                if let Err(error) = training_room::platform::window::configure(view, policy_app) {
                    eprintln!("无法设置 WebView2 窗口策略：{error}");
                }
            })?;
            // Electron's dimensions describe the outer window, not the content area.
            let scale=window.scale_factor()?;let outer=window.outer_size()?;let inner=window.inner_size()?;
            let client = tauri::LogicalSize::new(1360.0-(outer.width-inner.width)as f64/scale,800.0-(outer.height-inner.height)as f64/scale);
            window.set_size(client)?;
            window.set_min_size(Some(client))?;
            window.set_max_size(Some(client))?;
            window.center()?;
            if cfg!(any(debug_assertions, feature = "qa")){if let Some(path)=std::env::var_os("ATR_WINDOW_POLICY_REPORT"){
                let size=window.outer_size()?;let position=window.outer_position()?;
                std::fs::write(path,serde_json::to_vec_pretty(&json!({"bounds":{"x":position.x,"y":position.y,"width":size.width as f64/scale,"height":size.height as f64/scale},"backgroundColor":if dark{"#0f0f0f"}else{"#dfe7ed"},"minimumSize":[1360,800],"maximumSize":[1360,800],"resizable":window.is_resizable()?,"maximizable":window.is_maximizable()?,"minimizable":window.is_minimizable()?,"movable":true,"closable":true,"fullscreenable":false}))?)?;
            }}
            let resource_app = app.handle().clone();
            let resource_gate = app.state::<Arc<Mutex<()>>>().inner().clone();
            // Independent of account auto-refresh and application installer updates.
            let interval = if cfg!(any(debug_assertions, feature = "qa")) {
                std::env::var("ATR_RESOURCE_CHECK_SECONDS").ok().and_then(|s| s.parse::<u64>().ok()).filter(|n| *n > 0).unwrap_or(3600)
            } else { 3600 };
            std::thread::spawn(move || loop {
                let _ = update_game_resources(&shared, &resource_app, &resource_gate);
                std::thread::sleep(std::time::Duration::from_secs(interval));
            });
            Ok(())
        }).run(tauri::generate_context!());
    if let Err(error) = result {
        eprintln!("应用初始化失败：{error}");
        std::process::exit(1);
    }
}
