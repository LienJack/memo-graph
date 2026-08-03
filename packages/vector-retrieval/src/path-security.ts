import {
  lstat,
  mkdir,
  realpath,
} from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

import {
  ScopeSchema,
  canonicalSha256,
  scopeKey,
} from "@memo-graph/contracts";
import { z } from "zod";

export const VECTOR_PROCESS_TRUST_BOUNDARY =
  "The child provides availability and crash containment for trusted native dependencies; it is not an OS sandbox or a boundary against malicious package code.";

export type VectorPathLayout = {
  dataRoot: string;
  vectorRoot: string;
  scopeRoot: string;
  databasePath: string;
  databasePathHash: ReturnType<typeof canonicalSha256>;
  modelRoot: string;
  homePath: string;
  tempPath: string;
};

async function rejectSymlink(path: string): Promise<void> {
  try {
    if ((await lstat(path)).isSymbolicLink()) {
      throw new Error(`vector path cannot be a symbolic link: ${path}`);
    }
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
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
    throw new Error("vector path escapes its canonical root");
  }
}

export async function prepareVectorPaths(input: {
  dataRoot: string;
  modelRoot: string;
  principalId: string;
  scope: z.input<typeof ScopeSchema>;
}): Promise<VectorPathLayout> {
  const requestedDataRoot = resolve(input.dataRoot);
  const requestedModelRoot = resolve(input.modelRoot);
  await rejectSymlink(requestedDataRoot);
  await rejectSymlink(requestedModelRoot);
  await Promise.all([
    mkdir(requestedDataRoot, { recursive: true }),
    mkdir(requestedModelRoot, { recursive: true }),
  ]);
  const [dataRoot, modelRoot] = await Promise.all([
    realpath(requestedDataRoot),
    realpath(requestedModelRoot),
  ]);
  const scope = ScopeSchema.parse(input.scope);
  const principalId = z
    .string()
    .trim()
    .min(1)
    .max(200)
    .parse(input.principalId);

  const derivedRoot = join(dataRoot, "derived");
  const vectorRoot = join(derivedRoot, "vector");
  for (const path of [derivedRoot, vectorRoot]) {
    await rejectSymlink(path);
    await mkdir(path, { recursive: true });
    assertContained(dataRoot, await realpath(path));
  }
  const scopeIdentity = canonicalSha256({
    principal_id: principalId,
    scope_key: scopeKey(scope),
  }).slice("sha256:".length);
  const scopeRoot = join(vectorRoot, "scopes", scopeIdentity);
  await rejectSymlink(dirname(scopeRoot));
  await mkdir(dirname(scopeRoot), { recursive: true });
  await rejectSymlink(scopeRoot);
  await mkdir(scopeRoot, { recursive: true });
  const canonicalScopeRoot = await realpath(scopeRoot);
  assertContained(dataRoot, canonicalScopeRoot);
  const databasePath = join(canonicalScopeRoot, "vectors.db");
  await rejectSymlink(databasePath);

  const homePath = join(vectorRoot, "home");
  const tempPath = join(vectorRoot, "tmp");
  for (const path of [homePath, tempPath]) {
    await rejectSymlink(path);
    await mkdir(path, { recursive: true });
    assertContained(dataRoot, await realpath(path));
  }

  return {
    dataRoot,
    vectorRoot: await realpath(vectorRoot),
    scopeRoot: canonicalScopeRoot,
    databasePath,
    databasePathHash: canonicalSha256({
      relative_database_path: databasePath.slice(dataRoot.length + 1),
    }),
    modelRoot,
    homePath,
    tempPath,
  };
}

export async function createVectorChildEnvironment(options: {
  dataRoot: string;
  source?: NodeJS.ProcessEnv;
}): Promise<NodeJS.ProcessEnv> {
  const source = options.source ?? process.env;
  const requestedDataRoot = resolve(options.dataRoot);
  await rejectSymlink(requestedDataRoot);
  await mkdir(requestedDataRoot, { recursive: true });
  const dataRoot = await realpath(requestedDataRoot);
  const homePath = join(dataRoot, "derived", "vector", "home");
  const tempPath = join(dataRoot, "derived", "vector", "tmp");
  await Promise.all([
    mkdir(homePath, { recursive: true }),
    mkdir(tempPath, { recursive: true }),
  ]);
  const environment: NodeJS.ProcessEnv = {
    PATH: dirname(process.execPath),
    HOME: homePath,
    TMPDIR: tempPath,
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
