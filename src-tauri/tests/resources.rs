use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::io::Read;
use std::{collections::BTreeMap, fs, io::Write, path::Path};
use training_room::{
    resources::{
        repository::{trusted_url, Resources},
        validation::{hash, load},
    },
    storage::{write_json_atomic, Store},
};

fn fixture(root: &Path, version: &str) -> (Value, Vec<u8>) {
    let costs = json!([{"itemId":"item_0","quantity":1}]);
    let levels = json!({"1":costs,"2":costs,"3":costs});
    let operators=(0..100).map(|i|json!({"operatorId":format!("op_{i}"),"name":format!("干员 {i}"),"rarity":if i==0{6}else{1},"profession":"近卫","subProfession":"领主","maxElitePhase":if i==0{2}else{0},"promotionRequirements":{"1":if i==0{costs.clone()}else{json!([])},"2":if i==0{costs.clone()}else{json!([])}},"skills":if i==0{json!([{"skillId":"skill_0","operatorId":"op_0","index":1,"name":"技能","requirements":levels}])}else{json!([])},"modules":if i==0{json!([{"moduleId":"module_0","name":"模组","typeIcon":"lord-x","typeLabel":"X 型模组","requirements":levels}])}else{json!([])}})).collect::<Vec<_>>();
    let game = json!({"version":version,"updatedAt":"2026-09-12T00:00:00.000Z","operators":operators,"materials":(0..30).map(|i|json!({"itemId":format!("item_{i}"),"name":format!("材料 {i}"),"rarity":1,"type":1})).collect::<Vec<_>>(),"progression":{"characterExpMap":vec![vec![1;89];3],"characterUpgradeCostMap":vec![vec![1;89];3],"evolveGoldCost":vec![vec![1;2];6],"expItems":{"item_1":200},"lmdItemId":"item_0"}});
    let png =
        fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("../resources/images/item/30011.png"))
            .unwrap();
    let mut files = BTreeMap::from([
        (
            "data/game.json".to_string(),
            serde_json::to_vec(&game).unwrap(),
        ),
        (
            "images/skill/placeholder.svg".into(),
            b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>".to_vec(),
        ),
    ]);
    for i in 0..100 {
        files.insert(format!("images/avatar/op_{i}.png"), png.clone());
    }
    for i in 0..30 {
        files.insert(format!("images/item/item_{i}.png"), png.clone());
    }
    for name in [
        "images/profession-hd/近卫.png",
        "images/skill/skill_0.png",
        "images/module/type/lord-x.png",
    ] {
        files.insert(name.into(), png.clone());
    }
    for level in 0..=3 {
        files.insert(format!("images/mastery/m{level}.png"), png.clone());
        files.insert(format!("images/mastery/专精_{level}_角标.png"), png.clone());
        if level < 3 {
            files.insert(format!("images/elite/e{level}.png"), png.clone());
        }
        if level > 0 {
            files.insert(format!("images/module/stage/{level}.png"), png.clone());
        }
    }
    let mut manifest = json!({"resourceVersion":version,"schemaVersion":1,"buildTime":"2026-09-12T00:00:00.000Z","minAppVersion":"0.0.20-beta.16","sources":[{"repository":"https://github.com/example/data","commit":"0000000000000000000000000000000000000000"}],"files":{},"fallbacks":{"skills":[]}});
    for (name, bytes) in &files {
        manifest["files"][name] = json!({"size":bytes.len(),"sha256":hash(bytes)});
        let path = root.join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }
    write_json_atomic(&root.join("manifest.json"), &manifest).unwrap();
    let envelope = json!({"format":"training-room-resource-1","manifest":manifest,"files":files.iter().map(|(n,b)|(n.clone(),json!(STANDARD.encode(b)))).collect::<serde_json::Map<_,_>>()});
    let mut encoder = flate2::write::GzEncoder::new(vec![], flate2::Compression::default());
    encoder
        .write_all(&serde_json::to_vec(&envelope).unwrap())
        .unwrap();
    let bytes = encoder.finish().unwrap();
    manifest["package"] = json!({"url":"https://github.com/WangXiangpu0916/Arknights-Training-Room/releases/download/resources-test/package.gz","size":bytes.len(),"sha256":hash(&bytes)});
    (manifest, bytes)
}

#[test]
fn resource_transaction_rejects_corruption_and_recovers_interrupted_commit() {
    let root = std::env::temp_dir().join(format!("atr-native-resource-{}", std::process::id()));
    fs::create_dir_all(&root).unwrap();
    let a = root.join("bundled");
    fixture(&a, "2026.09.12.1");
    let (manifest, bytes) = fixture(&root.join("next-source"), "2026.09.13.1");
    let store = Store::new(root.join("profile")).unwrap();
    let mut resources = Resources::initialize(&store, &a, "0.0.20-beta.16").unwrap();
    let original = fs::read(store.root.join("game-data/data/game.json")).unwrap();
    let mut corrupt = bytes.clone();
    corrupt[0] ^= 1;
    assert!(resources.install(&corrupt, &manifest, |_| Ok(())).is_err());
    assert_eq!(
        fs::read(store.root.join("game-data/data/game.json")).unwrap(),
        original
    );
    for scenario in [
        "schema",
        "min-app",
        "missing-json",
        "missing-image",
        "reference",
        "path",
        "broken-package",
    ] {
        let mut expanded = vec![];
        flate2::read::GzDecoder::new(bytes.as_slice())
            .read_to_end(&mut expanded)
            .unwrap();
        let mut envelope: Value = serde_json::from_slice(&expanded).unwrap();
        let mut remote = manifest.clone();
        match scenario {
            "schema" => remote["schemaVersion"] = json!(99),
            "min-app" => remote["minAppVersion"] = json!("9.0.0"),
            "missing-json" | "missing-image" => {
                let name = if scenario == "missing-json" {
                    "data/game.json"
                } else {
                    "images/avatar/op_0.png"
                };
                remote["files"].as_object_mut().unwrap().remove(name);
                envelope["files"].as_object_mut().unwrap().remove(name);
            }
            "reference" => {
                let mut game: Value = serde_json::from_slice(
                    &STANDARD
                        .decode(envelope["files"]["data/game.json"].as_str().unwrap())
                        .unwrap(),
                )
                .unwrap();
                game["operators"][0]["skills"][0]["requirements"]["1"][0]["itemId"] =
                    json!("unknown");
                let changed = serde_json::to_vec(&game).unwrap();
                remote["files"]["data/game.json"] =
                    json!({"size":changed.len(),"sha256":hash(&changed)});
                envelope["files"]["data/game.json"] = json!(STANDARD.encode(changed));
            }
            "path" => {
                remote["files"]["images/../settings.json"] =
                    json!({"size":1,"sha256":"0".repeat(64)})
            }
            _ => {}
        }
        let mut snapshot = remote.clone();
        snapshot.as_object_mut().unwrap().remove("package");
        envelope["manifest"] = snapshot;
        let mut encoder = flate2::write::GzEncoder::new(vec![], flate2::Compression::default());
        encoder
            .write_all(&serde_json::to_vec(&envelope).unwrap())
            .unwrap();
        let package = if scenario == "broken-package" {
            b"broken gzip".to_vec()
        } else {
            encoder.finish().unwrap()
        };
        remote["package"]["size"] = json!(package.len());
        remote["package"]["sha256"] = json!(hash(&package));
        assert!(
            resources.install(&package, &remote, |_| Ok(())).is_err(),
            "{scenario}"
        );
        assert_eq!(
            fs::read(store.root.join("game-data/data/game.json")).unwrap(),
            original,
            "{scenario}"
        );
    }
    assert!(resources
        .install(&bytes, &manifest, |_| Err::<(), _>(
            "derived state failed".into()
        ))
        .is_err());
    assert_eq!(resources.active.manifest["resourceVersion"], "2026.09.12.1");
    resources
        .install(&bytes, &manifest, |data| {
            assert_eq!(data["version"], "2026.09.13.1");
            Ok(())
        })
        .unwrap();
    assert!(resources
        .assets
        .read()
        .unwrap()
        .read("2026.09.12.1", "images/avatar/op_0.png")
        .is_ok());
    assert!(resources
        .assets
        .read()
        .unwrap()
        .read("2026.09.13.1", "../settings.json")
        .is_err());
    write_json_atomic(
        &store.root.join("game-data.transaction.json"),
        &json!({"from":"2026.09.12.1","to":"2026.09.13.1"}),
    )
    .unwrap();
    fs::create_dir_all(store.root.join("game-data.next")).unwrap();
    let recovered = Resources::initialize(&store, &a, "0.0.20-beta.16").unwrap();
    assert_eq!(recovered.active.manifest["resourceVersion"], "2026.09.12.1");
    assert_eq!(
        fs::read(store.root.join("game-data/data/game.json")).unwrap(),
        original
    );
    assert!(!store.root.join("game-data.next").exists());
    assert!(load(&store.root.join("game-data"), "0.0.20-beta.16", None, None).is_ok());
    for bad in ["http://example.org/a","https://evil.com/a","https://github.com/other/repo/releases/download/x/a","https://user:secret@github.com/WangXiangpu0916/Arknights-Training-Room/releases/download/x/a"]{assert!(trusted_url(bad,true,false).is_err());}
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn service_preserves_legacy_cache_settings_and_separates_logout_from_clear_cache() {
    use training_room::service::Service;
    let root = std::env::temp_dir().join(format!("atr-service-{}", std::process::id()));
    let bundled = root.join("bundled");
    fixture(&bundled, "2026.09.12.1");
    let profile = root.join("profile");
    let store = Store::new(profile.clone()).unwrap();
    store.write("settings.json",&json!({"theme":"dark","autoRefresh":false,"unlimitedItemIds":[],"selectedUid":"fixture"})).unwrap();
    store.write("account-cache.json",&json!({"uid":"fixture","syncedAt":"2026-01-01","operators":[],"inventory":{"item_0":123}})).unwrap();
    let original = fs::read(profile.join("account-cache.json")).unwrap();
    let mut service = Service::initialize(profile.clone(), &bundled, "0.0.20-beta.16").unwrap();
    let first = service.state().unwrap();
    assert_eq!(first, service.state().unwrap());
    assert_eq!(first["settings"]["theme"], "black");
    assert_eq!(first["usingCache"], true);
    assert!(service
        .refresh_account(None)
        .unwrap_err()
        .contains("尚未连接"));
    assert_eq!(
        fs::read(profile.join("account-cache.json")).unwrap(),
        original
    );
    let changed = service.update_settings(json!({"theme":"light"})).unwrap();
    assert_eq!(changed["single"], first["single"]);
    assert_eq!(changed["settings"]["theme"], "light");
    let credentials = json!({"accessToken":"fixture","cred":"fixture","credToken":"fixture"});
    service.store.save_credentials(&credentials).unwrap();
    service.invalidate(false);
    let logged_out = service.logout().unwrap();
    assert_eq!(logged_out["loggedIn"], false);
    assert_eq!(logged_out["account"]["uid"], "fixture");
    assert!(logged_out["settings"].get("selectedUid").is_none());
    service.store.save_credentials(&credentials).unwrap();
    service.invalidate(false);
    let cleared = service.clear_cache().unwrap();
    assert_eq!(cleared["loggedIn"], true);
    assert!(cleared["account"].is_null());
    assert!(!profile.join("account-cache.json").exists());
    assert!(profile.join("credentials.bin").exists());
    fs::remove_dir_all(root).unwrap();
}
