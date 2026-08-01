import { describe, expect, it } from "vitest";

import {
  G6_HARD_RULE_ORDER,
  deriveProofStates,
  evaluateFirstFalse,
  loadG6Fixture,
  validateG6Fixture,
} from "../../scripts/g6-evidence-common.mjs";
import { parseOperatorArguments } from "../../apps/operator-cli/src/cli.js";

function clone<T>(value: T): T {
  return structuredClone(value);
}

function first<T>(values: T[]): T {
  const value = values[0];
  if (value === undefined) throw new Error("expected non-empty fixture");
  return value;
}

describe("frozen G6 operational-hardening fixtures", () => {
  it("binds every prior gate, M6 AE, evidence family, fault, workload, and runbook", () => {
    const fixture = loadG6Fixture();
    expect(() => validateG6Fixture(fixture)).not.toThrow();
    expect(fixture.prior_gates.map(({ gate }) => gate)).toEqual([
      "G3R",
      "G4A",
      "G4B",
      "G5",
    ]);
    expect(fixture.acceptance_examples.map(({ id }) => id)).toEqual([
      "M6_AE1",
      "M6_AE2",
      "M6_AE3",
      "M6_AE4",
      "M6_AE5",
      "M6_AE6",
      "M6_AE7",
      "M6_AE8",
    ]);
    expect(
      fixture.acceptance_examples.every(
        ({ oracles }) =>
          oracles.includes("success") && oracles.includes("failure"),
      ),
    ).toBe(true);
    expect(fixture.hard_rule_order).toEqual(G6_HARD_RULE_ORDER);
    expect(fixture.configuration).toMatchObject({
      graph_enabled: false,
      vector_enabled: false,
      automatic_learning_publication: false,
    });
  });

  it.each([
    "evidence family",
    "fault point",
    "workload",
    "runbook step",
    "acceptance example",
    "prior gate",
  ])("rejects a missing or duplicate %s", (dimension) => {
    const fixture = loadG6Fixture();
    const changed = clone(fixture);
    if (dimension === "evidence family") {
      changed.evidence_families.push(first(changed.evidence_families));
    } else if (dimension === "fault point") {
      changed.fault_points.pop();
    } else if (dimension === "workload") {
      changed.workloads = [];
    } else if (dimension === "runbook step") {
      changed.runbook_steps[1] = first(changed.runbook_steps);
    } else if (dimension === "acceptance example") {
      changed.acceptance_examples.pop();
    } else {
      changed.prior_gates.pop();
    }
    expect(() => validateG6Fixture(changed)).toThrow(dimension);
  });

  it("rejects changed hard-rule order, empty critical groups, and unsafe topology", () => {
    const fixture = loadG6Fixture();
    const reordered = clone(fixture);
    reordered.hard_rule_order.reverse();
    expect(() => validateG6Fixture(reordered)).toThrow("hard-rule order");

    const empty = clone(fixture);
    empty.critical_rule_groups.security = [];
    expect(() => validateG6Fixture(empty)).toThrow("critical group");

    for (const key of [
      "graph_enabled",
      "vector_enabled",
      "automatic_learning_publication",
    ] as const) {
      const unsafe = clone(fixture);
      unsafe.configuration[key] = true;
      expect(() => validateG6Fixture(unsafe)).toThrow(key);
    }
  });

  it("rejects threshold, environment, partition, fixture, and prior-gate drift", () => {
    const fixture = loadG6Fixture();

    const threshold = clone(fixture);
    Reflect.deleteProperty(threshold.thresholds.admission, "max_queue_depth");
    expect(() => validateG6Fixture(threshold)).toThrow("threshold");

    const environment = clone(fixture);
    environment.thresholds.environment.platform = "linux-x64";
    expect(() => validateG6Fixture(environment)).toThrow("environment");

    const partition = clone(fixture);
    partition.partition_policy.security = "fixtures/g6/recovery";
    expect(() => validateG6Fixture(partition)).toThrow("partition");

    const binding = clone(fixture);
    first(binding.fixture_bindings).raw_hash = `sha256:${"0".repeat(
      64,
    )}`;
    expect(() => validateG6Fixture(binding)).toThrow("fixture binding");

    const priorGate = clone(fixture);
    first(priorGate.prior_gates).artifact_sha256 = `sha256:${"0".repeat(
      64,
    )}`;
    expect(() => validateG6Fixture(priorGate)).toThrow("prior gate");
  });

  it("rejects unsafe supply-chain, authority, and release-control drift", () => {
    const fixture = loadG6Fixture();

    const registry = clone(fixture);
    registry.supply_chain.registry_unavailable = "pass";
    expect(() => validateG6Fixture(registry)).toThrow("supply-chain");

    const nativeBuild = clone(fixture);
    nativeBuild.supply_chain_policy.approved_native_builds.push(
      "unreviewed-native-addon",
    );
    expect(() => validateG6Fixture(nativeBuild)).toThrow("supply-chain");

    const nativeOutput = clone(fixture);
    first(
      nativeOutput.supply_chain_policy.approved_native_outputs,
    ).raw_digest = `sha256:${"0".repeat(64)}`;
    expect(() => validateG6Fixture(nativeOutput)).toThrow(
      "native output binding",
    );

    const authority = clone(fixture);
    authority.decision_authority.public_key_spki_base64url = "unknown";
    expect(() => validateG6Fixture(authority)).toThrow(
      "decision authority",
    );

    const release = clone(fixture);
    first(
      release.release_control.scenarios.slice(2),
    ).secret_admission_allowed = true;
    expect(() => validateG6Fixture(release)).toThrow(
      "release-control",
    );
  });

  it("rejects runtime inputs that enter evidence or decision partitions", () => {
    const fixture = loadG6Fixture();
    const evidence = clone(fixture);
    evidence.runtime_inputs.paths.push({
      path: "docs/evaluations/g6-fault-report.json",
      kind: "file",
    });
    expect(() => validateG6Fixture(evidence)).toThrow(
      "evidence or decision path",
    );

    const decision = clone(fixture);
    decision.runtime_inputs.paths.push({
      path: ".trellis/tasks/07-30-agent-memory-runtime-m6/task.json",
      kind: "file",
    });
    expect(() => validateG6Fixture(decision)).toThrow(
      "evidence or decision path",
    );
  });

  it("rejects missing or duplicate executable proof obligations", () => {
    const fixture = loadG6Fixture();
    const duplicateFault = clone(fixture);
    const firstGroup = first(
      duplicateFault.fault_fixture.fault_groups as Array<{
        fault_points: string[];
      }>,
    );
    const secondGroup = duplicateFault.fault_fixture.fault_groups[1] as
      | { fault_points: string[] }
      | undefined;
    if (secondGroup === undefined) throw new Error("expected fault groups");
    secondGroup.fault_points[0] = first(firstGroup.fault_points);
    expect(() => validateG6Fixture(duplicateFault)).toThrow(
      "fault proof obligation",
    );

    const missingResource = clone(fixture);
    missingResource.resource_fixture.proofs.pop();
    expect(() => validateG6Fixture(missingResource)).toThrow(
      "resource proof obligation",
    );

    const invalidRunbook = clone(fixture);
    first(invalidRunbook.runbook_fixture.steps).automation =
      "operator imaginary --json";
    expect(() => validateG6Fixture(invalidRunbook)).toThrow(
      "automation",
    );
  });

  it("blocks every claim that shares one aggregate proof result", () => {
    expect(
      deriveProofStates(
        [
          {
            id: "aggregate-proof",
            obligations: ["oracle:a", "oracle:b"],
            command: ["pnpm", "vitest"],
            state: "pass",
            exit_code: 0,
            signal: null,
          },
        ],
        ["oracle:a", "oracle:b"],
        "aggregate",
      ),
    ).toEqual({
      "oracle:a": "blocked",
      "oracle:b": "blocked",
    });
  });

  it("parses every frozen runbook automation with the actual CLI grammar", () => {
    const fixture = loadG6Fixture();
    for (const step of fixture.runbook_fixture.steps) {
      expect(() =>
        parseOperatorArguments(step.automation.split(" ")),
      ).not.toThrow();
    }
  });

  it("selects the first false or blocked rule deterministically", () => {
    const allTrue = Object.fromEntries(
      G6_HARD_RULE_ORDER.map((rule) => [rule, true]),
    );
    expect(evaluateFirstFalse(allTrue)).toEqual({
      eligible: true,
      first_non_pass: null,
      state: "pass",
    });
    expect(
      evaluateFirstFalse({
        ...allTrue,
        restore: false,
        supply_chain: "blocked",
      }),
    ).toEqual({
      eligible: false,
      first_non_pass: "restore",
      state: "fail",
    });
    expect(
      evaluateFirstFalse({
        ...allTrue,
        supply_chain: "blocked",
      }),
    ).toEqual({
      eligible: false,
      first_non_pass: "supply_chain",
      state: "blocked",
    });
  });
});
