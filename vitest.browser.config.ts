import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      {
        find: /^@memo-graph\/contracts\/workbench$/,
        replacement: fileURLToPath(
          new URL("./packages/contracts/src/workbench.ts", import.meta.url),
        ),
      },
      {
        find: /^@memo-graph\/contracts$/,
        replacement: fileURLToPath(
          new URL("./packages/contracts/src/index.ts", import.meta.url),
        ),
      },
    ],
  },
  test: {
    include: ["tests/browser/**/*.browser.test.tsx"],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: "chromium" }],
    },
  },
});
