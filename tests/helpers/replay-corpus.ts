import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, sep } from "node:path";

import {
  ReplayCaseBodySchema,
  ReplayManifestSchema,
  type EvaluationPartition,
  type ReplayCaseBody,
  type ReplayManifest,
} from "../../packages/contracts/src/index.js";

const replayRoot = fileURLToPath(
  new URL("../../fixtures/replay/", import.meta.url),
);

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

export async function loadReplayManifest(): Promise<ReplayManifest> {
  return ReplayManifestSchema.parse(
    await readJson(resolve(replayRoot, "manifest.json")),
  );
}

export async function loadReplayPartition(
  partition: EvaluationPartition,
): Promise<ReplayCaseBody[]> {
  const manifest = await loadReplayManifest();
  const partitionRoot = resolve(replayRoot, partition);
  const bodies: ReplayCaseBody[] = [];

  for (const descriptor of manifest.cases.filter(
    (entry) => entry.partition === partition,
  )) {
    const bodyPath = resolve(replayRoot, descriptor.body_file);
    if (!bodyPath.startsWith(`${partitionRoot}${sep}`)) {
      throw new Error(
        `Replay case ${descriptor.case_id} escaped partition ${partition}`,
      );
    }
    bodies.push(ReplayCaseBodySchema.parse(await readJson(bodyPath)));
  }
  return bodies;
}
