import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statfsSync,
} from "node:fs";
import { platform } from "node:os";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

import {
  CanonicalHashSchema,
  PINNED_G6_RELEASE_CONTROL_TRUST,
  RuntimeIdentitySchema,
  canonicalSha256,
  type RuntimeIdentity,
  type RuntimeIdentityProvider,
  type RuntimePlatformIdentity,
} from "@memo-graph/contracts";

import {
  OperatorConfigError,
  type OperatorConfig,
} from "./config.js";

const MAX_RUNTIME_INPUT_BYTES = 128 * 1024 * 1024;

export type RuntimeInput =
  | { readonly path: string; readonly kind: "file" }
  | {
      readonly path: string;
      readonly kind: "tree";
      readonly suffixes: readonly string[];
      readonly excluded_segments: readonly string[];
    };

type SourceBinding = {
  path: string;
  raw_hash: `sha256:${string}`;
};

/**
 * This production-owned allowlist is the authority used at secret-admission
 * time. Evidence fixtures may repeat it, but operator configuration cannot
 * replace or narrow it.
 */
export const G6_RUNTIME_INPUTS = Object.freeze([
  {
    path: "packages",
    kind: "tree",
    suffixes: [".ts", ".js", ".json", ".node"],
    excluded_segments: ["node_modules"],
  },
  {
    path: "apps",
    kind: "tree",
    suffixes: [".ts", ".js", ".json", ".node"],
    excluded_segments: ["node_modules"],
  },
  {
    path: "migrations",
    kind: "tree",
    suffixes: [".sql"],
    excluded_segments: [],
  },
  {
    path: "tools/rename-noreplace",
    kind: "tree",
    suffixes: [".c", ".mjs"],
    excluded_segments: [],
  },
  { path: "tools/rename-noreplace/rename-noreplace", kind: "file" },
  { path: "package.json", kind: "file" },
  { path: "pnpm-lock.yaml", kind: "file" },
  { path: "pnpm-workspace.yaml", kind: "file" },
  { path: "tsconfig.base.json", kind: "file" },
  { path: "tsconfig.json", kind: "file" },
  { path: "eslint.config.js", kind: "file" },
  { path: "vitest.config.ts", kind: "file" },
  { path: "scripts/g6-evidence-common.mjs", kind: "file" },
  { path: "scripts/g6-evidence-common.d.mts", kind: "file" },
  { path: "scripts/g6-bootstrap.mjs", kind: "file" },
  { path: "scripts/g6-bootstrap.d.mts", kind: "file" },
  { path: "scripts/run-g6-fault-matrix.mjs", kind: "file" },
  { path: "scripts/run-g6-resource-report.mjs", kind: "file" },
  { path: "scripts/run-g6-runbooks.mjs", kind: "file" },
  { path: "scripts/build-g6-manifest.mjs", kind: "file" },
  { path: "scripts/build-g6-runtime-identity.mjs", kind: "file" },
  { path: "scripts/build-g6-runtime-identity.d.mts", kind: "file" },
  { path: "scripts/build-g6-release-control.mjs", kind: "file" },
  { path: "scripts/build-g6-release-control.d.mts", kind: "file" },
  { path: "scripts/verify-g6-evidence.mjs", kind: "file" },
  { path: "scripts/verify-g6-evidence.d.mts", kind: "file" },
] satisfies readonly RuntimeInput[]);

function rawSha256(bytes: Buffer): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function assertRelativeInputPath(path: string): void {
  if (
    path.length === 0 ||
    isAbsolute(path) ||
    path.includes("\\") ||
    path.split("/").includes("..")
  ) {
    throw new OperatorConfigError();
  }
}

function assertContained(root: string, candidate: string): void {
  const fromRoot = relative(root, candidate);
  if (
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  ) {
    throw new OperatorConfigError();
  }
}

function secureRead(root: string, relativePath: string): Buffer {
  assertRelativeInputPath(relativePath);
  const path = resolve(root, relativePath);
  assertContained(root, path);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const before = fstatSync(descriptor);
    const pathBefore = lstatSync(path);
    if (
      !before.isFile() ||
      pathBefore.isSymbolicLink() ||
      before.dev !== pathBefore.dev ||
      before.ino !== pathBefore.ino ||
      before.size < 0 ||
      before.size > MAX_RUNTIME_INPUT_BYTES ||
      realpathSync(path) !== path
    ) {
      throw new OperatorConfigError();
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    const pathAfter = lstatSync(path);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      after.dev !== pathAfter.dev ||
      after.ino !== pathAfter.ino
    ) {
      throw new OperatorConfigError();
    }
    return bytes;
  } catch {
    throw new OperatorConfigError();
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

function filesUnder(
  root: string,
  relativeRoot: string,
  excludedSegments: ReadonlySet<string>,
): string[] {
  assertRelativeInputPath(relativeRoot);
  const absoluteRoot = resolve(root, relativeRoot);
  assertContained(root, absoluteRoot);
  try {
    const rootStat = lstatSync(absoluteRoot);
    if (
      !rootStat.isDirectory() ||
      rootStat.isSymbolicLink() ||
      realpathSync(absoluteRoot) !== absoluteRoot
    ) {
      throw new OperatorConfigError();
    }
    return readdirSync(absoluteRoot, { withFileTypes: true })
      .flatMap((entry) => {
        if (excludedSegments.has(entry.name)) {
          return [];
        }
        const child = `${relativeRoot}/${entry.name}`;
        const childPath = join(absoluteRoot, entry.name);
        const stat = lstatSync(childPath);
        if (stat.isSymbolicLink()) {
          throw new OperatorConfigError();
        }
        if (stat.isDirectory()) {
          return filesUnder(root, child, excludedSegments);
        }
        if (!stat.isFile()) {
          throw new OperatorConfigError();
        }
        return [child];
      })
      .sort();
  } catch {
    throw new OperatorConfigError();
  }
}

function expandInput(root: string, input: RuntimeInput): string[] {
  if (input.kind === "file") {
    return [input.path];
  }
  const excluded = new Set(input.excluded_segments);
  return filesUnder(root, input.path, excluded).filter((path) =>
    input.suffixes.some((suffix) => path.endsWith(suffix)),
  );
}

export function runtimeInputIdentity(input: {
  releaseRoot: string;
  inputs?: readonly RuntimeInput[];
}): {
  bindings: SourceBinding[];
  tested_implementation_digest: `sha256:${string}`;
} {
  const root = resolve(input.releaseRoot);
  try {
    const stat = lstatSync(root);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      realpathSync(root) !== root
    ) {
      throw new OperatorConfigError();
    }
  } catch {
    throw new OperatorConfigError();
  }
  const paths = (input.inputs ?? G6_RUNTIME_INPUTS)
    .flatMap((entry) => expandInput(root, entry))
    .sort();
  if (paths.length === 0 || new Set(paths).size !== paths.length) {
    throw new OperatorConfigError();
  }
  const bindings = paths.map((path) => ({
    path,
    raw_hash: rawSha256(secureRead(root, path)),
  }));
  return {
    bindings,
    tested_implementation_digest: canonicalSha256(bindings),
  };
}

export function defaultRuntimeReleaseRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
}

export function runtimeConfigurationDigest(
  config: OperatorConfig,
): RuntimeIdentity["configuration_digest"] {
  const recoveryAuthority = config.recovery.authority;
  const operatorConfirmation = config.operator_confirmation;
  const admission = config.secret_admission;
  return CanonicalHashSchema.parse(canonicalSha256({
    schema_version: "1.0.0",
    topology: "single-user-single-root-single-writer-stdio",
    data_root: resolve(config.data_root),
    principal_id: config.principal_id,
    root_ref: config.root_ref,
    qualification: config.qualification,
    recovery_authority:
      recoveryAuthority === null
        ? null
        : {
            directory: resolve(recoveryAuthority.directory),
            authority_key_id: recoveryAuthority.authority_key_id,
            trust_root_version: recoveryAuthority.trust_root_version,
            public_key_path: resolve(
              recoveryAuthority.public_key_path,
            ),
          },
    operator_confirmation_trust:
      operatorConfirmation?.trust ?? null,
    secret_admission:
      admission === null
        ? null
        : {
            enabled: admission.enabled,
            approval_trust: admission.approval_trust,
            release_trust: admission.release_trust,
            encryption_provider: {
              key_id: admission.encryption_provider.key_id,
              key_generation:
                admission.encryption_provider.key_generation,
              commitment_key_id:
                admission.encryption_provider.commitment_key_id,
            },
          },
  }));
}

function currentPlatformIdentity(releaseRoot: string): {
  identity: RuntimePlatformIdentity;
  environment: {
    runtime: string;
    platform: string;
    filesystem: string;
    topology: "single-user-single-root-single-writer-stdio";
  };
} {
  const filesystemType = statfsSync(releaseRoot).type;
  const filesystem =
    process.platform === "darwin" && filesystemType === 26
      ? "apfs"
      : `type-${filesystemType}`;
  return {
    identity: {
      node: process.versions.node,
      os: platform(),
      architecture: process.arch,
      sqlite: process.versions.sqlite ?? "unavailable",
      filesystem,
    },
    environment: {
      runtime: `node-${process.versions.node}`,
      platform: `${process.platform}-${process.arch}`,
      filesystem,
      topology: "single-user-single-root-single-writer-stdio",
    },
  };
}

export function currentRuntimeIdentity(input: {
  schemaVersion: RuntimeIdentity["schema_version"];
  configurationDigest: RuntimeIdentity["configuration_digest"];
  releaseRoot?: string;
  inputs?: readonly RuntimeInput[];
}): RuntimeIdentity {
  const releaseRoot = input.releaseRoot ?? defaultRuntimeReleaseRoot();
  const implementation = runtimeInputIdentity({
    releaseRoot,
    ...(input.inputs === undefined ? {} : { inputs: input.inputs }),
  });
  const migrations = implementation.bindings.filter(
    ({ path }) => path.startsWith("migrations/") && path.endsWith(".sql"),
  );
  const lock = implementation.bindings.find(
    ({ path }) => path === "pnpm-lock.yaml",
  );
  if (lock === undefined || migrations.length === 0) {
    throw new OperatorConfigError();
  }
  const platformIdentity = currentPlatformIdentity(releaseRoot);
  const base = {
    schema_version: input.schemaVersion,
    tested_implementation_digest:
      implementation.tested_implementation_digest,
    tested_envelope_digest: canonicalSha256({
      schema_version: input.schemaVersion,
      environment: platformIdentity.environment,
      configuration_digest: input.configurationDigest,
      optional_features: {
        graph_enabled: false,
        vector_enabled: false,
        automatic_learning_publication: false,
      },
    }),
    dependency_lock_digest: lock.raw_hash,
    migration_set_digest: canonicalSha256(migrations),
    platform: platformIdentity.identity,
    configuration_digest: input.configurationDigest,
    decision_authority_hash: canonicalSha256(
      PINNED_G6_RELEASE_CONTROL_TRUST,
    ),
  };
  return RuntimeIdentitySchema.parse({
    ...base,
    runtime_identity_hash: canonicalSha256(base),
  });
}

export function productionRuntimeIdentityProvider(
  expected: RuntimeIdentity,
  config: OperatorConfig,
): RuntimeIdentityProvider {
  const parsedExpected = RuntimeIdentitySchema.parse(expected);
  return {
    current: async () =>
      currentRuntimeIdentity({
        schemaVersion: parsedExpected.schema_version,
        configurationDigest: runtimeConfigurationDigest(config),
      }),
  };
}
