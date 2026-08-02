// Builds for iOS and installs the result on a connected device with
// `ios-deploy`. Run via `npm run build:ios`.
import { execFileSync, execSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
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
