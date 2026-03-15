import * as s from "../db.js";

export async function getConversation(id) {
  return s.getConversationStmt.get({ $id: id }) ?? null;
}

export async function upsertConversation({ id, messages, systemPrompt, model, totalTokens }) {
  return s.upsertConversationStmt.run({
    $id: id,
    $messages: JSON.stringify(messages),
    $systemPrompt: systemPrompt ?? null,
    $model: model ?? null,
    $totalTokens: totalTokens ?? 0,
  });
}

export async function appendMessages(id, newMessages) {
  return s.appendMessagesRaw(id, newMessages);
}

export async function deleteConversation(id) {
  return s.deleteConversationStmt.run({ $id: id });
}
