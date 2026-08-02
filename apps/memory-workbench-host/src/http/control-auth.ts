import {
  createHmac,
  timingSafeEqual,
} from "node:crypto";

import {
  canonicalJson,
  canonicalSha256,
} from "@memo-graph/contracts";
import { z } from "zod";

export const WorkbenchControlNonceSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{32}$/u);
export const WorkbenchControlProofSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/u);

export function createWorkbenchControlProof(input: {
  credential: Buffer;
  instanceId: string;
  origin: string;
  nonce: string;
  body: unknown;
}): string {
  const nonce = WorkbenchControlNonceSchema.parse(input.nonce);
  return createHmac("sha256", input.credential)
    .update("memo-graph/workbench-control/v1\0")
    .update(
      canonicalJson({
        instance_id: input.instanceId,
        origin: input.origin,
        nonce,
        body_hash: canonicalSha256(input.body),
      }),
    )
    .digest("base64url");
}

export function workbenchControlProofMatches(input: {
  credential: Buffer;
  instanceId: string;
  origin: string;
  nonce: string;
  body: unknown;
  proof: string;
}): boolean {
  const proof = WorkbenchControlProofSchema.safeParse(input.proof);
  const nonce = WorkbenchControlNonceSchema.safeParse(input.nonce);
  if (!proof.success || !nonce.success) {
    return false;
  }
  const actual = Buffer.from(proof.data, "base64url");
  const expected = Buffer.from(
    createWorkbenchControlProof({ ...input, nonce: nonce.data }),
    "base64url",
  );
  return actual.byteLength === expected.byteLength &&
    timingSafeEqual(actual, expected);
}
