import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  assertContentFreeEvidence,
  loadG6Fixture,
} from "../../scripts/g6-evidence-common.mjs";

describe("G6 content-free evidence boundary", () => {
  it.each([
    { raw_path: "/Users/example/private.db" },
    { plaintext: "private memory" },
    { ciphertext: "opaque-but-content-bearing" },
    { key_material: "not-allowed" },
    { content_hash: `sha256:${"a".repeat(64)}` },
    { production_slo: "99.99%" },
    { fleet_claim: true },
    { multi_platform_claim: true },
    { cross_bundle_link_id: "stable-user-derived-link" },
  ])("rejects content, secret material, paths, and overclaims: %j", (value) => {
    expect(() => assertContentFreeEvidence(value)).toThrow();
  });

  it("allows repository source bindings but rejects source hashes outside that namespace", () => {
    expect(() =>
      assertContentFreeEvidence({
        source_bindings: [
          {
            path: "packages/contracts/src/g6.ts",
            raw_hash: `sha256:${"a".repeat(64)}`,
          },
        ],
      }),
    ).not.toThrow();
    expect(() =>
      assertContentFreeEvidence({
        artifact: {
          path: "runtime-output.json",
          raw_hash: `sha256:${"a".repeat(64)}`,
        },
      }),
    ).toThrow();
  });

  it("rejects hidden absolute paths and key markers in nested evidence", () => {
    expect(() =>
      assertContentFreeEvidence({
        result: {
          location: "/Users/example/secret-root",
        },
      }),
    ).toThrow("absolute paths");
    expect(() =>
      assertContentFreeEvidence({
        nested: {
          private_key: "marker",
        },
      }),
    ).toThrow("forbidden");
  });

  it("rejects secret-bearing string values and sensitive command arguments", () => {
    expect(() =>
      assertContentFreeEvidence({
        diagnostic: "password=hunter2",
      }),
    ).toThrow("secret-bearing");
    expect(() =>
      assertContentFreeEvidence({
        command: "operator inspect --token local-credential",
      }),
    ).toThrow("secret-bearing");
    expect(() =>
      assertContentFreeEvidence({
        output: "-----BEGIN PRIVATE KEY-----",
      }),
    ).toThrow("secret-bearing");
    expect(() =>
      assertContentFreeEvidence({
        note: "DELETED_MEMORY_MARKER_48291",
      }),
    ).toThrow();
  });

  it("accepts only canonical argv and placeholder-only runbook automation", () => {
    expect(() =>
      assertContentFreeEvidence({
        command: [
          "pnpm",
          "vitest",
          "run",
          "<test-file>",
          "-t",
          "<test-name>",
        ],
        automation:
          "doctor --config <operator-config> --format json",
        bootstrap: {
          command: [
            "pnpm",
            "-r",
            "--config.offline=true",
            "rebuild",
            "--pending",
          ],
        },
      }),
    ).not.toThrow();

    for (const value of [
      {
        command: [
          "pnpm",
          "vitest",
          "run",
          "PRIVATE_MEMORY_MARKER_48291",
        ],
      },
      {
        command: ["node", "/Users/example/private-tool.mjs"],
      },
      {
        automation:
          "doctor --config DELETED_MEMORY_MARKER_48291 --format json",
      },
      {
        automation:
          "doctor --config /Users/example/operator.json --format json",
      },
    ]) {
      expect(() => assertContentFreeEvidence(value)).toThrow();
    }
  });

  it("keeps committed fixtures free of private keys and current release authority", () => {
    const fixture = loadG6Fixture();
    for (const step of fixture.runbook_fixture.steps) {
      expect(() =>
        assertContentFreeEvidence({ automation: step.automation }),
      ).not.toThrow();
    }
    expect(JSON.stringify(fixture)).not.toMatch(
      /BEGIN (?:ED25519 |PRIVATE )?PRIVATE KEY/u,
    );
    expect(fixture.release_control.current_control).toBeNull();
    for (const path of [
      "fixtures/g6/decision-authority.json",
      "fixtures/g6/release-control.json",
      "fixtures/g6/runtime-inputs.json",
    ]) {
      expect(readFileSync(path, "utf8")).not.toMatch(
        /private_key|key_material|absolute_path/u,
      );
    }
  });
});
