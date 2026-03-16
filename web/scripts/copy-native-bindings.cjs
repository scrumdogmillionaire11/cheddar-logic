// Copies better-sqlite3's native binding to the path Next.js searches at runtime.
// Better-sqlite3 ends up bundled into .next/server/chunks/ (because @cheddar-logic/data
// is a local workspace package inlined by webpack), so its __dirname points into .next/
// and the bindings package searches there for the .node file.
const { cpSync, mkdirSync, existsSync } = require('fs');
const { join } = require('path');

const ver = process.version.slice(1); // e.g. "20.20.1"
const destDir = join('.next', 'compiled', ver, process.platform, process.arch);
const src = join('..', 'packages', 'data', 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
const dest = join(destDir, 'better_sqlite3.node');

if (!existsSync(src)) {
  console.warn(`[copy-native-bindings] Source not found: ${src} — skipping`);
  process.exit(0);
}

mkdirSync(destDir, { recursive: true });
cpSync(src, dest);
console.log(`[copy-native-bindings] Copied better_sqlite3.node → ${destDir}`);
