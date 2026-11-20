import * as fsp from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import * as path from 'node:path';
import { ConnectorItemRejectedError, type FsEntry, type FsProvider } from '../types';

/** Profondeur maximale du parcours : borne un arbre pathologique (montage bouclant, arborescence géante). */
const MAX_DEPTH = 32;
const READ_CHUNK = 64 * 1024;

const SERVICE_DIRS = new Set(['_envoyes', '_erreurs']);
const TEMP_SUFFIXES = ['.tmp', '.temp', '.part', '.partial', '.crdownload', '.filepart'];

function skipName(name: string, isDir: boolean): boolean {
  if (name.startsWith('.')) return true;
  if (isDir) return SERVICE_DIRS.has(name.toLowerCase());
  if (name.startsWith('~$')) return true;
  const lower = name.toLowerCase();
  return TEMP_SUFFIXES.some((s) => lower.endsWith(s));
}

/**
 * Implémentation réelle de `FsProvider` sur `node:fs/promises`. Lecture seule : aucune écriture,
 * aucun déplacement, aucune suppression. Les liens symboliques ne sont jamais suivis au parcours.
 */
export function createDefaultFsProvider(): FsProvider {
  const posix = process.platform !== 'win32';

  async function walkDir(
    root: string,
    relDir: string,
    depth: number,
    out: FsEntry[],
  ): Promise<void> {
    if (depth > MAX_DEPTH) return;
    const dirAbs = relDir ? path.join(root, ...relDir.split('/')) : root;
    const dirents = await fsp.readdir(dirAbs, { withFileTypes: true });
    for (const d of dirents) {
      if (d.isSymbolicLink()) continue; // jamais suivi : anti-traversée
      if (skipName(d.name, d.isDirectory())) continue;
      const rel = relDir ? `${relDir}/${d.name}` : d.name;
      if (d.isDirectory()) {
        await walkDir(root, rel, depth + 1, out);
      } else if (d.isFile()) {
        let st;
        try {
          st = await fsp.lstat(path.join(dirAbs, d.name));
        } catch {
          continue; // disparu entre le listage et la lecture des attributs
        }
        if (!st.isFile()) continue;
        out.push({
          relPath: rel,
          size: st.size,
          mtimeMs: st.mtimeMs,
          birthtimeMs: st.birthtimeMs > 0 ? st.birthtimeMs : undefined,
          // Sous Windows/SMB, mode/uid/gid sont fabriqués par Node : on ne les expose pas.
          mode: posix ? st.mode & 0o7777 : undefined,
          uid: posix ? st.uid : undefined,
          gid: posix ? st.gid : undefined,
        });
      }
    }
  }

  return {
    async walk(root: string): Promise<FsEntry[]> {
      const out: FsEntry[] = [];
      await walkDir(root, '', 0, out);
      return out;
    },

    async readFile(absPath: string, maxBytes: number): Promise<Buffer> {
      // O_NOFOLLOW (hors Windows) : même si le chemin a été échangé contre un lien après le contrôle
      // `realpath`, l'ouverture échoue au lieu de suivre le lien.
      const flags = fsConstants.O_RDONLY | (posix ? fsConstants.O_NOFOLLOW : 0);
      const fh = await fsp.open(absPath, flags);
      try {
        const st = await fh.stat();
        if (!st.isFile()) throw new ConnectorItemRejectedError("Ce n'est pas un fichier ordinaire.");
        if (st.size > maxBytes) {
          throw new ConnectorItemRejectedError(`Fichier trop volumineux (limite ${maxBytes} octets).`);
        }
        const chunks: Buffer[] = [];
        let total = 0;
        for (;;) {
          const buf = Buffer.allocUnsafe(READ_CHUNK);
          const { bytesRead } = await fh.read(buf, 0, READ_CHUNK, null);
          if (bytesRead === 0) break;
          total += bytesRead;
          // Le fichier peut grossir pendant la lecture : on re-borne au fil de l'eau.
          if (total > maxBytes) {
            throw new ConnectorItemRejectedError(`Fichier trop volumineux (limite ${maxBytes} octets).`);
          }
          chunks.push(buf.subarray(0, bytesRead));
        }
        return Buffer.concat(chunks, total);
      } finally {
        await fh.close();
      }
    },

    async realpath(absPath: string): Promise<string> {
      return fsp.realpath(absPath);
    },
  };
}
