use crate::{
    domain::planning::{array, text},
    platform::http,
    resources::repository::trusted_url,
    storage::write_atomic,
    Result,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha512};
use std::path::PathBuf;

const RELEASES: &str = "https://github.com/WangXiangpu0916/Arknights-Training-Room/releases";
type Fetch = fn(&str, usize, bool, &mut dyn FnMut(usize, Option<usize>)) -> Result<Vec<u8>>;
pub struct Updater {
    pub state: Value,
    download: Option<(String, String)>,
    installer: Option<PathBuf>,
    cache: PathBuf,
    fetch: Fetch,
}
impl Updater {
    pub fn new(version: &str, cache: PathBuf) -> Self {
        let supported =
            !cfg!(debug_assertions) && std::env::var_os("PORTABLE_EXECUTABLE_FILE").is_none();
        Self {
            state: json!({"currentVersion":version,"supported":supported,"phase":if supported{"idle"}else{"unsupported"},"message":if supported{"可从 GitHub Releases 检查新的测试版本。"}else{"自动更新仅支持 Windows 安装版。"}}),
            download: None,
            installer: None,
            cache,
            fetch,
        }
    }
    fn set(&mut self, phase: &str, message: String, emit: &mut impl FnMut(&Value)) {
        self.state["phase"] = json!(phase);
        self.state["message"] = json!(message);
        emit(&self.state);
    }
    fn error(&mut self, error: String, action: &str, emit: &mut impl FnMut(&Value)) {
        if let Some(root) = self.cache.parent() {
            crate::storage::log(root, "app-update-error", &error);
        }
        let detail = if error.contains("404") {
            "GitHub 发布源当前不可用（HTTP 404），请稍后重试。"
        } else if error.contains("网络") || error.contains("超时") {
            "无法连接 GitHub，请检查网络后重试。"
        } else {
            "暂时无法获取版本信息，请稍后重试。"
        };
        self.set("error", format!("{action}失败：{detail}"), emit);
    }
    pub fn check(&mut self, mut emit: impl FnMut(&Value)) -> Value {
        if self.state["supported"] != true {
            return self.state.clone();
        }
        self.set("checking", "正在检查 GitHub Releases…".into(), &mut emit);
        let result = (|| -> Result<()> {
            let feed = (self.fetch)(
                &format!("{RELEASES}.atom"),
                2 * 1024 * 1024,
                true,
                &mut |_, _| {},
            )?;
            let tag = select_tag(&String::from_utf8(feed).map_err(|e| e.to_string())?)?;
            let bytes = (self.fetch)(
                &format!("{RELEASES}/download/{tag}/beta.yml"),
                2 * 1024 * 1024,
                false,
                &mut |_, _| {},
            )
            .or_else(|_| {
                (self.fetch)(
                    &format!("{RELEASES}/download/{tag}/latest.yml"),
                    2 * 1024 * 1024,
                    false,
                    &mut |_, _| {},
                )
            })?;
            let metadata: Value = serde_yaml::from_slice(&bytes).map_err(|e| e.to_string())?;
            let version =
                semver::Version::parse(text(&metadata["version"])).map_err(|e| e.to_string())?;
            let current = semver::Version::parse(text(&self.state["currentVersion"]))
                .map_err(|e| e.to_string())?;
            self.state.as_object_mut().unwrap().remove("progress");
            if version <= current {
                self.state
                    .as_object_mut()
                    .unwrap()
                    .remove("availableVersion");
                self.set("current", "当前已是最新测试版本。".into(), &mut emit);
                return Ok(());
            }
            let entry = array(&metadata["files"])
                .iter()
                .find(|v| text(&v["url"]).ends_with(".exe"))
                .cloned()
                .unwrap_or_else(|| json!({"url":metadata["path"],"sha512":metadata["sha512"]}));
            let filename = text(&entry["url"]);
            if !regex::Regex::new(r"^[A-Za-z0-9._-]+-Setup-(?:x64|arm64)\.exe$")
                .unwrap()
                .is_match(filename)
                || STANDARD
                    .decode(text(&entry["sha512"]))
                    .map_err(|e| e.to_string())?
                    .len()
                    != 64
            {
                return Err("更新文件校验信息无效".into());
            }
            self.download = Some((
                format!("{RELEASES}/download/{tag}/{filename}"),
                text(&entry["sha512"]).into(),
            ));
            self.state["availableVersion"] = json!(version.to_string());
            self.set(
                "available",
                format!("发现新测试版本 v{version}，可选择下载更新。"),
                &mut emit,
            );
            Ok(())
        })();
        if let Err(error) = result {
            self.error(error, "检查更新", &mut emit);
        }
        self.state.clone()
    }
    pub fn download(&mut self, mut emit: impl FnMut(&Value)) -> Value {
        if self.state["supported"] != true || self.state["phase"] != "available" {
            return self.state.clone();
        }
        self.state["progress"] = json!(0);
        self.set(
            "downloading",
            format!("正在下载 v{}…", text(&self.state["availableVersion"])),
            &mut emit,
        );
        let result = (|| -> Result<()> {
            let (url, expected) = self.download.clone().ok_or("更新下载信息缺失")?;
            let mut previous = 0;
            let bytes = (self.fetch)(&url, 512 * 1024 * 1024, false, &mut |size, total| {
                if let Some(total) = total.filter(|n| *n > 0) {
                    let percent = ((size as f64 / total as f64) * 100.0).round() as u32;
                    if percent != previous {
                        previous = percent;
                        self.state["progress"] = json!(percent);
                        emit(&self.state);
                    }
                }
            })?;
            if STANDARD.encode(Sha512::digest(&bytes)) != expected {
                return Err("更新文件 SHA-512 不匹配".into());
            }
            std::fs::create_dir_all(&self.cache).map_err(|e| e.to_string())?;
            let installer = self.cache.join("training-room-update.exe");
            write_atomic(&installer, &bytes)?;
            self.installer = Some(installer);
            self.state["progress"] = json!(100);
            self.set(
                "ready",
                format!(
                    "v{} 已下载，重启应用即可安装。",
                    text(&self.state["availableVersion"])
                ),
                &mut emit,
            );
            Ok(())
        })();
        if let Err(error) = result {
            self.error(error, "下载更新", &mut emit);
        }
        self.state.clone()
    }
    pub fn install(&mut self, mut emit: impl FnMut(&Value)) -> Result<bool> {
        if self.state["supported"] != true || self.state["phase"] != "ready" {
            return Ok(false);
        }
        let path = self.installer.as_ref().ok_or("更新文件尚未下载")?;
        let expected = &self.download.as_ref().ok_or("更新校验信息缺失")?.1;
        if STANDARD.encode(Sha512::digest(
            std::fs::read(path).map_err(|e| e.to_string())?,
        )) != *expected
        {
            return Err("更新文件 SHA-512 不匹配".into());
        }
        std::process::Command::new(path)
            .args(["--updated", "--force-run"])
            .spawn()
            .map_err(|e| e.to_string())?;
        self.set("installing", "正在重启并安装更新…".into(), &mut emit);
        Ok(true)
    }
}
fn fetch(
    url: &str,
    limit: usize,
    feed: bool,
    mut progress: &mut dyn FnMut(usize, Option<usize>),
) -> Result<Vec<u8>> {
    let mut target = if feed && url == format!("{RELEASES}.atom") {
        url::Url::parse(url).map_err(|e| e.to_string())?
    } else {
        trusted_url(url, true, false)?
    };
    for _ in 0..=5 {
        let response = http::request(target.as_str(), "GET", &[], &[], limit, &mut progress)?;
        if matches!(response.status, 301 | 302 | 303 | 307 | 308) {
            let location = response.location.ok_or("更新重定向缺少地址")?;
            target = trusted_url(
                target.join(&location).map_err(|e| e.to_string())?.as_str(),
                false,
                false,
            )?;
            continue;
        }
        if !(200..300).contains(&response.status) {
            return Err(format!("HTTP {}", response.status));
        }
        return Ok(response.body);
    }
    Err("更新重定向次数过多".into())
}
fn select_tag(feed: &str) -> Result<String> {
    let pattern=regex::Regex::new(r#"href="https://github\.com/WangXiangpu0916/Arknights-Training-Room/releases/tag/([A-Za-z0-9.-]+)""#).unwrap();
    for capture in pattern.captures_iter(feed) {
        let tag = &capture[1];
        if let Ok(version) = semver::Version::parse(tag.strip_prefix('v').unwrap_or(tag)) {
            let channel = version.pre.as_str().split('.').next().unwrap_or("");
            if channel.is_empty() || channel == "beta" {
                return Ok(tag.into());
            }
        }
    }
    Err("没有可用的测试版本".into())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn update_download_preserves_channel_integrity_and_refuses_tampered_installer() {
        fn fixture(
            url: &str,
            _limit: usize,
            feed: bool,
            progress: &mut dyn FnMut(usize, Option<usize>),
        ) -> Result<Vec<u8>> {
            if feed {
                return Ok(format!("<link href=\"{RELEASES}/tag/v0.0.21-beta.1\"/>").into_bytes());
            }
            if url.ends_with("beta.yml") {
                return Err("HTTP 404".into());
            }
            if url.ends_with("latest.yml") {
                return Ok(format!("version: 0.0.21-beta.1\npath: Arknights-Training-Room-0.0.21-beta.1-Setup-x64.exe\nsha512: {}\n",STANDARD.encode(Sha512::digest(b"verified installer"))).into_bytes());
            }
            progress(9, Some(18));
            progress(18, Some(18));
            Ok(b"verified installer".to_vec())
        }
        let root = std::env::temp_dir().join(format!("atr-updater-{}", std::process::id()));
        let mut updater = Updater::new("0.0.20-beta.16", root.join("updates"));
        updater.state["supported"] = json!(true);
        updater.fetch = fixture;
        let mut phases = vec![];
        assert_eq!(
            updater.check(|s| phases.push(s["phase"].clone()))["phase"],
            "available"
        );
        assert_eq!(
            updater.download(|s| phases.push(s["phase"].clone()))["phase"],
            "ready"
        );
        assert_eq!(phases.first().unwrap(), "checking");
        assert!(phases.contains(&json!("downloading")));
        let installer = updater.installer.as_ref().unwrap();
        assert_eq!(std::fs::read(installer).unwrap(), b"verified installer");
        std::fs::write(installer, b"tampered").unwrap();
        assert!(updater.install(|_| {}).unwrap_err().contains("SHA-512"));
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn beta_feed_ignores_resource_and_alpha_releases() {
        let feed = [
            "resources-latest",
            "v1.0.0-alpha.2",
            "v0.1.0-beta.1",
            "v0.0.20",
        ]
        .map(|tag| format!("<link href=\"{RELEASES}/tag/{tag}\"/>"))
        .join("");
        assert_eq!(select_tag(&feed).unwrap(), "v0.1.0-beta.1");
    }
}
