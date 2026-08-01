import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  writeSync,
} from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

import { deriveG6DecisionPublicKey } from "./build-g6-release-control.mjs";
import {
  canonicalEvidenceArgv,
  canonicalJson,
  currentCandidateIdentity,
  canonicalSha256,
  filesUnder,
  migrationIdentity,
  rawSha256,
  read,
  readJson,
  repositoryRoot,
  runtimeInputIdentity,
  runEvidenceCommand,
  sourceBinding,
  writeCanonicalJson,
} from "./g6-evidence-common.mjs";

const APPROVED_LIFECYCLE_BUILDS = Object.freeze([
  {
    name: "@ladybugdb/core",
    package_spec: "@ladybugdb/core@0.18.3",
    source_integrity:
      "sha512-XjpPKW4MrL28D2gYGTZuIjiEcPx12L21lx58QggrdrItw8o/e9Lmg/Ejoo4Kz08lZj+rIcC1Fu9thzIYOTUlJw==",
  },
  {
    name: "better-sqlite3",
    package_spec: "better-sqlite3@13.0.1",
    source_integrity:
      "sha512-LYpmOXdkpQYf4wmlxkdzW01XGlOXNIbjLg45yNkh0FQ4814VbK9PdOFmhZpYbej+EZtR/i3FDdhEG98HqZdgnA==",
  },
  {
    name: "esbuild",
    package_spec: "esbuild@0.28.1",
    source_integrity:
      "sha512-HrJrvZv5ayxBzPfwphOoNzkzOIIlifzk0KJrGK2c8R4+LKpMtpYLQeUdjnwjWv/LZlkH2laZk+4w78pi99D4Vw==",
  },
  {
    name: "onnxruntime-node",
    package_spec: "onnxruntime-node@1.24.3",
    source_integrity:
      "sha512-JH7+czbc8ALA819vlTgcV+Q214/+VjGeBHDjX81+ZCD0PCVCIFGFNtT0V4sXG/1JXypKPgScQcB3ij/hk3YnTg==",
  },
  {
    name: "protobufjs",
    package_spec: "protobufjs@7.6.5",
    source_integrity:
      "sha512-/FPD0nUc9jH6rfFjji9IBqOz4pcSE3CsT1m7Ep6Mdb0LxSUMj8hgl6GomOvZzpNpAqqGaXA0P3VSrZLFzIhQrw==",
  },
  {
    name: "sharp",
    package_spec: "sharp@0.35.3",
    source_integrity:
      "sha512-ej0zVHuZGHCiABXcNxeYhpRnPNPAcvbG8RMdBAhDAxLKkCRVSpK3Iyu7qbqw3JMzoj0REeM6f3tJLtVwl0023Q==",
  },
  {
    name: "sqlite-vec",
    package_spec: "sqlite-vec@0.1.9",
    source_integrity:
      "sha512-L7XJWRIBNvR9O5+vh1FQ+IGkh/3D2AzVksW5gdtk28m78Hy8skFD0pqReKH1Yp0/BUKRGcffgKvyO/EON5JXpA==",
  },
]);

const authoritySeedPath = resolve(
  repositoryRoot,
  "data/g6/decision-authority.seed",
);

function fsyncDirectory(path) {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function sameSeedIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

export function initializeG6Authority(seedPath = authoritySeedPath) {
  const directory = resolve(seedPath, "..");
  mkdirSync(directory, {
    recursive: true,
    mode: 0o700,
  });
  const directoryStat = lstatSync(directory, { bigint: true });
  if (
    !directoryStat.isDirectory() ||
    directoryStat.isSymbolicLink() ||
    realpathSync(directory) !== directory ||
    (directoryStat.mode & 0o777n) !== 0o700n ||
    (typeof process.getuid === "function" &&
      directoryStat.uid !== BigInt(process.getuid()))
  ) {
    throw new Error("G6 authority directory permissions are invalid");
  }
  let createdDescriptor;
  try {
    createdDescriptor = openSync(
      seedPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    const seed = randomBytes(32);
    try {
      let offset = 0;
      while (offset < seed.byteLength) {
        const written = writeSync(
          createdDescriptor,
          seed,
          offset,
          seed.byteLength - offset,
          offset,
        );
        if (written <= 0) {
          throw new Error("G6 authority seed write did not progress");
        }
        offset += written;
      }
      fsyncSync(createdDescriptor);
    } finally {
      seed.fill(0);
      closeSync(createdDescriptor);
      createdDescriptor = undefined;
    }
    fsyncDirectory(directory);
  } catch (error) {
    if (createdDescriptor !== undefined) {
      closeSync(createdDescriptor);
    }
    if (error?.code !== "EEXIST") {
      throw error;
    }
  }
  const descriptor = openSync(
    seedPath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  const stat = fstatSync(descriptor, { bigint: true });
  if (
    !stat.isFile() ||
    stat.size !== 32n ||
    (stat.mode & 0o777n) !== 0o600n ||
    (typeof process.getuid === "function" &&
      stat.uid !== BigInt(process.getuid()))
  ) {
    closeSync(descriptor);
    throw new Error("G6 authority seed permissions are invalid");
  }
  const seed = Buffer.alloc(32);
  const overflow = Buffer.alloc(1);
  try {
    const bytesRead = readSync(
      descriptor,
      seed,
      0,
      seed.byteLength,
      0,
    );
    const overflowBytes = readSync(
      descriptor,
      overflow,
      0,
      overflow.byteLength,
      seed.byteLength,
    );
    const observed = fstatSync(descriptor, { bigint: true });
    if (
      bytesRead !== seed.byteLength ||
      overflowBytes !== 0 ||
      !sameSeedIdentity(stat, observed)
    ) {
      throw new Error("G6 authority seed changed during use");
    }
    return {
      authority_seed_state: "external_restricted",
      public_key_spki_base64url: deriveG6DecisionPublicKey(seed),
    };
  } finally {
    seed.fill(0);
    overflow.fill(0);
    closeSync(descriptor);
  }
}

function auditResult() {
  const args = ["audit", "--json", "--audit-level", "high"];
  const command = canonicalEvidenceArgv("pnpm", args);
  const result = spawnSync(
    "pnpm",
    args,
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      timeout: 300_000,
    },
  );
  const combined = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const registryUnavailable =
    /(?:ENETUNREACH|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ERR_PNPM_META_FETCH_FAIL|registry.*unavailable)/iu.test(
      combined,
    );
  const advisories = (() => {
    try {
      const parsed = JSON.parse(result.stdout);
      return (
        parsed.metadata?.vulnerabilities ??
        parsed.metadata?.vulnerability ??
        null
      );
    } catch {
      return null;
    }
  })();
  return {
    command,
    state: registryUnavailable
      ? "blocked"
      : result.status === 0
        ? "pass"
        : "fail",
    exit_code: result.status,
    registry_available: !registryUnavailable,
    vulnerability_summary: advisories,
  };
}

function verifyNoRuntimeDownloads() {
  const sources = [
    ...filesUnder("packages"),
    ...filesUnder("apps"),
  ].filter(
    (path) =>
      path.includes("/src/") &&
      (path.endsWith(".ts") || path.endsWith(".mts")),
  );
  const downloadPattern =
    /\b(?:fetch|https?\.get|https?\.request)\s*\(/u;
  return {
    state: sources.every(
      (path) => !downloadPattern.test(read(path).toString("utf8")),
    )
      ? "pass"
      : "fail",
    scanned_source_files: sources.length,
  };
}

function dependencyInventoryResult() {
  const args = ["list", "--json", "--depth", "Infinity"];
  const command = canonicalEvidenceArgv("pnpm", args);
  const result = spawnSync(
    "pnpm",
    args,
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      timeout: 300_000,
    },
  );
  const packages = new Set();
  if (result.status === 0) {
    try {
      const visit = (entry) => {
        if (entry === null || typeof entry !== "object") return;
        if (
          typeof entry.name === "string" &&
          typeof entry.version === "string"
        ) {
          packages.add(`${entry.name}@${entry.version}`);
        }
        for (const dependency of Object.values(
          entry.dependencies ?? {},
        )) {
          visit(dependency);
        }
      };
      JSON.parse(result.stdout).forEach(visit);
    } catch {
      packages.clear();
    }
  }
  return {
    command,
    state:
      result.status === 0 && packages.size > 0 ? "pass" : "fail",
    exit_code: result.status,
    package_count: packages.size,
    sbom_digest:
      packages.size > 0
        ? canonicalSha256([...packages].sort())
        : null,
  };
}

function nativeOutputResult(policy) {
  const outputs = policy.approved_native_outputs.map(
    ({ name, relative_path: path, raw_digest: expectedDigest }) => {
      const observedDigest = (() => {
        try {
          return rawSha256(read(path));
        } catch {
          return null;
        }
      })();
      return {
        name,
        expected_digest: expectedDigest,
        observed_digest: observedDigest,
        verified: observedDigest === expectedDigest,
      };
    },
  );
  return {
    state: outputs.every(({ verified }) => verified) ? "pass" : "fail",
    outputs,
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function hasExactLockSource(lockText, record) {
  const key = record.name.startsWith("@")
    ? `'${record.package_spec}'`
    : record.package_spec;
  const pattern = new RegExp(
    `(?:^|\\n)  ${escapeRegExp(key)}:\\n    resolution: \\{integrity: ${escapeRegExp(record.source_integrity)}\\}`,
    "u",
  );
  return pattern.test(lockText);
}

export function validateG6LifecycleInventory({
  policy,
  pendingBuilds,
  lockText,
}) {
  const policyEntriesValid =
    Array.isArray(policy?.approved_native_builds) &&
    policy.approved_native_builds.every(
      (entry) => typeof entry === "string",
    );
  const configured = Array.isArray(policy?.approved_native_builds)
    ? policy.approved_native_builds.filter(
        (entry) =>
          typeof entry === "string" && !entry.startsWith("tools/"),
      )
    : [];
  const expectedNames = APPROVED_LIFECYCLE_BUILDS.map(
    ({ name }) => name,
  );
  const policyAllowlistExact =
    policyEntriesValid &&
    canonicalJson([...configured].sort()) ===
    canonicalJson([...expectedNames].sort());
  const normalizedPending = Array.isArray(pendingBuilds)
    ? pendingBuilds.filter((entry) => typeof entry === "string")
    : [];
  const pendingBuildCount = Array.isArray(pendingBuilds)
    ? pendingBuilds.length
    : 0;
  const uniquePending =
    normalizedPending.length === new Set(normalizedPending).size;
  const pendingEntriesValid =
    Array.isArray(pendingBuilds) &&
    normalizedPending.length === pendingBuilds.length;
  const approvedRecords = normalizedPending.map((entry) =>
    APPROVED_LIFECYCLE_BUILDS.find(
      (record) =>
        record.package_spec === entry &&
        configured.includes(record.name),
    ),
  );
  const approvedPendingCount = approvedRecords.filter(Boolean).length;
  const sourceBoundRecords = approvedRecords.filter(
    (record) =>
      record !== undefined &&
      typeof lockText === "string" &&
      hasExactLockSource(lockText, record),
  );
  const sourceBindingCount = sourceBoundRecords.length;
  const pass =
    policyAllowlistExact &&
    pendingEntriesValid &&
    uniquePending &&
    pendingBuildCount > 0 &&
    approvedPendingCount === pendingBuildCount &&
    sourceBindingCount === pendingBuildCount;
  return {
    state: pass ? "pass" : "fail",
    pending_build_count: pendingBuildCount,
    approved_pending_count: approvedPendingCount,
    ignored_unapproved_count: pendingBuildCount - approvedPendingCount,
    source_binding_count: sourceBindingCount,
    policy_allowlist_exact: policyAllowlistExact,
    pending_entries_valid: pendingEntriesValid,
    pending_entries_unique: uniquePending,
    pending_builds_digest:
      !pendingEntriesValid || normalizedPending.length === 0
        ? null
        : canonicalSha256([...normalizedPending].sort()),
    approved_pending_sources_digest:
      sourceBoundRecords.length === 0
        ? null
        : canonicalSha256(
            sourceBoundRecords
              .map(({ package_spec: packageSpec, source_integrity: sourceIntegrity }) => ({
                package_spec: packageSpec,
                source_integrity: sourceIntegrity,
              }))
              .sort((left, right) =>
                left.package_spec < right.package_spec
                  ? -1
                  : left.package_spec > right.package_spec
                    ? 1
                    : 0,
              ),
          ),
  };
}

function lifecycleInventoryResult(policy) {
  const command = runEvidenceCommand(
    "pnpm",
    ["ignored-builds"],
    { timeoutMs: 300_000 },
  );
  const pendingBuilds = (() => {
    try {
      const modules = JSON.parse(
        read("node_modules/.modules.yaml").toString("utf8"),
      );
      return Array.isArray(modules.pendingBuilds)
        ? modules.pendingBuilds
        : [];
    } catch {
      return [];
    }
  })();
  const validation = validateG6LifecycleInventory({
    policy,
    pendingBuilds,
    lockText: read("pnpm-lock.yaml").toString("utf8"),
  });
  return {
    ...validation,
    command: command.command,
    state:
      command.state === "pass"
        ? validation.state
        : command.state === "blocked"
          ? "blocked"
          : "fail",
    exit_code: command.exit_code,
    signal: command.signal,
  };
}

function skippedCommand(program, args, state) {
  return {
    command: canonicalEvidenceArgv(program, args),
    state,
    exit_code: null,
    signal: null,
  };
}

function g6ProvenanceStatement() {
  const runtimeInputs = runtimeInputIdentity();
  const migrations = migrationIdentity();
  return {
    schema_version: "1.0.0",
    predicate_type: "memo-graph/g6-build-provenance/v1",
    candidate_binding: "tested_implementation_digest",
    tested_implementation_digest:
      runtimeInputs.tested_implementation_digest,
    dependency_lock_digest: rawSha256(read("pnpm-lock.yaml")),
    migration_set_digest: migrations.migration_set_digest,
    source_bindings: [
      sourceBinding("package.json", true),
      sourceBinding("pnpm-lock.yaml"),
      sourceBinding("tools/rename-noreplace/build.mjs"),
      sourceBinding("tools/rename-noreplace/rename-noreplace.c"),
    ],
  };
}

export function buildG6Provenance(options = {}) {
  const statement = g6ProvenanceStatement();
  const provenance = {
    ...statement,
    statement_digest: canonicalSha256(statement),
  };
  if (options.write ?? true) {
    writeCanonicalJson(
      "fixtures/g6/security/provenance.json",
      provenance,
    );
  }
  return provenance;
}

export function verifyG6Provenance(
  provenance = readJson("fixtures/g6/security/provenance.json"),
) {
  const {
    statement_digest: statementDigest,
    ...statement
  } = provenance;
  const expected = g6ProvenanceStatement();
  const valid =
    canonicalJson(statement) === canonicalJson(expected) &&
    /^sha256:[a-f0-9]{64}$/u.test(statementDigest) &&
    canonicalSha256(statement) === statementDigest;
  return {
    state: valid ? "pass" : "fail",
    candidate_binding: provenance.candidate_binding,
    tested_implementation_digest:
      provenance.tested_implementation_digest,
    statement_digest: statementDigest,
  };
}

function verifySupplyChain() {
  const packageJson = readJson("package.json");
  const policy = readJson(
    "fixtures/g6/security/supply-chain-policy.json",
  );
  const approvedPackages = policy.approved_native_builds.filter(
    (name) => !name.startsWith("tools/"),
  );
  const configured = [...packageJson.pnpm.onlyBuiltDependencies].sort();
  const configuredExpected = [...approvedPackages].sort();
  const packagePolicyState =
    packageJson.packageManager === policy.package_manager &&
    `node-${process.versions.node}` === policy.runtime &&
    JSON.stringify(configured) === JSON.stringify(configuredExpected)
      ? "pass"
      : "fail";

  const candidate = currentCandidateIdentity();
  const lockText = read("pnpm-lock.yaml").toString("utf8");
  const lockIntegrity = {
    state:
      lockText.includes("lockfileVersion:") &&
      lockText.includes("integrity:")
        ? "pass"
        : "fail",
    frozen: true,
    integrity_entries: lockText.match(/\bintegrity:/gu)?.length ?? 0,
  };
  const install = runEvidenceCommand(
    "pnpm",
    [
      "install",
      "--force",
      "--frozen-lockfile",
      "--ignore-scripts",
      "--offline",
    ],
    { timeoutMs: 600_000 },
  );
  const storeIntegrity = runEvidenceCommand(
    "pnpm",
    ["store", "status"],
    { timeoutMs: 300_000 },
  );
  const lifecycleInventory = lifecycleInventoryResult(policy);
  const dependencyInventory = dependencyInventoryResult();
  const audit = auditResult();
  const runtimeDownloads = verifyNoRuntimeDownloads();
  const provenance = verifyG6Provenance();
  const waiversCurrent = policy.vulnerability_policy.waivers.every(
    ({ expires_at: expiresAt }) =>
      Date.parse(expiresAt) > Date.parse("2026-07-30T00:00:00.000Z"),
  );
  const prebuildEligible =
    candidate.dirty_paths_allowed &&
    packagePolicyState === "pass" &&
    lockIntegrity.state === "pass" &&
    install.state === "pass" &&
    storeIntegrity.state === "pass" &&
    lifecycleInventory.state === "pass" &&
    dependencyInventory.state === "pass" &&
    audit.state === "pass" &&
    runtimeDownloads.state === "pass" &&
    provenance.state === "pass" &&
    waiversCurrent;
  const approvedBuild = prebuildEligible
    ? runEvidenceCommand(
        "pnpm",
        ["-r", "--config.offline=true", "rebuild", "--pending"],
        { timeoutMs: 600_000 },
      )
    : skippedCommand(
        "pnpm",
        ["-r", "--config.offline=true", "rebuild", "--pending"],
        audit.state === "blocked" ? "blocked" : "fail",
      );
  const localNativeBuild = prebuildEligible
    ? runEvidenceCommand("node", [
        "tools/rename-noreplace/build.mjs",
      ])
    : skippedCommand(
        "node",
        ["tools/rename-noreplace/build.mjs"],
        audit.state === "blocked" ? "blocked" : "fail",
      );
  const nativeOutputs =
    approvedBuild.state === "pass" &&
    localNativeBuild.state === "pass"
      ? nativeOutputResult(policy)
      : {
          state:
            audit.state === "blocked" ? "blocked" : "fail",
          outputs: [],
        };
  const checks = {
    source_clean: candidate.dirty_paths_allowed ? "pass" : "fail",
    package_policy: packagePolicyState,
    lock_store_tarball:
      install.state === "pass" && storeIntegrity.state === "pass"
        ? "pass"
        : install.state === "blocked" ||
            storeIntegrity.state === "blocked"
          ? "blocked"
          : "fail",
    lifecycle_inventory: lifecycleInventory.state,
    approved_native_builds:
      approvedBuild.state === "pass" &&
      localNativeBuild.state === "pass" &&
      nativeOutputs.state === "pass"
        ? "pass"
        : nativeOutputs.state,
    runtime_downloads: runtimeDownloads.state,
    sbom: dependencyInventory.state,
    provenance: provenance.state,
    vulnerability_audit: audit.state,
    waiver_expiry: waiversCurrent ? "pass" : "fail",
  };
  const firstNonPass = Object.entries(checks).find(
    ([, state]) => state !== "pass",
  );
  const report = {
    schema_version: "1.0.0",
    gate: "G6",
    family: "supply_chain",
    candidate,
    state: firstNonPass?.[1] ?? "pass",
    first_non_pass: firstNonPass?.[0] ?? null,
    checks,
    bootstrap: {
      scripts_disabled_install: install,
      store_tarball_integrity: storeIntegrity,
      lifecycle_inventory: lifecycleInventory,
      approved_package_build: approvedBuild,
      approved_local_native_build: localNativeBuild,
      dependency_inventory: dependencyInventory,
      provenance,
    },
    lock_integrity: lockIntegrity,
    runtime_download_scan: runtimeDownloads,
    native_outputs: nativeOutputs,
    audit,
    waiver_count: policy.vulnerability_policy.waivers.length,
    source_bindings: [
      sourceBinding("package.json", true),
      sourceBinding("pnpm-lock.yaml"),
      sourceBinding("pnpm-workspace.yaml"),
      sourceBinding(
        "fixtures/g6/security/supply-chain-policy.json",
        true,
      ),
      sourceBinding("fixtures/g6/security/provenance.json", true),
      sourceBinding("tools/rename-noreplace/build.mjs"),
      sourceBinding("tools/rename-noreplace/rename-noreplace.c"),
    ],
  };
  writeCanonicalJson(
    "docs/evaluations/g6-supply-chain-report.json",
    report,
  );
  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const command = process.argv[2] ?? "verify";
  if (command === "initialize-authority") {
    process.stdout.write(
      `${JSON.stringify(initializeG6Authority())}\n`,
    );
  } else if (command === "build-provenance") {
    process.stdout.write(
      `${JSON.stringify(buildG6Provenance())}\n`,
    );
  } else if (command === "verify") {
    const report = verifySupplyChain();
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (report.state !== "pass") process.exitCode = 1;
  } else {
    throw new Error(`unknown G6 bootstrap command: ${command}`);
  }
}
