#!/usr/bin/env node
/**
 * Checks the recorded Telegram Web K DOM contract against real upstream sources.
 *
 * This is a drift detector, not a proof of correctness. It answers exactly one question — does
 * every token this project still depends on exist in `morethanwords/tweb` today? — and it cannot
 * see structure: a class that survives but moves to another node still passes. The value is that a
 * rename or removal upstream stops being something a user discovers for us.
 *
 * Usage:
 *   node scripts/check-tweb-contract.mjs [--ref <branch-or-sha>] [--pinned] [--keep]
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, extname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CONTRACT_PATH = join(REPO_ROOT, "contracts", "tweb-dom-contract.json");
const SHA_PATTERN = /^[0-9a-f]{40}$/i;

function parseArguments(argv) {
  const options = { ref: null, pinned: false, keep: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--ref") {
      options.ref = argv[index + 1] ?? null;
      index += 1;
    } else if (argument === "--pinned") {
      options.pinned = true;
    } else if (argument === "--keep") {
      options.keep = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

function tarballUrl(repository, ref) {
  const path = SHA_PATTERN.test(ref) ? ref : `refs/heads/${ref}`;
  return `https://codeload.github.com/${repository}/tar.gz/${path}`;
}

async function downloadSources(repository, ref, workDir) {
  const url = tarballUrl(repository, ref);
  process.stderr.write(`Fetching ${url}\n`);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`Upstream fetch failed: ${response.status} ${response.statusText} (${url})`);
  }
  writeFileSync(join(workDir, "tweb.tar.gz"), Buffer.from(await response.arrayBuffer()));
  const extracted = join(workDir, "tweb");
  mkdirSync(extracted, { recursive: true });
  // Paths stay relative to workDir: GNU tar reads a Windows drive letter as a remote host.
  execFileSync("tar", ["-xzf", "tweb.tar.gz", "-C", "tweb", "--strip-components=1"], {
    cwd: workDir,
    stdio: ["ignore", "ignore", "inherit"],
  });
  return extracted;
}

function collectSourceFiles(root, extensions) {
  const files = [];
  const walk = (directory) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        walk(full);
      } else if (extensions.includes(extname(entry.name))) {
        files.push(full);
      }
    }
  };
  walk(root);
  return files;
}

/**
 * Reads every source file once into `{ path, text, quotedWords }`.
 *
 * `quotedWords` is the set of whitespace-separated words found inside short quoted strings, which
 * is how class names appear in `class="a b"`, `classList.add("a")` and SolidJS `classList` objects.
 * Matching those as whole words keeps `.time` from being "found" inside `timestamp`.
 *
 * Interpolations are blanked first, because Web K writes fixed class names next to variable ones
 * in one template literal (`` `dialog-subtitle-badge badge badge-${SIZE}` ``). Dropping the
 * interpolation keeps the literal half of such a list visible as ordinary words.
 */
function loadCorpus(files) {
  const corpus = [];
  const quotedString = /(['"`])([A-Za-z0-9_\- ]{0,300}?)\1/g;
  for (const path of files) {
    let text;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    const quotedWords = new Set();
    for (const match of text.replace(/\$\{[^{}]*\}/g, " ").matchAll(quotedString)) {
      for (const word of match[2].split(/\s+/)) {
        if (word) quotedWords.add(word);
      }
    }
    corpus.push({ path, text, quotedWords });
  }
  return corpus;
}

function escapeForRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function kebabToCamel(value) {
  return value.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
}

function locate(corpus, predicate) {
  for (const file of corpus) {
    if (predicate(file)) return file.path;
  }
  return null;
}

function findClassToken(corpus, token) {
  const selector = new RegExp(`(?<![\\w-])\\.${escapeForRegExp(token)}(?![\\w-])`);
  return locate(corpus, (file) => file.quotedWords.has(token) || selector.test(file.text));
}

function findIdToken(corpus, token) {
  const selector = new RegExp(`(?<![\\w-])#${escapeForRegExp(token)}(?![\\w-])`);
  return locate(corpus, (file) => file.quotedWords.has(token) || selector.test(file.text));
}

function findElementToken(corpus, token) {
  const tag = new RegExp(`<${escapeForRegExp(token)}(?![\\w-])`);
  return locate(corpus, (file) => file.quotedWords.has(token) || tag.test(file.text));
}

function findAttributeToken(corpus, token) {
  const literal = new RegExp(`(?<![\\w-])${escapeForRegExp(token)}(?![\\w-])`);
  const dataset = token.startsWith("data-")
    ? new RegExp(`dataset\\.${escapeForRegExp(kebabToCamel(token.slice("data-".length)))}(?![\\w])`)
    : null;
  return locate(corpus, (file) => literal.test(file.text) || (dataset !== null && dataset.test(file.text)));
}

const FINDERS = {
  class: findClassToken,
  id: findIdToken,
  element: findElementToken,
  attribute: findAttributeToken,
};

/**
 * Explains a miss that is probably not a real removal.
 *
 * SCSS writes nested names as `&-suffix`, so a class built that way never appears literally. A hint
 * here is a prompt to re-verify by hand and mark the token `dynamic`, not a pass.
 */
function suffixHint(corpus, token) {
  const parts = token.split("-");
  for (let start = 1; start < parts.length; start += 1) {
    const suffix = parts.slice(start).join("-");
    const nested = new RegExp(`&-${escapeForRegExp(suffix)}(?![\\w-])`);
    const path = locate(corpus, (file) => nested.test(file.text));
    if (path) return { suffix: `&-${suffix}`, path };
  }
  return null;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const contract = JSON.parse(readFileSync(CONTRACT_PATH, "utf8"));
  const { repository, pinnedCommit, sourceGlobs, sourceExtensions } = contract.upstream;
  const ref = options.ref ?? (options.pinned ? pinnedCommit : "master");

  const workDir = mkdtempSync(join(tmpdir(), "tweb-contract-"));
  let checkout;
  try {
    checkout = await downloadSources(repository, ref, workDir);
    const roots = sourceGlobs.map((glob) => join(checkout, glob.replace(/\/\*\*$/, "")));
    const files = roots.flatMap((root) => {
      try {
        statSync(root);
      } catch {
        throw new Error(`Upstream layout changed: ${root} is missing`);
      }
      return collectSourceFiles(root, sourceExtensions);
    });
    process.stderr.write(`Scanning ${files.length} upstream files\n\n`);
    const corpus = loadCorpus(files);

    const missing = [];
    const legacy = [];
    const skipped = [];
    let verified = 0;

    for (const entry of contract.tokens) {
      if (entry.status === "dynamic") {
        skipped.push(entry);
        continue;
      }
      const finder = FINDERS[entry.kind];
      if (!finder) throw new Error(`Unknown token kind: ${entry.kind}`);
      const found = finder(corpus, entry.token);
      if (entry.status === "legacy") {
        legacy.push({ entry, path: found });
        continue;
      }
      if (found) {
        verified += 1;
      } else {
        missing.push({ entry, hint: suffixHint(corpus, entry.token) });
      }
    }

    const describe = (path) => relative(checkout, path).split(sep).join("/");
    console.log(`tweb DOM contract vs ${repository}@${ref}`);
    console.log(`  verified: ${verified}`);
    console.log(`  missing:  ${missing.length}`);
    console.log(`  not enforced: ${legacy.length} legacy, ${skipped.length} dynamic`);
    if (ref !== pinnedCommit) {
      console.log(`  contract was hand-verified at ${pinnedCommit}`);
    }

    for (const { entry, hint } of missing) {
      console.log(`\nMISSING ${entry.kind} "${entry.token}" (${entry.area})`);
      if (entry.note) console.log(`  note: ${entry.note}`);
      if (hint) {
        console.log(`  hint: upstream has "${hint.suffix}" in ${describe(hint.path)} — it may be`);
        console.log("        composed by SCSS nesting rather than written literally.");
      }
    }
    for (const { entry, path } of legacy) {
      console.log(`\nLEGACY ${entry.kind} "${entry.token}" — not enforced. ${entry.note ?? ""}`);
      if (path) {
        console.log(`  a literal match still exists in ${describe(path)}; it may be unrelated.`);
      }
    }
    for (const entry of skipped) {
      console.log(`\nSKIPPED ${entry.kind} "${entry.token}" — ${entry.note ?? "composed at runtime"}`);
    }

    if (missing.length > 0) {
      console.log(
        "\nEach missing token is a Telegram DOM assumption this project still makes. Re-verify it" +
          "\nby hand, then either fix the selector in src/telegram/domContract.ts or mark the token" +
          "\n\"dynamic\" in contracts/tweb-dom-contract.json with the reason.",
      );
      process.exitCode = 1;
    }
  } finally {
    if (!options.keep) {
      rmSync(workDir, { recursive: true, force: true });
    } else {
      process.stderr.write(`\nKept upstream checkout in ${workDir}\n`);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
