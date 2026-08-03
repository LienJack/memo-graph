import { describe, expect, it } from "vitest";

import {
  CanonicalJsonError,
  canonicalJson,
  canonicalSha256,
} from "../../packages/contracts/src/index.js";

describe("canonical JSON", () => {
  it("sorts object keys recursively while preserving array order", () => {
    expect(
      canonicalJson({
        z: 1,
        a: { y: true, b: ["second", "first"] },
      }),
    ).toBe('{"a":{"b":["second","first"],"y":true},"z":1}');
  });

  it("produces the same hash for objects with different insertion order", () => {
    expect(canonicalSha256({ b: 2, a: 1 })).toBe(
      canonicalSha256({ a: 1, b: 2 }),
    );
  });

  it.each([
    { value: Number.POSITIVE_INFINITY, label: "non-finite number" },
    { value: Number.MAX_SAFE_INTEGER + 1, label: "unsafe integer" },
    { value: -0, label: "negative zero" },
    { value: undefined, label: "undefined" },
    { value: new Date(), label: "non-plain object" },
  ])("rejects $label", ({ value }) => {
    expect(() => canonicalJson(value)).toThrow(CanonicalJsonError);
  });

  it("rejects sparse arrays instead of silently normalizing holes", () => {
    const sparse = new Array<unknown>(2);
    sparse[1] = "present";

    expect(() => canonicalJson(sparse)).toThrow("sparse arrays are not allowed");
  });
});
