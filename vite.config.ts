/** Configures the single-file Tampermonkey bundle and its metadata header. */
import { defineConfig, type Plugin } from "vite";

const USERSCRIPT_FILE_NAME = "clean-forward-for-telegram.user.js";

const TAMPERMONKEY_HEADER = `// ==UserScript==
// @name         Clean Forward for Telegram
// @namespace    https://github.com/clean-forward-for-telegram
// @version      0.1.0
// @description  Sends copied Telegram messages as new messages to selected chats.
// @match        https://web.telegram.org/k/*
// @grant        none
// @run-at       document-idle
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

export default defineConfig({
  plugins: [tampermonkeyHeaderPlugin()],
  build: {
    emptyOutDir: true,
    minify: false,
    sourcemap: false,
    target: "es2020",
    lib: {
      entry: "src/main.ts",
      formats: ["iife"],
      name: "CleanForwardForTelegram",
      fileName: () => USERSCRIPT_FILE_NAME,
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
});
