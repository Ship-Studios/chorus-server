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
  let chunks = [];

  return {
    /**
     * Feed raw data from stdout. Splits on newlines, parses each
     * complete line as JSON, falls back to `{ type: "raw", text }`.
     */
    feed(data) {
      chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data));

      // Safety valve: if we've accumulated a huge chunk with no newline,
      // emit it as a raw event and reset to avoid unbounded memory growth.
      const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
      if (totalLength > MAX_LINE_LENGTH) {
        onChunk({ type: "raw", text: Buffer.concat(chunks).toString() });
        chunks = [];
        return;
      }

      const lines = Buffer.concat(chunks).toString().split("\n");
      chunks = [Buffer.from(lines[lines.length - 1])];

      for (const line of lines.slice(0, -1)) {
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
      const buffer = Buffer.concat(chunks).toString();
      chunks = [];
      if (!buffer.trim()) return;
      try {
        onChunk(JSON.parse(buffer));
      } catch {
        onChunk({ type: "raw", text: buffer.trim() });
      }
    },
  };
}
