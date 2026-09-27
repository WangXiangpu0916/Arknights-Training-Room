use crate::{
    domain::{
        crafting::safe_integer,
        planning::{array, number, text},
    },
    Result,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, fs, path::Path};

pub const MANIFEST_URL:&str="https://github.com/WangXiangpu0916/Arknights-Training-Room/releases/download/resources-latest/manifest.json";
pub const MAX_PACKAGE: usize = 80 * 1024 * 1024;
pub const MAX_EXPANDED: usize = 160 * 1024 * 1024;
pub fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub fn ensure(ok: bool, message: impl AsRef<str>) -> Result<()> {
    if ok {
        Ok(())
    } else {
        Err(format!("资源校验失败：{}", message.as_ref()))
    }
}
fn matches(value: &str, pattern: &'static str) -> bool {
    // Only the fixed schema patterns below enter this cache; compile once per worker.
    thread_local! {static PATTERNS:std::cell::RefCell<std::collections::BTreeMap<&'static str,regex::Regex>>=Default::default();}
    PATTERNS.with(|patterns| {
        patterns
            .borrow_mut()
            .entry(pattern)
            .or_insert_with(|| regex::Regex::new(pattern).unwrap())
            .is_match(value)
    })
}
fn valid_text(v: &Value) -> bool {
    v.as_str()
        .is_some_and(|s| !s.is_empty() && s.encode_utf16().count() <= 512)
}
fn id(v: &Value) -> bool {
    v.as_str().is_some_and(|s| matches(s, r"^[A-Za-z0-9_-]+$"))
}
fn integer(v: &Value, min: f64, max: f64) -> bool {
    v.as_f64()
        .is_some_and(|n| safe_integer(n) && n >= min && n <= max)
}
const MAX_INT: f64 = 9_007_199_254_740_991.0;

pub fn safe_path(name: &str) -> Result<()> {
    ensure(
        name.encode_utf16().count() <= 240
            && !name.chars().any(|c| c == '\\' || c == ':' || c <= '\u{1f}'),
        "文件路径无效",
    )?;
    for s in name.split('/') {
        ensure(
            !s.is_empty()
                && s != "."
                && s != ".."
                && !s.ends_with(['.', ' '])
                && !s.contains(['<', '>', '"', '|', '?', '*'])
                && !matches(s, r"(?i)^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)"),
            format!("不安全路径 {name}"),
        )?;
    }
    ensure(
        matches!(
            name,
            "data/game.json" | "metadata/provenance.json" | "metadata/notices.md"
        ) || matches(name, r"^images/.+\.(png|svg)$"),
        format!("未允许的文件 {name}"),
    )
}

pub fn manifest(m: &Value, version: &str, remote: bool) -> Result<()> {
    ensure(m.is_object(), "manifest 必须是对象")?;
    let rv = text(&m["resourceVersion"]);
    ensure(
        matches(rv, r"^\d{4}\.\d{2}\.\d{2}\.\d+$"),
        "resourceVersion 无效",
    )?;
    let date = rv.split('.').take(3).collect::<Vec<_>>().join("-");
    ensure(
        chrono::NaiveDate::parse_from_str(&date, "%Y-%m-%d").is_ok_and(|d| d.to_string() == date)
            && rv
                .split('.')
                .all(|s| s.parse::<f64>().is_ok_and(safe_integer)),
        "resourceVersion 日期或序号无效",
    )?;
    ensure(
        integer(&m["schemaVersion"], 1.0, MAX_INT),
        "schemaVersion 无效",
    )?;
    if m["schemaVersion"] != 1 {
        return Err(format!(
            "此资源格式需要升级应用（支持 schema 1，收到 {}），继续使用当前资源。",
            m["schemaVersion"]
        ));
    }
    ensure(
        valid_text(&m["buildTime"])
            && chrono::DateTime::parse_from_rfc3339(text(&m["buildTime"])).is_ok(),
        "buildTime 无效",
    )?;
    ensure(valid_text(&m["minAppVersion"]), "minAppVersion 无效")?;
    let parse = |s: &str| -> Result<semver::Version> {
        ensure(
            matches(s, r"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$"),
            format!("应用版本格式无效：{s}"),
        )?;
        semver::Version::parse(s).map_err(|e| e.to_string())
    };
    if parse(version)? < parse(text(&m["minAppVersion"]))? {
        return Err(format!(
            "此资源需要应用 v{} 或更高版本，请升级应用；当前资源保持可用。",
            text(&m["minAppVersion"])
        ));
    }
    ensure(!array(&m["sources"]).is_empty(), "缺少固定上游版本")?;
    for s in array(&m["sources"]) {
        ensure(
            s.is_object()
                && valid_text(&s["repository"])
                && if s.get("commit").is_some() {
                    matches(
                        text(&s["repository"]),
                        r"^https://github\.com/[\w.-]+/[\w.-]+$",
                    ) && matches(text(&s["commit"]), r"^[a-f0-9]{40}$")
                } else {
                    text(&s["repository"]) == "https://torappu.prts.wiki/assets/uniequip_type"
                        && matches(text(&s["dataVersion"]), r"^sha256:[a-f0-9]{64}$")
                },
            "上游 repository / 固定 commit 或内容摘要无效",
        )?;
        ensure(
            s.get("dataVersion").is_none() || valid_text(&s["dataVersion"]),
            "上游内容摘要无效",
        )?;
    }
    let files = m["files"].as_object().ok_or("资源校验失败：文件清单无效")?;
    ensure(files.len() > 1 && files.len() <= 10000, "文件清单无效")?;
    let mut names = BTreeSet::new();
    let mut size = 0.0;
    for (name, info) in files {
        safe_path(name)?;
        ensure(
            names.insert(name.to_lowercase()),
            format!("大小写冲突 {name}"),
        )?;
        ensure(
            info.is_object()
                && integer(&info["size"], 1.0, 20.0 * 1024.0 * 1024.0)
                && matches(text(&info["sha256"]), r"^[a-f0-9]{64}$"),
            format!("文件校验信息无效 {name}"),
        )?;
        size += number(&info["size"]);
    }
    ensure(size <= 110.0 * 1024.0 * 1024.0, "展开资源超过大小限制")?;
    ensure(
        files.contains_key("data/game.json"),
        "缺少关键 JSON data/game.json",
    )?;
    let fallback = &m["fallbacks"]["skills"];
    ensure(
        fallback.is_array()
            && array(fallback).iter().all(id)
            && array(fallback)
                .iter()
                .map(text)
                .collect::<BTreeSet<_>>()
                .len()
                == array(fallback).len(),
        "技能 fallback 无效",
    )?;
    if remote {
        let p = &m["package"];
        ensure(
            p.is_object()
                && valid_text(&p["url"])
                && integer(&p["size"], 1.0, MAX_PACKAGE as f64)
                && matches(text(&p["sha256"]), r"^[a-f0-9]{64}$"),
            "资源包信息无效",
        )?;
    }
    Ok(())
}

pub fn game(d: &Value, m: &Value, previous: Option<&Value>) -> Result<()> {
    ensure(
        d.is_object() && d["version"] == m["resourceVersion"] && d["updatedAt"] == m["buildTime"],
        "数据版本与清单不一致",
    )?;
    ensure(
        array(&d["operators"]).len() >= 100 && array(&d["materials"]).len() >= 30,
        "关键数据集为空或过少",
    )?;
    let mut items = BTreeSet::new();
    for item in array(&d["materials"]) {
        ensure(
            item.is_object()
                && id(&item["itemId"])
                && items.insert(text(&item["itemId"]))
                && valid_text(&item["name"])
                && integer(&item["rarity"], 0.0, 6.0)
                && integer(&item["type"], 0.0, 20.0),
            "材料结构 / ID 无效",
        )?;
        for key in ["purpose", "description"] {
            ensure(
                item.get(key).is_none() || item[key].is_string(),
                format!("材料 {key} 无效"),
            )?;
        }
    }
    let costs = |values: &Value, label: &str, required: bool| -> Result<()> {
        ensure(
            values.is_array() && (!required || !array(values).is_empty()),
            format!("{label} 消耗为空或无效"),
        )?;
        let mut seen = BTreeSet::new();
        for cost in array(values) {
            ensure(
                cost.is_object()
                    && id(&cost["itemId"])
                    && items.contains(text(&cost["itemId"]))
                    && integer(&cost["quantity"], 1.0, MAX_INT)
                    && seen.insert(text(&cost["itemId"])),
                format!("{label} 引用未知材料或非法数量"),
            )?;
        }
        Ok(())
    };
    for item in array(&d["materials"]) {
        if let Some(recipe) = item.get("recipe") {
            ensure(
                recipe.is_object()
                    && recipe["productItemId"] == item["itemId"]
                    && integer(&recipe["outputQuantity"], 1.0, MAX_INT),
                "合成公式无效",
            )?;
            costs(&recipe["ingredients"], text(&item["itemId"]), true)?;
        }
    }
    let mut operators = BTreeSet::new();
    let mut modules = BTreeSet::new();
    for op in array(&d["operators"]) {
        ensure(
            op.is_object()
                && id(&op["operatorId"])
                && operators.insert(text(&op["operatorId"]))
                && valid_text(&op["name"])
                && integer(&op["rarity"], 1.0, 6.0)
                && [
                    "先锋", "近卫", "重装", "狙击", "术师", "医疗", "辅助", "特种",
                ]
                .contains(&text(&op["profession"]))
                && valid_text(&op["subProfession"])
                && integer(&op["maxElitePhase"], 0.0, 2.0),
            "干员结构 / ID / 职业无效",
        )?;
        for key in [
            "searchPinyin",
            "searchPinyinInitials",
            "implementationDate",
            "gender",
            "position",
        ] {
            ensure(
                op.get(key).is_none() || op[key].is_string(),
                format!("干员 {key} 无效"),
            )?;
        }
        for key in [
            "obtainMethods",
            "races",
            "birthPlaces",
            "organizations",
            "teams",
            "tags",
        ] {
            ensure(
                op.get(key).is_none()
                    || (op[key].is_array() && array(&op[key]).iter().all(Value::is_string)),
                format!("干员 {key} 无效"),
            )?;
        }
        ensure(
            op.get("birthdayMonth").is_none() || integer(&op["birthdayMonth"], 1.0, 12.0),
            "生日月份无效",
        )?;
        ensure(
            op["promotionRequirements"].is_object()
                && op["skills"].is_array()
                && op["modules"].is_array(),
            "干员培养结构无效",
        )?;
        for level in 1..=2 {
            costs(
                &op["promotionRequirements"][level.to_string()],
                &format!("{} E{level}", text(&op["operatorId"])),
                number(&op["rarity"]) >= 4.0 && level as f64 <= number(&op["maxElitePhase"]),
            )?;
        }
        let mut skills = BTreeSet::new();
        for skill in array(&op["skills"]) {
            ensure(
                skill.is_object()
                    && id(&skill["skillId"])
                    && skills.insert(text(&skill["skillId"]))
                    && skill["operatorId"] == op["operatorId"]
                    && integer(&skill["index"], 1.0, 20.0)
                    && valid_text(&skill["name"])
                    && skill["requirements"].is_object(),
                "技能 ID / 干员关联无效",
            )?;
            for level in 1..=3 {
                costs(
                    &skill["requirements"][level.to_string()],
                    &format!("{} M{level}", text(&skill["skillId"])),
                    true,
                )?;
            }
        }
        ensure(
            number(&op["rarity"]) < 4.0 || !skills.is_empty(),
            format!("高星干员缺少技能 {}", text(&op["operatorId"])),
        )?;
        for module in array(&op["modules"]) {
            ensure(
                module.is_object()
                    && id(&module["moduleId"])
                    && modules.insert(text(&module["moduleId"]))
                    && valid_text(&module["name"])
                    && valid_text(&module["typeIcon"])
                    && valid_text(&module["typeLabel"])
                    && module["requirements"].is_object(),
                "模组结构 / ID 无效",
            )?;
            for level in 1..=3 {
                costs(
                    &module["requirements"][level.to_string()],
                    &format!("{} Lv{level}", text(&module["moduleId"])),
                    true,
                )?;
            }
        }
    }
    let p = &d["progression"];
    ensure(
        p.is_object()
            && items.contains(text(&p["lmdItemId"]))
            && p["expItems"].as_object().is_some_and(|m| !m.is_empty()),
        "升级曲线 / 经验物品缺失",
    )?;
    for (id, value) in p["expItems"].as_object().unwrap() {
        ensure(
            items.contains(id.as_str()) && integer(value, 1.0, MAX_INT),
            "经验物品引用无效",
        )?;
    }
    for key in [
        "characterExpMap",
        "characterUpgradeCostMap",
        "evolveGoldCost",
    ] {
        let evolve = key == "evolveGoldCost";
        ensure(
            array(&p[key]).len() >= if evolve { 6 } else { 3 },
            format!("{key} 无效"),
        )?;
        for row in array(&p[key]) {
            ensure(
                array(row).len() >= if evolve { 2 } else { 89 }
                    && array(row).iter().all(|n| integer(n, -1.0, MAX_INT)),
                format!("{key} 曲线无效"),
            )?;
        }
    }
    ensure(
        array(&d["operators"])
            .iter()
            .any(|o| number(&o["rarity"]) == 6.0)
            && !modules.is_empty(),
        "六星干员 / 模组数据消失",
    )?;
    if let Some(previous) = previous {
        let counts = |g: &Value| {
            let ops = array(&g["operators"]);
            [
                ops.len(),
                array(&g["materials"]).len(),
                ops.iter().filter(|o| number(&o["rarity"]) == 6.0).count(),
                ops.iter().map(|o| array(&o["skills"]).len()).sum(),
                ops.iter().map(|o| array(&o["modules"]).len()).sum(),
                ops.iter()
                    .filter(|o| text(&o["subProfession"]) != "未知分支")
                    .count(),
            ]
        };
        for (i, (next, old)) in counts(d).into_iter().zip(counts(previous)).enumerate() {
            ensure(
                next as f64 >= old as f64 * 0.9,
                format!("sanity check 数据集 {i} 较上一快照减少超过 10%"),
            )?;
        }
    }
    Ok(())
}

pub fn files(root: &Path) -> Result<Vec<String>> {
    fn walk(root: &Path, dir: &Path, out: &mut Vec<String>) -> Result<()> {
        for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            let kind = entry.file_type().map_err(|e| e.to_string())?;
            ensure(
                !kind.is_symlink(),
                format!("不允许符号链接 {}", path.display()),
            )?;
            if kind.is_dir() {
                walk(root, &path, out)?;
            } else {
                ensure(kind.is_file(), "非常规文件")?;
                out.push(
                    path.strip_prefix(root)
                        .map_err(|e| e.to_string())?
                        .to_string_lossy()
                        .replace('\\', "/"),
                );
            }
        }
        Ok(())
    }
    let mut out = vec![];
    walk(root, root, &mut out)?;
    out.sort();
    Ok(out)
}

pub fn load(
    root: &Path,
    version: &str,
    previous: Option<&Value>,
    expected: Option<&Value>,
) -> Result<(Value, Value)> {
    let m: Value =
        serde_json::from_slice(&fs::read(root.join("manifest.json")).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    manifest(&m, version, false)?;
    if let Some(expected) = expected {
        ensure(&m == expected, "包内与远端 manifest 不一致")?;
    }
    let entries = m["files"].as_object().unwrap();
    let actual = files(root)?;
    ensure(
        actual.len() == entries.len() + 1
            && actual
                .iter()
                .all(|n| n == "manifest.json" || entries.contains_key(n)),
        "缺失资源或包含清单外文件",
    )?;
    for (name, info) in entries {
        safe_path(name)?;
        let bytes = fs::read(root.join(name)).map_err(|e| e.to_string())?;
        ensure(
            bytes.len() as f64 == number(&info["size"]) && hash(&bytes) == text(&info["sha256"]),
            format!("文件损坏 {name}"),
        )?;
        if name.ends_with(".png") {
            ensure(
                bytes.len() >= 24
                    && bytes[..8] == [137, 80, 78, 71, 13, 10, 26, 10]
                    && u32::from_be_bytes(bytes[16..20].try_into().unwrap()) > 0
                    && u32::from_be_bytes(bytes[20..24].try_into().unwrap()) > 0,
                format!("非法 PNG {name}"),
            )?;
        }
        if name.ends_with(".svg") {
            ensure(
                !matches(
                    &String::from_utf8_lossy(&bytes),
                    r#"(?i)<script|\bon\w+\s*=|href\s*=\s*["'](?:https?:|javascript:|data:)"#,
                ),
                format!("不安全 SVG {name}"),
            )?;
        }
    }
    let data: Value =
        serde_json::from_slice(&fs::read(root.join("data/game.json")).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    game(&data, &m, previous)?;
    let mut required = BTreeSet::from(["images/skill/placeholder.svg".to_string()]);
    let mut all_skills = BTreeSet::new();
    let fallback = array(&m["fallbacks"]["skills"])
        .iter()
        .map(text)
        .collect::<BTreeSet<_>>();
    for op in array(&data["operators"]) {
        required.insert(format!("images/avatar/{}.png", text(&op["operatorId"])));
        required.insert(format!(
            "images/profession-hd/{}.png",
            text(&op["profession"])
        ));
        for skill in array(&op["skills"]) {
            let id = text(&skill["skillId"]);
            all_skills.insert(id);
            if !fallback.contains(id) {
                required.insert(format!("images/skill/{id}.png"));
            }
        }
        for module in array(&op["modules"]) {
            required.insert(format!(
                "images/module/type/{}.png",
                text(&module["typeIcon"]).to_lowercase()
            ));
        }
    }
    for item in array(&data["materials"]) {
        required.insert(format!("images/item/{}.png", text(&item["itemId"])));
    }
    for level in 0..=3 {
        required.insert(format!("images/mastery/m{level}.png"));
        required.insert(format!("images/mastery/专精_{level}_角标.png"));
        if level < 3 {
            required.insert(format!("images/elite/e{level}.png"));
        }
        if level > 0 {
            required.insert(format!("images/module/stage/{level}.png"));
        }
    }
    for name in required {
        ensure(entries.contains_key(&name), format!("缺少关键图片 {name}"))?;
    }
    ensure(
        fallback.iter().all(|s| all_skills.contains(s)),
        "fallback 引用未知技能",
    )?;
    ensure(
        fallback.len() as f64 <= all_skills.len() as f64 * 0.1,
        "缺失技能图标超过 10%",
    )?;
    Ok((m, data))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn resource_paths_are_bounded_windows_paths() {
        for name in [
            "../settings.json",
            "images/../../credentials.bin",
            "images/CON.png",
            "images/x:evil.png",
            "images/a./b.png",
            "images/a\\b.png",
        ] {
            assert!(safe_path(name).is_err(), "{name}");
        }
        assert!(safe_path("images/mastery/专精_1_角标.png").is_ok());
    }
}
