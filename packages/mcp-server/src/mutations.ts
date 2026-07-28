import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { isAbsolute } from "node:path";

import {
  ApprovalRegistryManifestSchema,
  canonicalJson,
  type ApprovalRegistryManifest,
} from "@memo-graph/contracts";
import {
  ApprovalError,
  approvalRegistryHash,
  assertApprovalGrant,
  type ApprovalBinding,
  type ApprovalRegistry,
  type VerifiedApproval,
} from "@memo-graph/memory-kernel";
export { ApprovalError } from "@memo-graph/memory-kernel";

type ManifestSnapshot = {
  manifest: ApprovalRegistryManifest;
  registry_hash: `sha256:${string}`;
};

export class LocalManifestApprovalRegistry implements ApprovalRegistry {
  readonly #manifestPath: string;
  readonly #clock: () => string;
  readonly #expectedUid: number | undefined;

  constructor(options: {
    manifestPath: string;
    clock?: () => string;
    expectedUid?: number;
  }) {
    if (!isAbsolute(options.manifestPath)) {
      throw new ApprovalError("APPROVAL_INVALID");
    }
    this.#manifestPath = options.manifestPath;
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#expectedUid =
      options.expectedUid ??
      (typeof process.getuid === "function" ? process.getuid() : undefined);
  }

  async verify(binding: ApprovalBinding): Promise<VerifiedApproval> {
    const snapshot = this.#readSnapshot();
    const grant = snapshot.manifest.approvals.find(
      (candidate) => candidate.approval_id === binding.approval_id,
    );
    if (grant === undefined) {
      throw new ApprovalError("APPROVAL_REQUIRED");
    }
    assertApprovalGrant(binding, grant, this.#clock());
    return {
      grant,
      registry_hash: snapshot.registry_hash,
    };
  }

  async confirmUnchanged(approval: VerifiedApproval): Promise<void> {
    const snapshot = this.#readSnapshot();
    const current = snapshot.manifest.approvals.find(
      (candidate) =>
        candidate.approval_id === approval.grant.approval_id,
    );
    if (
      snapshot.registry_hash !== approval.registry_hash ||
      current === undefined ||
      canonicalJson(current) !== canonicalJson(approval.grant)
    ) {
      throw new ApprovalError("APPROVAL_INVALID");
    }
  }

  #readSnapshot(): ManifestSnapshot {
    let descriptor: number | undefined;
    try {
      const pathStat = lstatSync(this.#manifestPath);
      if (pathStat.isSymbolicLink() || !pathStat.isFile()) {
        throw new ApprovalError("APPROVAL_INVALID");
      }
      descriptor = openSync(
        this.#manifestPath,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      const descriptorStat = fstatSync(descriptor);
      if (
        !descriptorStat.isFile() ||
        (this.#expectedUid !== undefined &&
          descriptorStat.uid !== this.#expectedUid) ||
        (descriptorStat.mode & 0o022) !== 0 ||
        descriptorStat.dev !== pathStat.dev ||
        descriptorStat.ino !== pathStat.ino
      ) {
        throw new ApprovalError("APPROVAL_INVALID");
      }
      const text = readFileSync(descriptor, "utf8");
      const manifest = ApprovalRegistryManifestSchema.parse(
        JSON.parse(text) as unknown,
      );
      return {
        manifest,
        registry_hash: approvalRegistryHash(manifest),
      };
    } catch (error) {
      if (error instanceof ApprovalError) {
        throw error;
      }
      throw new ApprovalError("APPROVAL_INVALID");
    } finally {
      if (descriptor !== undefined) {
        closeSync(descriptor);
      }
    }
  }
}
