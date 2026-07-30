import { createHash } from "node:crypto";

import {
  CanonicalHashSchema,
  canonicalSha256,
  type CanonicalHash,
} from "@memo-graph/contracts";

const RECOVERY_TRANSPORT_FIELDS = new Set(["replayed"]);

function recoveryHashPayload(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return {
      recovery_binary_v1: {
        size_bytes: value.byteLength,
        sha256:
          `sha256:${createHash("sha256").update(value).digest("hex")}`,
      },
    };
  }
  if (value === undefined) {
    return { recovery_undefined_v1: true };
  }
  if (Array.isArray(value)) {
    return value.map((item) => recoveryHashPayload(item));
  }
  if (
    typeof value === "object" &&
    value !== null &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  ) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !RECOVERY_TRANSPORT_FIELDS.has(key))
        .map(([key, item]) => [
          key,
          recoveryHashPayload(item),
        ]),
    );
  }
  return value;
}

export function recoveryContentHash(value: unknown): CanonicalHash {
  return CanonicalHashSchema.parse(
    canonicalSha256(recoveryHashPayload(value)),
  );
}
