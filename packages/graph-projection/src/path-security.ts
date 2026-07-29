import {
  open,
  readFile,
  rename,
  lstat,
  mkdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

import {
  canonicalJson,
  canonicalSha256,
} from "@memo-graph/contracts";

export type GraphPathLayout = {
  dataRoot: string;
  graphRoot: string;
  databasePath: string;
  databasePathHash: ReturnType<typeof canonicalSha256>;
  generationId: string | null;
  activeManifestPath: string;
  homePath: string;
  tempPath: string;
};

export type GraphActiveGenerationManifest = {
  schema_version: "1.0.0";
  generation_id: string;
  global_logical_digest: string;
  published_at: string;
};

const GENERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u;
const CANONICAL_HASH_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const ACTIVE_MANIFEST_NAME = "active-generation.json";

function validateGenerationId(input: string): string {
  if (!GENERATION_ID_PATTERN.test(input)) {
    throw new Error("graph generation identity is invalid");
  }
  return input;
}

function parseActiveManifest(input: unknown): GraphActiveGenerationManifest {
  if (
    typeof input !== "object" ||
    input === null ||
    !("schema_version" in input) ||
    input.schema_version !== "1.0.0" ||
    !("generation_id" in input) ||
    typeof input.generation_id !== "string" ||
    !("global_logical_digest" in input) ||
    typeof input.global_logical_digest !== "string" ||
    !CANONICAL_HASH_PATTERN.test(input.global_logical_digest) ||
    !("published_at" in input) ||
    typeof input.published_at !== "string" ||
    !Number.isFinite(Date.parse(input.published_at))
  ) {
    throw new Error("graph active generation manifest is invalid");
  }
  return {
    schema_version: "1.0.0",
    generation_id: validateGenerationId(input.generation_id),
    global_logical_digest: input.global_logical_digest,
    published_at: input.published_at,
  };
}

async function readManifest(
  path: string,
): Promise<GraphActiveGenerationManifest | null> {
  try {
    return parseActiveManifest(
      JSON.parse(await readFile(path, "utf8")) as unknown,
    );
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}

async function rejectFinalSymlink(path: string): Promise<void> {
  try {
    const status = await lstat(path);
    if (status.isSymbolicLink()) {
      throw new Error(`graph path cannot be a symbolic link: ${path}`);
    }
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }
}

function assertContained(root: string, candidate: string): void {
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    throw new Error("graph path escapes the canonical data root");
  }
}

export async function prepareGraphDatabasePath(
  dataRootInput: string,
  options: {
    generationId?: string;
  } = {},
): Promise<GraphPathLayout> {
  const requestedRoot = resolve(dataRootInput);
  await mkdir(requestedRoot, { recursive: true });
  await rejectFinalSymlink(requestedRoot);
  const dataRoot = await realpath(requestedRoot);

  const derivedRoot = join(dataRoot, "derived");
  await rejectFinalSymlink(derivedRoot);
  await mkdir(derivedRoot, { recursive: true });
  const graphRoot = join(derivedRoot, "graph");
  await rejectFinalSymlink(graphRoot);
  await mkdir(graphRoot, { recursive: true });
  const canonicalGraphRoot = await realpath(graphRoot);
  assertContained(dataRoot, canonicalGraphRoot);

  const activeManifestPath = join(
    canonicalGraphRoot,
    ACTIVE_MANIFEST_NAME,
  );
  await rejectFinalSymlink(activeManifestPath);
  const activeManifest =
    options.generationId === undefined
      ? await readManifest(activeManifestPath)
      : null;
  const generationId =
    options.generationId === undefined
      ? activeManifest?.generation_id ?? null
      : validateGenerationId(options.generationId);
  const databaseParent =
    generationId === null
      ? canonicalGraphRoot
      : join(canonicalGraphRoot, "generations", generationId);
  await rejectFinalSymlink(databaseParent);
  await mkdir(databaseParent, { recursive: true });
  const canonicalDatabaseParent = await realpath(databaseParent);
  assertContained(dataRoot, canonicalDatabaseParent);
  const databasePath = join(canonicalDatabaseParent, "ladybug.lbdb");
  await rejectFinalSymlink(databasePath);
  assertContained(dataRoot, databasePath);

  const homePath = join(canonicalGraphRoot, "home");
  const tempPath = join(canonicalGraphRoot, "tmp");
  await Promise.all([
    mkdir(homePath, { recursive: true }),
    mkdir(tempPath, { recursive: true }),
  ]);
  for (const path of [homePath, tempPath]) {
    await rejectFinalSymlink(path);
    assertContained(dataRoot, await realpath(path));
  }

  return {
    dataRoot,
    graphRoot: canonicalGraphRoot,
    databasePath,
    databasePathHash: canonicalSha256({
      data_root: dataRoot,
      relative_database_path:
        databasePath.slice(dataRoot.length + 1),
    }),
    generationId,
    activeManifestPath,
    homePath,
    tempPath,
  };
}

export async function readActiveGraphGeneration(
  dataRoot: string,
): Promise<GraphActiveGenerationManifest | null> {
  const layout = await prepareGraphDatabasePath(dataRoot);
  return readManifest(layout.activeManifestPath);
}

export async function publishGraphGeneration(options: {
  dataRoot: string;
  generationId: string;
  globalLogicalDigest: string;
  publishedAt: string;
}): Promise<GraphActiveGenerationManifest> {
  const generationId = validateGenerationId(options.generationId);
  if (!CANONICAL_HASH_PATTERN.test(options.globalLogicalDigest)) {
    throw new Error("graph global logical digest is invalid");
  }
  if (!Number.isFinite(Date.parse(options.publishedAt))) {
    throw new Error("graph generation publication time is invalid");
  }
  const layout = await prepareGraphDatabasePath(options.dataRoot, {
    generationId,
  });
  await lstat(layout.databasePath);
  const manifest = parseActiveManifest({
    schema_version: "1.0.0",
    generation_id: generationId,
    global_logical_digest: options.globalLogicalDigest,
    published_at: options.publishedAt,
  });
  const temporaryPath = join(
    layout.graphRoot,
    `.active-generation-${randomUUID()}.tmp`,
  );
  await writeFile(temporaryPath, canonicalJson(manifest), {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  const temporaryHandle = await open(temporaryPath, "r");
  try {
    await temporaryHandle.sync();
  } finally {
    await temporaryHandle.close();
  }
  await rename(temporaryPath, layout.activeManifestPath);
  const graphRootHandle = await open(layout.graphRoot, "r");
  try {
    await graphRootHandle.sync();
  } finally {
    await graphRootHandle.close();
  }
  return manifest;
}

export async function quarantineGraphGeneration(options: {
  dataRoot: string;
  generationId: string;
  reasonCode: string;
}): Promise<string> {
  const generationId = validateGenerationId(options.generationId);
  const active = await readActiveGraphGeneration(options.dataRoot);
  if (active?.generation_id === generationId) {
    throw new Error("active graph generation cannot be quarantined");
  }
  const layout = await prepareGraphDatabasePath(options.dataRoot, {
    generationId,
  });
  const source = dirname(layout.databasePath);
  const quarantineRoot = join(layout.graphRoot, "quarantine");
  await rejectFinalSymlink(quarantineRoot);
  await mkdir(quarantineRoot, { recursive: true });
  const target = join(
    quarantineRoot,
    `${generationId}-${canonicalSha256({
      reason_code: options.reasonCode,
    }).slice("sha256:".length, 23)}`,
  );
  assertContained(layout.dataRoot, target);
  await rename(source, target);
  return target;
}

export async function createGraphChildEnvironment(options: {
  dataRoot: string;
  source?: NodeJS.ProcessEnv;
}): Promise<NodeJS.ProcessEnv> {
  const source = options.source ?? process.env;
  const layout = await prepareGraphDatabasePath(options.dataRoot);
  const environment: NodeJS.ProcessEnv = {
    PATH: dirname(process.execPath),
    HOME: layout.homePath,
    TMPDIR: layout.tempPath,
  };
  for (const key of ["LANG", "LC_ALL", "TZ"] as const) {
    const value = source[key];
    if (
      value !== undefined &&
      /^[A-Za-z0-9_./:+-]{1,120}$/u.test(value)
    ) {
      environment[key] = value;
    }
  }
  return environment;
}
