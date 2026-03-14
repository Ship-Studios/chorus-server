/**
 * Handle Anthropic API errors uniformly across routes.
 * Returns true if the error was handled (reply sent), false otherwise.
 */
export function handleAnthropicError(err, reply) {
  const status = err?.status;

  if (status === 429) {
    const retryAfter = err.headers?.["retry-after"];
    const headers = retryAfter ? { "Retry-After": retryAfter } : undefined;
    const response = reply.code(429);
    if (headers) response.headers(headers);
    response.send({ error: "Rate limited — try again later" });
    return true;
  }

  if (status === 529) {
    reply.code(503).send({ error: "AI service overloaded — try again later" });
    return true;
  }

  if (status === 401) {
    reply.code(502).send({ error: "API key configuration error" });
    return true;
  }

  return false;
}
