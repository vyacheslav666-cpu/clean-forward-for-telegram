#!/usr/bin/env node
/**
 * Packs the built extension into the ZIP uploaded to the Chrome Web Store.
 *
 * The file list is read out of the built manifest rather than hardcoded, so renaming the content
 * script in `vite.config.ts` cannot leave this script packing a name that no longer exists. That
 * also settles what stays out: `dist/` holds the Tampermonkey userscript too, and the manifest
 * does not reference it — an unexplained script next to a `world: "MAIN"` content script is
 * exactly the kind of thing that turns an automated review into a manual one.
 *
 * The version check exists because `dist/` is gitignored and refreshed only by whoever last ran a
 * build. Through `npm run package:extension` the build runs first and the check is a formality;
 * run against a stale `dist/`, it is the only thing standing between a forgotten rebuild and an
 * upload labelled with the previous version. A wrong version in the store's public history cannot
 * be rewritten.
 *
 * Usage:
 *   node scripts/pack-extension.mjs
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST_DIR = join(REPO_ROOT, "dist");
const MANIFEST_NAME = "manifest.json";
const ARCHIVE_PREFIX = "clean-forward";

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read ${path}: ${error instanceof Error ? error.message : error}`);
  }
}

/**
 * Collects every file the manifest points at, in a stable order with the manifest first.
 *
 * Only the fields this extension actually uses are read. An unknown field silently contributing
 * nothing is the failure mode worth avoiding, so anything added to the manifest later has to be
 * added here too — and the missing-file check below is what makes that omission visible.
 */
function referencedFiles(manifest) {
  const names = [MANIFEST_NAME];
  for (const script of manifest.content_scripts ?? []) {
    names.push(...(script.js ?? []), ...(script.css ?? []));
  }
  names.push(...Object.values(manifest.icons ?? {}));
  if (manifest.background?.service_worker) {
    names.push(manifest.background.service_worker);
  }
  return [...new Set(names)];
}

/**
 * Writes the archive with every entry at its root, which is what Chrome requires: a ZIP holding a
 * single top-level folder is rejected for having no manifest.
 *
 * Both branches run from inside `dist/` and pass relative names. That keeps the archive flat, and
 * it keeps every path on the command line ASCII — a repository path with non-Latin characters or
 * spaces never has to survive the console code page on the way to PowerShell.
 */
function createArchive(fileNames, archiveName) {
  const destination = `../${archiveName}`;
  if (process.platform === "win32") {
    const quoted = fileNames.map((name) => `'${name.replace(/'/g, "''")}'`).join(",");
    execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Compress-Archive -LiteralPath ${quoted} -DestinationPath '${destination}' -Force`,
      ],
      { cwd: DIST_DIR, stdio: ["ignore", "inherit", "inherit"] },
    );
    return;
  }
  try {
    // -X drops uid/gid and other local file attributes that mean nothing to the store.
    execFileSync("zip", ["-q", "-X", destination, ...fileNames], {
      cwd: DIST_DIR,
      stdio: ["ignore", "inherit", "inherit"],
    });
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error("The `zip` command is required to pack the extension on this platform.");
    }
    throw error;
  }
}

function main() {
  const { version } = readJson(join(REPO_ROOT, "package.json"));
  const manifestPath = join(DIST_DIR, MANIFEST_NAME);
  if (!existsSync(manifestPath)) {
    throw new Error(`No ${MANIFEST_NAME} in dist/. Run \`npm run build\` first.`);
  }

  const manifest = readJson(manifestPath);
  if (manifest.version !== version) {
    throw new Error(
      `dist/${MANIFEST_NAME} is version ${manifest.version}, package.json is ${version}.\n` +
        "dist/ was built before the version was bumped. Run `npm run build` and pack again.",
    );
  }

  const fileNames = referencedFiles(manifest);
  const missing = fileNames.filter((name) => !existsSync(join(DIST_DIR, name)));
  if (missing.length > 0) {
    throw new Error(
      `The manifest references files that dist/ does not contain: ${missing.join(", ")}.`,
    );
  }

  const archiveName = `${ARCHIVE_PREFIX}-${version}.zip`;
  const archivePath = join(REPO_ROOT, archiveName);
  // Compress-Archive -Force and zip both merge into an existing archive rather than replacing it,
  // which would keep a file that an earlier build referenced and this one does not.
  rmSync(archivePath, { force: true });
  createArchive(fileNames, archiveName);

  const kilobytes = (statSync(archivePath).size / 1024).toFixed(1);
  console.log(`${archiveName} (${kilobytes} KB)`);
  for (const name of fileNames) {
    console.log(`  ${name}`);
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
