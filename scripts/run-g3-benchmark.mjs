import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import process from "node:process";

import {
  CanonicalHashSchema,
  G3OverlayCaseSchema,
  G3OverlayManifestSchema,
  ReplayCaseBodySchema,
  ReplayManifestSchema,
  canonicalSha256,
} from "../packages/contracts/dist/index.js";
import {
  benchmarkG3ReplayCase,
} from "../packages/memory-kernel/dist/index.js";

const repositoryRoot = resolve(import.meta.dirname, "..");
const profile =
  process.argv.slice(2).find((argument) => argument !== "--") ?? "small";
if (profile !== "small" && profile !== "expected") {
  throw new Error("G3 benchmark profile must be small or expected");
}
const baseManifest = ReplayManifestSchema.parse(
  JSON.parse(
    readFileSync(
      join(repositoryRoot, "fixtures/replay/manifest.json"),
      "utf8",
    ),
  ),
);
const overlayManifest = G3OverlayManifestSchema.parse(
  JSON.parse(
    readFileSync(
      join(repositoryRoot, "fixtures/g3/manifest.json"),
      "utf8",
    ),
  ),
);
const overlayDescriptor = overlayManifest.cases.find(
  (entry) => entry.case_id === "hold_multi_hop_lineage",
);
const baseDescriptor = baseManifest.cases.find(
  (entry) => entry.case_id === "hold_multi_hop_lineage",
);
if (overlayDescriptor === undefined || baseDescriptor === undefined) {
  throw new Error("G3 multi-hop benchmark fixture is missing");
}
const base = ReplayCaseBodySchema.parse(
  JSON.parse(
    readFileSync(
      join(
        repositoryRoot,
        "fixtures/replay",
        baseDescriptor.body_file,
      ),
      "utf8",
    ),
  ),
);
const overlay = G3OverlayCaseSchema.parse(
  JSON.parse(
    readFileSync(
      join(
        repositoryRoot,
        "fixtures/g3",
        overlayDescriptor.overlay_file,
      ),
      "utf8",
    ),
  ),
);
if (
  canonicalSha256(base) !== overlayDescriptor.base_case_hash ||
  canonicalSha256(overlay) !== overlayDescriptor.content_hash
) {
  throw new Error("G3 benchmark fixture hash mismatch");
}
const implementationCommit = execFileSync(
  "git",
  ["rev-parse", "HEAD"],
  { cwd: repositoryRoot, encoding: "utf8" },
).trim();
const dependencyLockHash = CanonicalHashSchema.parse(
  `sha256:${createHash("sha256")
    .update(readFileSync(join(repositoryRoot, "pnpm-lock.yaml")))
    .digest("hex")}`,
);
const report = await benchmarkG3ReplayCase(
  {
    arm: "m3_layered",
    base,
    overlay,
    overlay_hash: overlayDescriptor.content_hash,
    token_budget: 1_800,
    implementation_commit: implementationCommit,
    dependency_lock_hash: dependencyLockHash,
  },
  profile,
);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
