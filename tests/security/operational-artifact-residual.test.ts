import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  OperationalArtifactClassSchema,
  canonicalSha256,
  type OperationalArtifactClass,
} from "../../packages/contracts/src/index.js";
import {
  scanOperationalArtifactResiduals,
} from "../../apps/operator-cli/src/operational-artifact-scan.js";

const cleanupPaths: string[] = [];
const MARKER = "private operational marker 72841";
const NOW = "2026-07-30T12:30:00.000Z";

function fixtureRoots(): Record<OperationalArtifactClass, string> {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), "memo-graph-residual-")),
  );
  cleanupPaths.push(root);
  return Object.fromEntries(
    OperationalArtifactClassSchema.options.map((artifactClass) => {
      const directory = join(root, artifactClass);
      mkdirSync(directory, { mode: 0o700 });
      writeFileSync(
        join(directory, `${artifactClass}.artifact`),
        artifactClass === "ciphertext"
          ? Buffer.from([0x81, 0x00, 0xff, 0x21])
          : `content-free ${artifactClass} fixture\n`,
        { mode: 0o600 },
      );
      return [artifactClass, directory];
    }),
  ) as Record<OperationalArtifactClass, string>;
}

afterEach(() => {
  while (cleanupPaths.length > 0) {
    const target = cleanupPaths.pop();
    if (target !== undefined) {
      chmodSync(target, 0o700);
      chmodSync(join(target, "temp"), 0o700);
      rmSync(target, { recursive: true, force: true });
    }
  }
});

describe("operational artifact residual audit", () => {
  it("covers every registered artifact class without emitting content", () => {
    const roots = fixtureRoots();
    const audit = scanOperationalArtifactResiduals({
      auditId: "operational_residual_audit_1",
      checkedAt: NOW,
      roots,
      forbiddenMarkers: [MARKER],
    });
    expect(audit.completed).toBe(true);
    expect(
      audit.classes.map(({ artifact_class }) => artifact_class),
    ).toEqual(OperationalArtifactClassSchema.options);
    expect(
      audit.classes.find(
        ({ artifact_class }) => artifact_class === "quarantine",
      ),
    ).toMatchObject({
      outcome: "quarantined_non_publishable",
    });
    const rendered = JSON.stringify(audit);
    expect(rendered).not.toContain(MARKER);
    expect(rendered).not.toContain(roots.canonical);

    const repeated = scanOperationalArtifactResiduals({
      auditId: "operational_residual_audit_2",
      checkedAt: NOW,
      roots,
      forbiddenMarkers: [MARKER],
    });
    const canonicalInventory = audit.classes.find(
      ({ artifact_class }) => artifact_class === "canonical",
    )?.inventory_hash;
    const repeatedCanonicalInventory = repeated.classes.find(
      ({ artifact_class }) => artifact_class === "canonical",
    )?.inventory_hash;
    const dictionaryRecoverableInventory = canonicalSha256([
      {
        relative_name_hash: canonicalSha256("canonical.artifact"),
        size: Buffer.byteLength("content-free canonical fixture\n"),
        mode: 0o600,
      },
    ]);
    expect(canonicalInventory).not.toBe(dictionaryRecoverableInventory);
    expect(repeatedCanonicalInventory).not.toBe(canonicalInventory);
  });

  it("blocks missing, unreadable, and sensitive residual classes", () => {
    const roots = fixtureRoots();
    roots.backup = join(roots.backup, "missing");
    chmodSync(roots.temp, 0o000);
    writeFileSync(join(roots.log, "residual.log"), MARKER, {
      mode: 0o600,
    });
    const audit = scanOperationalArtifactResiduals({
      auditId: "operational_residual_audit_blocked",
      checkedAt: NOW,
      roots,
      forbiddenMarkers: [MARKER],
    });
    expect(audit.completed).toBe(false);
    expect(
      audit.classes.find(
        ({ artifact_class }) => artifact_class === "backup",
      ),
    ).toMatchObject({
      outcome: "blocked",
      error_code: "ARTIFACT_CLASS_UNREADABLE",
    });
    expect(
      audit.classes.find(
        ({ artifact_class }) => artifact_class === "temp",
      ),
    ).toMatchObject({
      outcome: "blocked",
      error_code: "ARTIFACT_CLASS_UNREADABLE",
    });
    expect(
      audit.classes.find(
        ({ artifact_class }) => artifact_class === "log",
      ),
    ).toMatchObject({
      outcome: "blocked",
      error_code: "SENSITIVE_RESIDUAL_DETECTED",
    });
    expect(JSON.stringify(audit)).not.toContain(MARKER);
  });

  it("fails closed when an artifact is replaced by a symlink before open", () => {
    const roots = fixtureRoots();
    const target = join(roots.canonical, "canonical.artifact");
    const replacement = join(roots.context, "context.artifact");
    let replaced = false;
    const audit = scanOperationalArtifactResiduals({
      auditId: "operational_residual_audit_race",
      checkedAt: NOW,
      roots,
      testBeforeOpen: (path) => {
        if (!replaced && path === target) {
          replaced = true;
          unlinkSync(target);
          symlinkSync(replacement, target);
        }
      },
    });
    expect(replaced).toBe(true);
    expect(audit.completed).toBe(false);
    expect(
      audit.classes.find(
        ({ artifact_class }) => artifact_class === "canonical",
      ),
    ).toMatchObject({
      outcome: "blocked",
      error_code: "ARTIFACT_CLASS_UNREADABLE",
    });
  });
});
