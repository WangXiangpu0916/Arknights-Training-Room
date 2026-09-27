use webview2_com::{Microsoft::Web::WebView2::Win32::*, ScriptDialogOpeningEventHandler};
use windows::core::{Interface, PWSTR};
use windows_sys::Win32::{
    System::Com::CoTaskMemFree,
    UI::{Controls::*, WindowsAndMessaging::IDOK},
};

thread_local! {
    static DIALOG: std::cell::RefCell<Option<(ICoreWebView2ScriptDialogOpeningEventArgs, ICoreWebView2Deferral, usize)>> = const { std::cell::RefCell::new(None) };
}

pub fn configure(
    view: tauri::webview::PlatformWebview,
    app: tauri::AppHandle,
) -> windows::core::Result<()> {
    unsafe {
        let controller = view.controller();
        let webview = controller.CoreWebView2()?;
        let settings = webview.Settings()?;
        settings.SetAreDefaultContextMenusEnabled(false)?;
        settings.SetIsZoomControlEnabled(false)?;
        settings
            .cast::<ICoreWebView2Settings5>()?
            .SetIsPinchZoomEnabled(false)?;
        settings
            .cast::<ICoreWebView2Settings6>()?
            .SetIsSwipeNavigationEnabled(false)?;
        settings
            .cast::<ICoreWebView2Settings3>()?
            .SetAreBrowserAcceleratorKeysEnabled(false)?;
        settings.SetAreDefaultScriptDialogsEnabled(false)?;
        let mut parent = windows::Win32::Foundation::HWND::default();
        controller.ParentWindow(&mut parent)?;
        let parent = parent.0 as usize;
        webview.add_ScriptDialogOpening(
            &ScriptDialogOpeningEventHandler::create(Box::new(move |_, args| {
                if let Some(args) = args {
                    let mut kind = COREWEBVIEW2_SCRIPT_DIALOG_KIND::default();
                    args.Kind(&mut kind)?;
                    // The frozen UI uses only confirm(). Match Electron's Windows TaskDialog,
                    // including its application-name title and system OK / Cancel buttons.
                    if kind != COREWEBVIEW2_SCRIPT_DIALOG_KIND_CONFIRM {
                        return Ok(());
                    }
                    let deferral = args.GetDeferral()?;
                    DIALOG.with(|pending| *pending.borrow_mut() = Some((args, deferral, parent)));
                    let app = app.clone();
                    // Dispatch after the WebView2 callback returns; nested modal loops inside
                    // a WebView2 event handler are not supported. COM objects stay on the STA.
                    std::thread::spawn(move || {
                        let _ = app.run_on_main_thread(show_confirmation);
                    });
                }
                Ok(())
            })),
            &mut 0,
        )?;
        Ok(())
    }
}

fn show_confirmation() {
    DIALOG.with(|pending| {
        let Some((args, deferral, parent)) = pending.borrow_mut().take() else {
            return;
        };
        unsafe {
            let _ = (|| -> windows::core::Result<()> {
                let mut message = PWSTR::null();
                args.Message(&mut message)?;
                let title: Vec<u16> = "arknights-training-room"
                    .encode_utf16()
                    .chain(Some(0))
                    .collect();
                let mut config: TASKDIALOGCONFIG = std::mem::zeroed();
                config.cbSize = std::mem::size_of::<TASKDIALOGCONFIG>() as u32;
                config.hwndParent = parent as _;
                config.dwFlags = TDF_SIZE_TO_CONTENT
                    | TDF_ALLOW_DIALOG_CANCELLATION
                    | TDF_POSITION_RELATIVE_TO_WINDOW;
                config.pszWindowTitle = title.as_ptr();
                config.pszContent = message.0;
                config.dwCommonButtons = TDCBF_OK_BUTTON | TDCBF_CANCEL_BUTTON;
                config.nDefaultButton = IDOK;
                let mut chosen = 0;
                let status = TaskDialogIndirect(
                    &config,
                    &mut chosen,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                );
                CoTaskMemFree(message.0 as _);
                if status >= 0 && chosen == IDOK {
                    args.Accept()?;
                }
                Ok(())
            })();
            let _ = deferral.Complete();
        }
    });
}

pub fn system_dark() -> bool {
    use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD};
    let wide = |s: &str| s.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
    let mut value = 1u32;
    let mut size = 4;
    unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            wide("Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize").as_ptr(),
            wide("AppsUseLightTheme").as_ptr(),
            RRF_RT_REG_DWORD,
            std::ptr::null_mut(),
            &mut value as *mut _ as _,
            &mut size,
        );
    }
    value == 0
}
