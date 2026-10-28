use super::validation::{self as validate, ensure, hash, MANIFEST_URL, MAX_EXPANDED, MAX_PACKAGE};
use crate::{
    domain::planning::{number, text},
    platform::http,
    storage::{write_json_atomic, Store},
    Result,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::{
    collections::BTreeSet,
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::{Arc, RwLock},
};

pub struct Assets(Vec<(String, PathBuf, BTreeSet<String>)>);
impl Assets {
    fn new(active: &Snapshot, previous: Option<&Snapshot>) -> Self {
        Self(
            std::iter::once(active)
                .chain(previous)
                .map(|snapshot| {
                    (
                        text(&snapshot.manifest["resourceVersion"]).to_owned(),
                        snapshot.directory.clone(),
                        snapshot.manifest["files"]
                            .as_object()
                            .unwrap()
                            .keys()
                            .filter(|name| name.starts_with("images/"))
                            .cloned()
                            .collect(),
                    )
                })
                .collect(),
        )
    }
    pub fn read(&self, version: &str, name: &str) -> Result<Vec<u8>> {
        validate::safe_path(name)?;
        let (_, root, _) = self
            .0
            .iter()
            .find(|(v, _, files)| v == version && files.contains(name))
            .ok_or("Resource not found")?;
        fs::read(root.join(name)).map_err(|e| e.to_string())
    }
}

pub struct Snapshot {
    pub manifest: Value,
    pub data: Value,
    pub directory: PathBuf,
}
pub struct Resources {
    pub active: Snapshot,
    pub previous: Option<Snapshot>,
    pub assets: Arc<RwLock<Assets>>,
    root: PathBuf,
    version: String,
}
fn remove(path: &Path) -> Result<()> {
    match fs::remove_dir_all(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
fn unlink(path: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
fn snapshot(directory: &Path, version: &str) -> Result<Snapshot> {
    let (manifest, data) = validate::load(directory, version, None, None)?;
    Ok(Snapshot {
        manifest,
        data,
        directory: directory.to_path_buf(),
    })
}
fn copy(source: &Path, target: &Path) -> Result<()> {
    fs::create_dir_all(target).map_err(|e| e.to_string())?;
    for name in validate::files(source)? {
        let target = target.join(&name);
        fs::create_dir_all(target.parent().unwrap()).map_err(|e| e.to_string())?;
        fs::copy(source.join(name), target).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn resource_version(manifest: &Value) -> Vec<u64> {
    text(&manifest["resourceVersion"]).split('.').map(|s| s.parse().unwrap_or(0)).collect()
}

impl Resources {
    pub fn initialize(store: &Store, bundled: &Path, version: &str) -> Result<Self> {
        let root = store.root.clone();
        let current = root.join("game-data");
        let backup = root.join("game-data.backup");
        let next = root.join("game-data.next");
        let journal = root.join("game-data.transaction.json");
        if journal.exists() {
            if snapshot(&backup, version).is_ok() {
                remove(&current)?;
                fs::rename(&backup, &current).map_err(|e| e.to_string())?;
            }
            unlink(&journal)?;
            store.log("resource-interrupted-update-recovered", "");
        }
        remove(&next)?;
        let active = match snapshot(&current, version) {
            Ok(current) => current,
            Err(_) => {
                if snapshot(&backup, version).is_ok() {
                    remove(&current)?;
                    fs::rename(&backup, &current).map_err(|e| e.to_string())?;
                } else {
                    snapshot(bundled, version)?;
                    copy(bundled, &next)?;
                    snapshot(&next, version)?;
                    remove(&current)?;
                    fs::rename(&next, &current).map_err(|e| e.to_string())?;
                    store.log("game-data-cache-recovered", "已迁移到完整内置资源快照");
                }
                snapshot(&current, version)?
            }
        };
        let previous = snapshot(&backup, version).ok();
        let assets = Arc::new(RwLock::new(Assets::new(&active, previous.as_ref())));
        let mut resources = Self {
            active,
            previous,
            assets,
            root,
            version: version.into(),
        };
        // Local rebuilds can correct bundled data without changing its version.
        let bundled_manifest = fs::read(bundled.join("manifest.json")).ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
        if bundled_manifest.as_ref().is_some_and(|m| resource_version(m) > resource_version(&resources.active.manifest)
            || resource_version(m) == resource_version(&resources.active.manifest) && m["files"] != resources.active.manifest["files"]) {
            let result = (|| {
                validate::load(bundled, version, Some(&resources.active.data), None)?;
                copy(bundled, &next)?;
                let (manifest, data) = validate::load(&next, version, Some(&resources.active.data), None)?;
                resources.commit(manifest, data)
            })();
            remove(&next)?;
            match result {
                Ok(()) => store.log("bundled-resource-updated", "已同步内置资源"),
                Err(error) => store.log("bundled-resource-update-failed", &error),
            }
        }
        Ok(resources)
    }
    // Network I/O runs without the application state lock. Installation remains serialized.
    pub fn download_update(current: &Value, version: &str) -> Result<Option<(Value, Vec<u8>)>> {
        let url = if cfg!(any(debug_assertions, feature = "qa")) {
            std::env::var("ATR_RESOURCE_MANIFEST_URL").unwrap_or_else(|_| MANIFEST_URL.into())
        } else {
            MANIFEST_URL.into()
        };
        let remote: Value = serde_json::from_slice(&download(&url, 2 * 1024 * 1024, true)?)
            .map_err(|e| e.to_string())?;
        validate::manifest(&remote, version, true)?;
        if resource_version(&remote) <= resource_version(current) {
            return Ok(None);
        }
        let bytes = download(text(&remote["package"]["url"]), MAX_PACKAGE, false)?;
        Ok(Some((remote, bytes)))
    }
    pub fn install<T>(
        &mut self,
        bytes: &[u8],
        remote: &Value,
        prepare: impl FnOnce(&Value) -> Result<T>,
    ) -> Result<T> {
        validate::manifest(remote, &self.version, true)?;
        let next = self.root.join("game-data.next");
        remove(&next)?;
        fs::create_dir_all(&next).map_err(|e| e.to_string())?;
        let result = (|| {
            unpack(bytes, &next, remote)?;
            let mut expected = remote.clone();
            expected.as_object_mut().unwrap().remove("package");
            let (manifest, data) = validate::load(
                &next,
                &self.version,
                Some(&self.active.data),
                Some(&expected),
            )?;
            // Complete derived-state validation before entering the disk transaction.
            let prepared = prepare(&data)?;
            self.commit(manifest, data)?;
            Ok(prepared)
        })();
        let cleaned = remove(&next);
        match result {
            Ok(value) => {
                cleaned?;
                Ok(value)
            }
            Err(error) => {
                if let Ok(mut assets) = self.assets.write() {
                    *assets = Assets::new(&self.active, self.previous.as_ref());
                }
                Err(error)
            }
        }
    }

    fn commit(&mut self, manifest: Value, data: Value) -> Result<()> {
        let next = self.root.join("game-data.next");
        let backup = self.root.join("game-data.backup");
        let journal = self.root.join("game-data.transaction.json");
        let current = self.root.join("game-data");
        // Readers wait only for the directory switch, never for HTTP or plan calculation.
        let mut assets = self.assets.write().map_err(|_| "资源索引锁不可用")?;
        remove(&backup)?;
        self.previous = None;
        *assets = Assets::new(&self.active, None);
        write_json_atomic(&journal, &json!({"from":self.active.manifest["resourceVersion"],"to":manifest["resourceVersion"]}))?;
        fs::rename(&current, &backup).map_err(|e| e.to_string())?;
        let commit = fs::rename(&next, &current).map_err(|e| e.to_string()).and_then(|_| unlink(&journal));
        if let Err(error) = commit {
            remove(&current)?;
            fs::rename(&backup, &current).map_err(|e| e.to_string())?;
            unlink(&journal)?;
            return Err(error);
        }
        let mut old = std::mem::replace(&mut self.active, Snapshot { manifest, data, directory: current });
        old.directory = backup;
        self.previous = Some(old);
        *assets = Assets::new(&self.active, self.previous.as_ref());
        Ok(())
    }
}

pub fn trusted_url(url: &str, initial: bool, manifest: bool) -> Result<url::Url> {
    let parsed = url::Url::parse(url).map_err(|e| e.to_string())?;
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("资源地址不允许凭据".into());
    }
    if cfg!(any(debug_assertions, feature = "qa"))
        && parsed.scheme() == "http"
        && parsed.host_str() == Some("127.0.0.1")
    {
        return Ok(parsed);
    }
    if parsed.scheme() != "https" {
        return Err("资源更新仅允许 HTTPS".into());
    }
    if manifest && url != MANIFEST_URL {
        return Err("未受信任的资源清单地址".into());
    }
    if parsed.host_str() == Some("github.com")
        && parsed
            .path()
            .starts_with("/WangXiangpu0916/Arknights-Training-Room/releases/download/")
    {
        return Ok(parsed);
    }
    if !initial
        && matches!(
            parsed.host_str(),
            Some("release-assets.githubusercontent.com" | "objects.githubusercontent.com")
        )
    {
        return Ok(parsed);
    }
    Err("未受信任的资源下载地址".into())
}
fn download(url: &str, limit: usize, manifest: bool) -> Result<Vec<u8>> {
    let mut target = trusted_url(url, true, manifest)?;
    for _ in 0..=5 {
        let response = http::get(target.as_str(), limit)?;
        if matches!(response.status, 301 | 302 | 303 | 307 | 308) {
            let location = response.location.ok_or("资源下载重定向缺少地址")?;
            target = trusted_url(
                target.join(&location).map_err(|e| e.to_string())?.as_str(),
                false,
                false,
            )?;
            continue;
        }
        if !(200..300).contains(&response.status) {
            return Err(format!(
                "资源下载失败：HTTP {}，保留当前资源。",
                response.status
            ));
        }
        return Ok(response.body);
    }
    Err("资源下载重定向次数过多".into())
}
pub fn unpack(bytes: &[u8], directory: &Path, expected: &Value) -> Result<()> {
    if bytes.len() > MAX_PACKAGE
        || bytes.len() as f64 != number(&expected["package"]["size"])
        || hash(bytes) != text(&expected["package"]["sha256"])
    {
        return Err("资源包大小或 SHA-256 不匹配，保留当前资源。".into());
    }
    let mut expanded = vec![];
    flate2::read::GzDecoder::new(bytes)
        .take(MAX_EXPANDED as u64 + 1)
        .read_to_end(&mut expanded)
        .map_err(|e| e.to_string())?;
    ensure(expanded.len() <= MAX_EXPANDED, "展开资源超过大小限制")?;
    let envelope: Value = serde_json::from_slice(&expanded).map_err(|e| e.to_string())?;
    let mut manifest = expected.clone();
    manifest
        .as_object_mut()
        .ok_or("资源包结构或清单不一致")?
        .remove("package");
    let expected_files = expected["files"]
        .as_object()
        .ok_or("资源包结构或清单不一致")?;
    let files = envelope["files"]
        .as_object()
        .ok_or("资源包结构或清单不一致")?;
    if text(&envelope["format"]) != "training-room-resource-1"
        || envelope["manifest"] != manifest
        || files.len() != expected_files.len()
    {
        return Err("资源包结构或清单不一致".into());
    }
    for (name, content) in files {
        validate::safe_path(name)?;
        let info = expected_files
            .get(name)
            .ok_or_else(|| format!("资源包文件无效：{name}"))?;
        let file = STANDARD
            .decode(
                content
                    .as_str()
                    .ok_or_else(|| format!("资源包文件无效：{name}"))?,
            )
            .map_err(|_| format!("资源包文件无效：{name}"))?;
        if file.len() as f64 != number(&info["size"]) || hash(&file) != text(&info["sha256"]) {
            return Err(format!("资源包文件损坏：{name}"));
        }
        let target = directory.join(name);
        fs::create_dir_all(target.parent().unwrap()).map_err(|e| e.to_string())?;
        fs::write(target, file).map_err(|e| e.to_string())?;
    }
    write_json_atomic(&directory.join("manifest.json"), &manifest)
}
