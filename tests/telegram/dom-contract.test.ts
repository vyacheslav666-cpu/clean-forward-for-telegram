/// <reference types="vite/client" />
/**
 * Keeps the Telegram DOM contract honest.
 *
 * `scripts/check-tweb-contract.mjs` can only check tokens that are written down. These tests are
 * the other half: they prove the inventory in `contracts/tweb-dom-contract.json` still describes
 * every Telegram-owned selector the code actually uses, so a selector added straight into an
 * adapter cannot quietly escape the upstream check.
 */
import { describe, expect, it } from "vitest";
import contractJson from "../../contracts/tweb-dom-contract.json";

type TokenKind = "class" | "id" | "attribute" | "element";
type TokenStatus = "required" | "legacy" | "dynamic";
interface ContractToken {
  readonly token: string;
  readonly kind: TokenKind;
  readonly status: TokenStatus;
  readonly area: string;
  readonly note?: string;
}

const contract = contractJson as unknown as { readonly tokens: readonly ContractToken[] };

const CONTRACT_MODULE_PATH = "src/telegram/domContract.ts";
const sources = import.meta.glob("../../src/telegram/**/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/**
 * Wider corpus for the "is this token still used" direction.
 *
 * A token earns its place in the contract by being used anywhere in the project, not only by the
 * Telegram adapters: `night` is read from `src/ui` to theme this project's own overlays.
 */
const projectSources = import.meta.glob("../../src/**/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/**
 * The DOM property form of a `data-*` attribute.
 *
 * `data-monoforum-parent-peer-id` is read as `dataset.monoforumParentPeerId`, so searching for the
 * attribute name literally finds nothing even though the code depends on it.
 */
function datasetProperty(token: string): string | null {
  if (!token.startsWith("data-")) return null;
  return token
    .slice("data-".length)
    .replace(/-([a-z0-9])/g, (_, character: string) => character.toUpperCase());
}
const normalizePath = (path: string): string => path.replace(/^(\.\.\/)+/, "");

/** Attributes and shapes owned by HTML itself, never by Telegram. */
const STANDARD_ATTRIBUTES = new Set([
  "hidden",
  "aria-hidden",
  "aria-disabled",
  "contenteditable",
  "type",
  "checked",
  "href",
  "src",
  "role",
]);
const isProjectOwned = (token: string): boolean => token.startsWith("clean-forward");

interface SelectorTokens {
  readonly classes: readonly string[];
  readonly ids: readonly string[];
  readonly attributes: readonly string[];
  readonly elements: readonly string[];
}

function extractTokens(selector: string): SelectorTokens {
  const collect = (pattern: RegExp): string[] =>
    Array.from(selector.matchAll(pattern), (match) => match[match.length - 1] ?? "").filter(Boolean);
  return {
    classes: collect(/\.([A-Za-z_][\w-]*)/g),
    ids: collect(/#([A-Za-z_][\w-]*)/g),
    attributes: collect(/\[([A-Za-z_][\w-]*)/g),
    // Custom elements are the only bare tag names Telegram owns; every plain HTML tag is not ours.
    elements: collect(/(?:^|[\s,>+~(])([a-z][a-z0-9]*-[a-z0-9-]*)(?=[\s,.[:)]|$)/g),
  };
}

/**
 * Every string literal that reaches a DOM lookup or a class mutation.
 *
 * The two families are kept apart because a bare word means different things in each: a tag name
 * for `closest("button")`, a class name for `classList.add("active")`.
 */
function extractSelectorLiterals(source: string): readonly { value: string; isClassName: boolean }[] {
  const literals: { value: string; isClassName: boolean }[] = [];
  const calls =
    /(?:querySelector|querySelectorAll|closest|matches)(?:<[^>()]*>)?\(([^()]*)\)|classList\.(?:add|remove|contains|toggle)\(([^()]*)\)/g;
  for (const call of source.matchAll(calls)) {
    const isClassName = call[1] === undefined;
    const argumentText = call[1] ?? call[2] ?? "";
    for (const literal of argumentText.matchAll(/(['"`])((?:(?!\1)[^\\])*)\1/g)) {
      const value = literal[2] ?? "";
      // Interpolated templates carry a named constant, which is checked where it is declared.
      if (value.includes("${")) continue;
      if (value) literals.push({ value, isClassName });
    }
  }
  return literals;
}

const declared = new Map(contract.tokens.map((entry) => [`${entry.kind}:${entry.token}`, entry]));

function undeclared(selector: string): string[] {
  const { classes, ids, attributes, elements } = extractTokens(selector);
  const missing: string[] = [];
  const check = (kind: TokenKind, tokens: readonly string[]): void => {
    for (const token of tokens) {
      if (isProjectOwned(token)) continue;
      if (kind === "attribute" && STANDARD_ATTRIBUTES.has(token)) continue;
      if (!declared.has(`${kind}:${token}`)) missing.push(`${kind} "${token}"`);
    }
  };
  check("class", classes);
  check("id", ids);
  check("attribute", attributes);
  check("element", elements);
  return missing;
}

describe("Telegram DOM contract", () => {
  it("declares every token used by the contract module's selectors", () => {
    const entry = Object.entries(sources).find(([path]) =>
      normalizePath(path).endsWith(CONTRACT_MODULE_PATH),
    );
    expect(entry).toBeDefined();
    const offenders: string[] = [];
    for (const declaration of (entry?.[1] ?? "").matchAll(/^export const (\w+)[\s\S]*?;$/gm)) {
      const [statement, name] = declaration;
      for (const literal of (statement ?? "").matchAll(/(['"`])((?:(?!\1)[^\\])*)\1/g)) {
        const value = literal[2] ?? "";
        if (value.includes("${") || !/[.#[]/.test(value)) continue;
        for (const missing of undeclared(value)) {
          offenders.push(`${name ?? "?"}: ${missing}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("declares every token used by a selector written directly in an adapter", () => {
    const offenders: string[] = [];
    for (const [path, text] of Object.entries(sources)) {
      if (normalizePath(path).endsWith(CONTRACT_MODULE_PATH)) continue;
      for (const { value, isClassName } of extractSelectorLiterals(text)) {
        for (const missing of undeclared(isClassName ? `.${value}` : value)) {
          offenders.push(`${normalizePath(path)}: ${missing}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps no token that nothing in the project uses", () => {
    const corpus = Object.values(projectSources).join("\n");
    const isUsed = (entry: ContractToken): boolean => {
      if (new RegExp(`(?<![\w-])${entry.token}(?![\w-])`).test(corpus)) return true;
      // An attribute the code reads through `dataset` never appears under its own name.
      const property = datasetProperty(entry.token);
      return property !== null && new RegExp(`dataset\.${property}(?![\w])`).test(corpus);
    };
    const unused = contract.tokens
      .filter((entry) => !isUsed(entry))
      .map((entry) => `${entry.kind} "${entry.token}"`);
    expect(unused).toEqual([]);
  });

  it("holds one well-formed entry per token", () => {
    const kinds: readonly TokenKind[] = ["class", "id", "attribute", "element"];
    const statuses: readonly TokenStatus[] = ["required", "legacy", "dynamic"];
    const keys = contract.tokens.map((entry) => `${entry.kind}:${entry.token}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const entry of contract.tokens) {
      expect(kinds).toContain(entry.kind);
      expect(statuses).toContain(entry.status);
      expect(entry.area).toBeTruthy();
      // A token upstream cannot be searched for literally is only trustworthy with its reason.
      if (entry.status !== "required") expect(entry.note).toBeTruthy();
    }
  });
});
