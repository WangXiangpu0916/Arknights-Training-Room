use crate::{platform, Result};
use serde_json::{json, Value};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let temporary = path.with_file_name(format!(
        "{}.tmp",
        path.file_name().unwrap().to_string_lossy()
    ));
    let mut file = fs::File::create(&temporary).map_err(|e| e.to_string())?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())?;
    drop(file);
    platform::replace_file(&temporary, path).map_err(|e| e.to_string())
}

pub fn write_json_atomic(path: &Path, value: &Value) -> Result<()> {
    let mut bytes = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    bytes.push(b'\n');
    write_atomic(path, &bytes)
}

pub struct Store {
    pub root: PathBuf,
    credentials: Option<Option<Value>>,
}

impl Store {
    pub fn new(root: PathBuf) -> Result<Self> {
        fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        Ok(Self {
            root,
            credentials: None,
        })
    }
    pub fn read(&self, name: &str) -> Option<Value> {
        serde_json::from_slice(&fs::read(self.root.join(name)).ok()?).ok()
    }
    pub fn write(&self, name: &str, value: &Value) -> Result<()> {
        write_json_atomic(&self.root.join(name), value)
    }
    pub fn remove(&self, name: &str) -> Result<()> {
        match fs::remove_file(self.root.join(name)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
    pub fn settings(&self) -> Value {
        let old = self.read("settings.json").unwrap_or(Value::Null);
        let mut settings = json!({
            "unlimitedItemIds": old["unlimitedItemIds"].as_array().map(|v| v.iter().filter(|v| v.is_string()).cloned().collect::<Vec<_>>()).unwrap_or_default(),
            "autoRefresh": old["autoRefresh"] == true,
            "theme": match old["theme"].as_str() { Some("dark" | "black") => "black", Some("light") => "light", _ => "system" },
        });
        if old["selectedUid"].is_string() {
            settings["selectedUid"] = old["selectedUid"].clone();
        }
        settings
    }
    pub fn account(&self) -> Option<Value> {
        let mut account = self.read("account-cache.json")?;
        if !account["uid"].is_string()
            || !account["syncedAt"].is_string()
            || !account["inventory"].is_object()
        {
            return None;
        }
        for op in account["operators"].as_array_mut()? {
            if !op.is_object() {
                return None;
            }
            if !op["modules"].is_array() {
                op["modules"] = json!([]);
            }
        }
        Some(account)
    }
    pub fn credentials(&mut self) -> Option<Value> {
        if let Some(value) = &self.credentials {
            return value.clone();
        }
        let value = fs::read(self.root.join("credentials.bin"))
            .ok()
            .and_then(|b| platform::credentials::decrypt(&self.root, &b).ok())
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
            .filter(|v| {
                ["accessToken", "cred", "credToken"]
                    .iter()
                    .all(|k| v[k].is_string())
            });
        self.credentials = Some(value.clone());
        value
    }
    pub fn save_credentials(&mut self, value: &Value) -> Result<()> {
        let bytes = platform::credentials::encrypt(
            &self.root,
            &serde_json::to_vec(value).map_err(|e| e.to_string())?,
        )?;
        write_atomic(&self.root.join("credentials.bin"), &bytes)?;
        self.credentials = Some(Some(value.clone()));
        Ok(())
    }
    pub fn clear_credentials(&mut self) -> Result<()> {
        self.remove("credentials.bin")?;
        self.credentials = Some(None);
        Ok(())
    }
    pub fn log(&self, event: &str, detail: &str) {
        log(&self.root, event, detail);
    }
}
pub fn log(root: &Path, event: &str, detail: &str) {
    let _ = (|| -> std::io::Result<()> {
        let path = root.join("app.log");
        if fs::metadata(&path).is_ok_and(|m| m.len() > 1_000_000) {
            let _ = fs::remove_file(root.join("app.log.1"));
            fs::rename(&path, root.join("app.log.1"))?;
        }
        let safe = regex::Regex::new(r#"(?i)((?:access[_-]?token|cred[_-]?token|cred|token|authorization|cookie|set-cookie|password|secret|api[_-]?key)["']?\s*[:=]\s*["']?)([^"'\s,;}{]+)"#).unwrap().replace_all(detail, "${1}[REDACTED]");
        let safe = regex::Regex::new(r"(?i)(bearer\s+)[A-Za-z0-9._~+/=-]+")
            .unwrap()
            .replace_all(&safe, "${1}[REDACTED]");
        let safe = regex::Regex::new(r"(?i)\buid\s*=\s*[A-Za-z0-9_-]+\b")
            .unwrap()
            .replace_all(&safe, "uid=[REDACTED]");
        let safe = regex::Regex::new(r"[A-Za-z0-9_-]{24,}")
            .unwrap()
            .replace_all(&safe, "[REDACTED]");
        writeln!(
            OpenOptions::new().create(true).append(true).open(path)?,
            "{} {} {}",
            chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            event,
            safe.chars().take(2000).collect::<String>()
        )
    })();
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn legacy_profile_is_idempotent_and_credentials_are_authenticated() {
        let root = std::env::temp_dir().join(format!("atr-store-test-{}", std::process::id()));
        let mut store = Store::new(root.clone()).unwrap();
        store.write("settings.json", &json!({"theme":"dark","unlimitedItemIds":["30013",4],"autoRefresh":true,"selectedUid":"fixture"})).unwrap();
        let original = fs::read(root.join("settings.json")).unwrap();
        assert_eq!(
            store.settings(),
            json!({"theme":"black","unlimitedItemIds":["30013"],"autoRefresh":true,"selectedUid":"fixture"})
        );
        assert_eq!(store.settings(), store.settings());
        assert_eq!(fs::read(root.join("settings.json")).unwrap(), original);
        store.write("account-cache.json", &json!({"uid":"fixture","syncedAt":"2026-01-01","inventory":{},"operators":[{"operatorId":"test"}]})).unwrap();
        assert_eq!(
            store.account().unwrap()["operators"][0]["modules"],
            json!([])
        );
        #[cfg(windows)]
        {
            let credentials = json!({"accessToken":"synthetic-access","cred":"synthetic-cred","credToken":"synthetic-token"});
            store.save_credentials(&credentials).unwrap();
            let mut reopened = Store::new(root.clone()).unwrap();
            assert_eq!(reopened.credentials(), Some(credentials));
            let mut encrypted = fs::read(root.join("credentials.bin")).unwrap();
            encrypted[16] ^= 1;
            assert!(platform::credentials::decrypt(&root, &encrypted).is_err());
        }
        fs::remove_dir_all(root).unwrap();
    }
}
