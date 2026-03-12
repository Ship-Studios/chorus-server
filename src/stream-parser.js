/**
 * Line-buffered JSON stream parser for Claude CLI output.
 *
 * Both `sendPrompt` and `spawnSwarmAgent` stream structured JSON from
 * `claude --output-format stream-json`. Each line is either valid JSON
 * or a raw text line that couldn't be parsed.
 *
 * @param {(chunk: object) => void} onChunk - Called for each parsed line
 * @returns {{ feed: (data: Buffer | string) => void, flush: () => void }}
 */
const MAX_LINE_LENGTH = 512 * 1024;

export function createStreamParser(onChunk) {
  let buffer = "";

  return {
    /**
     * Feed raw data from stdout. Splits on newlines, parses each
     * complete line as JSON, falls back to `{ type: "raw", text }`.
     */
    feed(data) {
      buffer += data.toString();

      // Safety valve: if we've accumulated a huge chunk with no newline,
      // emit it as a raw event and reset to avoid unbounded memory growth.
      if (buffer.length > MAX_LINE_LENGTH) {
        onChunk({ type: "raw", text: buffer });
        buffer = "";
        return;
      }

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          onChunk(JSON.parse(line));
        } catch {
          onChunk({ type: "raw", text: line });
        }
      }
    },

    /**
     * Flush any remaining buffered content (called on process close).
     */
    flush() {
      if (!buffer.trim()) return;
      try {
        onChunk(JSON.parse(buffer));
      } catch {
        onChunk({ type: "raw", text: buffer.trim() });
      }
      buffer = "";
    },
  };
}
