import process from "node:process";

import { OperatorConfigSchema } from "../apps/operator-cli/dist/config.js";
import {
  G6_RUNTIME_INPUTS,
  currentRuntimeIdentity,
  runtimeConfigurationDigest,
} from "../apps/operator-cli/dist/runtime-identity.js";

import {
  canonicalJson,
  canonicalSha256,
  readJson,
} from "./g6-evidence-common.mjs";

export function buildG6RuntimeIdentity(options = {}) {
  const thresholds = readJson("fixtures/g6/thresholds.json");
  const authority = readJson("fixtures/g6/decision-authority.json");
  const runtimeInputs = readJson("fixtures/g6/runtime-inputs.json");
  if (
    canonicalJson(runtimeInputs.paths) !==
    canonicalJson(G6_RUNTIME_INPUTS)
  ) {
    throw new Error("G6 runtime input policy differs from production");
  }
  const operatorConfig = OperatorConfigSchema.parse(
    options.operatorConfig ??
      readJson("fixtures/g6/operator-config.json"),
  );
  const decisionTrust = {
    schema_version: authority.schema_version,
    purpose: "g6_release_control",
    authority_key_id: authority.authority_key_id,
    authority_key_generation: authority.authority_key_generation,
    public_key_spki_base64url:
      authority.public_key_spki_base64url,
    valid_from: authority.valid_from,
    expires_at: authority.expires_at,
    revoked_at: authority.revoked_at,
    maximum_control_ttl_seconds:
      authority.maximum_control_ttl_seconds,
  };
  const identity = currentRuntimeIdentity({
    schemaVersion: "1.0.0",
    configurationDigest: runtimeConfigurationDigest(operatorConfig),
  });
  const actualRuntime = `node-${identity.platform.node}`;
  const actualPlatform =
    `${process.platform}-${identity.platform.architecture}`;
  const actualFilesystem = identity.platform.filesystem;
  if (
    actualRuntime !== thresholds.environment.runtime ||
    actualPlatform !== thresholds.environment.platform ||
    actualFilesystem !== thresholds.environment.filesystem
  ) {
    throw new Error(
      `G6 exact environment mismatch: ${actualRuntime}/${actualPlatform}/${actualFilesystem}`,
    );
  }
  if (
    identity.decision_authority_hash !== canonicalSha256(decisionTrust)
  ) {
    throw new Error("G6 decision authority differs from production pin");
  }
  return identity;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.stdout.write(`${JSON.stringify(buildG6RuntimeIdentity())}\n`);
}
