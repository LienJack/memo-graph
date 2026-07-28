import {
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import process from "node:process";

const acceptedCommit = "31959fc841ddc95f7570e5e0f2028a1e6b00243e";
const repositoryRoot = realpathSync(
  resolve(dirname(fileURLToPath(import.meta.url)), ".."),
);
const temporaryParent = realpathSync(
  mkdtempSync(join(realpathSync(tmpdir()), "memo-graph-g3-m2-")),
);
const checkout = join(temporaryParent, "checkout");

function run(command, args, options = {}) {
  execFileSync(command, args, {
    cwd: repositoryRoot,
    stdio: "inherit",
    ...options,
  });
}

let registeredWorktree = false;
try {
  run("git", ["worktree", "add", "--detach", checkout, acceptedCommit]);
  registeredWorktree = true;
  run(
    "pnpm",
    ["install", "--offline", "--frozen-lockfile", "--ignore-scripts"],
    { cwd: checkout },
  );
  run(
    "pnpm",
    ["--filter", "@memo-graph/contracts", "build"],
    { cwd: checkout },
  );
  run(
    "pnpm",
    ["--filter", "@memo-graph/context-compiler", "build"],
    { cwd: checkout },
  );
  run(
    "pnpm",
    [
      "exec",
      "vitest",
      "run",
      "tests/replay/layered-context-replay.test.ts",
    ],
    {
      env: {
        ...process.env,
        G3_ACCEPTED_M2_COMPILER_MODULE: join(
          checkout,
          "packages/context-compiler/dist/index.js",
        ),
      },
    },
  );
} finally {
  if (registeredWorktree) {
    try {
      run("git", ["worktree", "remove", "--force", checkout]);
    } catch {
      // The explicit temporary path is removed below as a final fallback.
    }
  }
  if (
    temporaryParent.startsWith(
      `${realpathSync(tmpdir())}/memo-graph-g3-m2-`,
    )
  ) {
    rmSync(temporaryParent, { recursive: true, force: true });
  }
}
