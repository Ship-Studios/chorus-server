export const IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".svelte-kit", ".next", ".nuxt",
  "__pycache__", ".venv", "venv", "coverage", ".turbo", ".cache", ".output",
  "target", ".expo", ".parcel-cache", "out", ".vercel", ".netlify",
  ".svelte-kit", "android", "ios", ".gradle", ".idea", ".vscode",
]);

export const SOURCE_EXTS = new Set([
  ".js", ".ts", ".jsx", ".tsx", ".svelte", ".vue",
  ".py", ".rb", ".go", ".rs", ".java", ".kt", ".swift",
  ".css", ".scss", ".less", ".html",
]);

export const CONFIG_EXTS = new Set([".json", ".yaml", ".yml", ".toml"]);

export const IMPORT_PATTERNS = [
  /import\\s+(?:[\\w{}\\s,*]+\\s+from\\s+)?['\"]([^'\"]+)['\"]/g,
  /require\\s*\\(\\s*['\"]([^'\"]+)['\"]\\s*\\)/g,
  /import\\s*\\(\\s*['\"]([^'\"]+)['\"]\\s*\\)/g,
  /^(?:from\\s+(\\S+)\\s+import|import\\s+(\\S+))/gm,
  /import\\s+\"([^\"]+)\"/g,
];

export function parseImports(content, _ext) {
  const imports = new Set();
  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(content))) {
      const spec = m[1] ?? m[2];
      if (spec) imports.add(spec);
    }
  }
  return imports;
}

export function fileDesc(name, ext) {
  if (ext === ".svelte") return "Svelte component";
  if (ext === ".vue") return "Vue component";
  if (ext === ".tsx" || ext === ".jsx") return "React component";
  if (ext === ".ts") return "TypeScript module";
  if (ext === ".js") return "JavaScript module";
  if (ext === ".py") return "Python module";
  if (ext === ".go") return "Go source";
  if (ext === ".rs") return "Rust source";
  if (ext === ".java" || ext === ".kt") return "JVM source";
  if (ext === ".css" || ext === ".scss" || ext === ".less") return "Stylesheet";
  if (ext === ".html") return "HTML template";
  if (ext === ".json") return "JSON config";
  if (ext === ".yaml" || ext === ".yml") return "YAML config";
  return "Source file";
}

export function dirDesc(name, childCount) {
  const lower = name.toLowerCase();
  const suffix = `(${childCount} item${childCount !== 1 ? "s" : ""})`;
  if (lower === "components" || lower === "component") return `UI components ${suffix}`;
  if (lower === "routes" || lower === "pages") return `Route handlers ${suffix}`;
  if (lower === "lib" || lower === "utils" || lower === "helpers") return `Shared utilities ${suffix}`;
  if (lower === "stores" || lower === "store") return `State management ${suffix}`;
  if (lower === "hooks" || lower === "composables") return `Lifecycle hooks ${suffix}`;
  if (lower === "services" || lower === "api") return `Service layer ${suffix}`;
  if (lower === "models" || lower === "types" || lower === "schemas") return `Data models ${suffix}`;
  if (lower === "middleware") return `Middleware ${suffix}`;
  if (lower === "plugins") return `Plugin modules ${suffix}`;
  if (lower === "tests" || lower === "__tests__" || lower === "test") return `Test suites ${suffix}`;
  if (lower === "config" || lower === "configs") return `Configuration ${suffix}`;
  if (lower === "assets" || lower === "static" || lower === "public") return `Static assets ${suffix}`;
  if (lower === "styles" || lower === "css") return `Stylesheets ${suffix}`;
  if (lower === "layouts") return `Layout templates ${suffix}`;
  if (lower === "server" || lower === "backend") return `Server-side logic ${suffix}`;
  if (lower === "client" || lower === "frontend") return `Client-side code ${suffix}`;
  if (lower === "commands" || lower === "cmd") return `CLI commands ${suffix}`;
  return `Directory ${suffix}`;
}
