use crate::{
    domain::planning::{array, text, Planner},
    network::skland::Skland,
    resources::repository::Resources,
    storage::Store,
    Result,
};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub struct Service {
    pub store: Store,
    pub resources: Resources,
    pub skland: Skland,
    pub settings: Value,
    account: Value,
    planner: Planner,
    revision: u64,
    using_cache: bool,
    last_error: String,
    cached_state: Option<Value>,
    cached_plans: Option<Value>,
}
impl Service {
    pub fn initialize(root: PathBuf, bundled: &Path, version: &str) -> Result<Self> {
        let store = Store::new(root)?;
        let resources = Resources::initialize(&store, bundled, version)?;
        let planner = Planner::new(resources.active.data.clone())?;
        let account = store.account().unwrap_or(Value::Null);
        let mut settings = store.settings();
        let allowed = |id: &Value| {
            planner
                .blue
                .iter()
                .chain(&planner.summaries)
                .any(|v| v == text(id))
        };
        let filtered = array(&settings["unlimitedItemIds"])
            .iter()
            .filter(|id| allowed(id))
            .cloned()
            .collect::<Vec<_>>();
        if filtered.len() != array(&settings["unlimitedItemIds"]).len() {
            settings["unlimitedItemIds"] = json!(filtered);
            store.write("settings.json", &settings)?;
        }
        Ok(Self {
            store,
            resources,
            skland: Skland::new()?,
            settings,
            account,
            planner,
            revision: 0,
            using_cache: true,
            last_error: String::new(),
            cached_state: None,
            cached_plans: None,
        })
    }
    pub fn invalidate(&mut self, plans: bool) {
        self.revision += 1;
        self.cached_state = None;
        if plans {
            self.cached_plans = None;
        }
    }
    pub fn automatic_refresh(&mut self) -> bool {
        self.settings["autoRefresh"] == true
            && !self.account.is_null()
            && self.store.credentials().is_some()
    }
    fn unlimited(&self) -> Vec<String> {
        array(&self.settings["unlimitedItemIds"])
            .iter()
            .map(|v| text(v).into())
            .collect()
    }
    pub fn state(&mut self) -> Result<Value> {
        if let Some(state) = &self.cached_state {
            return Ok(state.clone());
        }
        if self.cached_plans.is_none() {
            self.cached_plans = Some(self.planner.complete(&self.account, &self.unlimited())?);
        }
        let mut state = self.cached_plans.as_ref().unwrap().clone();
        state["revision"] = json!(self.revision);
        state["loggedIn"] = json!(self.store.credentials().is_some());
        state["account"] = self.account.clone();
        state["gameData"] = self.planner.game.clone();
        state["resourceAssetBase"] = json!(format!(
            "http://atr-resource.localhost/{}/images/",
            text(&self.resources.active.manifest["resourceVersion"])
        ));
        state["settings"] = self.settings.clone();
        state["usingCache"] = json!(!self.account.is_null() && self.using_cache);
        state["lastError"] = json!(self.last_error);
        self.cached_state = Some(state.clone());
        Ok(state)
    }
    pub fn update_settings(&mut self, patch: Value) -> Result<Value> {
        if !patch.is_object() {
            return Err("设置内容格式无效".into());
        }
        let mut next = self.settings.clone();
        if let Some(ids) = patch.get("unlimitedItemIds").filter(|v| !v.is_null()) {
            let ids = ids.as_array().ok_or("设置内容格式无效")?;
            next["unlimitedItemIds"] = json!(ids
                .iter()
                .filter(|v| self
                    .planner
                    .blue
                    .iter()
                    .chain(&self.planner.summaries)
                    .any(|id| Some(id.as_str()) == v.as_str()))
                .collect::<Vec<_>>());
        }
        if patch["autoRefresh"].is_boolean() {
            next["autoRefresh"] = patch["autoRefresh"].clone();
        }
        if matches!(patch["theme"].as_str(), Some("light" | "black" | "system")) {
            next["theme"] = patch["theme"].clone();
        }
        let changed = next["unlimitedItemIds"] != self.settings["unlimitedItemIds"];
        self.store.write("settings.json", &next)?;
        self.settings = next;
        self.invalidate(changed);
        self.state()
    }
    pub fn refresh_account(&mut self, uid: Option<String>) -> Result<Value> {
        let selected = uid
            .filter(|v| !v.is_empty())
            .or_else(|| {
                self.settings["selectedUid"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .map(String::from)
            })
            .or_else(|| self.account["uid"].as_str().map(String::from))
            .ok_or("请先选择森空岛绑定角色")?;
        let result = (|| {
            let mut next = self.skland.account(&mut self.store, &selected)?;
            let bindings = self.skland.bindings(&mut self.store).unwrap_or(json!([]));
            if let Some(name) = array(&bindings)
                .iter()
                .find(|b| text(&b["uid"]) == selected)
                .and_then(|b| b.get("nickName"))
            {
                next["nickname"] = name.clone();
            }
            let mut settings = self.settings.clone();
            settings["selectedUid"] = json!(selected);
            self.store.write("account-cache.json", &next)?;
            self.store.write("settings.json", &settings)?;
            self.account = next;
            self.settings = settings;
            self.using_cache = false;
            self.last_error.clear();
            self.invalidate(true);
            self.store.log("account-refresh-success", "");
            Ok(())
        })();
        if let Err(error) = result {
            self.last_error = error;
            self.invalidate(false);
            self.store.log("account-refresh-failure", &self.last_error);
            return Err(self.last_error.clone());
        }
        self.state()
    }
    pub fn update_resources(&mut self) -> Result<Value> {
        let account = &self.account;
        let unlimited = self.unlimited();
        match self.resources.update(|data| {
            let planner = Planner::new(data.clone())?;
            let plans = planner.complete(account, &unlimited)?;
            Ok((planner, plans))
        }) {
            Ok(next) => {
                if let Some((planner, plans)) = next {
                    self.planner = planner;
                    self.cached_plans = Some(plans);
                }
                self.last_error.clear();
                self.invalidate(false);
                self.store.log(
                    "game-data-update-success",
                    text(&self.resources.active.data["version"]),
                );
            }
            Err(error) => {
                self.last_error = error;
                self.invalidate(false);
                self.store.log("game-data-update-failure", &self.last_error);
                return Err(self.last_error.clone());
            }
        }
        self.state()
    }
    pub fn logout(&mut self) -> Result<Value> {
        self.store.clear_credentials()?;
        let mut settings = self.settings.clone();
        settings.as_object_mut().unwrap().remove("selectedUid");
        self.store.write("settings.json", &settings)?;
        self.settings = settings;
        self.invalidate(false);
        self.store.log("account-logout", "");
        self.state()
    }
    pub fn clear_cache(&mut self) -> Result<Value> {
        self.store.remove("account-cache.json")?;
        self.account = Value::Null;
        self.using_cache = false;
        self.invalidate(true);
        self.store.log("account-cache-cleared", "");
        self.state()
    }
    pub fn material_detail(&self, id: &str) -> Result<Value> {
        self.planner
            .material_detail(id, &self.account, &self.unlimited())
    }
}
