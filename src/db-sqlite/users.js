import * as s from "../db.js";

export async function getUserById(id) {
  return s.getUserByIdStmt.get({ $id: id }) ?? null;
}

export async function getUserByGoogleId(googleId) {
  return s.getUserByGoogleIdStmt.get({ $googleId: googleId }) ?? null;
}

export async function getUserByApiKey(apiKey) {
  return s.getUserByApiKeyStmt.get({ $apiKey: apiKey }) ?? null;
}

export async function upsertUser({ id, googleId, email, name, avatarUrl, apiKey }) {
  return s.upsertUserStmt.get({
    $id: id,
    $googleId: googleId,
    $email: email,
    $name: name ?? null,
    $avatarUrl: avatarUrl ?? null,
    $apiKey: apiKey,
  });
}

export async function updateUserApiKey(id, newApiKey) {
  return s.updateUserApiKeyStmt.get({ $id: id, $apiKey: newApiKey }) ?? null;
}
