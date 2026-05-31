#!/usr/bin/env node
// Load better-sqlite3; rebuild from source when compiled for a different Node ABI.
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function rebuild() {
  console.log(`better-sqlite3: rebuilding for Node ${process.version}...`);
  execSync("npm rebuild better-sqlite3 --build-from-source", {
    cwd: webRoot,
    stdio: "inherit",
  });
}

try {
  require("better-sqlite3");
} catch (error) {
  if (error?.code === "ERR_DLOPEN_FAILED") {
    rebuild();
    require("better-sqlite3");
    console.log("better-sqlite3: ok");
    process.exit(0);
  }
  throw error;
}
