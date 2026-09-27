use super::crafting::{Amount, Engine, Inventory, Recipe};
use crate::Result;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

pub fn array(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).unwrap_or(&[])
}
pub fn text(value: &Value) -> &str {
    value.as_str().unwrap_or("")
}
pub fn number(value: &Value) -> f64 {
    value.as_f64().unwrap_or(0.0)
}
fn amounts(value: &Value) -> Result<Vec<Amount>> {
    if value.is_null() {
        Ok(vec![])
    } else {
        serde_json::from_value(value.clone()).map_err(|e| e.to_string())
    }
}
fn inventory(value: &Value) -> Result<Inventory> {
    serde_json::from_value(value.clone()).map_err(|e| e.to_string())
}
fn roots(stages: &[Value]) -> Vec<String> {
    stages
        .iter()
        .flat_map(|s| {
            array(&s["craft"]["unlimitedRoots"])
                .iter()
                .map(|x| text(x).to_owned())
        })
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}
fn total_requirements(stages: &[Value]) -> Value {
    let mut total: Vec<Amount> = vec![];
    for stage in stages {
        for item in array(&stage["requirements"]) {
            if let Some(found) = total
                .iter_mut()
                .find(|v| v.item_id == text(&item["itemId"]))
            {
                found.quantity += number(&item["quantity"]);
            } else {
                total.push(Amount {
                    item_id: text(&item["itemId"]).into(),
                    quantity: number(&item["quantity"]),
                });
            }
        }
    }
    json!(total)
}
fn stages(
    engine: &Engine,
    original: &Inventory,
    requested: &[Value],
    process_unlimited: bool,
) -> Result<Vec<Value>> {
    let mut planned = vec![];
    let mut remaining = original.clone();
    for stage in requested {
        let craft = engine.fulfill(
            &remaining,
            &amounts(&stage["requirements"])?,
            process_unlimited,
        );
        if !craft.feasible {
            if process_unlimited {
                let fallback = stages(engine, original, requested, false)?;
                if fallback.len() > planned.len() {
                    return Ok(fallback);
                }
            }
            break;
        }
        remaining = craft.remaining_inventory.clone();
        let mut next = stage.clone();
        next["craft"] = json!(craft);
        planned.push(next);
    }
    Ok(planned)
}

pub struct Planner {
    pub game: Value,
    definitions: BTreeMap<String, usize>,
    pub recipes: BTreeMap<String, Recipe>,
    pub blue: Vec<String>,
    pub summaries: Vec<String>,
    pub mastery_materials: BTreeSet<String>,
}

impl Planner {
    pub fn new(game: Value) -> Result<Self> {
        let mut recipes = BTreeMap::new();
        for item in array(&game["materials"]) {
            if let Some(value) = item.get("recipe") {
                let recipe: Recipe =
                    serde_json::from_value(value.clone()).map_err(|e| e.to_string())?;
                recipes.insert(recipe.product_item_id.clone(), recipe);
            }
        }
        let mut mastery = BTreeSet::new();
        let mut pending = vec![];
        for operator in array(&game["operators"]) {
            for skill in array(&operator["skills"]) {
                if let Some(req) = skill["requirements"].as_object() {
                    for items in req.values() {
                        for item in array(items) {
                            pending.push(text(&item["itemId"]).to_string());
                        }
                    }
                }
            }
        }
        while let Some(id) = pending.pop() {
            if mastery.insert(id.clone()) {
                if let Some(recipe) = recipes.get(&id) {
                    pending.extend(recipe.ingredients.iter().map(|x| x.item_id.clone()));
                }
            }
        }
        let blue = array(&game["materials"])
            .iter()
            .filter(|m| {
                number(&m["rarity"]) == 3.0
                    && number(&m["type"]) != 3.0
                    && mastery.contains(text(&m["itemId"]))
            })
            .map(|m| text(&m["itemId"]).into())
            .collect();
        let summaries = array(&game["materials"])
            .iter()
            .filter(|m| number(&m["type"]) == 3.0)
            .map(|m| text(&m["itemId"]).into())
            .collect();
        let definitions = array(&game["operators"])
            .iter()
            .enumerate()
            .map(|(i, o)| (text(&o["operatorId"]).into(), i))
            .collect();
        Ok(Self {
            game,
            definitions,
            recipes,
            blue,
            summaries,
            mastery_materials: mastery,
        })
    }
    pub fn complete(&self, account: &Value, unlimited: &[String]) -> Result<Value> {
        let mastery = self.group(account, unlimited, "mastery")?;
        let mut result = mastery;
        result["promotions"] = self.group(account, unlimited, "promotion")?;
        result["modules"] = self.group(account, unlimited, "module")?;
        result["statistics"] = self.statistics(account);
        result["unlimitedEligibleItemIds"] = json!(self.blue);
        result["skillSummaryItemIds"] = json!(self.summaries);
        Ok(result)
    }
    fn group(&self, account: &Value, unlimited: &[String], kind: &str) -> Result<Value> {
        if account.is_null() {
            return Ok(json!({"single":[],"continuous":[],"singleReal":[],"continuousReal":[]}));
        }
        let inventory = inventory(&account["inventory"])?;
        let single_real = self.plan(array(&account["operators"]), &inventory, &[], kind, false)?;
        let continuous_real =
            self.plan(array(&account["operators"]), &inventory, &[], kind, true)?;
        let single = if unlimited.is_empty() {
            single_real.clone()
        } else {
            self.plan(
                array(&account["operators"]),
                &inventory,
                unlimited,
                kind,
                false,
            )?
        };
        let continuous = if unlimited.is_empty() {
            continuous_real.clone()
        } else {
            self.plan(
                array(&account["operators"]),
                &inventory,
                unlimited,
                kind,
                true,
            )?
        };
        Ok(
            json!({"single":single,"continuous":continuous,"singleReal":single_real,"continuousReal":continuous_real}),
        )
    }
    pub fn plan(
        &self,
        owned: &[Value],
        inventory: &Inventory,
        unlimited: &[String],
        kind: &str,
        continuous: bool,
    ) -> Result<Vec<Value>> {
        let planned_engine = Engine::new(&self.recipes, unlimited);
        let finite_engine = Engine::new(&self.recipes, &[]);
        let mut candidates = vec![];
        for owned in owned {
            let Some(index) = self.definitions.get(text(&owned["operatorId"])) else {
                continue;
            };
            let op = &self.game["operators"][*index];
            match kind {
                "mastery" => {
                    if number(&owned["elitePhase"]) < 2.0 || number(&owned["skillLevel"]) < 7.0 {
                        continue;
                    }
                    for owned_skill in array(&owned["skills"]) {
                        let from = number(&owned_skill["masteryLevel"]) as i32;
                        if from >= 3 {
                            continue;
                        }
                        let Some(skill) = array(&op["skills"])
                            .iter()
                            .find(|s| s["skillId"] == owned_skill["skillId"])
                        else {
                            continue;
                        };
                        let requested = (from..if continuous {3} else {from+1}).map(|level|json!({"from":level,"to":level+1,"requirements":skill["requirements"][(level+1).to_string()].as_array().cloned().unwrap_or_default()})).collect::<Vec<_>>();
                        if continuous {
                            let planned = stages(&planned_engine, inventory, &requested, true)?;
                            if planned.len() < 2 {
                                continue;
                            }
                            // Legacy mastery checks finite stages without the cross-stage fallback.
                            let mut finite_end = from;
                            let mut remaining = inventory.clone();
                            if !unlimited.is_empty() {
                                for stage in &requested {
                                    let result = finite_engine.fulfill(
                                        &remaining,
                                        &amounts(&stage["requirements"])?,
                                        true,
                                    );
                                    if !result.feasible {
                                        break;
                                    }
                                    remaining = result.remaining_inventory;
                                    finite_end += 1;
                                }
                            } else {
                                finite_end = from + planned.len() as i32;
                            }
                            let last = planned.last().unwrap();
                            let uses = number(&last["to"]) > finite_end as f64;
                            candidates.push(json!({"operator":op,"skill":skill,"from":from,"to":last["to"],"stages":planned,"usesUnlimited":uses,
                                "unlimitedRoots":if uses {roots(&planned)}else{vec![]},"remainingInventory":last["craft"]["remainingInventory"]}));
                        } else {
                            let requirements = &requested[0]["requirements"];
                            let planned =
                                planned_engine.fulfill(inventory, &amounts(requirements)?, true);
                            if !planned.feasible {
                                continue;
                            }
                            let finite = if unlimited.is_empty() {
                                planned.clone()
                            } else {
                                finite_engine.fulfill(inventory, &amounts(requirements)?, true)
                            };
                            let uses = !unlimited.is_empty() && !finite.feasible;
                            let effective = if uses { &planned } else { &finite };
                            candidates.push(json!({"operator":op,"skill":skill,"from":from,"to":from+1,"stages":[{"from":from,"to":from+1,"requirements":requirements,"craft":effective}],
                                "usesUnlimited":uses,"unlimitedRoots":if uses {planned.unlimited_roots.clone()}else{BTreeSet::new()},"remainingInventory":effective.remaining_inventory}));
                        }
                    }
                }
                "promotion" => {
                    let phase = number(&owned["elitePhase"]) as i32;
                    if phase >= 2 {
                        continue;
                    }
                    let p = &self.game["progression"];
                    let exp_available = p["expItems"]
                        .as_object()
                        .map(|m| {
                            m.iter()
                                .map(|(id, v)| {
                                    inventory.get(id).copied().unwrap_or(0.0) * number(v)
                                })
                                .sum::<f64>()
                        })
                        .unwrap_or(0.0);
                    let mut exp_required = 0.0;
                    let mut requested = vec![];
                    for from in phase..if continuous { 2 } else { phase + 1 } {
                        let to = from + 1;
                        let max_level = match (number(&op["rarity"]) as i32, to) {
                            (3, 1) => 40,
                            (4, 1) => 45,
                            (4, 2) => 60,
                            (5, 1) | (6, 1) => 50,
                            (5, 2) => 70,
                            (6, 2) => 80,
                            _ => 0,
                        };
                        let promotion = &op["promotionRequirements"][to.to_string()];
                        if max_level == 0 || array(promotion).is_empty() {
                            break;
                        }
                        let level = if from == phase {
                            number(&owned["level"]) as i32
                        } else {
                            1
                        };
                        let progress = if from == phase {
                            number(&owned["experience"])
                        } else {
                            0.0
                        };
                        let curve = |name: &str| {
                            array(&p[name][from as usize])
                                .iter()
                                .skip((level - 1).max(0) as usize)
                                .take((max_level - 1 - (level - 1).max(0)).max(0) as usize)
                                .map(number)
                                .filter(|n| *n >= 0.0)
                                .sum::<f64>()
                        };
                        let exp = (curve("characterExpMap") - progress).max(0.0);
                        let lmd = curve("characterUpgradeCostMap")
                            + number(
                                &p["evolveGoldCost"]
                                    [(number(&op["rarity"]) as usize).saturating_sub(1)]
                                    [(to - 1) as usize],
                            );
                        if exp_required + exp > exp_available {
                            break;
                        }
                        exp_required += exp;
                        let requirements = total_requirements(&[
                            json!({"requirements":promotion}),
                            json!({"requirements":[{"itemId":p["lmdItemId"],"quantity":lmd}]}),
                        ]);
                        requested.push(json!({"from":from,"to":to,"experienceRequired":exp,"requirements":requirements}));
                    }
                    if let Some(mut candidate) = self.staged_candidate(
                        op,
                        owned,
                        &requested,
                        inventory,
                        &planned_engine,
                        &finite_engine,
                        !unlimited.is_empty(),
                        continuous,
                    )? {
                        candidate["from"] = json!(phase);
                        candidate["experienceAvailable"] = json!(exp_available);
                        candidate["experienceRequired"] = json!(array(&candidate["stages"])
                            .iter()
                            .map(|s| number(&s["experienceRequired"]))
                            .sum::<f64>());
                        candidates.push(candidate);
                    }
                }
                _ => {
                    let unlock = match number(&op["rarity"]) as i32 {
                        4 => 40.0,
                        5 => 50.0,
                        6 => 60.0,
                        _ => f64::INFINITY,
                    };
                    if number(&owned["elitePhase"]) < 2.0 || number(&owned["level"]) < unlock {
                        continue;
                    }
                    for module in array(&op["modules"]) {
                        let from = array(&owned["modules"])
                            .iter()
                            .find(|m| m["moduleId"] == module["moduleId"])
                            .map(|m| number(&m["level"]))
                            .unwrap_or(0.0)
                            .clamp(0.0, 3.0) as i32;
                        if from >= 3 {
                            continue;
                        }
                        let mut requested = vec![];
                        for level in from + 1..=if continuous { 3 } else { from + 1 } {
                            let requirements = &module["requirements"][level.to_string()];
                            if array(requirements).is_empty() {
                                break;
                            }
                            requested.push(
                                json!({"from":level-1,"to":level,"requirements":requirements}),
                            );
                        }
                        if let Some(mut candidate) = self.staged_candidate(
                            op,
                            owned,
                            &requested,
                            inventory,
                            &planned_engine,
                            &finite_engine,
                            !unlimited.is_empty(),
                            continuous,
                        )? {
                            candidate["from"] = json!(from);
                            candidate["module"] = module.clone();
                            candidates.push(candidate);
                        }
                    }
                }
            }
        }
        // Locale-sensitive ordering belongs to the presentation adapter. It keeps
        // the existing Intl/zh-CN comparator instead of changing to byte ordering.
        Ok(candidates)
    }
    fn staged_candidate(
        &self,
        op: &Value,
        owned: &Value,
        requested: &[Value],
        inventory: &Inventory,
        planned_engine: &Engine,
        finite_engine: &Engine,
        compare: bool,
        continuous: bool,
    ) -> Result<Option<Value>> {
        let planned = stages(planned_engine, inventory, requested, true)?;
        if planned.is_empty() || (continuous && planned.len() < 2) {
            return Ok(None);
        }
        let finite = if compare {
            stages(finite_engine, inventory, requested, true)?
        } else {
            planned.clone()
        };
        let uses = planned.len() > finite.len();
        let effective = if uses { &planned } else { &finite };
        let last = effective.last().unwrap();
        Ok(Some(
            json!({"operator":op,"currentLevel":owned["level"],"to":last["to"],"stages":effective,
            "requirements":total_requirements(effective),"craft":last["craft"],"usesUnlimited":uses,
            "unlimitedRoots":if uses{roots(effective)}else{vec![]},"remainingInventory":last["craft"]["remainingInventory"]}),
        ))
    }
    pub fn material_detail(
        &self,
        id: &str,
        account: &Value,
        unlimited: &[String],
    ) -> Result<Value> {
        let material = array(&self.game["materials"])
            .iter()
            .find(|m| text(&m["itemId"]) == id)
            .ok_or_else(|| format!("未知材料：{id}"))?;
        let inventory = if account.is_null() {
            Inventory::new()
        } else {
            inventory(&account["inventory"])?
        };
        let craftable =
            Engine::new(&self.recipes, &[]).recursive_quantity(&inventory, self.recipes.get(id));
        let real = inventory.get(id).copied().unwrap_or(0.0);
        let parents = array(&self.game["materials"])
            .iter()
            .filter(|m| {
                array(&m["recipe"]["ingredients"])
                    .iter()
                    .any(|a| text(&a["itemId"]) == id)
            })
            .collect::<Vec<_>>();
        Ok(
            json!({"material":material,"realQuantity":real,"unlimited":unlimited.iter().any(|x|x==id),"craftable":craftable,"planningAvailable":real+craftable,"parents":parents}),
        )
    }
    pub fn statistics(&self, account: &Value) -> Value {
        let owned = array(&account["operators"])
            .iter()
            .map(|o| (text(&o["operatorId"]), o))
            .collect::<BTreeMap<_, _>>();
        let all = array(&self.game["operators"]);
        let scope = |ops: Vec<&Value>| {
            let mut mastery = vec![];
            let mut modules = vec![];
            let mut elite1 = vec![];
            let mut elite2 = vec![];
            for op in ops {
                let rarity = number(&op["rarity"]) as i32;
                let current = owned
                    .get(text(&op["operatorId"]))
                    .copied()
                    .unwrap_or(&Value::Null);
                for skill in array(&op["skills"]).iter().filter(|s| {
                    (1..=3).all(|l| !array(&s["requirements"][l.to_string()]).is_empty())
                }) {
                    mastery.push((
                        rarity,
                        array(&current["skills"])
                            .iter()
                            .find(|s| s["skillId"] == skill["skillId"])
                            .is_some_and(|s| number(&s["masteryLevel"]) >= 3.0),
                    ));
                }
                for module in array(&op["modules"]) {
                    modules.push((
                        rarity,
                        array(&current["modules"])
                            .iter()
                            .find(|m| m["moduleId"] == module["moduleId"])
                            .map(|m| number(&m["level"]))
                            .unwrap_or(0.0),
                    ));
                }
                let max = op["maxElitePhase"].as_i64().unwrap_or_else(|| {
                    if !array(&op["promotionRequirements"]["2"]).is_empty() || rarity >= 4 {
                        2
                    } else if !array(&op["promotionRequirements"]["1"]).is_empty() || rarity == 3 {
                        1
                    } else {
                        0
                    }
                });
                if max >= 1 {
                    elite1.push((rarity, number(&current["elitePhase"]) >= 1.0));
                }
                if max >= 2 {
                    elite2.push((rarity, number(&current["elitePhase"]) >= 2.0));
                }
            }
            json!({"mastery":statistic(&mastery),"moduleUnlocked":statistic(&modules.iter().map(|(r,l)|(*r,*l>=1.0)).collect::<Vec<_>>()),"moduleStage3":statistic(&modules.iter().map(|(r,l)|(*r,*l>=3.0)).collect::<Vec<_>>()),"elite1":statistic(&elite1),"elite2":statistic(&elite2)})
        };
        json!({"ownership":statistic(&all.iter().map(|o|(number(&o["rarity"])as i32,owned.contains_key(text(&o["operatorId"])))).collect::<Vec<_>>()),"scopes":{"all":scope(all.iter().collect()),"owned":scope(all.iter().filter(|o|owned.contains_key(text(&o["operatorId"]))).collect())}})
    }
}
fn statistic(items: &[(i32, bool)]) -> Value {
    let mut groups = BTreeMap::<String, (usize, usize)>::new();
    for (rarity, complete) in items {
        let group = groups.entry(rarity.to_string()).or_default();
        group.1 += 1;
        if *complete {
            group.0 += 1;
        }
    }
    json!({"completed":items.iter().filter(|(_,c)|*c).count(),"total":items.len(),"byRarity":groups.into_iter().map(|(r,(c,t))|(r,json!({"completed":c,"total":t}))).collect::<serde_json::Map<_,_>>()})
}
