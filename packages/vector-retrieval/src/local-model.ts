import { createHash } from "node:crypto";
import {
  lstat,
  readdir,
  readFile,
  realpath,
} from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import {
  VectorEmbeddingEpochSchema,
  type VectorEmbeddingEpoch,
} from "@memo-graph/contracts";

export type VerifiedLocalModelSnapshot = {
  epochId: VectorEmbeddingEpoch["epoch_id"];
  modelDirectory: string;
  files: ReadonlyArray<{
    path: VectorEmbeddingEpoch["model"]["files"][number]["path"];
    absolutePath: string;
    sha256: `sha256:${string}`;
    bytes: number;
  }>;
};

const QUALIFIED_MODEL_REVISION =
  "761b726dd34fb83930e26aab4e9ac3899aa1fa78";
const QUALIFIED_MODEL_HASHES = {
  "config.json":
    "sha256:cb99455288675345e1a4f411438d5d0adbba5fbd3a67ea4fb03c015433b996c1",
  "onnx/model_int8.onnx":
    "sha256:4d24e2bc01a447951524466ef533e52944bf48509e6552810bcee1a2711cb02c",
  "tokenizer.json":
    "sha256:0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39",
  "tokenizer_config.json":
    "sha256:a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b",
} as const;

function assertContained(root: string, candidate: string): void {
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    throw new Error("local model file escapes the snapshot root");
  }
}

async function collectSnapshotFiles(
  directory: string,
  prefix = "",
): Promise<string[]> {
  const paths: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const relativePath =
      prefix.length === 0
        ? entry.name
        : `${prefix}/${entry.name}`;
    const absolutePath = join(directory, entry.name);
    const status = await lstat(absolutePath);
    if (status.isSymbolicLink()) {
      throw new Error("local model snapshot cannot contain symlinks");
    }
    if (status.isDirectory()) {
      paths.push(
        ...await collectSnapshotFiles(
          absolutePath,
          relativePath,
        ),
      );
      continue;
    }
    if (!status.isFile()) {
      throw new Error("local model snapshot contains a non-file entry");
    }
    paths.push(relativePath);
  }
  return paths.sort();
}

export async function verifyLocalModelSnapshot(
  modelRootInput: string,
  epochInput: unknown,
): Promise<VerifiedLocalModelSnapshot> {
  const epoch = VectorEmbeddingEpochSchema.parse(epochInput);
  if (
    epoch.runtime.package_version !== "4.2.0" ||
    epoch.sqlite_binding.package_version !== "13.0.1" ||
    epoch.index.package_version !== "0.1.9" ||
    epoch.model.revision !== QUALIFIED_MODEL_REVISION ||
    epoch.model.files.some(
      (file) =>
        file.sha256 !== QUALIFIED_MODEL_HASHES[file.path],
    )
  ) {
    throw new Error("vector epoch does not match the qualified candidate");
  }
  const requestedRoot = resolve(modelRootInput);
  const rootStatus = await lstat(requestedRoot);
  if (rootStatus.isSymbolicLink() || !rootStatus.isDirectory()) {
    throw new Error("local model root must be a real directory");
  }
  const modelRoot = await realpath(requestedRoot);
  const modelDirectory = join(
    modelRoot,
    ...epoch.model.repository.split("/"),
  );
  const directoryStatus = await lstat(modelDirectory);
  if (directoryStatus.isSymbolicLink() || !directoryStatus.isDirectory()) {
    throw new Error("local model snapshot directory is invalid");
  }
  const canonicalModelDirectory = await realpath(modelDirectory);
  assertContained(modelRoot, canonicalModelDirectory);

  const expectedPaths = epoch.model.files
    .map((file) => file.path)
    .sort();
  const observedPaths = await collectSnapshotFiles(
    canonicalModelDirectory,
  );
  if (
    expectedPaths.length !== observedPaths.length ||
    expectedPaths.some(
      (path, index) => path !== observedPaths[index],
    )
  ) {
    throw new Error(
      "local model snapshot must contain exactly the four epoch files",
    );
  }

  const files = [];
  for (const expected of epoch.model.files) {
    const absolutePath = join(
      canonicalModelDirectory,
      ...expected.path.split("/"),
    );
    assertContained(canonicalModelDirectory, absolutePath);
    const status = await lstat(absolutePath);
    if (status.isSymbolicLink() || !status.isFile()) {
      throw new Error("local model snapshot contains an invalid file");
    }
    const bytes = await readFile(absolutePath);
    const sha256 =
      `sha256:${createHash("sha256").update(bytes).digest("hex")}` as const;
    if (sha256 !== expected.sha256) {
      throw new Error("local model snapshot identity mismatch");
    }
    files.push({
      path: expected.path,
      absolutePath,
      sha256,
      bytes: status.size,
    });
  }
  return {
    epochId: epoch.epoch_id,
    modelDirectory: canonicalModelDirectory,
    files,
  };
}
