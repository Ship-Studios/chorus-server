import * as s from "../db.js";

export async function getAllCraftAgents() {
  return s.getAllCraftAgents.all();
}

export async function getCraftAgent(id) {
  return s.getCraftAgent.get({ $id: id }) ?? null;
}

export async function insertCraftAgent({ name, description, promptSnippet, icon, color, tags, modelPreference }) {
  return s.insertCraftAgent.get({
    $name: name,
    $description: description ?? null,
    $promptSnippet: promptSnippet,
    $icon: icon ?? "default",
    $color: color ?? "#4ade80",
    $tags: tags ?? "[]",
    $modelPreference: modelPreference ?? null,
  });
}

export async function updateCraftAgent(id, { name, description, promptSnippet, icon, color, tags, modelPreference }) {
  return s.updateCraftAgentStmt.get({
    $id: id,
    $name: name,
    $description: description ?? null,
    $promptSnippet: promptSnippet,
    $icon: icon ?? "default",
    $color: color ?? "#4ade80",
    $tags: tags ?? "[]",
    $modelPreference: modelPreference ?? null,
  });
}

export async function deleteCraftAgent(id) {
  return s.deleteCraftAgentStmt.run({ $id: id });
}
