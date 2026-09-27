use serde_json::json;
use std::{collections::BTreeMap, io::Read};
use training_room::domain::{
    crafting::{Amount, Engine, Inventory, Recipe},
    planning::{text, Planner},
};
fn main() {
    let mut bytes = String::new();
    std::io::stdin().read_to_string(&mut bytes).unwrap();
    let input: serde_json::Value = serde_json::from_str(&bytes).unwrap();
    let unlimited: Vec<String> =
        serde_json::from_value(input.get("unlimited").cloned().unwrap_or(json!([]))).unwrap();
    let result = match text(&input["kind"]) {
        "craft" | "quantity" => {
            let recipes: Vec<Recipe> = serde_json::from_value(input["recipes"].clone()).unwrap();
            let recipes: BTreeMap<_, _> = recipes
                .into_iter()
                .map(|r| (r.product_item_id.clone(), r))
                .collect();
            let inventory: Inventory = serde_json::from_value(input["inventory"].clone()).unwrap();
            let engine = Engine::new(&recipes, &unlimited);
            if input["kind"] == "quantity" {
                json!(engine.recursive_quantity(&inventory, recipes.get(text(&input["itemId"]))))
            } else {
                json!(engine.fulfill(
                    &inventory,
                    &serde_json::from_value::<Vec<Amount>>(input["requirements"].clone()).unwrap(),
                    input["processUnlimited"] != false
                ))
            }
        }
        "groups" => {
            let planner = Planner::new(input["game"].clone()).unwrap();
            json!({"mastery":planner.mastery_materials,"blue":planner.blue,"skillSummaries":planner.summaries})
        }
        _ => {
            let planner = Planner::new(input["game"].clone()).unwrap();
            if input["kind"] == "benchmark" {
                let account = &input["account"];
                let inventory: Inventory =
                    serde_json::from_value(account["inventory"].clone()).unwrap();
                let owned = account["operators"].as_array().unwrap();
                let kind = text(&input["planner"]);
                let continuous = input["continuous"] == true;
                let run = || {
                    planner
                        .plan(owned, &inventory, &unlimited, kind, continuous)
                        .unwrap()
                };
                run();
                let mut times = vec![];
                let mut count = 0;
                for _ in 0..input["samples"].as_u64().unwrap_or(7) {
                    let start = std::time::Instant::now();
                    let result = run();
                    times.push(start.elapsed().as_secs_f64() * 1000.0);
                    count = result.len();
                }
                let mut sorted = times.clone();
                sorted.sort_by(f64::total_cmp);
                json!({"samples":times,"medianMs":sorted[sorted.len()/2],"minMs":sorted[0],"maxMs":sorted[sorted.len()-1],"resultCount":count})
            } else if input["kind"] == "statistics" {
                planner.statistics(&input["account"])
            } else {
                planner.complete(&input["account"], &unlimited).unwrap()
            }
        }
    };
    println!("{}", result);
}
