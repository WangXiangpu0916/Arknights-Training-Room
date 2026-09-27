use crate::Result;
use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::{fs, path::Path};

#[cfg(windows)]
fn dpapi(bytes: &[u8], encrypt: bool) -> Result<Vec<u8>> {
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{
            CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
        },
    };
    let input = CRYPT_INTEGER_BLOB {
        cbData: bytes.len().try_into().map_err(|_| "凭据过大")?,
        pbData: bytes.as_ptr() as *mut u8,
    };
    let mut output: CRYPT_INTEGER_BLOB = unsafe { std::mem::zeroed() };
    let success = unsafe {
        if encrypt {
            CryptProtectData(
                &input,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptUnprotectData(
                &input,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        }
    };
    if success == 0 {
        return Err("Windows 安全存储当前不可用，拒绝保存森空岛凭据".into());
    }
    let result =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe {
        LocalFree(output.pbData as *mut _);
    }
    Ok(result)
}

#[cfg(not(windows))]
fn dpapi(_: &[u8], _: bool) -> Result<Vec<u8>> {
    Err("Windows 安全存储当前不可用，拒绝保存森空岛凭据".into())
}

fn key(root: &Path, create: bool) -> Result<Vec<u8>> {
    let path = root.join("Local State");
    let mut state: Value = match fs::read(&path) {
        Ok(bytes) => {
            serde_json::from_slice(&bytes).map_err(|e| format!("安全存储配置无效：{e}"))?
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound && create => json!({}),
        Err(e) => return Err(e.to_string()),
    };
    if let Some(encoded) = state
        .pointer("/os_crypt/encrypted_key")
        .and_then(Value::as_str)
    {
        let protected = STANDARD.decode(encoded).map_err(|e| e.to_string())?;
        let payload = protected
            .strip_prefix(b"DPAPI")
            .ok_or("安全存储密钥格式无效")?;
        let key = dpapi(payload, false)?;
        if key.len() != 32 {
            return Err("安全存储密钥长度无效".into());
        }
        return Ok(key);
    }
    if !create {
        return Err("安全存储密钥缺失".into());
    }
    let mut key = vec![0; 32];
    getrandom::fill(&mut key).map_err(|e| e.to_string())?;
    let mut protected = b"DPAPI".to_vec();
    protected.extend(dpapi(&key, true)?);
    if !state.is_object() {
        return Err("安全存储配置无效".into());
    }
    if state.get("os_crypt").is_some_and(|v| !v.is_object()) {
        return Err("安全存储配置无效".into());
    }
    if state.get("os_crypt").is_none() {
        state["os_crypt"] = json!({});
    }
    state["os_crypt"]["encrypted_key"] = Value::String(STANDARD.encode(protected));
    crate::storage::write_json_atomic(&path, &state)?;
    Ok(key)
}

// Electron 37 OSCrypt: v10 + 12-byte nonce + AES-256-GCM ciphertext/tag.
// The AES key is DPAPI-wrapped in the existing profile's Local State.
pub fn decrypt(root: &Path, bytes: &[u8]) -> Result<Vec<u8>> {
    if !bytes.starts_with(b"v10") || bytes.len() < 31 {
        return Err("安全存储凭据格式无效".into());
    }
    let cipher = Aes256Gcm::new_from_slice(&key(root, false)?).map_err(|e| e.to_string())?;
    cipher
        .decrypt(Nonce::from_slice(&bytes[3..15]), &bytes[15..])
        .map_err(|_| "安全存储凭据解密失败".into())
}

pub fn encrypt(root: &Path, bytes: &[u8]) -> Result<Vec<u8>> {
    let cipher = Aes256Gcm::new_from_slice(&key(root, true)?).map_err(|e| e.to_string())?;
    let mut nonce = [0; 12];
    getrandom::fill(&mut nonce).map_err(|e| e.to_string())?;
    let mut encrypted = b"v10".to_vec();
    encrypted.extend(nonce);
    encrypted.extend(
        cipher
            .encrypt(Nonce::from_slice(&nonce), bytes)
            .map_err(|_| "安全存储凭据加密失败")?,
    );
    Ok(encrypted)
}
