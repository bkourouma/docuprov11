// @archivage/storage — FileStore abstraction + local-disk implementation (T016, D-16).
// Binaries are stored off-DB as {fileId}{extension} under the ARCHIVES root.

import { createReadStream, type ReadStream } from 'node:fs';
import { mkdir, readFile, writeFile, unlink, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export interface FileStore {
  /** Absolute path where this file's binary lives. */
  path(fileId: number, extension: string): string;
  write(fileId: number, extension: string, data: Buffer): Promise<string>;
  read(fileId: number, extension: string): Promise<Buffer>;
  createReadStream(fileId: number, extension: string): ReadStream;
  exists(fileId: number, extension: string): Promise<boolean>;
  remove(fileId: number, extension: string): Promise<void>;
}

function fileName(fileId: number, extension: string): string {
  const ext = extension.startsWith('.') || extension === '' ? extension : `.${extension}`;
  return `${fileId}${ext}`;
}

export class DiskFileStore implements FileStore {
  private readonly root: string;

  constructor(rootDir: string) {
    this.root = resolve(rootDir);
  }

  path(fileId: number, extension: string): string {
    return join(this.root, fileName(fileId, extension));
  }

  async write(fileId: number, extension: string, data: Buffer): Promise<string> {
    await mkdir(this.root, { recursive: true });
    const target = this.path(fileId, extension);
    await writeFile(target, data);
    return target;
  }

  read(fileId: number, extension: string): Promise<Buffer> {
    return readFile(this.path(fileId, extension));
  }

  createReadStream(fileId: number, extension: string): ReadStream {
    return createReadStream(this.path(fileId, extension));
  }

  async exists(fileId: number, extension: string): Promise<boolean> {
    try {
      await access(this.path(fileId, extension));
      return true;
    } catch {
      return false;
    }
  }

  async remove(fileId: number, extension: string): Promise<void> {
    try {
      await unlink(this.path(fileId, extension));
    } catch {
      /* already gone */
    }
  }
}
