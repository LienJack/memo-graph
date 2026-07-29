import {
  lstat,
  mkdir,
  realpath,
} from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

import { canonicalSha256 } from "@memo-graph/contracts";

export type GraphPathLayout = {
  dataRoot: string;
  graphRoot: string;
  databasePath: string;
  databasePathHash: ReturnType<typeof canonicalSha256>;
  homePath: string;
  tempPath: string;
};

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

  const databasePath = join(canonicalGraphRoot, "ladybug.lbdb");
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
    homePath,
    tempPath,
  };
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
