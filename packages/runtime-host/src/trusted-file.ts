import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type BigIntStats,
} from "node:fs";
import { resolve } from "node:path";

type FileIdentity = {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mode: bigint;
  uid: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
};

function identity(stat: BigIntStats): FileIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mode: stat.mode,
    uid: stat.uid,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

/** Read one private, owner-only regular file through a verified descriptor. */
export function readPrivateOperatorFile(
  path: string,
  hooks: { afterOpen?: () => void } = {},
): Buffer {
  const resolved = resolve(path);
  let descriptor: number | undefined;
  let bytes: Buffer | undefined;
  try {
    const pathBefore = lstatSync(resolved, { bigint: true });
    if (pathBefore.isSymbolicLink() || !pathBefore.isFile()) {
      throw new Error("trusted private descriptor is invalid");
    }
    descriptor = openSync(
      resolved,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const descriptorBefore = fstatSync(descriptor, { bigint: true });
    const expectedOwner = process.getuid?.();
    if (
      !descriptorBefore.isFile() ||
      descriptorBefore.dev !== pathBefore.dev ||
      descriptorBefore.ino !== pathBefore.ino ||
      descriptorBefore.size <= 0n ||
      descriptorBefore.size > 65_536n ||
      (descriptorBefore.mode & 0o077n) !== 0n ||
      (expectedOwner !== undefined &&
        descriptorBefore.uid !== BigInt(expectedOwner))
    ) {
      throw new Error("trusted private descriptor is invalid");
    }
    hooks.afterOpen?.();
    bytes = Buffer.alloc(Number(descriptorBefore.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(
        descriptor,
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (count <= 0) {
        throw new Error("trusted private descriptor is invalid");
      }
      offset += count;
    }
    const descriptorAfter = fstatSync(descriptor, { bigint: true });
    const pathAfter = lstatSync(resolved, { bigint: true });
    if (
      pathAfter.isSymbolicLink() ||
      !pathAfter.isFile() ||
      !sameIdentity(identity(descriptorBefore), identity(descriptorAfter)) ||
      descriptorAfter.dev !== pathAfter.dev ||
      descriptorAfter.ino !== pathAfter.ino ||
      realpathSync(resolved) !== resolved
    ) {
      throw new Error("trusted private descriptor is invalid");
    }
    return bytes;
  } catch {
    bytes?.fill(0);
    throw new Error("trusted private descriptor is invalid");
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}
