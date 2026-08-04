#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const workspaceRoot = realpathSync(
  resolve(dirname(fileURLToPath(import.meta.url)), ".."),
);

function pnpmCommand(nodeExecutable = process.execPath) {
  const entry = process.env.npm_execpath;
  if (entry !== undefined && isAbsolute(entry) && existsSync(entry)) {
    return { command: nodeExecutable, prefix: [entry] };
  }
  return { command: "pnpm", prefix: [] };
}

function runPnpm(args, options = {}) {
  const pnpm = pnpmCommand(options.nodeExecutable);
  const result = spawnSync(pnpm.command, [...pnpm.prefix, ...args], {
    cwd: workspaceRoot,
    env: options.install
      ? { ...process.env, CI: process.env.CI ?? "true" }
      : process.env,
    stdio: "inherit",
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const installerArguments = process.argv.slice(2);
if (installerArguments[0] === "--") {
  installerArguments.shift();
}

runPnpm(["install", "--frozen-lockfile"], { install: true });
const managedNode = realpathSync(
  resolve(workspaceRoot, "node_modules", "node", "bin", "node"),
);
runPnpm([
  "run",
  "codex:install:prepared",
  ...installerArguments,
], { nodeExecutable: managedNode });
