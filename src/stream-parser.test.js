import { describe, expect, it } from "bun:test";
import { createStreamParser } from "./stream-parser.js";

describe("createStreamParser", () => {
  it("parses valid JSON lines", () => {
    const chunks = [];
    const parser = createStreamParser((chunk) => chunks.push(chunk));

    parser.feed('{"type":"message","text":"hello"}\n{"type":"status","ok":true}\n');

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toEqual({ type: "message", text: "hello" });
    expect(chunks[1]).toEqual({ type: "status", ok: true });
  });

  it("falls back to raw for non-JSON lines", () => {
    const chunks = [];
    const parser = createStreamParser((chunk) => chunks.push(chunk));

    parser.feed("not json at all\n");

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual({ type: "raw", text: "not json at all" });
  });

  it("handles partial lines across multiple feed calls", () => {
    const chunks = [];
    const parser = createStreamParser((chunk) => chunks.push(chunk));

    parser.feed('{"type":"m');
    expect(chunks).toHaveLength(0); // no newline yet

    parser.feed('essage"}\n');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual({ type: "message" });
  });

  it("skips empty lines", () => {
    const chunks = [];
    const parser = createStreamParser((chunk) => chunks.push(chunk));

    parser.feed('\n\n{"ok":true}\n\n');

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual({ ok: true });
  });

  it("flushes remaining buffer content", () => {
    const chunks = [];
    const parser = createStreamParser((chunk) => chunks.push(chunk));

    parser.feed('{"final":true}'); // no trailing newline
    expect(chunks).toHaveLength(0);

    parser.flush();
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual({ final: true });
  });

  it("flush handles non-JSON buffer as raw", () => {
    const chunks = [];
    const parser = createStreamParser((chunk) => chunks.push(chunk));

    parser.feed("partial text");
    parser.flush();

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual({ type: "raw", text: "partial text" });
  });

  it("flush is no-op when buffer is empty", () => {
    const chunks = [];
    const parser = createStreamParser((chunk) => chunks.push(chunk));

    parser.flush();
    expect(chunks).toHaveLength(0);
  });

  it("flush is no-op when buffer is only whitespace", () => {
    const chunks = [];
    const parser = createStreamParser((chunk) => chunks.push(chunk));

    parser.feed("   ");
    parser.flush();
    expect(chunks).toHaveLength(0);
  });

  it("handles mixed valid and invalid lines", () => {
    const chunks = [];
    const parser = createStreamParser((chunk) => chunks.push(chunk));

    parser.feed('{"a":1}\nraw text\n{"b":2}\n');

    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toEqual({ a: 1 });
    expect(chunks[1]).toEqual({ type: "raw", text: "raw text" });
    expect(chunks[2]).toEqual({ b: 2 });
  });

  it("accepts Buffer input", () => {
    const chunks = [];
    const parser = createStreamParser((chunk) => chunks.push(chunk));

    parser.feed(Buffer.from('{"buf":true}\n'));

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual({ buf: true });
  });
});
