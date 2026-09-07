#!/usr/bin/env node
/**
 * Cut a release.
 *
 *   npm run release -- 0.2.0     # explicit version
 *   npm run release -- patch     # 0.1.0 -> 0.1.1   (also: minor, major)
 *   npm run release -- 0.2.0 --dry-run
 *
 * Bumps the version in package.json, package-lock.json, src-tauri/tauri.conf.json,
 * src-tauri/Cargo.toml and src-tauri/Cargo.lock, commits, tags `vX.Y.Z` and pushes.
 * The tag triggers .github/workflows/release.yml, which builds, signs and
 * publishes the installers plus latest.json for the in-app updater.
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = process.argv.slice(2);
const dry = args.includes("--dry-run");
const spec = args.find((a) => !a.startsWith("--"));

if (!spec) {
  console.error("usage: npm run release -- <x.y.z | patch | minor | major> [--dry-run]");
  process.exit(1);
}

const sh = (cmd) => execSync(cmd, { cwd: root, stdio: "pipe" }).toString().trim();
const file = (p) => resolve(root, p);
const read = (p) => readFileSync(file(p), "utf8");
const write = (p, s) => (dry ? console.log(`[dry] would write ${p}`) : writeFileSync(file(p), s));

const dirty = sh("git status --porcelain");
if (dirty && !dry) {
  console.error("working tree is not clean — commit or stash first:\n" + dirty);
  process.exit(1);
}
const branch = sh("git rev-parse --abbrev-ref HEAD");
if (branch !== "main") {
  console.error(`releases are cut from main (you are on ${branch})`);
  process.exit(1);
}

const pkg = JSON.parse(read("package.json"));
const current = pkg.version;
let next = spec;
if (["patch", "minor", "major"].includes(spec)) {
  const [ma, mi, pa] = current.split(".").map(Number);
  next = spec === "major" ? `${ma + 1}.0.0` : spec === "minor" ? `${ma}.${mi + 1}.0` : `${ma}.${mi}.${pa + 1}`;
}
if (!/^\d+\.\d+\.\d+$/.test(next)) {
  console.error(`invalid version: ${next}`);
  process.exit(1);
}
if (sh(`git tag -l v${next}`)) {
  console.error(`tag v${next} already exists`);
  process.exit(1);
}
console.log(`${current} -> ${next}`);

pkg.version = next;
write("package.json", JSON.stringify(pkg, null, 2) + "\n");

const lock = JSON.parse(read("package-lock.json"));
lock.version = next;
if (lock.packages && lock.packages[""]) lock.packages[""].version = next;
write("package-lock.json", JSON.stringify(lock, null, 2) + "\n");

const conf = JSON.parse(read("src-tauri/tauri.conf.json"));
conf.version = next;
write("src-tauri/tauri.conf.json", JSON.stringify(conf, null, 2) + "\n");

write("src-tauri/Cargo.toml", read("src-tauri/Cargo.toml").replace(/^version = "[^"]+"/m, `version = "${next}"`));
write(
  "src-tauri/Cargo.lock",
  read("src-tauri/Cargo.lock").replace(/(\[\[package\]\]\nname = "osprey"\nversion = ")[^"]+(")/, `$1${next}$2`),
);

if (dry) {
  console.log(`[dry] would commit "release: v${next}", tag v${next} and push`);
  process.exit(0);
}

sh("git add package.json package-lock.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock");
sh(`git commit -m "release: v${next}"`);
sh(`git tag -a v${next} -m "Osprey v${next}"`);
sh("git push origin main");
sh(`git push origin v${next}`);
console.log(`pushed v${next} — watch https://github.com/lbss9/osprey/actions`);
