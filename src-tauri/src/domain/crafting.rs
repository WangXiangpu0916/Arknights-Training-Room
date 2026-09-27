use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

pub type Inventory = BTreeMap<String, f64>;
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Amount {
    pub item_id: String,
    pub quantity: f64,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Recipe {
    pub product_item_id: String,
    pub output_quantity: f64,
    pub ingredients: Vec<Amount>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    pub item_id: String,
    pub requested: f64,
    pub available_inventory: f64,
    pub from_inventory: f64,
    pub exchange_quantity: f64,
    pub crafted: f64,
    pub batches: f64,
    pub output_quantity: f64,
    pub ingredients: Vec<Amount>,
    pub children: Vec<Step>,
    pub unlimited_roots: BTreeSet<String>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Craft {
    pub feasible: bool,
    pub remaining_inventory: Inventory,
    pub steps: Vec<Step>,
    pub unlimited_roots: BTreeSet<String>,
    pub exchanges: Vec<Amount>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}
struct Run {
    inventory: Inventory,
    roots: BTreeSet<String>,
    exchanges: Inventory,
    process_unlimited: bool,
}
pub struct Engine<'a> {
    recipes: &'a BTreeMap<String, Recipe>,
    unlimited: BTreeSet<String>,
}

pub fn safe_integer(value: f64) -> bool {
    value.is_finite() && value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_991.0
}

impl<'a> Engine<'a> {
    pub fn new(recipes: &'a BTreeMap<String, Recipe>, unlimited: &[String]) -> Self {
        Self {
            recipes,
            unlimited: unlimited.iter().cloned().collect(),
        }
    }
    pub fn fulfill(
        &self,
        inventory: &Inventory,
        requirements: &[Amount],
        process_unlimited: bool,
    ) -> Craft {
        let mut run = Run {
            inventory: inventory.clone(),
            roots: BTreeSet::new(),
            exchanges: Inventory::new(),
            process_unlimited,
        };
        let mut steps = Vec::new();
        let mut requirements = requirements.iter().collect::<Vec<_>>();
        requirements.sort_by(|a, b| a.item_id.cmp(&b.item_id));
        for requirement in &requirements {
            if !safe_integer(requirement.quantity) || requirement.quantity < 0.0 {
                return failure(
                    inventory,
                    steps,
                    format!("材料 {} 数量无效", requirement.item_id),
                );
            }
            match self.ensure(
                &mut run,
                &requirement.item_id,
                requirement.quantity,
                &BTreeSet::new(),
            ) {
                Ok(step) => steps.push(step),
                Err(error) => {
                    if process_unlimited && !self.unlimited.is_empty() {
                        return self.fulfill(
                            inventory,
                            &requirements.into_iter().cloned().collect::<Vec<_>>(),
                            false,
                        );
                    }
                    return failure(inventory, steps, error);
                }
            }
        }
        Craft {
            feasible: true,
            remaining_inventory: run.inventory,
            steps,
            unlimited_roots: run.roots,
            exchanges: run
                .exchanges
                .into_iter()
                .map(|(item_id, quantity)| Amount { item_id, quantity })
                .collect(),
            error: None,
        }
    }
    fn ensure(
        &self,
        run: &mut Run,
        item_id: &str,
        quantity: f64,
        visiting: &BTreeSet<String>,
    ) -> Result<Step, String> {
        let available = run.inventory.get(item_id).copied().unwrap_or(0.0).max(0.0);
        let from_inventory = available.min(quantity);
        run.inventory
            .insert(item_id.into(), available - from_inventory);
        let shortage = quantity - from_inventory;
        let mut step = Step {
            item_id: item_id.into(),
            requested: quantity,
            available_inventory: available,
            from_inventory,
            exchange_quantity: 0.0,
            crafted: 0.0,
            batches: 0.0,
            output_quantity: 1.0,
            ingredients: vec![],
            children: vec![],
            unlimited_roots: BTreeSet::new(),
        };
        if shortage == 0.0 {
            return Ok(step);
        }
        let recipe = self.recipes.get(item_id);
        if self.unlimited.contains(item_id) {
            let mut exchange = shortage;
            if recipe.is_some() && run.process_unlimited {
                let finite_engine = Engine::new(self.recipes, &[]);
                let amount = |quantity| {
                    [Amount {
                        item_id: item_id.into(),
                        quantity,
                    }]
                };
                let mut finite = finite_engine.fulfill(&run.inventory, &amount(shortage), true);
                if finite.feasible {
                    run.inventory = finite.remaining_inventory;
                    let mut finite_step = finite.steps.remove(0);
                    finite_step.requested = quantity;
                    finite_step.available_inventory = available;
                    finite_step.from_inventory = from_inventory;
                    return Ok(finite_step);
                }
                let (mut low, mut high) = (0.0, shortage);
                while low + 1.0 < high {
                    let middle = low + ((high - low) / 2.0).floor();
                    let attempt = finite_engine.fulfill(&run.inventory, &amount(middle), true);
                    if attempt.feasible {
                        low = middle;
                        finite = attempt;
                    } else {
                        high = middle;
                    }
                }
                if low > 0.0 {
                    run.inventory = finite.remaining_inventory;
                    step = finite.steps.remove(0);
                    exchange -= low;
                }
            }
            run.roots.insert(item_id.into());
            *run.exchanges.entry(item_id.into()).or_default() += exchange;
            step.requested = quantity;
            step.available_inventory = available;
            step.from_inventory = from_inventory;
            step.exchange_quantity = exchange;
            step.unlimited_roots = BTreeSet::from([item_id.into()]);
            return Ok(step);
        }
        let recipe = recipe.ok_or_else(|| format!("{item_id} 库存不足且无法加工"))?;
        if visiting.contains(item_id) {
            return Err(format!("加工配方存在循环依赖：{item_id}"));
        }
        if !safe_integer(recipe.output_quantity) || recipe.output_quantity <= 0.0 {
            return Err(format!("{item_id} 的配方产量无效"));
        }
        let batches = (shortage / recipe.output_quantity).ceil();
        let mut visiting = visiting.clone();
        visiting.insert(item_id.into());
        for ingredient in &recipe.ingredients {
            step.children.push(self.ensure(
                run,
                &ingredient.item_id,
                ingredient.quantity * batches,
                &visiting,
            )?);
        }
        let produced = batches * recipe.output_quantity;
        *run.inventory.entry(item_id.into()).or_default() += produced - shortage;
        step.crafted = produced;
        step.batches = batches;
        step.output_quantity = recipe.output_quantity;
        step.ingredients = recipe
            .ingredients
            .iter()
            .map(|x| Amount {
                item_id: x.item_id.clone(),
                quantity: x.quantity * batches,
            })
            .collect();
        step.unlimited_roots = step
            .children
            .iter()
            .flat_map(|x| x.unlimited_roots.iter().cloned())
            .collect();
        Ok(step)
    }
    pub fn recursive_quantity(&self, inventory: &Inventory, recipe: Option<&Recipe>) -> f64 {
        let Some(recipe) = recipe.filter(|r| {
            !r.ingredients.is_empty() && safe_integer(r.output_quantity) && r.output_quantity > 0.0
        }) else {
            return 0.0;
        };
        let mut available = inventory.clone();
        available.insert(recipe.product_item_id.clone(), 0.0);
        let feasible = |quantity| {
            self.fulfill(
                &available,
                &[Amount {
                    item_id: recipe.product_item_id.clone(),
                    quantity,
                }],
                true,
            )
            .feasible
        };
        let (mut low, mut high) = (0.0, recipe.output_quantity);
        while feasible(high) && high <= (9_007_199_254_740_991.0_f64 / 2.0).floor() {
            low = high;
            high *= 2.0;
        }
        while low + 1.0 < high {
            let middle = low + ((high - low) / 2.0).floor();
            if feasible(middle) {
                low = middle;
            } else {
                high = middle;
            }
        }
        low
    }
}
fn failure(inventory: &Inventory, steps: Vec<Step>, error: String) -> Craft {
    Craft {
        feasible: false,
        remaining_inventory: inventory.clone(),
        steps,
        unlimited_roots: BTreeSet::new(),
        exchanges: vec![],
        error: Some(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shared_material_fallback_and_cycles_preserve_inventory() {
        let recipe = Recipe {
            product_item_id: "a".into(),
            output_quantity: 1.0,
            ingredients: vec![Amount {
                item_id: "b".into(),
                quantity: 2.0,
            }],
        };
        let recipes = BTreeMap::from([("a".into(), recipe)]);
        let inventory = BTreeMap::from([("b".into(), 2.0)]);
        let engine = Engine::new(&recipes, &["a".into()]);
        let result = engine.fulfill(
            &inventory,
            &[
                Amount {
                    item_id: "a".into(),
                    quantity: 1.0,
                },
                Amount {
                    item_id: "b".into(),
                    quantity: 2.0,
                },
            ],
            true,
        );
        assert!(result.feasible);
        assert_eq!(result.exchanges[0].quantity, 1.0);
        assert_eq!(inventory["b"], 2.0);
        let requirements = [Amount {
            item_id: "a".into(),
            quantity: 1.0,
        }];
        assert_eq!(
            serde_json::to_value(engine.fulfill(&inventory, &requirements, true)).unwrap(),
            serde_json::to_value(engine.fulfill(&inventory, &requirements, true)).unwrap(),
            "Reusing an engine must not retain inventory from the previous plan"
        );
        assert_eq!(
            Engine::new(&recipes, &[]).recursive_quantity(&inventory, recipes.get("a")),
            1.0
        );
        let cycle = BTreeMap::from([(
            "a".into(),
            Recipe {
                product_item_id: "a".into(),
                output_quantity: 1.0,
                ingredients: vec![Amount {
                    item_id: "a".into(),
                    quantity: 1.0,
                }],
            },
        )]);
        assert!(
            !Engine::new(&cycle, &[])
                .fulfill(
                    &Inventory::new(),
                    &[Amount {
                        item_id: "a".into(),
                        quantity: 1.0
                    }],
                    true
                )
                .feasible
        );
    }
}
