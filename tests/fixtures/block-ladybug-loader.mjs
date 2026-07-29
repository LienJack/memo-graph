export async function resolve(specifier, context, nextResolve) {
  if (
    specifier === "@ladybugdb/core" ||
    specifier.startsWith("@ladybugdb/core/")
  ) {
    throw new Error("optional LadybugDB dependency is unavailable");
  }
  return nextResolve(specifier, context);
}
