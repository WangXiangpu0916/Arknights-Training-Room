use crate::{
    domain::planning::{array, text},
    platform::http,
    storage::Store,
    Result,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use hmac::{Hmac, Mac};
use md5::{Digest, Md5};
use serde_json::{json, Value};
use sha2::Sha256;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const APP_CODE: &str = "4ca99fa6b56cc2ba";
const HG: &str = "https://as.hypergryph.com";
const SK: &str = "https://zonai.skland.com";
const USER_AGENT: &str =
    "Skland/1.32.1 (com.hypergryph.skland; build:103201004; Android 33; ) Okhttp/4.11.0";
const REAUTH: &str = "森空岛认证已失效，自动续期失败。请立即重新认证";
#[derive(Debug)]
struct ApiError {
    message: String,
    credential_failure: bool,
}
impl From<String> for ApiError {
    fn from(message: String) -> Self {
        Self {
            message,
            credential_failure: false,
        }
    }
}
type ApiResult<T> = std::result::Result<T, ApiError>;
type Transport = fn(&str, &str, &[(&str, String)], &[u8]) -> Result<http::Response>;
fn transport(
    url: &str,
    method: &str,
    headers: &[(&str, String)],
    body: &[u8],
) -> Result<http::Response> {
    http::request(url, method, headers, body, 16 * 1024 * 1024, |_, _| {})
}
fn unwrap(envelope: Value, label: &str) -> ApiResult<Value> {
    let status = envelope
        .get("code")
        .filter(|v| !v.is_null())
        .or_else(|| envelope.get("status"));
    if status != Some(&json!(0)) {
        return Err(ApiError {
            message: format!(
                "{label}：{}",
                envelope
                    .get("message")
                    .or_else(|| envelope.get("msg"))
                    .map(|v| text(v).to_owned())
                    .unwrap_or_else(|| format!(
                        "错误码 {}",
                        status.map(Value::to_string).unwrap_or("undefined".into())
                    ))
            ),
            credential_failure: true,
        });
    }
    Ok(envelope["data"].clone())
}
fn request(
    send: Transport,
    url: &str,
    body: Option<Value>,
    headers: &[(&str, String)],
) -> ApiResult<Value> {
    let mut headers = headers.to_vec();
    headers.push(("User-Agent", USER_AGENT.into()));
    if body.is_some() {
        headers.push(("Content-Type", "application/json".into()));
    }
    let bytes = body
        .as_ref()
        .map(|v| serde_json::to_vec(v).unwrap())
        .unwrap_or_default();
    let response = send(
        url,
        if body.is_some() { "POST" } else { "GET" },
        &headers,
        &bytes,
    )?;
    if !(200..300).contains(&response.status) {
        return Err(ApiError {
            message: format!("网络请求失败：HTTP {}", response.status),
            credential_failure: matches!(response.status, 401 | 403),
        });
    }
    unwrap(
        serde_json::from_slice(&response.body).map_err(|e| ApiError::from(e.to_string()))?,
        "接口请求失败",
    )
}
pub fn encode(value: &str) -> String {
    value
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}
pub fn signed_headers(
    path: &str,
    key: &str,
    cred: &str,
    device: &str,
    timestamp: &str,
) -> Vec<(&'static str, String)> {
    let (pathname, query) = path.split_once('?').unwrap_or((path, ""));
    let header = json!({"platform":"3","timestamp":timestamp,"dId":device,"vName":"1.0.0"});
    let payload = format!("{pathname}{query}{timestamp}{header}");
    let mut hmac = Hmac::<Sha256>::new_from_slice(key.as_bytes()).unwrap();
    hmac.update(payload.as_bytes());
    let hmac = format!("{:x}", hmac.finalize().into_bytes());
    let sign = format!("{:x}", Md5::digest(hmac.as_bytes()));
    vec![
        ("cred", cred.into()),
        ("sign", sign),
        ("platform", "3".into()),
        ("timestamp", timestamp.into()),
        ("dId", device.into()),
        ("vName", "1.0.0".into()),
        ("User-Agent", USER_AGENT.into()),
    ]
}
pub struct Skland {
    device: String,
    send: Transport,
}
impl Skland {
    pub fn new() -> Result<Self> {
        let mut bytes = [0; 16];
        getrandom::fill(&mut bytes).map_err(|e| e.to_string())?;
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        let hex = bytes.iter().map(|n| format!("{n:02X}")).collect::<String>();
        Ok(Self {
            device: format!(
                "{}-{}-{}-{}-{}",
                &hex[..8],
                &hex[8..12],
                &hex[12..16],
                &hex[16..20],
                &hex[20..]
            ),
            send: transport,
        })
    }
    pub fn start_qr(&self) -> Result<Value> {
        let result = request(
            self.send,
            &format!("{HG}/general/v1/gen_scan/login"),
            Some(json!({"appCode":APP_CODE})),
            &[],
        )
        .map_err(|e| e.message)?;
        let scan = text(&result["scanId"]);
        if scan.is_empty() {
            return Err("接口请求失败：扫码标识缺失".into());
        }
        Ok(
            json!({"scanId":scan,"qrCode":qr_image(&format!("hypergryph://scan_login?scanId={scan}"))?}),
        )
    }
    pub fn finish_qr(&self, store: &mut Store, scan: &str) -> Result<Value> {
        let deadline = Instant::now() + Duration::from_secs(120);
        let mut code = String::new();
        while Instant::now() < deadline {
            match request(
                self.send,
                &format!("{HG}/general/v1/scan_status?scanId={}", encode(scan)),
                None,
                &[],
            ) {
                Ok(v) => {
                    code = text(&v["scanCode"]).into();
                    if !code.is_empty() {
                        break;
                    }
                }
                Err(_) => std::thread::sleep(Duration::from_secs(2)),
            }
        }
        if code.is_empty() {
            return Err("二维码已过期，请重新生成".into());
        }
        let token = request(
            self.send,
            &format!("{HG}/user/auth/v1/token_by_scan_code"),
            Some(json!({"scanCode":code})),
            &[],
        )
        .map_err(|e| e.message)?;
        let credentials = self
            .refresh_credentials(&json!({"accessToken":token["token"]}))
            .map_err(|e| e.message)?;
        store.save_credentials(&credentials)?;
        self.bindings(store)
    }
    pub fn bindings(&self, store: &mut Store) -> Result<Value> {
        let data = self.signed_get(store, "/api/v1/game/player/binding")?;
        let app = array(&data["list"])
            .iter()
            .find(|x| x["appCode"] == "arknights")
            .ok_or("森空岛账号未绑定《明日方舟》角色")?;
        Ok(json!(array(&app["bindingList"])
            .iter()
            .map(|b| {
                let mut b = b.clone();
                b["isDefault"] = json!(b["uid"] == app["defaultUid"]);
                b
            })
            .collect::<Vec<_>>()))
    }
    pub fn account(&self, store: &mut Store, uid: &str) -> Result<Value> {
        if uid.is_empty() {
            return Err("请先选择要同步的游戏角色".into());
        }
        normalize(
            uid,
            &self.signed_get(
                store,
                &format!("/api/v1/game/cultivate/player?uid={}", encode(uid)),
            )?,
        )
    }
    fn signed_get(&self, store: &mut Store, path: &str) -> Result<Value> {
        let mut credentials = store.credentials().ok_or("尚未连接森空岛")?;
        let mut stage = 0;
        loop {
            let timestamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|e| e.to_string())?
                .as_secs()
                .saturating_sub(1)
                .to_string();
            let response = (self.send)(
                &format!("{SK}{path}"),
                "GET",
                &signed_headers(
                    path,
                    text(&credentials["credToken"]),
                    text(&credentials["cred"]),
                    &self.device,
                    &timestamp,
                ),
                &[],
            )?;
            let envelope: Value = if response.status == 401 {
                json!({"code":if stage==0{10000}else{10002}})
            } else {
                if !(200..300).contains(&response.status) {
                    return Err(format!("森空岛网络错误：HTTP {}", response.status));
                }
                serde_json::from_slice(&response.body).map_err(|e| e.to_string())?
            };
            let status = envelope
                .get("code")
                .filter(|v| !v.is_null())
                .or_else(|| envelope.get("status"))
                .and_then(Value::as_i64);
            if status == Some(10000) && stage == 0 {
                match request(
                    self.send,
                    &format!("{SK}/api/v1/auth/refresh"),
                    None,
                    &[("cred", text(&credentials["cred"]).into())],
                ) {
                    Ok(data) => {
                        credentials["credToken"] = data["token"].clone();
                        store.save_credentials(&credentials)?;
                        stage = 1;
                        continue;
                    }
                    Err(e) if e.credential_failure => {}
                    Err(e) => return Err(e.message),
                }
            }
            if matches!(status, Some(10000 | 10002)) && stage < 2 {
                match self.refresh_credentials(&credentials) {
                    Ok(next) => {
                        credentials = next;
                        store.save_credentials(&credentials)?;
                        stage = 2;
                        continue;
                    }
                    Err(e) if e.credential_failure => return Err(REAUTH.into()),
                    Err(e) => return Err(e.message),
                }
            }
            if matches!(status, Some(10000 | 10002)) && stage == 2 {
                return Err(REAUTH.into());
            }
            return unwrap(envelope, "森空岛请求失败").map_err(|e| e.message);
        }
    }
    fn refresh_credentials(&self, old: &Value) -> ApiResult<Value> {
        let grant = request(
            self.send,
            &format!("{HG}/user/oauth2/v2/grant"),
            Some(json!({"appCode":APP_CODE,"token":old["accessToken"],"type":0})),
            &[],
        )?;
        let data = request(
            self.send,
            &format!("{SK}/api/v1/user/auth/generate_cred_by_code"),
            Some(json!({"code":grant["code"],"kind":1})),
            &[],
        )?;
        Ok(json!({"accessToken":old["accessToken"],"cred":data["cred"],"credToken":data["token"]}))
    }
}

pub fn normalize(uid: &str, data: &Value) -> Result<Value> {
    // The remote API has returned both JSON numbers and numeric strings.
    fn number(value: &Value) -> f64 {
        value
            .as_f64()
            .or_else(|| value.as_str().and_then(|v| v.trim().parse().ok()))
            .unwrap_or(0.0)
    }
    if !data["characters"].is_array() || !data["items"].is_array() {
        return Err("森空岛返回结构已变化：缺少 characters 或 items".into());
    }
    let mut merged: Vec<Value> = vec![];
    let brackets = regex::Regex::new(r"\[([0-9]+?)\]").unwrap();
    let amiya = regex::Regex::new(r"_amiya\d+$").unwrap();
    for raw in array(&data["characters"]) {
        let id = text(&raw["id"]);
        let id = id.strip_prefix("char_").unwrap_or(id);
        let id = if amiya.is_match(id) { "002_amiya" } else { id };
        if !merged.iter().any(|o| text(&o["operatorId"]) == id) {
            merged.push(json!({"operatorId":id,"level":number(&raw["level"]),"experience":number(&raw["exp"]).max(0.0),"elitePhase":number(&raw["evolvePhase"]),"skillLevel":number(&raw["mainSkillLevel"]),"skills":[],"modules":[]}));
        }
        let current = merged
            .iter_mut()
            .find(|o| text(&o["operatorId"]) == id)
            .unwrap();
        for (key, source) in [
            ("level", "level"),
            ("experience", "exp"),
            ("elitePhase", "evolvePhase"),
            ("skillLevel", "mainSkillLevel"),
        ] {
            current[key] = json!(number(&current[key]).max(number(&raw[source])));
        }
        for (source, target, id_key, level_key) in [
            ("skills", "skills", "skillId", "masteryLevel"),
            ("equips", "modules", "moduleId", "level"),
        ] {
            let values = current[target].as_array_mut().unwrap();
            for item in array(&raw[source]) {
                let id = brackets
                    .replace_all(text(&item["id"]), "_${1}")
                    .into_owned();
                let level = number(&item["level"]).clamp(0.0, 3.0);
                if let Some(old) = values.iter_mut().find(|s| text(&s[id_key]) == id) {
                    old[level_key] = json!(number(&old[level_key]).max(level));
                } else {
                    values.push(json!({id_key:id,level_key:level}));
                }
            }
        }
    }
    let mut inventory = serde_json::Map::new();
    for item in array(&data["items"]) {
        let count = item["count"].as_f64().or_else(|| {
            item["count"].as_str().and_then(|s| {
                if s.trim().is_empty() {
                    Some(0.0)
                } else {
                    s.parse().ok()
                }
            })
        });
        if let Some(count) = count.filter(|n| n.is_finite() && *n >= 0.0) {
            inventory.insert(text(&item["id"]).into(), json!(count));
        }
    }
    Ok(
        json!({"uid":uid,"syncedAt":chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true),"operators":merged,"inventory":inventory}),
    )
}
fn qr_image(value: &str) -> Result<String> {
    let qr = qrcode::QrCode::new(value.as_bytes()).map_err(|e| e.to_string())?;
    let size = qr.width();
    let scale = 320.0 / (size + 2) as f64;
    let mut pixels = vec![255; 320 * 320 * 4];
    for y in 0..320 {
        for x in 0..320 {
            if y as f64 >= scale
                && x as f64 >= scale
                && (y as f64) < 320.0 - scale
                && (x as f64) < 320.0 - scale
            {
                let row = ((y as f64 - scale) / scale).floor() as usize;
                let col = ((x as f64 - scale) / scale).floor() as usize;
                if qr[(col, row)] == qrcode::Color::Dark {
                    let at = (y * 320 + x) * 4;
                    pixels[at..at + 3].fill(0);
                }
            }
        }
    }
    let mut bytes = vec![];
    {
        let mut encoder = png::Encoder::new(&mut bytes, 320, 320);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder
            .write_header()
            .map_err(|e| e.to_string())?
            .write_image_data(&pixels)
            .map_err(|e| e.to_string())?;
    }
    Ok(format!("data:image/png;base64,{}", STANDARD.encode(bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::planning::number;
    use std::{cell::RefCell, collections::VecDeque};
    thread_local! { static RESPONSES: RefCell<VecDeque<(&'static str,u32,Value)>> = const { RefCell::new(VecDeque::new()) }; }
    fn fake(
        url: &str,
        _method: &str,
        _headers: &[(&str, String)],
        _body: &[u8],
    ) -> Result<http::Response> {
        RESPONSES.with(|queue| {
            let (suffix, status, body) =
                queue.borrow_mut().pop_front().expect("unexpected request");
            assert!(url.ends_with(suffix), "{url}");
            Ok(http::Response {
                status,
                location: None,
                body: serde_json::to_vec(&body).unwrap(),
            })
        })
    }
    #[test]
    fn signing_and_two_stage_credential_renewal_match_existing_contract() {
        let headers = signed_headers(
            "/api/v1/game/cultivate/player?uid=123",
            "fixture-token",
            "fixture-cred",
            "fixture-device",
            "1700000000",
        );
        assert_eq!(
            headers.iter().find(|(k, _)| *k == "sign").unwrap().1,
            "97b9a140616bd7236054209c2baa7a05"
        );
        let root = std::env::temp_dir().join(format!("atr-renewal-{}", std::process::id()));
        let mut store = Store::new(root.clone()).unwrap();
        let credentials = json!({"accessToken":"access","cred":"cred","credToken":"expired"});
        store.save_credentials(&credentials).unwrap();
        let skland = Skland {
            device: "fixture".into(),
            send: fake,
        };
        let binding = json!({"code":0,"data":{"list":[{"appCode":"arknights","defaultUid":"123","bindingList":[{"uid":"123"}]}]}});
        RESPONSES.with(|q| {
            *q.borrow_mut() = VecDeque::from([
                ("/binding", 401, json!({})),
                ("/refresh", 200, json!({"code":0,"data":{"token":"fresh"}})),
                ("/binding", 200, binding.clone()),
            ])
        });
        assert_eq!(skland.bindings(&mut store).unwrap()[0]["isDefault"], true);
        assert_eq!(store.credentials().unwrap()["credToken"], "fresh");
        RESPONSES.with(|q| {
            *q.borrow_mut() = VecDeque::from([
                ("/binding", 200, json!({"code":10002})),
                ("/grant", 200, json!({"code":0,"data":{"code":"grant"}})),
                (
                    "/generate_cred_by_code",
                    200,
                    json!({"code":0,"data":{"cred":"renewed","token":"renewed-token"}}),
                ),
                ("/binding", 200, binding),
            ])
        });
        skland.bindings(&mut store).unwrap();
        assert_eq!(store.credentials().unwrap()["cred"], "renewed");
        let before = std::fs::read(root.join("credentials.bin")).unwrap();
        RESPONSES.with(|q| {
            *q.borrow_mut() = VecDeque::from([
                ("/binding", 401, json!({})),
                ("/refresh", 401, json!({})),
                ("/grant", 401, json!({})),
            ])
        });
        assert_eq!(skland.bindings(&mut store).unwrap_err(), REAUTH);
        assert_eq!(std::fs::read(root.join("credentials.bin")).unwrap(), before);
        RESPONSES.with(|q| *q.borrow_mut() = VecDeque::from([("/binding", 500, json!({}))]));
        assert!(skland
            .bindings(&mut store)
            .unwrap_err()
            .contains("HTTP 500"));
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn account_merges_amiya_and_filters_bad_inventory() {
        let result=normalize("fixture",&json!({"characters":[{"id":"char_002_amiya","level":30,"skills":[{"id":"s[1]","level":1}]},{"id":"char_1001_amiya2","level":50,"evolvePhase":2,"skills":[{"id":"s[1]","level":3}],"equips":[{"id":"m[1]","level":2}]}],"items":[{"id":"a","count":"12"},{"id":"b","count":-1},{"id":"c","count":"invalid"}]})).unwrap();
        assert_eq!(array(&result["operators"]).len(), 1);
        assert_eq!(number(&result["operators"][0]["level"]), 50.0);
        assert_eq!(result["operators"][0]["skills"][0]["skillId"], "s_1");
        assert_eq!(number(&result["inventory"]["a"]), 12.0);
        assert!(result["inventory"].get("b").is_none());
    }
    #[test]
    fn qr_preserves_png_dimensions() {
        let url = qr_image("hypergryph://scan_login?scanId=synthetic").unwrap();
        let bytes = STANDARD
            .decode(url.strip_prefix("data:image/png;base64,").unwrap())
            .unwrap();
        assert_eq!(u32::from_be_bytes(bytes[16..20].try_into().unwrap()), 320);
    }
}
