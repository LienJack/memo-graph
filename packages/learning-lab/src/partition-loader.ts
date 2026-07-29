import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import {
  EvaluationPartitionSchema,
  G5CaseBodySchema,
  G5CaseOracleSchema,
  G5FixtureManifestSchema,
  G5ThresholdsSchema,
  UtcTimestampSchema,
  assertG5PartitionAccess,
  canonicalSha256,
  type EvaluationPartition,
  type G5CaseBody,
  type G5CaseOracle,
  type G5FixtureManifest,
  type G5Thresholds,
} from "@memo-graph/contracts";
import { z } from "zod";

const PartitionAccessRoleSchema = z.enum([
  "calibration_tuning",
  "gate_evaluator",
]);

const PartitionLoadInputSchema = z
  .object({
    role: PartitionAccessRoleSchema,
    partition: EvaluationPartitionSchema,
  })
  .strict();

export type PartitionAccessRole = z.infer<
  typeof PartitionAccessRoleSchema
>;

export type G5LoadedEvaluationCase = {
  descriptor: G5FixtureManifest["evaluation_cases"][number];
  case_body: G5CaseBody;
  oracle: G5CaseOracle;
};

export type G5PartitionAccessEvent = {
  sequence: number;
  role: PartitionAccessRole;
  partition: EvaluationPartition;
  artifact: "case" | "oracle";
  outcome: "denied";
  detected_at: string;
};

export class G5FixtureAccessError extends Error {
  readonly code:
    | "PARTITION_ACCESS_DENIED"
    | "FIXTURE_HASH_MISMATCH"
    | "FIXTURE_IDENTITY_MISMATCH"
    | "FIXTURE_PATH_INVALID";

  constructor(code: G5FixtureAccessError["code"]) {
    super(code);
    this.name = "G5FixtureAccessError";
    this.code = code;
  }
}

export class G5PartitionLoader {
  readonly #fixtureRoot: string;
  readonly #clock: () => string;
  readonly #deniedEvents: G5PartitionAccessEvent[] = [];

  constructor(options: {
    fixtureRoot: string;
    clock?: () => string;
  }) {
    this.#fixtureRoot = resolve(options.fixtureRoot);
    this.#clock = options.clock ?? (() => new Date().toISOString());
  }

  async loadManifest(): Promise<G5FixtureManifest> {
    return G5FixtureManifestSchema.parse(
      await this.#readJson("manifest.json"),
    );
  }

  async loadThresholds(): Promise<G5Thresholds> {
    const manifest = await this.loadManifest();
    const thresholds = G5ThresholdsSchema.parse(
      await this.#readJson(manifest.thresholds_file),
    );
    if (canonicalSha256(thresholds) !== manifest.thresholds_hash) {
      throw new G5FixtureAccessError("FIXTURE_HASH_MISMATCH");
    }
    return thresholds;
  }

  async loadPartition(
    input: unknown,
  ): Promise<G5LoadedEvaluationCase[]> {
    const parsed = PartitionLoadInputSchema.parse(input);
    for (const artifact of ["case", "oracle"] as const) {
      try {
        assertG5PartitionAccess(
          parsed.role,
          parsed.partition,
          artifact,
        );
      } catch {
        this.#deniedEvents.push({
          sequence: this.#deniedEvents.length + 1,
          role: parsed.role,
          partition: parsed.partition,
          artifact,
          outcome: "denied",
          detected_at: UtcTimestampSchema.parse(this.#clock()),
        });
        throw new G5FixtureAccessError("PARTITION_ACCESS_DENIED");
      }
    }

    const manifest = await this.loadManifest();
    const descriptors = manifest.evaluation_cases.filter(
      (descriptor) => descriptor.partition === parsed.partition,
    );
    if (descriptors.length !== 3) {
      throw new G5FixtureAccessError("FIXTURE_IDENTITY_MISMATCH");
    }
    const loaded: G5LoadedEvaluationCase[] = [];
    for (const descriptor of descriptors) {
      const caseBody = G5CaseBodySchema.parse(
        await this.#readJson(descriptor.case_file),
      );
      const oracle = G5CaseOracleSchema.parse(
        await this.#readJson(descriptor.oracle_file),
      );
      if (
        canonicalSha256(caseBody) !== descriptor.case_hash ||
        canonicalSha256(oracle) !== descriptor.oracle_hash
      ) {
        throw new G5FixtureAccessError("FIXTURE_HASH_MISMATCH");
      }
      if (
        caseBody.case_id !== descriptor.case_id ||
        caseBody.partition !== descriptor.partition ||
        caseBody.family !== descriptor.family ||
        oracle.case_id !== descriptor.case_id ||
        oracle.partition !== descriptor.partition ||
        canonicalSha256([...caseBody.required_task_unit_ids].sort()) !==
          canonicalSha256([...oracle.expected_task_unit_ids].sort())
      ) {
        throw new G5FixtureAccessError(
          "FIXTURE_IDENTITY_MISMATCH",
        );
      }
      loaded.push({
        descriptor,
        case_body: caseBody,
        oracle,
      });
    }
    return loaded;
  }

  deniedAccessEvents(): readonly G5PartitionAccessEvent[] {
    return this.#deniedEvents.map((event) => ({ ...event }));
  }

  async #readJson(relativePath: string): Promise<unknown> {
    const root = await realpath(this.#fixtureRoot);
    const requested = resolve(root, relativePath);
    const pathFromRoot = relative(root, requested);
    if (
      pathFromRoot === "" ||
      pathFromRoot.startsWith("..") ||
      isAbsolute(pathFromRoot)
    ) {
      throw new G5FixtureAccessError("FIXTURE_PATH_INVALID");
    }
    let resolvedPath: string;
    try {
      resolvedPath = await realpath(requested);
    } catch {
      throw new G5FixtureAccessError("FIXTURE_PATH_INVALID");
    }
    const resolvedFromRoot = relative(root, resolvedPath);
    if (
      resolvedFromRoot.startsWith("..") ||
      isAbsolute(resolvedFromRoot)
    ) {
      throw new G5FixtureAccessError("FIXTURE_PATH_INVALID");
    }
    try {
      return JSON.parse(await readFile(resolvedPath, "utf8")) as unknown;
    } catch (error) {
      if (error instanceof G5FixtureAccessError) {
        throw error;
      }
      throw new G5FixtureAccessError("FIXTURE_HASH_MISMATCH");
    }
  }
}
