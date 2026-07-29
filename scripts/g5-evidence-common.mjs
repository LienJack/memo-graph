import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

import {
  canonicalSha256,
} from "../packages/contracts/dist/index.js";

export const repositoryRoot = resolve(import.meta.dirname, "..");
export const G5_RECORDED_AT = "2026-07-30T02:20:00.000+08:00";
export const G5_SCORER_ID = "g5-d5-conjunctive-scorer@1.0.0";
export const G5_SEED = 7;

export function rawSha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function read(relativePath) {
  return readFileSync(resolve(repositoryRoot, relativePath));
}

export function readJson(relativePath) {
  return JSON.parse(read(relativePath).toString("utf8"));
}

export function git(...args) {
  return execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
}

export function implementationIdentity() {
  const commit = git("rev-parse", "HEAD");
  return {
    commit,
    tree: git("rev-parse", `${commit}^{tree}`),
    dependency_lock_hash: rawSha256(read("pnpm-lock.yaml")),
  };
}

export function migrationIdentity() {
  const files = readdirSync(resolve(repositoryRoot, "migrations"))
    .filter((entry) => entry.endsWith(".sql"))
    .sort();
  const bindings = files.map((path) => ({
    path: `migrations/${path}`,
    raw_hash: rawSha256(read(`migrations/${path}`)),
  }));
  return {
    latest: files.at(-1),
    files: bindings,
    migration_set_hash: canonicalSha256(bindings),
  };
}

export function runtimeIdentity() {
  const identity = implementationIdentity();
  const migration = migrationIdentity();
  const fixtureManifest = readJson("fixtures/g5/manifest.json");
  return {
    implementation_commit: identity.commit,
    implementation_tree: identity.tree,
    dependency_lock_hash: identity.dependency_lock_hash,
    migration_set_hash: migration.migration_set_hash,
    runtime_identity_hash: canonicalSha256({
      node: process.versions.node,
      platform: process.platform,
      architecture: process.arch,
      implementation_tree: identity.tree,
      migration_set_hash: migration.migration_set_hash,
    }),
    corpus_hash: canonicalSha256(
      fixtureManifest.evaluation_cases,
    ),
    scorer_hash: canonicalSha256(G5_SCORER_ID),
    seed: G5_SEED,
    environment_hash: canonicalSha256({
      node: process.versions.node,
      platform: process.platform,
      architecture: process.arch,
      sqlite_binding: "better-sqlite3@13.0.1",
    }),
  };
}

export function environmentIdentity(sqliteVersion) {
  return {
    node: process.versions.node,
    pnpm: execFileSync("pnpm", ["--version"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    }).trim(),
    operating_system: execFileSync("uname", ["-a"], {
      encoding: "utf8",
    }).trim(),
    platform: process.platform,
    architecture: process.arch,
    sqlite: sqliteVersion,
  };
}

export function temporaryDataRoot(prefix) {
  return realpathSync(
    mkdtempSync(
      join(realpathSync(tmpdir()), `memo-graph-${prefix}-`),
    ),
  );
}

export function removeTemporaryRoot(path) {
  rmSync(path, { recursive: true, force: true });
}

export function sourceBinding(path, json = false) {
  const bytes = read(path);
  return {
    path,
    raw_hash: rawSha256(bytes),
    ...(json
      ? {
          canonical_hash: canonicalSha256(
            JSON.parse(bytes.toString("utf8")),
          ),
        }
      : {}),
  };
}

export function writeHashedReport(outputPath, body) {
  const report = {
    ...body,
    report_hash: canonicalSha256(body),
  };
  writeFileSync(
    resolve(repositoryRoot, outputPath),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  return report;
}

export function reportLogicalHash(report) {
  const logical = { ...report };
  Reflect.deleteProperty(logical, "recorded_at");
  Reflect.deleteProperty(logical, "report_hash");
  return canonicalSha256(logical);
}
