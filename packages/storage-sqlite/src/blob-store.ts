import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { StorageError } from "./errors.js";
import type { ParsedCommitEpisodeCommand } from "./protocol.js";

export type StoredBlob = {
  content_hash: string;
  size_bytes: number;
  media_type: string;
  relative_path: string;
};

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export class BlobStore {
  readonly #directory: string;

  constructor(directory: string) {
    this.#directory = directory;
  }

  pathFor(contentHash: string): string {
    return join(this.#directory, contentHash.slice("sha256:".length));
  }

  verifyExisting(contentHash: string, sizeBytes?: number): StoredBlob {
    const path = this.pathFor(contentHash);
    if (!existsSync(path)) {
      throw new StorageError("CORRUPTION");
    }
    const bytes = readFileSync(path);
    const actual = `sha256:${digest(bytes)}`;
    if (
      actual !== contentHash ||
      (sizeBytes !== undefined && bytes.byteLength !== sizeBytes)
    ) {
      throw new StorageError("CORRUPTION");
    }
    return {
      content_hash: contentHash,
      size_bytes: bytes.byteLength,
      media_type: "application/octet-stream",
      relative_path: `blobs/${contentHash.slice("sha256:".length)}`,
    };
  }

  ensure(blobs: ParsedCommitEpisodeCommand["blobs"]): StoredBlob[] {
    const unique = new Map<
      string,
      ParsedCommitEpisodeCommand["blobs"][number]
    >();
    for (const blob of blobs) {
      const current = unique.get(blob.content_hash);
      if (
        current !== undefined &&
        (current.media_type !== blob.media_type ||
          !Buffer.from(current.bytes).equals(Buffer.from(blob.bytes)))
      ) {
        throw new StorageError("INVALID_INPUT");
      }
      unique.set(blob.content_hash, blob);
    }

    return [...unique.values()].map((blob) => this.#ensureOne(blob));
  }

  #ensureOne(
    blob: ParsedCommitEpisodeCommand["blobs"][number],
  ): StoredBlob {
    const actualDigest = digest(blob.bytes);
    if (`sha256:${actualDigest}` !== blob.content_hash) {
      throw new StorageError("INVALID_INPUT");
    }

    const destination = this.pathFor(blob.content_hash);
    if (existsSync(destination)) {
      const existing = this.verifyExisting(
        blob.content_hash,
        blob.bytes.byteLength,
      );
      return { ...existing, media_type: blob.media_type };
    }

    const temporary = join(
      this.#directory,
      `.${actualDigest}.${randomUUID()}.tmp`,
    );
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temporary, "wx", 0o600);
      writeFileSync(descriptor, blob.bytes);
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporary, destination);
      chmodSync(destination, 0o600);

      const directoryDescriptor = openSync(this.#directory, "r");
      try {
        fsyncSync(directoryDescriptor);
      } finally {
        closeSync(directoryDescriptor);
      }
    } catch (error) {
      if (descriptor !== undefined) {
        closeSync(descriptor);
      }
      if (existsSync(temporary)) {
        unlinkSync(temporary);
      }
      throw error;
    }

    const stored = this.verifyExisting(blob.content_hash, blob.bytes.byteLength);
    if (statSync(destination).isFile() === false) {
      throw new StorageError("CORRUPTION");
    }
    return { ...stored, media_type: blob.media_type };
  }
}
