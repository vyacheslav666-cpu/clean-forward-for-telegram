/** Configures the two distributions built from one entry: a Tampermonkey userscript and an MV3 extension. */
import { defineConfig, type Plugin } from "vite";
import packageMetadata from "./package.json";

const USERSCRIPT_FILE_NAME = "clean-forward-for-telegram.user.js";
const CONTENT_SCRIPT_FILE_NAME = "content-script.js";
const ICON_FILE_NAME = "icon-128.png";
const TELEGRAM_MATCH = "https://web.telegram.org/k/*";

const TAMPERMONKEY_HEADER = `// ==UserScript==
// @name         Clean Forward for Telegram
// @namespace    https://github.com/clean-forward-for-telegram
// @version      ${packageMetadata.version}
// @description  Sends copied Telegram messages as new messages to selected chats.
// @match        ${TELEGRAM_MATCH}
// @grant        none
// @run-at       document-start
// ==/UserScript==`;

/**
 * Adds metadata in generateBundle because Vite's final code transform may discard Rollup banners.
 */
function tampermonkeyHeaderPlugin(): Plugin {
  return {
    name: "tampermonkey-header",
    apply: "build",
    generateBundle(_options, bundle) {
      const userscript = bundle[USERSCRIPT_FILE_NAME];
      if (userscript?.type === "chunk") {
        userscript.code = `${TAMPERMONKEY_HEADER}\n${userscript.code}`;
      }
    },
  };
}

/**
 * Emits the MV3 manifest beside the content script.
 *
 * `world: "MAIN"` is not a preference. The album bridge reads `apiManagerProxy` off the page's own
 * global (`src/telegram/TelegramModelBridge.ts`), and an isolated content-script world has a
 * different global object — there the bridge would find nothing and every album would silently fall
 * back to the "needs a verified grouped_id" refusal, which looks like a broken feature rather than
 * a missing permission. `document_start` and the match pattern mirror the userscript header so both
 * distributions load at the same moment on the same pages.
 *
 * No `permissions` are declared: the code only touches the DOM of the page it is injected into and
 * talks to no other origin, and a content script needs no permission for that — `matches` is what
 * grants the injection.
 */
function extensionManifestPlugin(): Plugin {
  return {
    name: "extension-manifest",
    apply: "build",
    generateBundle() {
      const manifest = {
        manifest_version: 3,
        name: "Clean Forward for Telegram",
        description: "Sends copied Telegram messages as new messages to selected chats.",
        version: packageMetadata.version,
        icons: { "128": ICON_FILE_NAME },
        content_scripts: [
          {
            matches: [TELEGRAM_MATCH],
            js: [CONTENT_SCRIPT_FILE_NAME],
            run_at: "document_start",
            world: "MAIN",
          },
        ],
      };
      this.emitFile({
        type: "asset",
        fileName: "manifest.json",
        source: `${JSON.stringify(manifest, null, 2)}\n`,
      });
    },
  };
}

/**
 * One entry, two wrappers.
 *
 * The target is selected by Vite's own `mode` rather than an environment variable so this file
 * needs no Node globals, and therefore no `@types/node` for a config that only describes a bundle.
 * Nothing under `src/` reads `import.meta.env`, so a non-production mode name cannot change what is
 * built — only which wrapper is put around it.
 */
export default defineConfig(({ mode }) => {
  const isExtension = mode === "extension";
  return {
    plugins: [isExtension ? extensionManifestPlugin() : tampermonkeyHeaderPlugin()],
    // Copied verbatim into `dist/`, which is how the icon reaches the packed extension.
    publicDir: isExtension ? "assets" : false,
    build: {
      // Only the first pass clears `dist/`; the second adds its distribution to what is there.
      emptyOutDir: !isExtension,
      minify: false,
      sourcemap: false,
      target: "es2020",
      lib: {
        entry: "src/main.ts",
        formats: ["iife" as const],
        name: "CleanForwardForTelegram",
        fileName: () => (isExtension ? CONTENT_SCRIPT_FILE_NAME : USERSCRIPT_FILE_NAME),
      },
      rollupOptions: {
        output: {
          inlineDynamicImports: true,
        },
      },
    },
  };
});
