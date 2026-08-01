import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import process from "node:process";

export const repositoryRoot = resolve(import.meta.dirname, "..");

export const G6_HARD_RULE_ORDER = Object.freeze([
  "integrity",
  "privacy",
  "deletion",
  "encryption",
  "restore",
  "rollback",
  "supply_chain",
  "binding",
]);

export const G6_EVIDENCE_PATHS = Object.freeze([
  "docs/evaluations/g6-code-review.md",
  "docs/evaluations/g6-fault-report.json",
  "docs/evaluations/g6-reproducibility-manifest.json",
  "docs/evaluations/g6-resource-report.json",
  "docs/evaluations/g6-runbook-report.json",
  "docs/evaluations/g6-security-report.json",
  "docs/evaluations/g6-supply-chain-report.json",
  "docs/evaluations/g6-verification-report.json",
]);

export const G6_DECISION_PATHS = Object.freeze([
  ".trellis/tasks/07-30-agent-memory-runtime-m6/task.json",
  "docs/evaluations/g6-decision.md",
  "docs/evaluations/g6-handoff.md",
  "docs/evaluations/g6-release-control.json",
]);

const PRIOR_GATES = Object.freeze(["G3R", "G4A", "G4B", "G5"]);
const ACCEPTANCE_EXAMPLES = Object.freeze(
  Array.from({ length: 8 }, (_, index) => `M6_AE${index + 1}`),
);
const EVIDENCE_FAMILIES = Object.freeze([
  "fault_recovery",
  "encryption_secret",
  "backup_restore_deletion",
  "resource_pressure",
  "learning_rollback",
  "operator_runbooks",
  "supply_chain",
  "independent_review",
]);
const ADMISSION_THRESHOLDS = Object.freeze([
  "max_queue_depth",
  "max_queue_age_ms",
  "min_available_bytes_enter",
  "min_available_bytes_recover",
  "max_wal_bytes_enter",
  "max_wal_bytes_recover",
]);

function compareUnicode(left, right) {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return Buffer.compare(leftBytes, rightBytes);
}

export function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite canonical value");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (typeof value === "object" && value !== undefined) {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => compareUnicode(left, right));
    return `{${entries
      .map(
        ([key, entry]) =>
          `${JSON.stringify(key)}:${canonicalJson(entry)}`,
      )
      .join(",")}}`;
  }
  throw new Error("unsupported canonical value");
}

export function rawSha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function canonicalSha256(value) {
  return rawSha256(Buffer.from(canonicalJson(value), "utf8"));
}

export function read(relativePath) {
  return readFileSync(resolve(repositoryRoot, relativePath));
}

export function readJson(relativePath) {
  return JSON.parse(read(relativePath).toString("utf8"));
}

export function filesUnder(relativeRoot) {
  const root = resolve(repositoryRoot, relativeRoot);
  return readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      const absolute = join(root, entry.name);
      if (entry.isDirectory()) {
        return filesUnder(
          relative(repositoryRoot, absolute).replaceAll("\\", "/"),
        );
      }
      return [relative(repositoryRoot, absolute).replaceAll("\\", "/")];
    })
    .sort();
}

function expandRuntimeInput(entry) {
  assertRelativePath(entry.path, "runtime input");
  if (entry.kind === "file") return [entry.path];
  if (entry.kind !== "tree") {
    throw new Error(`G6 runtime input ${entry.path} has invalid kind`);
  }
  const suffixes = entry.suffixes ?? [];
  const excludedSegments = new Set(entry.excluded_segments ?? []);
  return filesUnder(entry.path).filter((path) => {
    const segments = path.split("/");
    return (
      !segments.some((segment) => excludedSegments.has(segment)) &&
      (suffixes.length === 0 ||
        suffixes.some((suffix) => path.endsWith(suffix)))
    );
  });
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

export function artifactBinding(path, json = false) {
  const bytes = read(path);
  return {
    artifact_name: path,
    raw_digest: rawSha256(bytes),
    ...(json
      ? {
          canonical_digest: canonicalSha256(
            JSON.parse(bytes.toString("utf8")),
          ),
        }
      : {}),
  };
}

export function migrationIdentity() {
  const paths = filesUnder("migrations").filter((path) =>
    path.endsWith(".sql"),
  );
  const files = paths.map((path) => sourceBinding(path));
  return {
    latest: paths.at(-1) ?? null,
    files,
    migration_set_digest: canonicalSha256(files),
  };
}

export function runtimeInputIdentity(runtimeInputs = readJson(
  "fixtures/g6/runtime-inputs.json",
)) {
  const expandedPaths = runtimeInputs.paths.flatMap(expandRuntimeInput);
  assertUnique(expandedPaths, "expanded runtime input");
  const bindings = expandedPaths.sort().map((path) => sourceBinding(path));
  return {
    bindings,
    tested_implementation_digest: canonicalSha256(bindings),
  };
}

function assertUnique(values, label) {
  if (
    values.length === 0 ||
    new Set(values).size !== values.length
  ) {
    throw new Error(`G6 ${label} is missing or duplicated`);
  }
}

function assertExact(actual, expected, label) {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error(`G6 ${label} mismatch`);
  }
}

function assertRelativePath(path, label) {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").includes("..")
  ) {
    throw new Error(`G6 ${label} path is invalid`);
  }
}

function assertProof(proof, label) {
  if (
    proof === null ||
    typeof proof !== "object" ||
    typeof proof.test_file !== "string" ||
    !proof.test_file.startsWith("tests/") ||
    typeof proof.test_name !== "string" ||
    proof.test_name.length === 0
  ) {
    throw new Error(`G6 ${label} proof is invalid`);
  }
  assertRelativePath(proof.test_file, `${label} proof`);
}

export function loadG6Fixture() {
  const manifest = readJson("fixtures/g6/manifest.json");
  return {
    ...manifest,
    thresholds: readJson("fixtures/g6/thresholds.json"),
    release_control: readJson("fixtures/g6/release-control.json"),
    decision_authority: readJson(
      "fixtures/g6/decision-authority.json",
    ),
    runtime_inputs: readJson("fixtures/g6/runtime-inputs.json"),
    fault_fixture: readJson("fixtures/g6/faults/fault-matrix.json"),
    recovery_fixture: readJson(
      "fixtures/g6/recovery/acceptance-examples.json",
    ),
    resource_fixture: readJson(
      "fixtures/g6/resources/workloads.json",
    ),
    runbook_fixture: readJson(
      "fixtures/g6/runbooks/operator-runbooks.json",
    ),
    evidence_policy: readJson(
      "fixtures/g6/security/evidence-policy.json",
    ),
    supply_chain_policy: readJson(
      "fixtures/g6/security/supply-chain-policy.json",
    ),
  };
}

export function validateG6Fixture(input = loadG6Fixture()) {
  if (input.schema_version !== "1.0.0" || input.gate !== "G6") {
    throw new Error("G6 manifest identity mismatch");
  }
  assertExact(
    input.prior_gates.map(({ gate }) => gate),
    PRIOR_GATES,
    "prior gate",
  );
  for (const gate of input.prior_gates) {
    if (
      !["GO", "NO-GO"].includes(gate.decision) ||
      !/^sha256:[a-f0-9]{64}$/u.test(gate.artifact_sha256) ||
      rawSha256(read(gate.artifact_path)) !== gate.artifact_sha256
    ) {
      throw new Error("G6 prior gate binding is invalid");
    }
  }
  assertExact(
    input.acceptance_examples.map(({ id }) => id),
    ACCEPTANCE_EXAMPLES,
    "acceptance example",
  );
  if (
    input.acceptance_examples.some(
      ({ oracles }) =>
        !Array.isArray(oracles) ||
        !oracles.includes("success") ||
        !oracles.includes("failure"),
    )
  ) {
    throw new Error("G6 acceptance example Oracle coverage mismatch");
  }
  assertExact(
    input.evidence_families,
    EVIDENCE_FAMILIES,
    "evidence family",
  );
  assertUnique(input.fault_points, "fault point");
  if (input.fault_points.length !== 43) {
    throw new Error("G6 fault point mismatch");
  }
  assertExact(input.workloads, ["small", "expected"], "workload");
  assertUnique(input.runbook_steps, "runbook step");
  assertExact(
    input.runbook_steps,
    input.runbook_fixture.steps.map(({ id }) => id),
    "runbook step",
  );
  assertExact(
    Object.keys(input.recovery_fixture.acceptance_examples),
    ACCEPTANCE_EXAMPLES,
    "acceptance example Oracle",
  );
  if (
    input.fault_fixture.required_oracles.length !== 5 ||
    input.fault_fixture.fault_groups.length !== 12
  ) {
    throw new Error("G6 fault Oracle coverage mismatch");
  }
  assertUnique(
    input.fault_fixture.fault_groups.map(({ id }) => id),
    "fault proof group",
  );
  const mappedFaultPoints = input.fault_fixture.fault_groups.flatMap(
    ({ fault_points: faultPoints, proof, id }) => {
      assertProof(proof, `fault group ${id}`);
      return faultPoints;
    },
  );
  assertUnique(mappedFaultPoints, "fault proof obligation");
  assertExact(
    mappedFaultPoints,
    input.fault_points,
    "fault proof obligation",
  );
  for (const [id, example] of Object.entries(
    input.recovery_fixture.acceptance_examples,
  )) {
    assertProof(example.proof, `acceptance example ${id}`);
  }
  assertExact(
    Object.keys(input.resource_fixture.workloads),
    ["small", "expected"],
    "resource workload",
  );
  const resourceObligations = input.resource_fixture.proofs.flatMap(
    ({ id, obligations, test_file: testFile, test_name: testName }) => {
      assertProof(
        { test_file: testFile, test_name: testName },
        `resource ${id}`,
      );
      return obligations;
    },
  );
  assertUnique(resourceObligations, "resource proof obligation");
  assertExact(
    [...resourceObligations].sort(),
    ["small", "expected"]
      .flatMap((workload) =>
        [
          "admission_hysteresis",
          "bounded_queue",
          "checkpoint_convergence",
          "maintenance_exclusion",
        ].map((claim) => `${workload}:${claim}`),
      )
      .sort(),
    "resource proof obligation",
  );
  for (const step of input.runbook_fixture.steps) {
    assertProof(step.proof, `runbook ${step.id}`);
    assertCanonicalRunbookAutomation(
      step.automation,
      `runbook ${step.id}`,
    );
  }
  const securityObligations = input.evidence_policy.proofs.map(
    ({ id, obligation, test_file: testFile, test_name: testName }) => {
      assertProof(
        { test_file: testFile, test_name: testName },
        `security ${id}`,
      );
      return obligation;
    },
  );
  assertUnique(securityObligations, "security proof obligation");
  assertExact(
    securityObligations,
    [
      "content_free_evidence",
      "encryption_at_rest",
      "key_lifecycle",
      "wrong_key_rejection",
      "secret_residual_absence",
      "release_control_default_off",
    ],
    "security proof obligation",
  );
  assertExact(
    Object.keys(input.thresholds.admission),
    ADMISSION_THRESHOLDS,
    "threshold",
  );
  if (
    Object.values(input.thresholds.admission).some(
      (value) => !Number.isInteger(value) || value <= 0,
    )
  ) {
    throw new Error("G6 threshold mismatch");
  }
  assertExact(
    input.hard_rule_order,
    G6_HARD_RULE_ORDER,
    "hard-rule order",
  );
  for (const [rule, group] of Object.entries(
    input.critical_rule_groups,
  )) {
    if (!Array.isArray(group) || group.length === 0) {
      throw new Error(`G6 critical group ${rule} is empty`);
    }
  }
  for (const rule of G6_HARD_RULE_ORDER) {
    const group = input.critical_rule_groups[rule];
    if (!Array.isArray(group) || group.length === 0) {
      throw new Error(`G6 critical group ${rule} is empty`);
    }
  }
  for (const key of [
    "graph_enabled",
    "vector_enabled",
    "automatic_learning_publication",
  ]) {
    if (input.configuration[key] !== false) {
      throw new Error(`G6 ${key} must remain false`);
    }
  }
  assertExact(
    input.allowed_paths.evidence,
    G6_EVIDENCE_PATHS,
    "evidence path set",
  );
  assertExact(
    input.allowed_paths.decision,
    G6_DECISION_PATHS,
    "decision path set",
  );
  const runtimePaths = input.runtime_inputs.paths.map(({ path }) => path);
  assertUnique(runtimePaths, "runtime input");
  for (const entry of input.runtime_inputs.paths) {
    const { path } = entry;
    assertRelativePath(path, "runtime input");
    if (
      input.runtime_inputs.excluded_prefixes.some((prefix) =>
        path.startsWith(prefix),
      )
    ) {
      throw new Error("G6 evidence or decision path entered runtime inputs");
    }
    for (const expandedPath of expandRuntimeInput(entry)) {
      if (
        input.runtime_inputs.excluded_prefixes.some((prefix) =>
          expandedPath.startsWith(prefix),
        )
      ) {
        throw new Error(
          "G6 evidence or decision path entered runtime inputs",
        );
      }
    }
  }
  const identity = runtimeInputIdentity(input.runtime_inputs);
  assertExact(
    input.runtime_inputs.tested_implementation_digest,
    identity.tested_implementation_digest,
    "tested implementation digest",
  );
  const fixturePaths = input.fixture_bindings.map(({ path }) => path);
  assertUnique(fixturePaths, "fixture binding");
  for (const binding of input.fixture_bindings) {
    assertRelativePath(binding.path, "fixture binding");
    assertExact(
      sourceBinding(binding.path, true),
      binding,
      `fixture binding ${binding.path}`,
    );
  }
  if (
    input.release_control.current_control !== null ||
    input.release_control.decision_recorded !== false
  ) {
    throw new Error("G6 current release control must remain absent");
  }
  if (
    input.thresholds.environment.runtime !== "node-24.18.0" ||
    input.thresholds.environment.platform !== "darwin-arm64" ||
    input.thresholds.environment.filesystem !== "apfs" ||
    input.thresholds.claim_boundary !==
      "exact local evaluation thresholds; not a production SLO"
  ) {
    throw new Error("G6 threshold environment mismatch");
  }
  if (
    input.partition_policy.faults !== "fixtures/g6/faults" ||
    input.partition_policy.recovery !== "fixtures/g6/recovery" ||
    input.partition_policy.resources !== "fixtures/g6/resources" ||
    input.partition_policy.runbooks !== "fixtures/g6/runbooks" ||
    input.partition_policy.security !== "fixtures/g6/security"
  ) {
    throw new Error("G6 fixture partition mismatch");
  }
  if (
    input.supply_chain.registry_unavailable !== "blocked" ||
    input.supply_chain.lock_drift !== "fail" ||
    input.supply_chain.unapproved_native_build !== "fail" ||
    input.supply_chain.runtime_download !== "fail" ||
    input.supply_chain.expired_waiver !== "fail"
  ) {
    throw new Error("G6 supply-chain policy mismatch");
  }
  const releaseScenarios = input.release_control.scenarios.map(
    ({ name, decision, secret_admission_allowed }) => ({
      name,
      decision,
      secret_admission_allowed,
    }),
  );
  assertExact(
    releaseScenarios,
    [
      {
        name: "pending",
        decision: null,
        secret_admission_allowed: false,
      },
      {
        name: "synthetic_go",
        decision: "GO",
        secret_admission_allowed: true,
      },
      {
        name: "synthetic_no_go",
        decision: "NO-GO",
        secret_admission_allowed: false,
      },
    ],
    "release-control scenario",
  );
  if (
    input.decision_authority.algorithm !== "Ed25519" ||
    !/^[A-Za-z0-9_-]{59}$/u.test(
      input.decision_authority.public_key_spki_base64url,
    ) ||
    input.decision_authority.maximum_control_ttl_seconds !==
      input.release_control.maximum_control_ttl_seconds
  ) {
    throw new Error("G6 decision authority mismatch");
  }
  const packageJson = readJson("package.json");
  const approvedNative = input.supply_chain_policy.approved_native_builds
    .filter((name) => !name.startsWith("tools/"))
    .sort();
  if (
    input.supply_chain_policy.package_manager !==
      packageJson.packageManager ||
    input.supply_chain_policy.runtime !==
      `node-${process.versions.node}` ||
    canonicalJson(approvedNative) !==
      canonicalJson([...packageJson.pnpm.onlyBuiltDependencies].sort()) ||
    input.supply_chain_policy.scripts_disabled_until_verified !== true ||
    input.supply_chain_policy.prohibited_runtime_downloads !== true ||
    input.supply_chain_policy.approved_native_outputs.length !== 9 ||
    input.supply_chain_policy.required_artifacts.length !== 8
  ) {
    throw new Error("G6 supply-chain fixture mismatch");
  }
  for (const output of input.supply_chain_policy
    .approved_native_outputs) {
    assertRelativePath(output.relative_path, "native output");
    if (
      !/^sha256:[a-f0-9]{64}$/u.test(output.raw_digest) ||
      rawSha256(read(output.relative_path)) !== output.raw_digest
    ) {
      throw new Error("G6 native output binding mismatch");
    }
  }
  return input;
}

export function assertExactG6EvidencePaths(paths, options = {}) {
  const allowed = [
    ...G6_EVIDENCE_PATHS,
    ...(options.allowDecision === true ? G6_DECISION_PATHS : []),
  ].sort();
  assertExact([...paths].sort(), allowed, "evidence path set");
}

export function evaluateFirstFalse(checks) {
  for (const rule of G6_HARD_RULE_ORDER) {
    const value = checks[rule];
    if (value !== true) {
      return {
        eligible: false,
        first_non_pass: rule,
        state: value === "blocked" ? "blocked" : "fail",
      };
    }
  }
  return {
    eligible: true,
    first_non_pass: null,
    state: "pass",
  };
}

const FORBIDDEN_EVIDENCE_KEY =
  /(?:plaintext|ciphertext|key_material|private_key|raw_path|absolute_path|content_hash|production_slo|fleet_claim|multi_platform_claim|cross_bundle_link_id)/u;
const FORBIDDEN_EVIDENCE_VALUE =
  /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:password|passwd|api[_-]?key|secret|token|authorization|bearer)\s*(?:=|:)\s*\S+|--(?:password|passwd|api[_-]?key|secret|token|authorization|bearer)(?:=|\s+)\S+|(?:PASSWORD|PASSWD|API_KEY|SECRET|TOKEN|AUTHORIZATION)=\S+)/iu;
const FORBIDDEN_EVIDENCE_MARKER =
  /(?:marker|(?:^|[/\s:_-])(?:private|deleted)(?:[/\s:_-]|$)|\/Users\/|\\Users\\|[A-Za-z]:\\|\.\.[/\\])/iu;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const SOURCE_PATH_PATTERN =
  /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9@._+-]+(?:\/[A-Za-z0-9@._+-]+)*$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9@][A-Za-z0-9@._:/+-]{0,255}$/u;
const CANONICAL_RUNBOOK_AUTOMATION = Object.freeze([
  "doctor --config <operator-config> --format json",
  "backup inspect --backup-ref <backup-ref> --config <operator-config> --format json",
  "restore --dry-run --backup-ref <backup-ref> --target-ref <target-ref> --config <operator-config> --format json",
  "operator execute --confirmation-ref <restore-grant> --config <operator-config> --format json",
  "key inspect --config <operator-config> --format json",
  "key rotate --dry-run --config <operator-config> --format json",
  "purge audit --audit-id <audit-id> --tombstone-epoch 0 --config <operator-config> --format json",
  "rebuild --dry-run --repair-kind fts --config <operator-config> --format json",
  "rollback verify --release-ref <release-ref> --config <operator-config> --format json",
  "g6 verify --evidence-ref <verification-report> --config <operator-config> --format json",
]);
const STATIC_EVIDENCE_ARGV = Object.freeze([
  ["pnpm", "audit", "--json", "--audit-level", "high"],
  ["pnpm", "-r", "list", "--json", "--depth", "Infinity"],
  ["pnpm", "ignored-builds"],
  [
    "pnpm",
    "install",
    "--force",
    "--frozen-lockfile",
    "--ignore-scripts",
    "--offline",
  ],
  ["pnpm", "store", "status"],
  ["pnpm", "-r", "--config.offline=true", "rebuild", "--pending"],
  ["node", "tools/rename-noreplace/build.mjs"],
  [
    "pnpm",
    "vitest",
    "run",
    "<test-file>",
    "-t",
    "<test-name>",
  ],
]);
const ALLOWED_EVIDENCE_STRING_KEYS = new Set([
  "schema_version",
  "gate",
  "family",
  "state",
  "signal",
  "id",
  "obligations",
  "commit",
  "tree",
  "path",
  "raw_hash",
  "canonical_hash",
  "claim_boundary",
  "review_state",
  "predicate_type",
  "candidate_binding",
  "tested_implementation_digest",
  "tested_envelope_digest",
  "dependency_lock_digest",
  "migration_set_digest",
  "runtime_identity_hash",
  "configuration_digest",
  "evidence_bundle_hash",
  "release_binding_hash",
  "statement_digest",
  "first_non_pass",
  "name",
  "expected_digest",
  "observed_digest",
  "sbom_digest",
  "artifact_name",
  "raw_digest",
  "canonical_digest",
  "topology",
  "runtime",
  "platform",
  "workload",
  "node",
  "os",
  "architecture",
  "sqlite",
  "filesystem",
  "operation",
  "status",
  "evidence_ref",
  "error_code",
  "control_id",
  "purpose",
  "decision",
  "authority_key_id",
  "signature_algorithm",
  "issued_at",
  "expires_at",
  "verification_time",
  "signature",
  "public_key_spki_base64url",
  "valid_from",
  "revoked_at",
]);

function assertCanonicalEvidenceArgvValue(value, label) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((token) => typeof token !== "string") ||
    !STATIC_EVIDENCE_ARGV.some(
      (expected) => canonicalJson(value) === canonicalJson(expected),
    )
  ) {
    throw new Error(`G6 ${label} is not canonical argv`);
  }
  return value;
}

export function canonicalEvidenceArgv(program, args) {
  if (
    typeof program !== "string" ||
    !Array.isArray(args) ||
    args.some((entry) => typeof entry !== "string")
  ) {
    throw new Error("G6 command is not canonical argv");
  }
  if (
    program === "pnpm" &&
    args.length === 5 &&
    args[0] === "vitest" &&
    args[1] === "run" &&
    typeof args[2] === "string" &&
    args[2].startsWith("tests/") &&
    !args[2].startsWith("tests/../") &&
    args[3] === "-t" &&
    typeof args[4] === "string" &&
    args[4].length > 0
  ) {
    return [
      "pnpm",
      "vitest",
      "run",
      "<test-file>",
      "-t",
      "<test-name>",
    ];
  }
  if (
    program === "pnpm" &&
    canonicalJson(args) ===
      canonicalJson([
        "-r",
        "--config.offline=true",
        "rebuild",
        "--pending",
      ])
  ) {
    return [
      "pnpm",
      "-r",
      "--config.offline=true",
      "rebuild",
      "--pending",
    ];
  }
  const argv = [program, ...args];
  assertCanonicalEvidenceArgvValue(argv, "command");
  return argv;
}

export function assertCanonicalRunbookAutomation(value, label = "automation") {
  if (
    typeof value !== "string" ||
    FORBIDDEN_EVIDENCE_MARKER.test(value) ||
    !CANONICAL_RUNBOOK_AUTOMATION.includes(value)
  ) {
    throw new Error(`G6 ${label} automation is invalid`);
  }
  return value;
}

function assertEvidenceString(entry, key, ancestors) {
  if (
    FORBIDDEN_EVIDENCE_VALUE.test(entry) ||
    FORBIDDEN_EVIDENCE_MARKER.test(entry) ||
    [...entry].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined &&
        (codePoint <= 0x1f || codePoint === 0x7f);
    })
  ) {
    throw new Error("G6 evidence contains a secret-bearing value");
  }
  if (key === "automation") {
    assertCanonicalRunbookAutomation(entry);
    return;
  }
  if (
    key === "claim_boundary" &&
    entry !== "exact local evaluation thresholds; not a production SLO"
  ) {
    throw new Error("G6 evidence claim boundary is invalid");
  }
  if (key === "path" || key === "artifact_name") {
    if (!SOURCE_PATH_PATTERN.test(entry)) {
      throw new Error(`G6 evidence ${key} is not a repository path`);
    }
    return;
  }
  if (
    key === "allowed_evidence_artifacts" ||
    key === "allowed_decision_artifacts"
  ) {
    if (!SOURCE_PATH_PATTERN.test(entry)) {
      throw new Error(`G6 evidence ${key} is not a repository path`);
    }
    return;
  }
  if (key === "commit" || key === "tree") {
    if (!/^[a-f0-9]{40}$/u.test(entry)) {
      throw new Error(`G6 evidence ${key} is invalid`);
    }
    return;
  }
  if (
    key !== undefined &&
    (key.endsWith("_hash") ||
      key.endsWith("_digest") ||
      key === "expected_digest" ||
      key === "observed_digest")
  ) {
    if (!SHA256_PATTERN.test(entry)) {
      throw new Error(`G6 evidence ${key} is not canonical SHA-256`);
    }
    return;
  }
  if (
    key !== undefined &&
    !ALLOWED_EVIDENCE_STRING_KEYS.has(key) &&
    !SHA256_PATTERN.test(entry) &&
    !/^\d{4}-\d{2}-\d{2}T/u.test(entry) &&
    !["pass", "fail", "blocked"].includes(entry)
  ) {
    throw new Error(`G6 evidence string field ${key} is not allowlisted`);
  }
  if (
    key !== undefined &&
    ALLOWED_EVIDENCE_STRING_KEYS.has(key) &&
    key !== "claim_boundary" &&
    !IDENTIFIER_PATTERN.test(entry) &&
    !/^\d{4}-\d{2}-\d{2}T/u.test(entry) &&
    !/^[A-Za-z0-9_-]{43,128}$/u.test(entry)
  ) {
    throw new Error(`G6 evidence string field ${key} is invalid`);
  }
  if (
    key === "path" &&
    !ancestors.includes("source_bindings")
  ) {
    throw new Error("G6 paths are allowed only for source bindings");
  }
}

export function assertContentFreeEvidence(value) {
  const visit = (entry, ancestors) => {
    if (Array.isArray(entry)) {
      if (ancestors.at(-1) === "command") {
        assertCanonicalEvidenceArgvValue(entry, "command");
        return;
      }
      entry.forEach((item) => visit(item, ancestors));
      return;
    }
    if (typeof entry === "string") {
      const key = ancestors.at(-1);
      assertEvidenceString(entry, key, ancestors);
      return;
    }
    if (entry === null || typeof entry !== "object") return;
    for (const [key, child] of Object.entries(entry)) {
      if (FORBIDDEN_EVIDENCE_KEY.test(key)) {
        throw new Error(`G6 evidence field ${key} is forbidden`);
      }
      const next = [...ancestors, key];
      if (
        key === "raw_hash" &&
        !ancestors.includes("source_bindings")
      ) {
        throw new Error("G6 raw hash is allowed only for source bindings");
      }
      if (
        key === "path" &&
        !ancestors.includes("source_bindings")
      ) {
        throw new Error("G6 paths are allowed only for source bindings");
      }
      if (
        typeof child === "string" &&
        child.startsWith("/")
      ) {
        throw new Error("G6 absolute paths are forbidden");
      }
      visit(child, next);
    }
  };
  visit(value, []);
  return value;
}

export function runEvidenceProofs(proofs, expectedObligations, label) {
  assertUnique(
    proofs.map(({ id }) => id),
    `${label} proof`,
  );
  const obligations = proofs.flatMap(({ obligations }) => obligations);
  assertUnique(obligations, `${label} proof obligation`);
  assertExact(
    [...obligations].sort(),
    [...expectedObligations].sort(),
    `${label} proof obligation`,
  );
  return proofs.map(({ id, obligations: mapped, program, args }) => {
    if (
      typeof program !== "string" ||
      program.length === 0 ||
      !Array.isArray(args) ||
      args.some((argument) => typeof argument !== "string")
    ) {
      throw new Error(`G6 ${label} proof command is invalid`);
    }
    return {
      id,
      obligations: mapped,
      ...runEvidenceCommand(program, args),
    };
  });
}

export function deriveProofStates(proofs, expectedObligations, label) {
  const proofIds = proofs.map(({ id }) => id);
  assertUnique(proofIds, `${label} proof`);
  const states = new Map();
  for (const proof of proofs) {
    if (!["pass", "fail", "blocked"].includes(proof.state)) {
      throw new Error(`G6 ${label} proof state is invalid`);
    }
    const independentlyObservedState =
      proof.obligations.length === 1 ? proof.state : "blocked";
    for (const obligation of proof.obligations) {
      if (states.has(obligation)) {
        throw new Error(`G6 ${label} proof obligation is duplicated`);
      }
      states.set(obligation, independentlyObservedState);
    }
  }
  assertExact(
    [...states.keys()].sort(),
    [...expectedObligations].sort(),
    `${label} proof obligation`,
  );
  return Object.fromEntries(
    [...states.entries()].sort(([left], [right]) =>
      compareUnicode(left, right),
    ),
  );
}

export function writeCanonicalJson(relativePath, value) {
  assertContentFreeEvidence(value);
  const absolute = resolve(repositoryRoot, relativePath);
  mkdirSync(resolve(absolute, ".."), { recursive: true });
  writeFileSync(absolute, `${canonicalJson(value)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function gitText(args) {
  const result = spawnSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`G6 git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

export function currentCandidateIdentity() {
  const dirtyLines = gitText(["status", "--porcelain"])
    .split("\n")
    .filter(Boolean);
  const dirtyPaths = dirtyLines.map((line) => line.slice(3));
  const allowedPrefixes = [
    "docs/evaluations/g6-",
  ];
  return {
    commit: gitText(["rev-parse", "HEAD"]),
    tree: gitText(["rev-parse", "HEAD^{tree}"]),
    dirty_count: dirtyPaths.length,
    dirty_paths_allowed:
      dirtyPaths.length === 0 ||
      dirtyPaths.every((path) =>
        allowedPrefixes.some((prefix) => path.startsWith(prefix)),
      ),
  };
}

export function runEvidenceCommand(command, args, options = {}) {
  const evidenceArgv = canonicalEvidenceArgv(command, args);
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      ...(options.env ?? {}),
    },
    timeout: options.timeoutMs ?? 600_000,
  });
  return {
    command: evidenceArgv,
    state:
      result.error?.code === "ETIMEDOUT"
        ? "blocked"
        : result.status === 0
          ? "pass"
          : "fail",
    exit_code: result.status,
    signal: result.signal,
  };
}
