import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  IdentifierSchema,
  ReleaseQualificationSchema,
} from "@memo-graph/contracts";
import { z } from "zod";

const MAX_CONFIG_BYTES = 256 * 1024;

export const OperatorConfigSchema = z
  .object({
    data_root: z.string().trim().min(1),
    qualification: ReleaseQualificationSchema.default({
      status: "pending",
      tested_envelope_digest: null,
    }),
    recovery: z
      .object({
        backup_bundles: z.record(
          IdentifierSchema,
          z.string().trim().min(1),
        ),
        restore_targets: z.record(
          IdentifierSchema,
          z.string().trim().min(1),
        ),
      })
      .strict()
      .default({ backup_bundles: {}, restore_targets: {} }),
  })
  .strict();

export type OperatorConfig = z.output<typeof OperatorConfigSchema>;

export class OperatorConfigError extends Error {
  constructor() {
    super("operator configuration is invalid");
    this.name = "OperatorConfigError";
  }
}

export function loadOperatorConfig(pathInput: string): OperatorConfig {
  try {
    const path = resolve(pathInput);
    const stat = lstatSync(path);
    const expectedOwner = process.getuid?.();
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > MAX_CONFIG_BYTES ||
      (stat.mode & 0o022) !== 0 ||
      (expectedOwner !== undefined && stat.uid !== expectedOwner)
    ) {
      throw new OperatorConfigError();
    }
    const payload = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return OperatorConfigSchema.parse(payload);
  } catch {
    throw new OperatorConfigError();
  }
}
