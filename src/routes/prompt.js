import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { broadcast } from "../broadcast.js";
import { getSession, lookupSessionId } from "../db.js";
import { sendPrompt, cancelPrompt, isPromptActive } from "../prompt.js";

const PROMPT_BODY_LIMIT = 15 * 1024 * 1024;

export default async function promptRoutes(fastify) {
  fastify.post("/api/sessions/:sessionId/prompt", { bodyLimit: PROMPT_BODY_LIMIT }, async (req, reply) => {
    const { prompt, permissionMode, image } = req.body ?? {};
    if (!prompt) return reply.code(400).send({ error: "prompt is required" });

    const sessionId = lookupSessionId(req.params.sessionId);
    const session = getSession.get({ $id: sessionId });
    if (!session) return reply.code(404).send({ error: "Session not found" });

    if (isPromptActive(sessionId)) {
      return reply.code(409).send({ error: "A prompt is already running for this session" });
    }

    const cwd = session.worktree_dir || session.project_dir;
    if (!cwd || cwd === "unknown") {
      return reply.code(400).send({ error: "Session has no known working directory" });
    }

    // If an image is attached, save as temp file and prepend a read instruction
    let finalPrompt = prompt;
    let imagePath = null;
    if (image && image.data && image.mimeType) {
      try {
        const rawExt = image.mimeType.split("/")[1] || "png";
        const allowedExts = ["png", "jpg", "jpeg", "gif", "webp"];
        const ext = allowedExts.includes(rawExt) ? rawExt : "png";
        const filename = `.dashboard-screenshot-${randomUUID().slice(0, 8)}.${ext}`;
        imagePath = join(cwd, filename);
        await writeFile(imagePath, Buffer.from(image.data, "base64"));
        finalPrompt = `[Screenshot attached: ${filename}]\n\nPlease read and analyze the screenshot at "${imagePath}" before responding.\n\n${prompt}`;
      } catch (err) {
        console.error("Failed to save screenshot:", err);
      }
    }

    // Use the stored CLI session ID for --resume (not the dashboard's internal ID)
    const claudeSessionId = session.current_claude_session_id || req.params.sessionId;

    broadcast({ type: "prompt:start", sessionId, prompt: finalPrompt, hasImage: !!imagePath, permissionMode: permissionMode || null });

    try {
      sendPrompt(
        sessionId,
        { prompt: finalPrompt, cwd, claudeSessionId, permissionMode },
        (chunk) => broadcast({ type: "prompt:chunk", sessionId, chunk }),
        (result) => {
          broadcast({ type: "prompt:done", sessionId, exitCode: result.code, cancelled: result.cancelled, error: result.error, freshSession: result.freshSession || false });
          // Prompt may have modified files — signal diff refresh
          broadcast({ type: "diff:invalidated", sessionId });
          // Clean up the temp screenshot file once the prompt is done
          if (imagePath) {
            unlink(imagePath).catch(() => {});
          }
        },
      );
    } catch (err) {
      broadcast({ type: "prompt:done", sessionId, exitCode: null, error: err.message });
      broadcast({ type: "diff:invalidated", sessionId });
      return reply.code(500).send({ error: err.message });
    }

    return { ok: true, sessionId };
  });

  fastify.post("/api/sessions/:sessionId/prompt/cancel", async (req) => {
    const sessionId = lookupSessionId(req.params.sessionId);
    const cancelled = cancelPrompt(sessionId);
    // Do not broadcast prompt:done here — the process close/error handlers
    // are the single source of truth and will emit prompt:done with cancelled: true.
    return { ok: true, cancelled };
  });

  fastify.get("/api/sessions/:sessionId/prompt/status", async (req) => {
    const sessionId = lookupSessionId(req.params.sessionId);
    return { active: isPromptActive(sessionId) };
  });
}
