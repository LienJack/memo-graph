import { chmodSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
/* global process */

import { spawnSync } from "node:child_process";

const directory = dirname(fileURLToPath(import.meta.url));
const source = join(directory, "rename-noreplace.c");
const output = join(directory, "rename-noreplace");

if (process.platform !== "darwin") {
  if (existsSync(output)) {
    rmSync(output);
  }
  process.exit(0);
}

const result = spawnSync(
  process.env.CC ?? "cc",
  ["-std=c11", "-Wall", "-Wextra", "-Werror", "-O2", source, "-o", output],
  { stdio: "inherit" },
);
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
chmodSync(output, 0o755);
