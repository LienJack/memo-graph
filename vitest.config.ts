import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Several recovery Oracles intentionally exercise SQLite and isolated
    // child processes under 50-100 ms deadlines. Bounding file workers keeps
    // the suite itself from becoming an unrelated resource-exhaustion test;
    // the dedicated G4B resource benchmark owns saturation measurements.
    maxWorkers: 4,
    testTimeout: 15_000,
    coverage: {
      include: ["packages/*/src/**/*.ts"],
    },
  },
});
