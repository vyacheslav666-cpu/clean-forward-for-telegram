import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Spread the defaults rather than replacing them: assigning `exclude` overrides vitest's own
    // list, which is what keeps `node_modules` and `dist` out of a run.
    //
    // `.claude/worktrees` holds checkouts of this same repository made by other sessions. Their
    // copies of these test files match the default include glob, so a run picks up a second,
    // divergent suite and reports failures that belong to code nobody is editing here.
    exclude: [...configDefaults.exclude, "**/.claude/**"],
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
    clearMocks: true,
    restoreMocks: true,
  },
});
