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
    pub fn finish_qr(&self, store: &mut Store, scan: &str, cancelled: &impl Fn() -> bool) -> Result<Value> {
        let deadline = Instant::now() + Duration::from_secs(120);
        let mut code = String::new();
        while Instant::now() < deadline {
            if cancelled() { return Err("已取消扫码登录".into()); }
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
                Err(_) => {},
            }
            // Bound polling even when a successful response has no scan code yet.
            for _ in 0..20 {
                if cancelled() { return Err("已取消扫码登录".into()); }
                std::thread::sleep(Duration::from_millis(100));
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
        if cancelled() { return Err("已取消扫码登录".into()); }
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
        let mut account = normalize(
            uid,
            &self.signed_get(
                store,
                &format!("/api/v1/game/cultivate/player?uid={}", encode(uid)),
            )?,
        )?;
        let info = self.signed_get(store, &format!("/api/v1/game/player/info?uid={}", encode(uid)))?;
        merge_gain_times(&info, &mut account);
        account["training"] = normalize_training(&info, &account)?;
        Ok(account)
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

fn merge_gain_times(info: &Value, account: &mut Value) {
    let amiya = regex::Regex::new(r"_amiya\d+$").unwrap();
    let mut times = std::collections::HashMap::<&str, f64>::new();
    for character in array(&info["chars"]) {
        let time = character["gainTime"].as_f64()
            .or_else(|| character["gainTime"].as_str()?.trim().parse().ok());
        let Some(time) = time.filter(|n| n.is_finite() && n.fract() == 0.0 && *n > 0.0 && *n <= 9_007_199_254_740_991.0) else { continue; };
        let id = text(&character["charId"]);
        let id = id.strip_prefix("char_").unwrap_or(id);
        let id = if amiya.is_match(id) { "002_amiya" } else { id };
        // Merged forms share the earliest actual acquisition record.
        times.entry(id).and_modify(|old| *old = old.min(time)).or_insert(time);
    }
    for owned in account["operators"].as_array_mut().unwrap() {
        if let Some(time) = times.get(text(&owned["operatorId"])) {
            owned["gainTime"] = json!(time);
        }
    }
}

fn normalize_training(info: &Value, account: &Value) -> Result<Value> {
    let room = &info["building"]["training"];
    let trainee = &room["trainee"];
    let numeric = |value: &Value| value.as_f64().or_else(|| value.as_str()?.parse().ok());
    if trainee.is_null() || numeric(&trainee["targetSkill"]) == Some(-1.0)
        || numeric(&room["remainSecs"]).is_some_and(|n| n <= 0.0) {
        return Ok(Value::Null);
    }
    let invalid = || "森空岛训练室数据不完整，未更新账号快照".to_string();
    let index = numeric(&trainee["targetSkill"]).filter(|n| n.fract() == 0.0 && (0.0..=2.0).contains(n)).ok_or_else(invalid)? as usize;
    let character = array(&info["chars"]).iter().find(|c| c["charId"] == trainee["charId"]).ok_or_else(invalid)?;
    let skill = array(&character["skills"]).get(index).ok_or_else(invalid)?;
    let from = numeric(&skill["specializeLevel"]).filter(|n| n.fract() == 0.0 && (0.0..=3.0).contains(n)).ok_or_else(invalid)? as u64;
    if from == 3 { return Ok(Value::Null); }
    let id = text(&trainee["charId"]);
    let id = id.strip_prefix("char_").unwrap_or(id);
    let id = if regex::Regex::new(r"_amiya\d+$").unwrap().is_match(id) { "002_amiya" } else { id };
    let skill_id = regex::Regex::new(r"\[([0-9]+?)\]").unwrap().replace_all(text(&skill["id"]), "_${1}").into_owned();
    let owned = array(&account["operators"]).iter().find(|o| o["operatorId"] == id).ok_or_else(invalid)?;
    let current = array(&owned["skills"]).iter().find(|s| s["skillId"] == skill_id).ok_or_else(invalid)?;
    // A completed cultivate snapshot must not be advanced again by older base data.
    if numeric(&current["masteryLevel"]).is_some_and(|n| n > from as f64) { return Ok(Value::Null); }
    Ok(json!({"operatorId":id,"skillId":skill_id,"from":from,"to":from+1}))
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
    fn gain_times_use_actual_records_merge_forms_and_ignore_invalid_values() {
        let mut account = normalize("fixture", &json!({"characters":[
            {"id":"char_002_amiya"}, {"id":"char_1001_amiya2"}, {"id":"char_valid"},
            {"id":"char_zero"}, {"id":"char_negative"}, {"id":"char_invalid"}, {"id":"char_missing"},
            {"id":"char_fraction"}, {"id":"char_large"}, {"id":"char_nonfinite"}, {"id":"char_boolean"}
        ],"items":[]})).unwrap();
        let original = account.clone();
        let info = json!({"chars":[
            {"charId":"char_1001_amiya2","gainTime":1700000000},
            {"charId":"char_002_amiya","gainTime":"1600000000"},
            {"charId":"char_1037_amiya3","gainTime":1800000000},
            {"charId":"char_valid","gainTime":"1650000000"},
            {"charId":"char_unowned","gainTime":1500000000},
            {"charId":"char_zero","gainTime":0}, {"charId":"char_negative","gainTime":-1},
            {"charId":"char_invalid","gainTime":"bad"}, {"charId":"char_missing","gainTime":null},
            {"charId":"char_fraction","gainTime":1.5}, {"charId":"char_large","gainTime":9007199254740992.0},
            {"charId":"char_nonfinite","gainTime":"inf"}, {"charId":"char_boolean","gainTime":true}
        ]});
        merge_gain_times(&info, &mut account);
        assert_eq!(number(&account["operators"][0]["gainTime"]), 1600000000.0);
        assert_eq!(number(&account["operators"][1]["gainTime"]), 1650000000.0);
        assert!(array(&account["operators"])[2..].iter().all(|o| o.get("gainTime").is_none()));
        let with_times = account.clone();
        merge_gain_times(&json!({}), &mut account);
        assert_eq!(account, with_times);
        for owned in account["operators"].as_array_mut().unwrap() { owned.as_object_mut().unwrap().remove("gainTime"); }
        assert_eq!(account, original);
    }
    #[test]
    fn training_uses_the_trainee_skill_index_and_keeps_owned_levels() {
        for from in 0..3 {
            let account = normalize("fixture", &json!({"characters":[{"id":"char_1001_amiya2","skills":[{"id":"s[1]","level":0},{"id":"s[2]","level":from}]}],"items":[]})).unwrap();
            let original = account.clone();
            let mut info = json!({"building":{"training":{"trainee":{"charId":"char_1001_amiya2","targetSkill":1},"trainer":{"charId":"char_other"},"remainSecs":3600}},"chars":[{"charId":"char_1001_amiya2","skills":[{"id":"s[1]","specializeLevel":0},{"id":"s[2]","specializeLevel":from}]}]});
            assert_eq!(normalize_training(&info, &account).unwrap(), json!({"operatorId":"002_amiya","skillId":"s_2","from":from,"to":from+1}));
            assert_eq!(account, original);
            info["building"]["training"]["trainee"]["targetSkill"] = json!("1");
            assert_eq!(normalize_training(&info, &account).unwrap()["to"], from + 1);
            info["building"]["training"]["trainee"]["targetSkill"] = json!(9);
            assert!(normalize_training(&info, &account).is_err());
            info["building"]["training"]["trainee"]["targetSkill"] = json!(-1);
            assert!(normalize_training(&info, &account).unwrap().is_null());
            info["building"]["training"]["trainee"]["targetSkill"] = json!(1);
            info["building"]["training"]["remainSecs"] = json!(0);
            assert!(normalize_training(&info, &account).unwrap().is_null());
            info["building"]["training"]["remainSecs"] = json!(3600);
            info["chars"][0]["skills"][1]["specializeLevel"] = json!(3);
            assert!(normalize_training(&info, &account).unwrap().is_null());
            info["building"]["training"]["trainee"] = Value::Null;
            assert!(normalize_training(&info, &account).unwrap().is_null());
        }
        assert!(normalize_training(&json!({}), &json!({})).unwrap().is_null());
    }
    #[test]
    fn account_fetches_training_with_the_same_uid_and_clears_finished_tasks() {
        let root = std::env::temp_dir().join(format!("atr-training-{}", std::process::id()));
        let mut store = Store::new(root.clone()).unwrap();
        store.save_credentials(&json!({"accessToken":"access","cred":"cred","credToken":"token"})).unwrap();
        let skland = Skland { device: "fixture".into(), send: fake };
        for training in [json!({"trainee":{"charId":"char_op","targetSkill":0},"remainSecs":100}), json!({"trainee":null})] {
            let active = !training["trainee"].is_null();
            RESPONSES.with(|q| *q.borrow_mut() = VecDeque::from([
                ("/cultivate/player?uid=fixture",200,json!({"code":0,"data":{"characters":[{"id":"char_op","skills":[{"id":"skill","level":1}]}],"items":[]}})),
                ("/player/info?uid=fixture",200,json!({"code":0,"data":{"building":{"training":training},"chars":[{"charId":"char_op","gainTime":1600000000,"skills":[{"id":"skill","specializeLevel":1}]}]}})),
            ]));
            let account = skland.account(&mut store, "fixture").unwrap();
            assert_eq!(!account["training"].is_null(), active);
            assert_eq!(number(&account["operators"][0]["skills"][0]["masteryLevel"]), 1.0);
            assert_eq!(number(&account["operators"][0]["gainTime"]), 1600000000.0);
            store.write("account-cache.json", &account).unwrap();
            assert_eq!(store.account().unwrap(), account);
        }
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn cancelled_qr_does_not_poll_or_save_credentials() {
        let root = std::env::temp_dir().join(format!("atr-cancel-{}", std::process::id()));
        let mut store = Store::new(root.clone()).unwrap();
        let skland = Skland { device: "fixture".into(), send: fake };
        assert_eq!(skland.finish_qr(&mut store, "cancelled", &|| true).unwrap_err(), "已取消扫码登录");
        assert!(!root.join("credentials.bin").exists());
        std::fs::remove_dir_all(root).unwrap();
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
