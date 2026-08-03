import { cpSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = realpathSync(
  resolve(dirname(fileURLToPath(import.meta.url)), ".."),
);
const repositoryMigrations = realpathSync(
  resolve(packageRoot, "..", "..", "migrations"),
);
const packagedMigrations = resolve(packageRoot, "migrations");
const relativeTarget = relative(packageRoot, packagedMigrations);

if (
  relativeTarget !== "migrations" ||
  relativeTarget.startsWith(`..${sep}`)
) {
  throw new Error("UNSAFE_PACKAGED_MIGRATIONS_PATH");
}

rmSync(packagedMigrations, { recursive: true, force: true });
mkdirSync(packagedMigrations, { mode: 0o755 });
cpSync(repositoryMigrations, packagedMigrations, {
  recursive: true,
  force: false,
  errorOnExist: true,
});
