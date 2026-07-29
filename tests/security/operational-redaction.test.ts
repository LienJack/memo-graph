import { describe, expect, it } from "vitest";

import {
  OperationalStatusSchema,
  reduceOperationalStatus,
} from "../../packages/contracts/src/index.js";
import { renderOperationalStatus } from "../../apps/operator-cli/src/render.js";

describe("operational redaction", () => {
  it("allows only stable content-free fields on JSON and human surfaces", () => {
    const markers = [
      "memory plaintext marker",
      "Context marker",
      "search query marker",
      "ciphertext marker",
      "raw-key-marker",
      "token-marker",
      "/Users/local/private/data-root",
    ];
    const status = reduceOperationalStatus({
      observed_at: "2026-07-30T09:00:00.000Z",
      qualification: {
        status: "outside_tested_envelope",
        tested_envelope_digest: `sha256:${"a".repeat(64)}`,
      },
      observations: [
        {
          component: "data_root",
          state: "blocked",
          reason_code: "DATA_ROOT_UNSAFE",
          action_code: "SELECT_SAFE_DATA_ROOT",
          measurements: [],
        },
      ],
    });
    for (const output of [
      renderOperationalStatus(status, "json"),
      renderOperationalStatus(status, "human"),
    ]) {
      for (const marker of markers) {
        expect(output).not.toContain(marker);
      }
    }
    expect(
      OperationalStatusSchema.safeParse({
        ...status,
        path_hash: `sha256:${"b".repeat(64)}`,
      }).success,
    ).toBe(false);
    expect(
      OperationalStatusSchema.safeParse({
        ...status,
        memory: markers[0],
      }).success,
    ).toBe(false);
  });
});
