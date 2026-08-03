import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  CanonicalHashSchema,
  G3OverlayCaseSchema,
  G3OverlayManifestSchema,
  ReplayCaseBodySchema,
  ReplayManifestSchema,
  canonicalSha256,
  type EvaluationPartition,
  type G3OverlayCase,
  type G3OverlayDescriptor,
  type G3OverlayManifest,
  type ReplayCaseBody,
  type ReplayCaseDescriptor,
} from "../../packages/contracts/src/index.js";
import {
  CompileContextResultSchema,
} from "../../packages/context-compiler/src/index.js";
import {
  G3_ACCEPTED_M2_COMMIT,
  G3_ACCEPTED_M2_LOCK_HASH,
  runG3ReplayCase,
  type G3BaselineCompiler,
} from "../../packages/memory-kernel/src/index.js";

const repositoryRoot = fileURLToPath(
  new URL("../../", import.meta.url),
);
const replayRoot = resolve(repositoryRoot, "fixtures/replay");
const g3Root = resolve(repositoryRoot, "fixtures/g3");

export const G3_BASE_MANIFEST_RAW_SHA256 =
  "sha256:8827b6fd6f1db6df8643faa46cdd5ce1008c10cca092fada555e3896cd7804e3";

export type LoadedG3Case = {
  base_descriptor: ReplayCaseDescriptor;
  overlay_descriptor: G3OverlayDescriptor;
  base: ReplayCaseBody;
  overlay: G3OverlayCase;
};

function rawSha256(value: string | Buffer) {
  return CanonicalHashSchema.parse(
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
  );
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

function assertInside(
  root: string,
  path: string,
  label: string,
): void {
  if (!path.startsWith(`${root}${sep}`)) {
    throw new Error(`${label} escaped its declared partition`);
  }
}

export async function loadG3Manifest(): Promise<{
  base: ReturnType<typeof ReplayManifestSchema.parse>;
  overlay: G3OverlayManifest;
}> {
  const baseManifestPath = resolve(replayRoot, "manifest.json");
  const rawBase = await readFile(baseManifestPath);
  if (rawSha256(rawBase) !== G3_BASE_MANIFEST_RAW_SHA256) {
    throw new Error("frozen M0 replay manifest bytes changed");
  }
  const base = ReplayManifestSchema.parse(
    JSON.parse(rawBase.toString("utf8")) as unknown,
  );
  const overlay = G3OverlayManifestSchema.parse(
    await readJson(resolve(g3Root, "manifest.json")),
  );
  if (canonicalSha256(base) !== overlay.base_manifest_hash) {
    throw new Error("G3 overlay references a different M0 manifest");
  }
  return { base, overlay };
}

export async function loadG3Partition(
  partition: EvaluationPartition,
): Promise<LoadedG3Case[]> {
  const manifests = await loadG3Manifest();
  const basePartitionRoot = resolve(replayRoot, partition);
  const overlayPartitionRoot = resolve(g3Root, "overlays", partition);
  const loaded: LoadedG3Case[] = [];

  for (const overlayDescriptor of manifests.overlay.cases.filter(
    (entry) => entry.partition === partition,
  )) {
    const baseDescriptor = manifests.base.cases.find(
      (entry) => entry.case_id === overlayDescriptor.case_id,
    );
    if (baseDescriptor === undefined) {
      throw new Error(
        `G3 case ${overlayDescriptor.case_id} lacks an M0 descriptor`,
      );
    }
    const basePath = resolve(replayRoot, baseDescriptor.body_file);
    const overlayPath = resolve(g3Root, overlayDescriptor.overlay_file);
    assertInside(
      basePartitionRoot,
      basePath,
      `M0 case ${baseDescriptor.case_id}`,
    );
    assertInside(
      overlayPartitionRoot,
      overlayPath,
      `G3 case ${overlayDescriptor.case_id}`,
    );
    const base = ReplayCaseBodySchema.parse(await readJson(basePath));
    const overlay = G3OverlayCaseSchema.parse(
      await readJson(overlayPath),
    );
    if (
      base.case_id !== overlay.case_id ||
      base.partition !== overlay.partition ||
      canonicalSha256(base) !== baseDescriptor.content_hash ||
      baseDescriptor.content_hash !== overlayDescriptor.base_case_hash ||
      overlay.base_case_hash !== overlayDescriptor.base_case_hash ||
      canonicalSha256(overlay) !== overlayDescriptor.content_hash
    ) {
      throw new Error(
        `G3 case ${overlayDescriptor.case_id} failed immutable binding`,
      );
    }
    loaded.push({
      base_descriptor: baseDescriptor,
      overlay_descriptor: overlayDescriptor,
      base,
      overlay,
    });
  }
  return loaded;
}

export async function loadAllG3Cases(): Promise<LoadedG3Case[]> {
  const partitions = [
    "calibration",
    "holdout",
    "transfer",
  ] satisfies EvaluationPartition[];
  return (
    await Promise.all(
      partitions.map((partition) => loadG3Partition(partition)),
    )
  ).flat();
}

export function externalBaselineCompiler(
  modulePath: string,
): G3BaselineCompiler {
  return (input) =>
    new Promise((resolveResult, reject) => {
      const script = `
        import { pathToFileURL } from "node:url";
        let payload = "";
        process.stdin.setEncoding("utf8");
        for await (const chunk of process.stdin) payload += chunk;
        const module = await import(pathToFileURL(process.env.G3_COMPILER_MODULE).href);
        const input = JSON.parse(payload);
        delete input.request.lane_overrides;
        process.stdout.write(JSON.stringify(module.compileContext(input)));
      `;
      const child = spawn(
        process.execPath,
        ["--input-type=module", "--eval", script],
        {
          env: {
            ...process.env,
            G3_COMPILER_MODULE: modulePath,
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) {
          reject(
            new Error(
              `accepted M2 compiler failed (${code ?? "signal"}): ${stderr}`,
            ),
          );
          return;
        }
        try {
          resolveResult(
            CompileContextResultSchema.parse(
              JSON.parse(stdout) as unknown,
            ),
          );
        } catch (error) {
          reject(error);
        }
      });
      child.stdin.end(JSON.stringify(input));
    });
}

export async function runThreeArms(
  loaded: LoadedG3Case,
  tokenBudget: number,
  options: {
    implementationCommit: string;
    dependencyLockHash: ReturnType<typeof CanonicalHashSchema.parse>;
    acceptedCompiler?: G3BaselineCompiler;
  },
) {
  const common = {
    base: loaded.base,
    overlay: loaded.overlay,
    overlay_hash: loaded.overlay_descriptor.content_hash,
    token_budget: tokenBudget,
  } as const;
  const accepted = await runG3ReplayCase({
    ...common,
    arm: "accepted_m2",
    implementation_commit: G3_ACCEPTED_M2_COMMIT,
    dependency_lock_hash: CanonicalHashSchema.parse(
      G3_ACCEPTED_M2_LOCK_HASH,
    ),
    ...(options.acceptedCompiler === undefined
      ? {}
      : { baseline_compiler: options.acceptedCompiler }),
  });
  const noProjection = await runG3ReplayCase({
    ...common,
    arm: "m3_no_projection",
    implementation_commit: options.implementationCommit,
    dependency_lock_hash: options.dependencyLockHash,
  });
  const layered = await runG3ReplayCase({
    ...common,
    arm: "m3_layered",
    implementation_commit: options.implementationCommit,
    dependency_lock_hash: options.dependencyLockHash,
  });
  return { accepted, noProjection, layered };
}

export async function currentDependencyLockHash() {
  return rawSha256(await readFile(resolve(repositoryRoot, "pnpm-lock.yaml")));
}
