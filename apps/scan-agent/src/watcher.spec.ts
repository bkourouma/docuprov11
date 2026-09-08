import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthorizationError, UploadError, type ScanApiClient } from './api-client';
import { FAILED_DIR, SENT_DIR } from './dispatch';
import { createState, ensureDirs, runCycle, type AgentState, type CycleOptions } from './watcher';

/** Logger muet : les cycles loggent beaucoup, les assertions portent sur le disque. */
const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as Parameters<typeof runCycle>[3];

function fakeClient(upload: ScanApiClient['upload']): ScanApiClient {
  return { upload } as unknown as ScanApiClient;
}

describe('runCycle', () => {
  let dir: string;
  let state: AgentState;
  let options: CycleOptions;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'scan-agent-'));
    await ensureDirs(dir);
    state = createState();
    options = {
      watchDir: dir,
      machineName: 'POSTE-01',
      stableMs: 1_000,
      maxAttempts: 3,
      maxFileBytes: 1_024,
    };
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // Sous Windows uniquement : ailleurs, `attrib` n'existe pas et le masquage est sans objet.
  const itOnWindows = process.platform === 'win32' ? it : it.skip;
  itOnWindows('masque les dossiers de service — seuls les PDF à déposer restent visibles', () => {
    for (const sub of [SENT_DIR, FAILED_DIR]) {
      const target = join(dir, sub);
      const output = execFileSync('attrib', [target]).toString();
      // `attrib` liste les drapeaux avant le chemin : « A  H   C:\… ».
      expect(output.slice(0, output.indexOf(target))).toContain('H');
    }
  });

  /** Deux cycles : le premier observe, le second (horloge avancée) constate la stabilité. */
  async function settleAndRun(client: ScanApiClient, elapsed = 5_000) {
    let now = 0;
    await runCycle(client, state, options, logger, () => now);
    now = elapsed;
    return runCycle(client, state, options, logger, () => now);
  }

  it('n’envoie rien tant que le fichier n’est pas stable', async () => {
    await writeFile(join(dir, 'scan.pdf'), '%PDF-1.4');
    const upload = jest.fn();
    const res = await runCycle(fakeClient(upload as never), state, options, logger, () => 0);

    expect(upload).not.toHaveBeenCalled();
    expect(res).toEqual({ uploaded: 0, failed: 0, pending: 1 });
  });

  it('envoie le fichier stable puis le classe dans _envoyes/<jour>', async () => {
    await writeFile(join(dir, 'scan.pdf'), '%PDF-1.4');
    const upload = jest.fn(async () => ({ mailScannedDocumentId: 42, fileName: 'scan.pdf' }));

    const res = await settleAndRun(fakeClient(upload as never));

    expect(res.uploaded).toBe(1);
    expect(upload).toHaveBeenCalledTimes(1);
    const [name, content, machine] = upload.mock.calls[0] as unknown as [string, Buffer, string];
    expect(name).toBe('scan.pdf');
    expect(content.toString()).toBe('%PDF-1.4');
    expect(machine).toBe('POSTE-01');

    expect(await readdir(dir)).not.toContain('scan.pdf'); // plus jamais renvoyé
    const days = await readdir(join(dir, SENT_DIR));
    expect(await readdir(join(dir, SENT_DIR, days[0]!))).toEqual(['scan.pdf']);
  });

  it('ne regarde ni les extensions refusées ni les sous-dossiers de service', async () => {
    await writeFile(join(dir, 'note.docx'), 'x');
    await writeFile(join(dir, 'scan.pdf.tmp'), 'x');
    await writeFile(join(dir, SENT_DIR, 'deja-envoye.pdf'), 'x');
    const upload = jest.fn();

    const res = await settleAndRun(fakeClient(upload as never));

    expect(upload).not.toHaveBeenCalled();
    expect(res).toEqual({ uploaded: 0, failed: 0, pending: 0 });
  });

  it('met en quarantaine avec son motif un fichier refusé par l’API', async () => {
    await writeFile(join(dir, 'scan.pdf'), '%PDF-1.4');
    const upload = jest.fn(async () => {
      throw new UploadError('HTTP 400 — Extension non acceptée', false, 400);
    });

    const res = await settleAndRun(fakeClient(upload as never));

    expect(res.failed).toBe(1);
    expect(upload).toHaveBeenCalledTimes(1); // non rejouable : une seule tentative
    expect((await readdir(join(dir, FAILED_DIR))).sort()).toEqual([
      'scan.pdf',
      'scan.pdf.motif.txt',
    ]);
    const note = await readFile(join(dir, FAILED_DIR, 'scan.pdf.motif.txt'), 'utf8');
    expect(note).toContain('Extension non acceptée');
  });

  it('réessaie une panne serveur puis abandonne après maxAttempts', async () => {
    await writeFile(join(dir, 'scan.pdf'), '%PDF-1.4');
    const upload = jest.fn(async () => {
      throw new UploadError('HTTP 503', true, 503);
    });
    const client = fakeClient(upload as never);

    let now = 0;
    await runCycle(client, state, options, logger, () => now);
    now = 5_000;
    for (let i = 0; i < 3; i += 1) await runCycle(client, state, options, logger, () => now);

    expect(upload).toHaveBeenCalledTimes(3); // maxAttempts
    expect(await readdir(join(dir, FAILED_DIR))).toContain('scan.pdf');
    expect(await readdir(dir)).not.toContain('scan.pdf');
  });

  it('met en quarantaine un fichier plus gros que la limite sans appeler l’API', async () => {
    await writeFile(join(dir, 'gros.pdf'), Buffer.alloc(2_048, 1));
    const upload = jest.fn();

    const res = await settleAndRun(fakeClient(upload as never));

    expect(upload).not.toHaveBeenCalled();
    expect(res.failed).toBe(1);
    expect(await readdir(join(dir, FAILED_DIR))).toContain('gros.pdf');
  });

  it('n’écrase jamais un homonyme déjà classé', async () => {
    await writeFile(join(dir, 'scan.pdf'), 'premier');
    const upload = jest.fn(async () => ({ mailScannedDocumentId: 1, fileName: 'scan.pdf' }));
    const client = fakeClient(upload as never);

    await settleAndRun(client);
    await writeFile(join(dir, 'scan.pdf'), 'second');
    state = createState();
    await settleAndRun(client);

    const days = await readdir(join(dir, SENT_DIR));
    const classed = await readdir(join(dir, SENT_DIR, days[0]!));
    expect(classed.sort()).toEqual(['scan (2).pdf', 'scan.pdf']);
    expect(await readFile(join(dir, SENT_DIR, days[0]!, 'scan.pdf'), 'utf8')).toBe('premier');
    expect(await readFile(join(dir, SENT_DIR, days[0]!, 'scan (2).pdf'), 'utf8')).toBe('second');
  });

  it('laisse tout en place quand le compte de service est refusé', async () => {
    await writeFile(join(dir, 'scan.pdf'), '%PDF-1.4');
    const upload = jest.fn(async () => {
      throw new AuthorizationError('permission manquante', 403);
    });

    await expect(settleAndRun(fakeClient(upload as never))).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    expect(await readdir(dir)).toContain('scan.pdf');
    expect(await readdir(join(dir, FAILED_DIR))).toHaveLength(0);
  });
});
