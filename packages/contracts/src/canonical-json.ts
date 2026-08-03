import { createHash } from "node:crypto";

export type CanonicalJsonPrimitive = boolean | null | number | string;
export type CanonicalJsonValue =
  | CanonicalJsonPrimitive
  | CanonicalJsonValue[]
  | { [key: string]: CanonicalJsonValue };

export class CanonicalJsonError extends TypeError {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`Canonical JSON error at ${path}: ${message}`);
    this.name = "CanonicalJsonError";
    this.path = path;
  }
}

function normalizeNumber(value: number, path: string): number {
  if (!Number.isFinite(value)) {
    throw new CanonicalJsonError(path, "numbers must be finite");
  }
  if (!Number.isSafeInteger(value) && Number.isInteger(value)) {
    throw new CanonicalJsonError(path, "integers must be within the safe range");
  }
  if (Object.is(value, -0)) {
    throw new CanonicalJsonError(path, "negative zero is not canonical");
  }
  return value;
}

function normalizeArray(value: unknown[], path: string): CanonicalJsonValue[] {
  const normalized: CanonicalJsonValue[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value)) {
      throw new CanonicalJsonError(`${path}[${index}]`, "sparse arrays are not allowed");
    }
    normalized.push(normalizeCanonicalValue(value[index], `${path}[${index}]`));
  }
  return normalized;
}

function normalizeObject(
  value: Record<string, unknown>,
  path: string,
): Record<string, CanonicalJsonValue> {
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new CanonicalJsonError(path, "only plain objects are allowed");
  }

  const normalized: Record<string, CanonicalJsonValue> = {};
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key === "symbol")) {
    throw new CanonicalJsonError(path, "symbol keys are not allowed");
  }
  for (const key of (keys as string[]).sort()) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined
    ) {
      throw new CanonicalJsonError(
        `${path}.${key}`,
        "properties must be enumerable data properties",
      );
    }
    normalized[key] = normalizeCanonicalValue(value[key], `${path}.${key}`);
  }
  return normalized;
}

export function normalizeCanonicalValue(
  value: unknown,
  path = "$",
): CanonicalJsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    return normalizeNumber(value, path);
  }
  if (Array.isArray(value)) {
    return normalizeArray(value, path);
  }
  if (typeof value === "object") {
    return normalizeObject(value as Record<string, unknown>, path);
  }
  throw new CanonicalJsonError(
    path,
    `unsupported value type ${typeof value}`,
  );
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalizeCanonicalValue(value));
}

export function canonicalSha256(value: unknown): `sha256:${string}` {
  const digest = createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
  return `sha256:${digest}`;
}

export function canonicalSha256Omitting(
  value: unknown,
  topLevelKeys: readonly string[],
): `sha256:${string}` {
  const normalized = normalizeCanonicalValue(value);
  if (
    normalized === null ||
    Array.isArray(normalized) ||
    typeof normalized !== "object"
  ) {
    throw new CanonicalJsonError("$", "top-level key omission requires an object");
  }

  const omitted = new Set(topLevelKeys);
  const payload = Object.fromEntries(
    Object.entries(normalized).filter(
      ([key]) => !omitted.has(key),
    ),
  );
  return canonicalSha256(payload);
}
