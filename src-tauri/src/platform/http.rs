use crate::Result;

pub struct Response {
    pub status: u32,
    pub location: Option<String>,
    pub body: Vec<u8>,
}

#[cfg(windows)]
pub fn request(
    url: &str,
    method: &str,
    headers: &[(&str, String)],
    body: &[u8],
    limit: usize,
    mut progress: impl FnMut(usize, Option<usize>),
) -> Result<Response> {
    use std::{
        ffi::c_void,
        ptr::{null, null_mut},
        time::{Duration, Instant},
    };
    use windows_sys::Win32::Networking::WinHttp::*;
    struct Handle(*mut c_void);
    impl Drop for Handle {
        fn drop(&mut self) {
            unsafe {
                WinHttpCloseHandle(self.0);
            }
        }
    }
    let handle = |value| {
        if value == null_mut() {
            Err(format!("网络请求失败：{}", std::io::Error::last_os_error()))
        } else {
            Ok(Handle(value))
        }
    };
    let check = |value| {
        if value == 0 {
            Err(format!("网络请求失败：{}", std::io::Error::last_os_error()))
        } else {
            Ok(())
        }
    };
    let wide = |value: &str| value.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
    let parsed = url::Url::parse(url).map_err(|e| e.to_string())?;
    if parsed.scheme() != "https"
        && !(cfg!(any(debug_assertions, feature = "qa"))
            && parsed.scheme() == "http"
            && parsed.host_str() == Some("127.0.0.1"))
    {
        return Err("网络请求仅允许 HTTPS".into());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("网络地址不允许凭据".into());
    }
    let agent = headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("user-agent"))
        .map(|(_, v)| v.as_str())
        .unwrap_or("Arknights-Training-Room");
    let session = handle(unsafe {
        WinHttpOpen(
            wide(agent).as_ptr(),
            WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
            null(),
            null(),
            0,
        )
    })?;
    check(unsafe { WinHttpSetTimeouts(session.0, 120000, 120000, 120000, 120000) })?;
    let connection = handle(unsafe {
        WinHttpConnect(
            session.0,
            wide(parsed.host_str().ok_or("网络地址无效")?).as_ptr(),
            parsed.port_or_known_default().ok_or("网络端口无效")?,
            0,
        )
    })?;
    let path = format!(
        "{}{}",
        parsed.path(),
        parsed.query().map(|q| format!("?{q}")).unwrap_or_default()
    );
    let request = handle(unsafe {
        WinHttpOpenRequest(
            connection.0,
            wide(method).as_ptr(),
            wide(&path).as_ptr(),
            null(),
            null(),
            null(),
            if parsed.scheme() == "https" {
                WINHTTP_FLAG_SECURE
            } else {
                0
            },
        )
    })?;
    let redirects = WINHTTP_OPTION_REDIRECT_POLICY_NEVER;
    check(unsafe {
        WinHttpSetOption(
            request.0,
            WINHTTP_OPTION_REDIRECT_POLICY,
            &redirects as *const _ as *const c_void,
            4,
        )
    })?;
    let decompress = WINHTTP_DECOMPRESSION_FLAG_GZIP | WINHTTP_DECOMPRESSION_FLAG_DEFLATE;
    check(unsafe {
        WinHttpSetOption(
            request.0,
            WINHTTP_OPTION_DECOMPRESSION,
            &decompress as *const _ as *const c_void,
            4,
        )
    })?;
    for (name, value) in headers {
        if name.contains(['\r', '\n']) || value.contains(['\r', '\n']) {
            return Err("网络请求头无效".into());
        }
    }
    let headers = wide(
        &headers
            .iter()
            .map(|(k, v)| format!("{k}: {v}\r\n"))
            .collect::<String>(),
    );
    let length: u32 = body.len().try_into().map_err(|_| "请求内容过大")?;
    let started = Instant::now();
    check(unsafe {
        WinHttpSendRequest(
            request.0,
            headers.as_ptr(),
            u32::MAX,
            body.as_ptr() as *const c_void,
            length,
            length,
            0,
        )
    })?;
    check(unsafe { WinHttpReceiveResponse(request.0, null_mut()) })?;
    let mut status = 0u32;
    let mut size = 4u32;
    check(unsafe {
        WinHttpQueryHeaders(
            request.0,
            WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
            null(),
            &mut status as *mut _ as *mut c_void,
            &mut size,
            null_mut(),
        )
    })?;
    let header = |key| -> Option<String> {
        let mut size = 0;
        unsafe {
            WinHttpQueryHeaders(request.0, key, null(), null_mut(), &mut size, null_mut());
        }
        if size == 0 || size > 32768 {
            return None;
        }
        let mut data = vec![0u16; (size as usize + 1) / 2];
        if unsafe {
            WinHttpQueryHeaders(
                request.0,
                key,
                null(),
                data.as_mut_ptr() as *mut c_void,
                &mut size,
                null_mut(),
            )
        } == 0
        {
            return None;
        }
        Some(String::from_utf16_lossy(
            &data[..data.iter().position(|n| *n == 0).unwrap_or(data.len())],
        ))
    };
    let location = header(WINHTTP_QUERY_LOCATION);
    if matches!(status, 301 | 302 | 303 | 307 | 308) {
        return Ok(Response {
            status,
            location,
            body: vec![],
        });
    }
    let declared = header(WINHTTP_QUERY_CONTENT_LENGTH).and_then(|h| h.parse::<usize>().ok());
    if declared.is_some_and(|n| n > limit) {
        return Err("资源下载超过大小限制".into());
    }
    let mut bytes = Vec::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        if started.elapsed() > Duration::from_secs(120) {
            return Err("资源请求已取消或超时".into());
        }
        let mut count = 0;
        check(unsafe {
            WinHttpReadData(
                request.0,
                buffer.as_mut_ptr() as *mut c_void,
                buffer.len() as u32,
                &mut count,
            )
        })?;
        if count == 0 {
            break;
        }
        if bytes.len() + count as usize > limit {
            return Err("资源下载超过大小限制".into());
        }
        bytes.extend_from_slice(&buffer[..count as usize]);
        progress(bytes.len(), declared);
    }
    Ok(Response {
        status,
        location,
        body: bytes,
    })
}

#[cfg(not(windows))]
pub fn request(
    _: &str,
    _: &str,
    _: &[(&str, String)],
    _: &[u8],
    _: usize,
    _: impl FnMut(usize, Option<usize>),
) -> Result<Response> {
    Err("当前仅支持 Windows 网络集成".into())
}

pub fn get(url: &str, limit: usize) -> Result<Response> {
    request(url, "GET", &[], &[], limit, |_, _| {})
}
