const blocked = new Set([
  "@huggingface/transformers",
  "better-sqlite3",
  "sqlite-vec",
]);

export async function resolve(specifier, context, nextResolve) {
  if (blocked.has(specifier)) {
    throw new Error(`blocked optional dependency: ${specifier}`);
  }
  return nextResolve(specifier, context);
}
