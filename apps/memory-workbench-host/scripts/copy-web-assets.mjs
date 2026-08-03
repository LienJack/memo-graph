import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const hostRoot = dirname(scriptDirectory);
const webRoot = join(hostRoot, "..", "memory-workbench-web", "dist");
const targetRoot = join(hostRoot, "dist", "public");
if (!existsSync(join(webRoot, "index.html"))) {
  throw new Error("memory workbench web build is missing");
}
rmSync(targetRoot, { recursive: true, force: true });
mkdirSync(join(targetRoot, "assets"), { recursive: true });
cpSync(join(webRoot, "index.html"), join(targetRoot, "index.html"));
for (const name of readdirSync(join(webRoot, "assets")).sort()) {
  if (name.endsWith(".map")) continue;
  const source = join(webRoot, "assets", name);
  if (!lstatSync(source).isFile()) continue;
  cpSync(source, join(targetRoot, "assets", name));
}
