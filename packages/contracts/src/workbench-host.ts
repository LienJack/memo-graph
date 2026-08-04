import { z } from "zod";

import {
  CanonicalHashSchema,
  UtcTimestampSchema,
} from "./common.js";
import { AutomaticMemoryEventSchema } from "./automatic-memory.js";

const LocalPathSchema = z.string().min(1).max(1_024);
const InstanceIdSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const LoopbackOriginSchema = z
  .string()
  .regex(/^http:\/\/127\.0\.0\.1:(?:[1-9]\d{0,4})$/u);

export const RuntimeRootIdentitySchema = z
  .object({
    canonical_root_hash: CanonicalHashSchema,
    device: z.string().regex(/^\d+$/u).max(40),
    inode: z.string().regex(/^\d+$/u).max(40),
  })
  .strict();

export const WorkbenchEndpointMetadataSchema = z
  .object({
    schema_version: z.literal("1.0.0"),
    instance_id: InstanceIdSchema,
    root_identity: RuntimeRootIdentitySchema,
    config_identity: CanonicalHashSchema,
    runtime_state: z.enum(["ready", "health_only"]),
    origin: LoopbackOriginSchema,
    port: z.number().int().min(1).max(65_535),
    process_id: z.number().int().positive(),
    control_credential_path: LocalPathSchema,
    runtime_descriptor_path: LocalPathSchema.nullable(),
    created_at: UtcTimestampSchema,
    ready_at: UtcTimestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.origin !== `http://127.0.0.1:${value.port}`) {
      context.addIssue({
        code: "custom",
        path: ["origin"],
        message: "workbench origin must match its exact loopback port",
      });
    }
    if (
      (value.runtime_state === "ready") !==
        (value.runtime_descriptor_path !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["runtime_descriptor_path"],
        message: "ready workbench endpoints require one Runtime descriptor",
      });
    }
  });

export const WorkbenchTicketExchangeSchema = z
  .object({
    instance_id: InstanceIdSchema,
    ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  })
  .strict();

export const WorkbenchBrowserSessionSchema = z
  .object({
    schema_version: z.literal("1.0.0"),
    instance_id: InstanceIdSchema,
    session_id: InstanceIdSchema,
    bearer: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
    expires_at: UtcTimestampSchema,
  })
  .strict();

export const WorkbenchControlBootstrapRequestSchema = z
  .object({})
  .strict();

export const WorkbenchControlBootstrapResponseSchema = z
  .object({
    schema_version: z.literal("1.0.0"),
    instance_id: InstanceIdSchema,
    ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
    expires_at: UtcTimestampSchema,
  })
  .strict();

export const WorkbenchLaunchResultSchema = z
  .object({
    schema_version: z.literal("1.0.0"),
    status: z.enum(["started", "reused"]),
    instance_id: InstanceIdSchema,
    runtime_state: z.enum(["ready", "health_only"]),
    origin: LoopbackOriginSchema,
    browser: z.enum(["opened", "suppressed", "failed"]),
    recovery: z.enum(["none", "open_launch_url"]),
  })
  .strict();

export const AutomaticMemoryHookDescriptorSchema = z
  .object({
    schema_version: z.literal("1.0.0"),
    instance_id: InstanceIdSchema,
    root_identity: RuntimeRootIdentitySchema,
    config_identity: CanonicalHashSchema,
    origin: LoopbackOriginSchema,
    credential_path: LocalPathSchema,
    capture_path: z.literal("/__hooks/capture"),
    created_at: UtcTimestampSchema,
    ready_at: UtcTimestampSchema,
  })
  .strict();

export const AutomaticMemoryHookCaptureRequestSchema = z
  .object({
    schema_version: z.literal("1.0.0"),
    idempotency_key: z.string().trim().min(8).max(200),
    source: z.enum(["direct", "spool"]),
    event: AutomaticMemoryEventSchema,
  })
  .strict();

export const AutomaticMemoryHookCaptureResponseSchema = z
  .object({
    schema_version: z.literal("1.0.0"),
    status: z.enum(["accepted", "skipped", "rejected"]),
    event_id: z.string().min(1).max(160),
    additional_context: z.string().max(16_000).nullable(),
  })
  .strict();

export type RuntimeRootIdentity = z.infer<typeof RuntimeRootIdentitySchema>;
export type WorkbenchBrowserSession = z.infer<
  typeof WorkbenchBrowserSessionSchema
>;
export type WorkbenchControlBootstrapResponse = z.infer<
  typeof WorkbenchControlBootstrapResponseSchema
>;
export type WorkbenchEndpointMetadata = z.infer<
  typeof WorkbenchEndpointMetadataSchema
>;
export type WorkbenchLaunchResult = z.infer<
  typeof WorkbenchLaunchResultSchema
>;
export type AutomaticMemoryHookDescriptor = z.infer<
  typeof AutomaticMemoryHookDescriptorSchema
>;
export type AutomaticMemoryHookCaptureRequest = z.infer<
  typeof AutomaticMemoryHookCaptureRequestSchema
>;
export type AutomaticMemoryHookCaptureResponse = z.infer<
  typeof AutomaticMemoryHookCaptureResponseSchema
>;
