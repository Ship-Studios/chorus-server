import * as s from "../db.js";

export async function getAllSettings() {
  return s.getAllSettingsStmt.all();
}

export async function getSetting(key) {
  return s.getSettingStmt.get({ $key: key }) ?? null;
}

export async function upsertSetting(key, value, encrypted = false) {
  return s.upsertSettingStmt.run({ $key: key, $value: value, $encrypted: encrypted ? 1 : 0 });
}

export async function deleteSetting(key) {
  return s.deleteSettingStmt.run({ $key: key });
}
