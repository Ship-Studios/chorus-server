import * as s from "../db.js";

export async function getUserSettings(userId) {
  return s.getUserSettingsStmt.all({ $userId: userId });
}

export async function getUserSetting(userId, key) {
  return s.getUserSettingStmt.get({ $userId: userId, $key: key }) ?? null;
}

export async function upsertUserSetting({ userId, key, value, encrypted }) {
  return s.upsertUserSettingStmt.run({
    $userId: userId,
    $key: key,
    $value: value,
    $encrypted: encrypted ? 1 : 0,
  });
}

export async function deleteUserSetting(userId, key) {
  return s.deleteUserSettingStmt.run({ $userId: userId, $key: key });
}
