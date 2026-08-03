// Builds for iOS and installs the result on a connected device with
// `ios-deploy`. Run via `npm run build:ios`.
import { execFileSync, execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const APPLE_DIR = "src-tauri/gen/apple";

if (process.platform !== "darwin") {
  console.error("iOS builds require macOS with Xcode installed.");
  process.exit(1);
}
if (!existsSync(APPLE_DIR)) {
  console.error(
    `${APPLE_DIR} is missing — run 'npm run tauri ios init' once to generate the Xcode project.`,
  );
  process.exit(1);
}

function has(cmd) {
  try {
    execSync(`command -v ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

if (!has("ios-deploy")) {
  console.error("ios-deploy not found. Install it with:  brew install ios-deploy");
  process.exit(1);
}

/**
 * Preflight the bundled Swift plugins.
 *
 * A method appended after a class's closing brace is still valid Swift —
 * braces balance, it just becomes a top-level function — and the only
 * complaint is `'@objc' can only be used with members of classes`, several
 * minutes into an Xcode build. Checking that every @objc entry point sits at
 * class depth costs milliseconds and fails with a line number.
 */
function checkSwiftPlugins() {
  const problems = [];
  for (const file of swiftSources("src-tauri")) {
    const src = readFileSync(file, "utf8");
    const lines = src.split("\n");
    const cleanLines = stripCommentsAndStrings(src).split("\n");
    let depth = 0;
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*@objc\b/.test(lines[i]) && depth !== 1) {
        // `@objc` may sit on the func's own line or the line above it.
        const sig = lines[i].match(/func\s+(\w+)/) ?? (lines[i + 1] ?? "").match(/func\s+(\w+)/);
        problems.push(
          `${file}:${i + 1}: @objc ${sig ? `'${sig[1]}' ` : ""}is at brace depth ` +
            `${depth}, not inside the class — Swift rejects @objc outside a class`,
        );
      }
      for (const c of cleanLines[i]) {
        if (c === "{") depth++;
        else if (c === "}") depth--;
      }
    }
    if (depth !== 0) problems.push(`${file}: unbalanced braces (ends at depth ${depth})`);
  }
  if (problems.length) {
    console.error("Swift plugin sources look malformed:\n  " + problems.join("\n  "));
    process.exit(1);
  }
}

/**
 * Blank out comments and string literals, preserving line structure, so only
 * real braces are counted. One pass, because doing it with separate regexes
 * gets the precedence wrong: strip line comments first and a `"https://…"`
 * loses its closing quote, which throws off every quote after it.
 */
function stripCommentsAndStrings(src) {
  let out = "";
  for (let i = 0; i < src.length; ) {
    const two = src.slice(i, i + 2);
    if (src[i] === '"') {
      out += " ";
      i++;
      while (i < src.length && src[i] !== '"' && src[i] !== "\n") {
        if (src[i] === "\n") break;
        i += src[i] === "\\" ? 2 : 1;
      }
      i++; // closing quote
    } else if (two === "//") {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (two === "/*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end < 0 ? src.length : end + 2;
      // Keep newlines so line numbers stay aligned.
      out += src.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
    } else {
      out += src[i];
      i++;
    }
  }
  return out;
}

function swiftSources(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "target" || e.name === "gen" || e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) swiftSources(p, out);
    else if (e.name.endsWith(".swift") && e.name !== "Package.swift") out.push(p);
  }
  return out;
}

checkSwiftPlugins();

const passthrough = process.argv.slice(2);
console.log("▸ Building for iOS…");
execFileSync("npm", ["run", "tauri", "--", "ios", "build", ...passthrough], {
  stdio: "inherit",
});

/** Newest .app produced by the build. */
function findApp(dir) {
  let best = null;
  const walk = (d, depth) => {
    if (depth > 4) return;
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const p = join(d, e.name);
      if (e.name.endsWith(".app")) {
        const mtime = statSync(p).mtimeMs;
        if (!best || mtime > best.mtime) best = { path: p, mtime };
        continue;
      }
      walk(p, depth + 1);
    }
  };
  walk(dir, 0);
  return best?.path ?? null;
}

const app = findApp(join(APPLE_DIR, "build")) ?? findApp(APPLE_DIR);
if (!app) {
  console.error("Build finished but no .app bundle was found under " + APPLE_DIR);
  process.exit(1);
}

console.log(`▸ Installing ${app}`);
try {
  execFileSync("ios-deploy", ["--bundle", app, "--justlaunch", "--no-wifi"], {
    stdio: "inherit",
  });
} catch {
  console.error(
    "\nios-deploy could not install the app. Check that an iPad is connected and trusted,\n" +
      "and that the build is signed with a provisioning profile for that device.",
  );
  process.exit(1);
}
console.log("▸ Done.");
