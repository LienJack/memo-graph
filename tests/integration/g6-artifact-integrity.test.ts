import {
  chmodSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  G6ReleaseControlSchema,
  G6ReleaseControlTrustSchema,
  RuntimeIdentitySchema,
  canonicalSha256,
} from "../../packages/contracts/src/index.js";
import { G6ReleaseControlArtifactSchema } from "../../apps/operator-cli/src/config.js";
import { verifyG6Candidate } from "../../apps/operator-cli/src/commands/g6.js";
import { verifyExactG6ReleaseControl } from "../../packages/storage-sqlite/src/release-control.js";
import {
  G6_EVIDENCE_PATHS,
  G6_HARD_RULE_ORDER,
  assertExactG6EvidencePaths,
  canonicalJson,
  evaluateFirstFalse,
  loadG6Fixture,
} from "../../scripts/g6-evidence-common.mjs";
import { buildG6RuntimeIdentity } from "../../scripts/build-g6-runtime-identity.mjs";
import { buildG6ReleaseControl } from "../../scripts/build-g6-release-control.mjs";
import {
  initializeG6Authority,
  validateG6LifecycleInventory,
  verifyG6Provenance,
} from "../../scripts/g6-bootstrap.mjs";
import {
  deriveG6HardRules,
  deriveG6ReportState,
  validateG6CodeReviewArtifact,
} from "../../scripts/verify-g6-evidence.mjs";

const cleanup: string[] = [];
const descriptors: number[] = [];

function syntheticVerification(
  identity: ReturnType<typeof buildG6RuntimeIdentity>,
  options: {
    eligible?: boolean;
    evidenceBundleHash?: `sha256:${string}`;
  } = {},
) {
  const eligible = options.eligible ?? true;
  return {
    schema_version: "1.0.0" as const,
    gate: "G6" as const,
    state: eligible ? ("pass" as const) : ("fail" as const),
    eligible,
    first_non_pass: eligible ? null : "integrity",
    decision_recorded: false as const,
    current_control_verified: false as const,
    evidence_bundle_hash:
      options.evidenceBundleHash ??
      canonicalSha256("synthetic-g6-evidence"),
    runtime_identity_hash:
      identity.runtime_identity_hash as `sha256:${string}`,
    tested_implementation_digest:
      identity.tested_implementation_digest as `sha256:${string}`,
  };
}

afterEach(() => {
  while (descriptors.length > 0) {
    const descriptor = descriptors.pop();
    if (descriptor !== undefined) closeSync(descriptor);
  }
  while (cleanup.length > 0) {
    const path = cleanup.pop();
    if (path !== undefined) {
      rmSync(path, { recursive: true, force: true });
    }
  }
});

describe("G6 harness integrity", () => {
  it("creates and reopens only a private durable decision-authority seed", () => {
    const root = realpathSync(
      mkdtempSync(join(realpathSync(tmpdir()), "memo-graph-g6-authority-")),
    );
    cleanup.push(root);
    const authorityDirectory = join(root, "authority");
    mkdirSync(authorityDirectory, { mode: 0o700 });
    const seedPath = join(authorityDirectory, "decision.seed");
    const first = initializeG6Authority(seedPath);
    const second = initializeG6Authority(seedPath);
    expect(second).toEqual(first);
    expect(statSync(seedPath).size).toBe(32);
    expect(statSync(seedPath).mode & 0o777).toBe(0o600);

    const symlinkTarget = join(authorityDirectory, "target.seed");
    const symlinkPath = join(authorityDirectory, "symlink.seed");
    writeFileSync(symlinkTarget, Buffer.alloc(32, 0x41), { mode: 0o600 });
    symlinkSync(symlinkTarget, symlinkPath);
    expect(() => initializeG6Authority(symlinkPath)).toThrow();

    const oversizedPath = join(authorityDirectory, "oversized.seed");
    writeFileSync(oversizedPath, Buffer.alloc(33, 0x42), { mode: 0o600 });
    expect(() => initializeG6Authority(oversizedPath)).toThrow(
      "permissions are invalid",
    );
  });

  it("builds a schema-valid runtime identity from an evidence-excluding allowlist", () => {
    const fixture = loadG6Fixture();
    const identity = buildG6RuntimeIdentity();
    expect(identity.tested_implementation_digest).toBe(
      fixture.runtime_inputs.tested_implementation_digest,
    );
    expect(identity.tested_envelope_digest).toMatch(
      /^sha256:[a-f0-9]{64}$/u,
    );
    expect(identity.configuration_digest).toMatch(
      /^sha256:[a-f0-9]{64}$/u,
    );
    expect(
      fixture.runtime_inputs.paths.every(
        ({ path }) =>
          !path.startsWith("docs/evaluations/g6-") &&
          !path.includes("/07-30-agent-memory-runtime-m6/"),
      ),
    ).toBe(true);
  });

  it("rejects a candidate signer unless the runtime identity commits its authority", () => {
    const root = realpathSync(
      mkdtempSync(join(realpathSync(tmpdir()), "memo-graph-g6-signer-")),
    );
    cleanup.push(root);
    const keyPath = join(root, "decision-key.seed");
    writeFileSync(keyPath, Buffer.alloc(32, 0x6a), { mode: 0o600 });
    const keyDescriptor = openSync(keyPath, "r");
    descriptors.push(keyDescriptor);
    const identity = buildG6RuntimeIdentity();
    const result = buildG6ReleaseControl({
      verification: syntheticVerification(identity),
      runtimeIdentity: identity,
      controlId: "g6-control:synthetic-integrity",
      issuedAt: "2026-07-30T08:00:00.000Z",
      expiresAt: "2026-07-30T08:05:00.000Z",
      privateKeyDescriptor: keyDescriptor,
      authorityKeyId: "g6-authority:synthetic-integrity",
      authorityKeyGeneration: 1,
    });
    const control = G6ReleaseControlSchema.parse(result.control);
    const trust = G6ReleaseControlTrustSchema.parse(result.trust);
    expect(
      G6ReleaseControlArtifactSchema.parse({
        ...result,
        verification_time: "2026-07-30T08:01:00.000Z",
      }).control,
    ).toEqual(control);
    expect(() =>
      verifyExactG6ReleaseControl({
        control,
        trust,
        runtimeIdentity: identity,
        now: "2026-07-30T08:01:00.000Z",
      }),
    ).toThrowError(expect.objectContaining({ code: "ENCRYPTION_REQUIRED" }));
    const {
      runtime_identity_hash: _runtimeIdentityHash,
      ...identityBase
    } = identity;
    void _runtimeIdentityHash;
    const syntheticIdentityBase = {
      ...identityBase,
      decision_authority_hash: canonicalSha256(trust),
    };
    const syntheticIdentity = RuntimeIdentitySchema.parse({
      ...syntheticIdentityBase,
      runtime_identity_hash: canonicalSha256(syntheticIdentityBase),
    });
    const trustedResult = buildG6ReleaseControl({
      verification: syntheticVerification(syntheticIdentity),
      runtimeIdentity: syntheticIdentity,
      controlId: "g6-control:synthetic-trusted",
      issuedAt: "2026-07-30T08:00:00.000Z",
      expiresAt: "2026-07-30T08:05:00.000Z",
      privateKeyDescriptor: keyDescriptor,
      authorityKeyId: "g6-authority:synthetic-integrity",
      authorityKeyGeneration: 1,
    });
    const trustedControl = G6ReleaseControlSchema.parse(
      trustedResult.control,
    );
    expect(
      verifyExactG6ReleaseControl({
        control: trustedControl,
        trust,
        runtimeIdentity: syntheticIdentity,
        now: "2026-07-30T08:01:00.000Z",
      }),
    ).toEqual(trustedControl);
    expect(control.control_id).toContain(
      result.evidence_binding.evidence_bundle_hash.slice("sha256:".length),
    );
  });

  it("rejects permissive key files, invalid evidence bindings, and unsafe controls", () => {
    const root = realpathSync(
      mkdtempSync(join(realpathSync(tmpdir()), "memo-graph-g6-refusal-")),
    );
    cleanup.push(root);
    const keyPath = join(root, "decision-key.seed");
    writeFileSync(keyPath, Buffer.alloc(32, 0x5c), { mode: 0o600 });
    const identity = buildG6RuntimeIdentity();

    chmodSync(keyPath, 0o644);
    const permissiveDescriptor = openSync(keyPath, "r");
    descriptors.push(permissiveDescriptor);
    expect(() =>
      buildG6ReleaseControl({
        verification: syntheticVerification(identity),
        runtimeIdentity: identity,
        controlId: "g6-control:permissive",
        issuedAt: "2026-07-30T08:00:00.000Z",
        expiresAt: "2026-07-30T08:05:00.000Z",
        privateKeyDescriptor: permissiveDescriptor,
        authorityKeyId: "g6-authority:refusal",
        authorityKeyGeneration: 1,
      }),
    ).toThrow("mode-0600");

    chmodSync(keyPath, 0o600);
    const restrictedDescriptor = openSync(keyPath, "r");
    descriptors.push(restrictedDescriptor);
    expect(() =>
      buildG6ReleaseControl({
        verification: {
          ...syntheticVerification(identity, { eligible: false }),
          state: "pass",
        },
        runtimeIdentity: identity,
        controlId: "g6-control:unsafe-no-go",
        issuedAt: "2026-07-30T08:00:00.000Z",
        expiresAt: "2026-07-30T08:05:00.000Z",
        privateKeyDescriptor: restrictedDescriptor,
        authorityKeyId: "g6-authority:refusal",
        authorityKeyGeneration: 1,
      }),
    ).toThrow("not signable");
    expect(() =>
      buildG6ReleaseControl({
        verification: syntheticVerification(identity, {
          evidenceBundleHash:
            "not-a-binding" as `sha256:${string}`,
        }),
        runtimeIdentity: identity,
        controlId: "g6-control:unbound",
        issuedAt: "2026-07-30T08:00:00.000Z",
        expiresAt: "2026-07-30T08:05:00.000Z",
        privateKeyDescriptor: restrictedDescriptor,
        authorityKeyId: "g6-authority:refusal",
        authorityKeyGeneration: 1,
      }),
    ).toThrow("canonical SHA-256");
  });

  it("freezes exact U7 evidence paths and leaves the current control absent", () => {
    expect(() => assertExactG6EvidencePaths(G6_EVIDENCE_PATHS)).not.toThrow();
    expect(() =>
      assertExactG6EvidencePaths(G6_EVIDENCE_PATHS.slice(1)),
    ).toThrow("evidence path set");
    expect(() =>
      assertExactG6EvidencePaths([
        ...G6_EVIDENCE_PATHS,
        "docs/evaluations/g6-unbound.json",
      ]),
    ).toThrow("evidence path set");
    expect(loadG6Fixture().release_control.current_control).toBeNull();
  });

  it("never qualifies missing, false, or blocked critical rules", () => {
    const pass = Object.fromEntries(
      G6_HARD_RULE_ORDER.map((rule) => [rule, true]),
    );
    expect(evaluateFirstFalse(pass).eligible).toBe(true);
    const missing = { ...pass };
    const lastRule = G6_HARD_RULE_ORDER.at(-1);
    if (lastRule === undefined) throw new Error("hard rules are empty");
    Reflect.deleteProperty(missing, lastRule);
    expect(evaluateFirstFalse(missing).eligible).toBe(false);
    expect(
      evaluateFirstFalse({ ...pass, supply_chain: "blocked" }).eligible,
    ).toBe(false);
  });

  it("independently derives report failure and registry blocking", () => {
    expect(
      deriveG6ReportState("fault", {
        commands: [
          { obligations: ["synthetic:fault"], state: "pass" },
        ],
        oracles: { old_or_new: true },
        acceptance_examples: {
          M6_AE1: {
            success_oracle: true,
            failure_oracle: false,
          },
        },
      }),
    ).toBe("fail");
    const supplyChainReport = (
      state: "pass" | "blocked",
      registryAvailable: boolean,
    ) => {
      const nativeState = state;
      const checks = {
        source_clean: "pass",
        package_policy: "pass",
        lock_store_tarball: "pass",
        lifecycle_inventory: "pass",
        approved_native_builds: nativeState,
        runtime_downloads: "pass",
        sbom: "pass",
        provenance: "pass",
        vulnerability_audit: state,
        waiver_expiry: "pass",
      };
      return {
        checks,
        first_non_pass:
          state === "pass" ? null : "approved_native_builds",
        bootstrap: {
          scripts_disabled_install: { state: "pass" },
          store_tarball_integrity: { state: "pass" },
          lifecycle_inventory: {
            state: "pass",
            pending_build_count: 1,
            approved_pending_count: 1,
            ignored_unapproved_count: 0,
            source_binding_count: 1,
            policy_allowlist_exact: true,
            pending_entries_valid: true,
            pending_entries_unique: true,
            pending_builds_digest: canonicalSha256(
              "synthetic-pending-builds",
            ),
            approved_pending_sources_digest: canonicalSha256(
              "synthetic-pending-sources",
            ),
          },
          approved_package_build: { state: nativeState },
          approved_local_native_build: { state: nativeState },
          dependency_inventory: { state: "pass" },
          provenance: { state: "pass" },
        },
        runtime_download_scan: { state: "pass" },
        audit: {
          state,
          registry_available: registryAvailable,
        },
        native_outputs: {
          state: nativeState,
          outputs: state === "pass" ? [{ verified: true }] : [],
        },
      };
    };
    expect(
      deriveG6ReportState(
        "supply_chain",
        supplyChainReport("blocked", false),
      ),
    ).toBe("blocked");
    expect(
      deriveG6ReportState(
        "supply_chain",
        supplyChainReport("pass", false),
      ),
    ).toBe("fail");
  });

  it("uses production eligibility logic to reject resource and runbook failures", () => {
    const passStates = {
      fault: "pass",
      resource: "pass",
      runbook: "pass",
      security: "pass",
      supply_chain: "pass",
    } as const;
    expect(
      evaluateFirstFalse(
        deriveG6HardRules({
          states: passStates,
          bindingPassed: true,
          codeReviewPassed: true,
        }),
      ).eligible,
    ).toBe(true);
    expect(
      evaluateFirstFalse(
        deriveG6HardRules({
          states: { ...passStates, resource: "fail" },
          bindingPassed: true,
          codeReviewPassed: true,
        }),
      ),
    ).toMatchObject({
      eligible: false,
      first_non_pass: "integrity",
    });
    expect(
      evaluateFirstFalse(
        deriveG6HardRules({
          states: { ...passStates, runbook: "blocked" },
          bindingPassed: true,
          codeReviewPassed: true,
        }),
      ),
    ).toMatchObject({
      eligible: false,
      first_non_pass: "binding",
    });
  });

  it("fails closed when candidate-bound provenance is missing or tampered", () => {
    expect(verifyG6Provenance().state).toBe("pass");
    expect(
      verifyG6Provenance({
        ...loadG6Fixture().supply_chain_policy,
      }),
    ).toMatchObject({ state: "fail" });
    const provenance = JSON.parse(
      readFileSync("fixtures/g6/security/provenance.json", "utf8"),
    ) as Record<string, unknown>;
    expect(
      verifyG6Provenance({
        ...provenance,
        tested_implementation_digest: canonicalSha256("tampered"),
      }),
    ).toMatchObject({ state: "fail" });
  });

  it("requires every pending lifecycle build to match the frozen package, version, and source integrity", () => {
    const policy = JSON.parse(
      readFileSync(
        "fixtures/g6/security/supply-chain-policy.json",
        "utf8",
      ),
    ) as Record<string, unknown>;
    const lockText = readFileSync("pnpm-lock.yaml", "utf8");
    const approved = validateG6LifecycleInventory({
      policy,
      pendingBuilds: [
        "better-sqlite3@13.0.1",
        "esbuild@0.28.1",
      ],
      lockText,
    });
    expect(approved).toMatchObject({
      state: "pass",
      pending_build_count: 2,
      approved_pending_count: 2,
      ignored_unapproved_count: 0,
      source_binding_count: 2,
    });

    expect(
      validateG6LifecycleInventory({
        policy,
        pendingBuilds: [
          "better-sqlite3@13.0.1",
          "protobufjs@7.6.5",
        ],
        lockText,
      }),
    ).toMatchObject({
      state: "pass",
      pending_build_count: 2,
      approved_pending_count: 2,
      ignored_unapproved_count: 0,
      source_binding_count: 2,
    });

    expect(
      validateG6LifecycleInventory({
        policy,
        pendingBuilds: [
          "better-sqlite3@13.0.1",
          "unapproved-native@1.0.0",
        ],
        lockText,
      }),
    ).toMatchObject({
      state: "fail",
      pending_build_count: 2,
      approved_pending_count: 1,
      ignored_unapproved_count: 1,
    });

    expect(
      validateG6LifecycleInventory({
        policy,
        pendingBuilds: ["better-sqlite3@13.0.1"],
        lockText: lockText.replace(
          "sha512-LYpmOXdkpQYf4wmlxkdzW01XGlOXNIbjLg45yNkh0FQ4814VbK9PdOFmhZpYbej+EZtR/i3FDdhEG98HqZdgnA==",
          "sha512-tampered-native-source",
        ),
      }),
    ).toMatchObject({
      state: "fail",
      source_binding_count: 0,
    });

    expect(
      validateG6LifecycleInventory({
        policy,
        pendingBuilds: [
          "better-sqlite3@13.0.1",
          "better-sqlite3@13.0.1",
        ],
        lockText,
      }),
    ).toMatchObject({
      state: "fail",
      pending_entries_unique: false,
    });
    expect(
      validateG6LifecycleInventory({
        policy,
        pendingBuilds: ["better-sqlite3@13.0.1", { invalid: true }],
        lockText,
      }),
    ).toMatchObject({
      state: "fail",
      pending_entries_valid: false,
    });
  });

  it("accepts only a canonical content-free candidate-bound code-review report", () => {
    const candidate = {
      commit: "a".repeat(40),
      tree: "b".repeat(40),
      tested_implementation_digest: canonicalSha256(
        "synthetic-code-review-candidate",
      ),
    };
    const lenses = [
      "correctness",
      "maintainability",
      "testing",
      "project-standards",
      "security",
      "data-integrity",
      "reliability",
      "performance",
      "api-contract",
    ].map((id) => ({
      id,
      state: "pass",
      unresolved_p0: 0,
      unresolved_p1: 0,
    }));
    const report = {
      schema_version: "1.0.0",
      gate: "G6",
      family: "independent_review",
      candidate,
      review_state: "pass",
      lenses,
      unresolved_p0: 0,
      unresolved_p1: 0,
      lower_priority_debt_recorded: true,
    };
    const canonicalReport = `${canonicalJson(report)}\n`;
    expect(
      validateG6CodeReviewArtifact(canonicalReport, candidate),
    ).toMatchObject({ passed: true });
    expect(() =>
      validateG6CodeReviewArtifact(
        `${JSON.stringify(report)}\n`,
        candidate,
      ),
    ).toThrow("canonical");
    expect(() =>
      validateG6CodeReviewArtifact(
        `${canonicalReport}review_state: pass\nPRIVATE_MEMORY_MARKER_48291`,
        candidate,
      ),
    ).toThrow();
    expect(() =>
      validateG6CodeReviewArtifact(canonicalReport, {
        ...candidate,
        tree: "d".repeat(40),
      }),
    ).toThrow("candidate");
  });

  it("parses the real verification-report contract instead of hashing a reference", () => {
    const hash = canonicalSha256("g6-report-contract");
    const report = {
      schema_version: "1.0.0",
      gate: "G6",
      state: "pass",
      eligible: true,
      first_non_pass: null,
      decision_recorded: false,
      current_control_verified: false,
      evidence_bundle_hash: hash,
      runtime_identity_hash: hash,
      tested_implementation_digest: hash,
      hard_rules: Object.fromEntries(
        G6_HARD_RULE_ORDER.map((rule) => [rule, true]),
      ),
      report_states: {
        fault: "pass",
        resource: "pass",
        runbook: "pass",
        security: "pass",
        supply_chain: "pass",
      },
      exact_environment: { runtime: "node-24.18.0" },
      topology: "single-user-single-root-single-writer-stdio",
      source_bindings: [{}],
    };
    expect(
      verifyG6Candidate({
        evidenceRef: "verification:g6",
        report,
      }),
    ).toMatchObject({
      status: "verified",
      eligible: true,
      evidence_bundle_hash: hash,
    });
    expect(() =>
      verifyG6Candidate({
        evidenceRef: "verification:g6",
        report: {
          ...report,
          hard_rules: { ...report.hard_rules, integrity: false },
        },
      }),
    ).toThrow();
  });
});
