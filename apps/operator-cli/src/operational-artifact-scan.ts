import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
} from "node:fs";
import { createHmac, randomBytes } from "node:crypto";
import { join, relative, resolve } from "node:path";

import {
  OperationalArtifactClassSchema,
  OperationalArtifactResidualAuditSchema,
  canonicalSha256,
  type OperationalArtifactClass,
  type OperationalArtifactResidualAudit,
} from "@memo-graph/contracts";

const MAX_SCAN_BYTES = 64 * 1024 * 1024;
const MAX_SCAN_FILES = 100_000;

function scanDirectory(
  rootInput: string,
  forbiddenMarkers: readonly string[],
  auditKey: Buffer,
  testBeforeOpen?: (path: string) => void,
) {
  const root = resolve(rootInput);
  const expectedOwner = process.getuid?.();
  const inventory: Array<{
    relative_name_hash: `sha256:${string}`;
    size: number;
    mode: number;
  }> = [];
  let byteCount = 0;
  const pending = [root];
  while (pending.length > 0) {
    const path = pending.pop();
    if (path === undefined) {
      break;
    }
    testBeforeOpen?.(path);
    const descriptor = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const stat = fstatSync(descriptor);
    if (
      stat.isSymbolicLink() ||
      (stat.mode & 0o077) !== 0 ||
      (expectedOwner !== undefined && stat.uid !== expectedOwner)
    ) {
      closeSync(descriptor);
      throw new Error("UNREADABLE_ARTIFACT_CLASS");
    }
    if (stat.isDirectory()) {
      if ((stat.mode & 0o500) !== 0o500) {
        closeSync(descriptor);
        throw new Error("UNREADABLE_ARTIFACT_CLASS");
      }
      const names = readdirSync(path).sort().reverse();
      const after = fstatSync(descriptor);
      const current = lstatSync(path);
      closeSync(descriptor);
      if (
        current.isSymbolicLink() ||
        current.dev !== stat.dev ||
        current.ino !== stat.ino ||
        after.dev !== stat.dev ||
        after.ino !== stat.ino ||
        after.mtimeMs !== stat.mtimeMs
      ) {
        throw new Error("UNREADABLE_ARTIFACT_CLASS");
      }
      for (const name of names) {
        pending.push(join(path, name));
      }
      continue;
    }
    if (
      !stat.isFile() ||
      (stat.mode & 0o400) === 0 ||
      inventory.length >= MAX_SCAN_FILES ||
      byteCount + stat.size > MAX_SCAN_BYTES
    ) {
      closeSync(descriptor);
      throw new Error("UNREADABLE_ARTIFACT_CLASS");
    }
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(
        descriptor,
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (count === 0) {
        closeSync(descriptor);
        throw new Error("UNREADABLE_ARTIFACT_CLASS");
      }
      offset += count;
    }
    const after = fstatSync(descriptor);
    closeSync(descriptor);
    if (
      after.dev !== stat.dev ||
      after.ino !== stat.ino ||
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      after.size > MAX_SCAN_BYTES - byteCount
    ) {
      throw new Error("UNREADABLE_ARTIFACT_CLASS");
    }
    try {
      if (
        forbiddenMarkers.some(
          (marker) =>
            marker.length > 0 && bytes.includes(Buffer.from(marker)),
        )
      ) {
        throw new Error("SENSITIVE_RESIDUAL_DETECTED");
      }
      byteCount += stat.size;
      inventory.push({
        relative_name_hash: `sha256:${createHmac(
          "sha256",
          auditKey,
        )
          .update(relative(root, path), "utf8")
          .digest("hex")}`,
        size: stat.size,
        mode: stat.mode & 0o777,
      });
    } finally {
      bytes.fill(0);
    }
  }
  return {
    file_count: inventory.length,
    byte_count: byteCount,
    inventory_hash: canonicalSha256(inventory),
  };
}

export function scanOperationalArtifactResiduals(input: {
  auditId: string;
  checkedAt: string;
  roots: Record<OperationalArtifactClass, string>;
  forbiddenMarkers?: readonly string[];
  testBeforeOpen?: (path: string) => void;
}): OperationalArtifactResidualAudit {
  const markers = input.forbiddenMarkers ?? [];
  const auditKey = randomBytes(32);
  try {
    const classes =
      OperationalArtifactClassSchema.options.map((artifactClass) => {
        try {
          const scanned = scanDirectory(
            input.roots[artifactClass],
            markers,
            auditKey,
            input.testBeforeOpen,
          );
          return {
            artifact_class: artifactClass,
            outcome:
              artifactClass === "quarantine"
                ? ("quarantined_non_publishable" as const)
                : ("verified_present" as const),
            ...scanned,
            error_code: null,
          };
        } catch (error) {
          const errorCode =
            error instanceof Error &&
            error.message === "SENSITIVE_RESIDUAL_DETECTED"
              ? "SENSITIVE_RESIDUAL_DETECTED"
              : "ARTIFACT_CLASS_UNREADABLE";
          return {
            artifact_class: artifactClass,
            outcome: "blocked" as const,
            file_count: 0,
            byte_count: 0,
            inventory_hash: null,
            error_code: errorCode,
          };
        }
      });
    const body = {
      schema_version: "1.0.0" as const,
      audit_id: input.auditId,
      checked_at: input.checkedAt,
      classes,
      completed: classes.every(({ outcome }) => outcome !== "blocked"),
    };
    return OperationalArtifactResidualAuditSchema.parse({
      ...body,
      audit_hash: canonicalSha256(body),
    });
  } finally {
    auditKey.fill(0);
  }
}
