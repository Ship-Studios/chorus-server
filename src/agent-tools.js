/**
 * Agent SDK tool definitions for Chorus.
 *
 * These tools are exposed to the Agent SDK via `createSdkMcpServer()`.
 * Each tool handler routes through the WebSocket bridge to the local
 * MCP daemon running on the user's machine, which executes the actual
 * file/bash/git operations.
 *
 * Tool name mapping:
 *   Agent SDK (Claude sees)  →  Bridge tool name  →  Local daemon handler
 *   Read                     →  fs_read           →  filesystem.read()
 *   Write                    →  fs_write          →  filesystem.write()
 *   Edit                     →  fs_edit           →  filesystem.edit()
 *   Bash                     →  bash_exec         →  bash.exec()
 *   Glob                     →  glob              →  search.glob()
 *   Grep                     →  grep              →  search.grep()
 *   ListDir                  →  fs_list           →  filesystem.list()
 *   GitDiff                  →  git_diff          →  git.diff()
 *   GitStatus                →  git_status        →  git.status()
 *   GitLog                   →  git_log           →  git.log()
 *
 * @module agent-tools
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Tool name mapping: SDK tool name → bridge tool name
// ---------------------------------------------------------------------------

export const TOOL_NAME_MAP = {
  Read: "fs_read",
  Write: "fs_write",
  Edit: "fs_edit",
  Bash: "bash_exec",
  Glob: "glob",
  Grep: "grep",
  ListDir: "fs_list",
  GitDiff: "git_diff",
  GitStatus: "git_status",
  GitLog: "git_log",
};

// ---------------------------------------------------------------------------
// Zod schemas for tool inputs (matches Claude Code's tool input interfaces)
// ---------------------------------------------------------------------------

const ReadSchema = {
  file_path: z.string().describe("The absolute path to the file to read"),
  offset: z.number().optional().describe("The line number to start reading from (1-based)"),
  limit: z.number().optional().describe("The number of lines to read"),
};

const WriteSchema = {
  file_path: z.string().describe("The absolute path to the file to write"),
  content: z.string().describe("The content to write to the file"),
};

const EditSchema = {
  file_path: z.string().describe("The absolute path to the file to modify"),
  old_string: z.string().describe("The text to replace"),
  new_string: z.string().describe("The text to replace it with"),
  replace_all: z.boolean().optional().describe("Replace all occurrences (default false)"),
};

const BashSchema = {
  command: z.string().describe("The command to execute"),
  description: z.string().optional().describe("Description of what the command does"),
  timeout: z.number().optional().describe("Optional timeout in milliseconds (max 600000)"),
};

const GlobSchema = {
  pattern: z.string().describe("The glob pattern to match files against"),
  path: z.string().optional().describe("The directory to search in"),
};

const GrepSchema = {
  pattern: z.string().describe("The regex pattern to search for"),
  path: z.string().optional().describe("File or directory to search in"),
  glob: z.string().optional().describe("Glob pattern to filter files (e.g. '*.js')"),
  output_mode: z.enum(["content", "files_with_matches", "count"]).optional()
    .describe("Output mode (default: files_with_matches)"),
};

const ListDirSchema = {
  path: z.string().describe("The directory path to list"),
};

const GitDiffSchema = {
  cwd: z.string().describe("The project directory"),
};

const GitStatusSchema = {
  cwd: z.string().describe("The project directory"),
};

const GitLogSchema = {
  cwd: z.string().describe("The project directory"),
  limit: z.number().optional().describe("Number of commits to show (default 20, max 100)"),
};

// ---------------------------------------------------------------------------
// Tool definitions for createSdkMcpServer()
// ---------------------------------------------------------------------------

/**
 * Create tool definitions that route through the bridge.
 *
 * @param {(toolName: string, toolInput: object) => Promise<object>} executeTool
 *   Function that sends a tool call to the local daemon via the WebSocket bridge.
 *   Signature: executeTool(bridgeToolName, params) → result
 *
 * @returns {Array<import("@anthropic-ai/claude-agent-sdk").SdkMcpToolDefinition>}
 */
export function createToolDefinitions(executeTool) {
  /**
   * Helper: create a tool def with a handler that maps the SDK tool name
   * to the bridge tool name and forwards the call.
   */
  function tool(name, description, inputSchema) {
    const bridgeName = TOOL_NAME_MAP[name];
    return {
      name,
      description,
      inputSchema,
      async handler(args) {
        // Map SDK param names to bridge param names where they differ
        const bridgeParams = mapParams(name, args);
        try {
          const result = await executeTool(bridgeName, bridgeParams);
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        } catch (err) {
          return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
        }
      },
    };
  }

  return [
    tool("Read", "Read the contents of a file from the local filesystem", ReadSchema),
    tool("Write", "Write content to a file on the local filesystem", WriteSchema),
    tool("Edit", "Make a string replacement edit to a file", EditSchema),
    tool("Bash", "Execute a bash command on the local machine", BashSchema),
    tool("Glob", "Find files matching a glob pattern", GlobSchema),
    tool("Grep", "Search file contents using regex", GrepSchema),
    tool("ListDir", "List contents of a directory", ListDirSchema),
    tool("GitDiff", "Show uncommitted git changes", GitDiffSchema),
    tool("GitStatus", "Show git working tree status", GitStatusSchema),
    tool("GitLog", "Show recent git commits", GitLogSchema),
  ];
}

// ---------------------------------------------------------------------------
// Parameter mapping: SDK tool params → bridge tool params
// ---------------------------------------------------------------------------

/**
 * Map Agent SDK tool input params to bridge tool params.
 * The SDK tools use Claude Code conventions (file_path), while the bridge
 * tools use simpler names (path). This function bridges the gap.
 */
function mapParams(toolName, args) {
  switch (toolName) {
    case "Read":
      return { path: args.file_path, offset: args.offset, limit: args.limit };
    case "Write":
      return { path: args.file_path, content: args.content };
    case "Edit":
      return {
        path: args.file_path,
        old_string: args.old_string,
        new_string: args.new_string,
        replace_all: args.replace_all,
      };
    case "Bash":
      // The bridge bash_exec expects { command, cwd }
      // cwd will be set by the session's project_dir on the server side
      return { command: args.command };
    case "Glob":
      return { pattern: args.pattern, path: args.path };
    case "Grep":
      return {
        pattern: args.pattern,
        path: args.path,
        glob: args.glob,
        output_mode: args.output_mode,
      };
    case "ListDir":
      return { path: args.path };
    case "GitDiff":
      return { cwd: args.cwd };
    case "GitStatus":
      return { cwd: args.cwd };
    case "GitLog":
      return { cwd: args.cwd, limit: args.limit };
    default:
      return args;
  }
}
