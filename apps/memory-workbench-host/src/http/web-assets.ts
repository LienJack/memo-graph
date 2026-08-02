import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_INDEX_BYTES = 2 * 1024 * 1024;
const MAX_ASSET_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 24 * 1024 * 1024;

const CONTENT_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".woff2", "font/woff2"],
]);

export type WorkbenchWebAsset = {
  contentType: string;
  bytes: Buffer;
};

export type WorkbenchWebAssets = {
  indexHtml: string;
  assets: ReadonlyMap<string, WorkbenchWebAsset>;
};

export function loadWorkbenchWebAssets(root: string): WorkbenchWebAssets {
  const indexPath = join(root, "index.html");
  const indexStat = lstatSync(indexPath);
  if (!indexStat.isFile() || indexStat.isSymbolicLink() || indexStat.size > MAX_INDEX_BYTES) {
    throw new Error("WORKBENCH_WEB_INDEX_INVALID");
  }
  const indexHtml = readFileSync(indexPath, "utf8");
  if (
    !indexHtml.includes('<div id="root"></div>') ||
    /<script(?![^>]*\bsrc=)[^>]*>/iu.test(indexHtml) ||
    /https?:\/\//iu.test(indexHtml)
  ) {
    throw new Error("WORKBENCH_WEB_INDEX_INVALID");
  }
  const assetRoot = join(root, "assets");
  const assets = new Map<string, WorkbenchWebAsset>();
  let totalBytes = Buffer.byteLength(indexHtml, "utf8");
  for (const name of readdirSync(assetRoot).sort()) {
    if (!/^[A-Za-z0-9._-]+$/u.test(name) || name.endsWith(".map")) continue;
    const path = join(assetRoot, name);
    const stat = lstatSync(path);
    const contentType = CONTENT_TYPES.get(extname(name));
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      contentType === undefined ||
      stat.size > MAX_ASSET_BYTES
    ) {
      throw new Error("WORKBENCH_WEB_ASSET_INVALID");
    }
    const bytes = readFileSync(path);
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new Error("WORKBENCH_WEB_ASSETS_TOO_LARGE");
    }
    assets.set(`/assets/${name}`, { contentType, bytes });
  }
  if (assets.size === 0) {
    throw new Error("WORKBENCH_WEB_ASSETS_MISSING");
  }
  return { indexHtml, assets };
}

export function loadPackagedWorkbenchWebAssets(): WorkbenchWebAssets {
  const candidates = [
    fileURLToPath(new URL("../public", import.meta.url)),
    fileURLToPath(new URL("../../dist/public", import.meta.url)),
  ];
  const root = candidates.find((candidate) =>
    existsSync(join(candidate, "index.html"))
  );
  if (root === undefined) {
    throw new Error("WORKBENCH_WEB_ASSETS_MISSING");
  }
  return loadWorkbenchWebAssets(root);
}

export function workbenchIndexHtml(
  assets: WorkbenchWebAssets,
  instanceId: string,
): string {
  const marker = '<html lang="zh-CN">';
  if (
    !assets.indexHtml.includes(marker) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(instanceId)
  ) {
    throw new Error("WORKBENCH_WEB_INDEX_INVALID");
  }
  return assets.indexHtml.replace(
    marker,
    `<html lang="zh-CN" data-instance="${instanceId}">`,
  );
}
