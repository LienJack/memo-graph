import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("storage package migrations", () => {
  it("ships an exact package-local copy of every canonical migration", () => {
    const canonicalRoot = join(process.cwd(), "migrations");
    const packageRoot = join(
      process.cwd(),
      "packages",
      "storage-sqlite",
      "migrations",
    );
    const canonicalNames = readdirSync(canonicalRoot).sort();

    expect(readdirSync(packageRoot).sort()).toEqual(canonicalNames);
    for (const name of canonicalNames) {
      expect(readFileSync(join(packageRoot, name))).toEqual(
        readFileSync(join(canonicalRoot, name)),
      );
    }
  });
});
