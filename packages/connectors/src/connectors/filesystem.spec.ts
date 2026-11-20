import * as path from 'node:path';
import { createDefaultRegistry } from '../default-registry';
import { buildConnector } from '../registry';
import {
  ConnectorAuthError,
  ConnectorItemRejectedError,
  type ConnectorDeps,
  type FsEntry,
  type FsProvider,
  type SourceConnector,
} from '../types';
import { filesystemConnector } from './filesystem';

const ROOT = path.resolve('/srv/ged');
const SCANS = path.join(ROOT, 'scans');
const OUTSIDE = path.resolve('/srv/autre');
const NOW = 1_800_000_000_000;
const OLD = NOW - 3_600_000;

interface MemFile {
  size: number;
  mtimeMs: number;
  mode?: number;
  uid?: number;
  gid?: number;
  birthtimeMs?: number;
  /** Lien symbolique : chemin réel simulé, hors racine. */
  linkTo?: string;
  content?: Buffer;
}

/** Système de fichiers en mémoire : aucun accès disque réel. */
class MemFs implements FsProvider {
  files = new Map<string, MemFile>();
  rootMissing = false;
  walkCalls = 0;

  add(rel: string, f: Partial<MemFile> = {}): void {
    const content = f.content ?? Buffer.from('contenu');
    this.files.set(rel, { size: content.length, mtimeMs: OLD, content, ...f });
  }
  async walk(root: string): Promise<FsEntry[]> {
    this.walkCalls++;
    if (this.rootMissing) throw Object.assign(new Error('absent'), { code: 'ENOENT' });
    expect(root).toBe(SCANS);
    return [...this.files.entries()].map(([relPath, f]) => ({
      relPath,
      size: f.size,
      mtimeMs: f.mtimeMs,
      birthtimeMs: f.birthtimeMs,
      mode: f.mode,
      uid: f.uid,
      gid: f.gid,
    }));
  }
  async readFile(absPath: string, maxBytes: number): Promise<Buffer> {
    const rel = path.relative(SCANS, absPath).split(path.sep).join('/');
    const f = this.files.get(rel);
    if (!f) throw Object.assign(new Error('absent'), { code: 'ENOENT' });
    if (f.size > maxBytes) throw new ConnectorItemRejectedError('trop gros');
    return f.content ?? Buffer.alloc(0);
  }
  /** Dossiers existants hors fichiers (racines, coffre, cibles de liens). */
  dirs = new Set<string>([ROOT, SCANS]);
  /** Table de liens symboliques simulés : chemin du lien → cible (peut elle-même traverser un lien). */
  links = new Map<string, string>();

  /** Résolution façon `realpath` : composant par composant, liens suivis, ENOENT si absent. */
  private resolveTable(p: string, depth = 0): string {
    if (depth > 10) throw Object.assign(new Error('boucle'), { code: 'ELOOP' });
    const abs = path.resolve(p);
    const { root } = path.parse(abs);
    let acc = root;
    for (const seg of path.relative(root, abs).split(path.sep).filter(Boolean)) {
      acc = path.join(acc, seg);
      const target = this.links.get(acc);
      if (target) acc = this.resolveTable(target, depth + 1);
      else if (![...this.dirs].some((d) => d === acc || d.startsWith(acc + path.sep)))
        throw Object.assign(new Error('absent'), { code: 'ENOENT' });
    }
    return acc;
  }

  async realpath(absPath: string): Promise<string> {
    const rel = path.relative(SCANS, absPath);
    const underScans = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
    if (this.rootMissing && (rel === '' || underScans)) {
      throw Object.assign(new Error('absent'), { code: 'ENOENT' });
    }
    if (underScans && !this.links.has(SCANS)) {
      const f = this.files.get(rel.split(path.sep).join('/'));
      if (!f) throw Object.assign(new Error('absent'), { code: 'ENOENT' });
      return f.linkTo ?? absPath;
    }
    return this.resolveTable(absPath);
  }
}

function make(
  mem: MemFs,
  config: Record<string, unknown> = {},
  extra: {
    limits?: { maxFileBytes?: number; allowedExtensions?: string[] };
    env?: NodeJS.ProcessEnv;
  } = {},
): SourceConnector {
  const deps: ConnectorDeps = {
    fs: mem,
    now: () => new Date(NOW),
    env: extra.env ?? { GED_CONNECTOR_FS_ROOTS: ROOT },
  };
  return buildConnector(createDefaultRegistry(), 'filesystem', {
    config: { rootPath: SCANS, ...config },
    credentials: {},
    limits: extra.limits,
    deps,
  });
}

const names = (items: { externalId: string }[]) => items.map((i) => i.externalId);

describe('filesystem — listage', () => {
  it('liste tout au premier passage et ignore les fichiers non éligibles', async () => {
    const mem = new MemFs();
    mem.add('a.pdf', { mtimeMs: OLD });
    mem.add('sous/b.docx', { mtimeMs: OLD + 1000 });
    mem.add('.cache.pdf');
    mem.add('~$brouillon.docx');
    mem.add('copie.pdf.part');
    mem.add('_envoyes/vieux.pdf');
    mem.add('_ERREURS/casse.pdf');
    mem.add('.git/x.pdf');
    mem.add('programme.exe');
    mem.add('sans-extension');
    const page = await make(mem).listChanges(null, { pageSize: 100 });
    expect(names(page.items)).toEqual(['a.pdf', 'sous/b.docx']);
    expect(page.hasMore).toBe(false);
    expect(page.deletedExternalIds).toEqual([]);
    expect(JSON.parse(page.nextToken as string)).toEqual({ m: OLD + 1000, p: 'sous/b.docx' });
  });

  it('renseigne les attributs de l’élément', async () => {
    const mem = new MemFs();
    mem.add('Rapport 2026.PDF', {
      size: 1234,
      mtimeMs: OLD,
      birthtimeMs: OLD - 5000,
      uid: 1001,
      content: Buffer.alloc(1234),
    });
    const [item] = (await make(mem).listChanges(null, { pageSize: 10 })).items;
    expect(item).toMatchObject({
      externalId: 'Rapport 2026.PDF',
      name: 'Rapport 2026.PDF',
      originPath: 'Rapport 2026.PDF',
      mimeType: 'application/pdf',
      byteLength: 1234,
      originAuthor: 'uid:1001',
      remoteVersion: `1234:${OLD}`,
    });
    expect(item?.originCreatedAt?.getTime()).toBe(OLD - 5000);
    expect(item?.originModifiedAt?.getTime()).toBe(OLD);
  });

  it('est incrémental : nouveaux et modifiés seulement', async () => {
    const mem = new MemFs();
    mem.add('a.pdf', { mtimeMs: OLD });
    mem.add('b.pdf', { mtimeMs: OLD + 10 });
    const c = make(mem);
    const first = await c.listChanges(null, { pageSize: 100 });
    const idle = await c.listChanges(first.nextToken, { pageSize: 100 });
    expect(idle.items).toEqual([]);
    expect(idle.nextToken).toBe(first.nextToken);

    mem.add('nouveau.pdf', { mtimeMs: OLD + 50 });
    mem.add('a.pdf', { mtimeMs: OLD + 100 }); // modifié
    const next = await c.listChanges(first.nextToken, { pageSize: 100 });
    expect(names(next.items)).toEqual(['nouveau.pdf', 'a.pdf']);
  });

  it('pagine par pageSize et reprend au curseur', async () => {
    const mem = new MemFs();
    for (let i = 0; i < 5; i++) mem.add(`f${i}.pdf`, { mtimeMs: OLD + i });
    const c = make(mem);
    const p1 = await c.listChanges(null, { pageSize: 2 });
    expect(names(p1.items)).toEqual(['f0.pdf', 'f1.pdf']);
    expect(p1.hasMore).toBe(true);
    const p2 = await c.listChanges(p1.nextToken, { pageSize: 2 });
    expect(names(p2.items)).toEqual(['f2.pdf', 'f3.pdf']);
    expect(p2.hasMore).toBe(true);
    const p3 = await c.listChanges(p2.nextToken, { pageSize: 2 });
    expect(names(p3.items)).toEqual(['f4.pdf']);
    expect(p3.hasMore).toBe(false);
  });

  it('départage les mtime identiques par chemin sans perdre ni répéter d’élément', async () => {
    const mem = new MemFs();
    for (const n of ['c', 'a', 'd', 'b']) mem.add(`${n}.pdf`, { mtimeMs: OLD });
    const c = make(mem);
    const p1 = await c.listChanges(null, { pageSize: 3 });
    const p2 = await c.listChanges(p1.nextToken, { pageSize: 3 });
    expect(names(p1.items)).toEqual(['a.pdf', 'b.pdf', 'c.pdf']);
    expect(names(p2.items)).toEqual(['d.pdf']);
  });

  it('ignore un fichier trop récent (en cours d’écriture) sans que le curseur le saute', async () => {
    const mem = new MemFs();
    mem.add('vieux.pdf', { mtimeMs: OLD });
    mem.add('en-cours.pdf', { mtimeMs: NOW - 5_000 });
    const c = make(mem);
    const p1 = await c.listChanges(null, { pageSize: 10 });
    expect(names(p1.items)).toEqual(['vieux.pdf']);
    // Le fichier a cessé de bouger depuis plus de 30 s : il est repris, derrière le curseur.
    mem.files.get('en-cours.pdf')!.mtimeMs = NOW - 60_000;
    const p2 = await c.listChanges(p1.nextToken, { pageSize: 10 });
    expect(names(p2.items)).toEqual(['en-cours.pdf']);
  });

  it('respecte minAgeSeconds = 0', async () => {
    const mem = new MemFs();
    mem.add('tout-neuf.pdf', { mtimeMs: NOW });
    const page = await make(mem, { minAgeSeconds: 0 }).listChanges(null, { pageSize: 10 });
    expect(names(page.items)).toEqual(['tout-neuf.pdf']);
  });

  it('ne descend pas dans les sous-dossiers si recursive = false', async () => {
    const mem = new MemFs();
    mem.add('racine.pdf');
    mem.add('sous/profond.pdf');
    const page = await make(mem, { recursive: false }).listChanges(null, { pageSize: 10 });
    expect(names(page.items)).toEqual(['racine.pdf']);
  });

  it('restreint aux extensions de la config (jamais au-delà de la liste globale)', async () => {
    const mem = new MemFs();
    mem.add('a.pdf');
    mem.add('b.docx');
    mem.add('c.exe');
    const page = await make(mem, { extensions: ['.docx', '.exe'] }).listChanges(null, {
      pageSize: 10,
    });
    expect(names(page.items)).toEqual(['b.docx']);
  });

  it('lève une erreur claire sur un jeton corrompu au lieu de relister', async () => {
    const mem = new MemFs();
    mem.add('a.pdf');
    const c = make(mem);
    for (const bad of ['pas du json', '{"m":"x","p":1}', '[]', 'null']) {
      await expect(c.listChanges(bad, { pageSize: 10 })).rejects.toThrow(/illisible/);
    }
    expect(mem.walkCalls).toBe(0);
  });

  it('refuse de lister si la config est dangereuse (racines absentes)', async () => {
    const mem = new MemFs();
    const c = make(mem, {}, { env: {} });
    await expect(c.listChanges(null, { pageSize: 10 })).rejects.toBeInstanceOf(ConnectorAuthError);
    expect(mem.walkCalls).toBe(0);
  });
});

describe('filesystem — récupération', () => {
  it('lit un fichier valide', async () => {
    const mem = new MemFs();
    mem.add('sous/x.pdf', { content: Buffer.from('%PDF-1.4') });
    const c = make(mem);
    const [item] = (await c.listChanges(null, { pageSize: 10 })).items;
    const file = await c.fetchFile(item!);
    expect(file.bytes.toString()).toBe('%PDF-1.4');
    expect(file.name).toBe('x.pdf');
    expect(file.mimeType).toBe('application/pdf');
  });

  it('refuse une extension non autorisée', async () => {
    const mem = new MemFs();
    mem.add('virus.exe');
    await expect(
      make(mem).fetchFile({ externalId: 'virus.exe', name: 'virus.exe' }),
    ).rejects.toBeInstanceOf(ConnectorItemRejectedError);
  });

  it('refuse une taille au-delà des limites (annoncée puis réelle)', async () => {
    const mem = new MemFs();
    mem.add('gros.pdf', { size: 500, content: Buffer.alloc(500) });
    const c = make(mem, {}, { limits: { maxFileBytes: 100 } });
    // Taille annoncée trop grande : refus avant toute lecture.
    await expect(
      c.fetchFile({ externalId: 'gros.pdf', name: 'gros.pdf', byteLength: 500 }),
    ).rejects.toBeInstanceOf(ConnectorItemRejectedError);
    // Taille annoncée mensongère : la lecture bornée refuse aussi.
    await expect(
      c.fetchFile({ externalId: 'gros.pdf', name: 'gros.pdf', byteLength: 10 }),
    ).rejects.toBeInstanceOf(ConnectorItemRejectedError);
  });

  it('refuse un fichier dont le chemin réel sort de la racine (lien symbolique)', async () => {
    const mem = new MemFs();
    mem.add('lien.pdf', { linkTo: path.join(OUTSIDE, 'secret.pdf') });
    await expect(make(mem).fetchFile({ externalId: 'lien.pdf', name: 'lien.pdf' })).rejects.toThrow(
      /sort du dossier/,
    );
  });

  it.each([
    ['../secret.pdf'],
    ['a/../../b.pdf'],
    ['/etc/passwd.pdf'],
    ['C:/x.pdf'],
    ['a\\b.pdf'],
    ['a\0.pdf'],
    ['a//b.pdf'],
    [''],
  ])('refuse l’identifiant de traversée %j', async (id) => {
    const mem = new MemFs();
    await expect(make(mem).fetchFile({ externalId: id, name: 'x.pdf' })).rejects.toBeInstanceOf(
      ConnectorItemRejectedError,
    );
  });

  it('refuse un fichier disparu comme un élément en erreur', async () => {
    await expect(
      make(new MemFs()).fetchFile({ externalId: 'parti.pdf', name: 'parti.pdf' }),
    ).rejects.toBeInstanceOf(ConnectorItemRejectedError);
  });

  it('n’écrit, ne déplace ni ne supprime rien : FsProvider n’expose que la lecture', async () => {
    const mem = new MemFs();
    mem.add('a.pdf');
    const c = make(mem);
    const [item] = (await c.listChanges(null, { pageSize: 10 })).items;
    await c.fetchFile(item!);
    expect([...mem.files.keys()]).toEqual(['a.pdf']);
  });
});

describe('filesystem — findMissing', () => {
  it('renvoie les ids dont le fichier n’existe plus ou sort de la racine', async () => {
    const mem = new MemFs();
    mem.add('reste.pdf');
    mem.add('lien.pdf', { linkTo: path.join(OUTSIDE, 'x.pdf') });
    const missing = await make(mem).findMissing!([
      'reste.pdf',
      'parti.pdf',
      'lien.pdf',
      '../hors.pdf',
    ]);
    expect(missing.sort()).toEqual(['../hors.pdf', 'lien.pdf', 'parti.pdf']);
  });

  it('lève si la racine est injoignable (partage démonté) au lieu de tout déclarer supprimé', async () => {
    const mem = new MemFs();
    mem.add('a.pdf');
    mem.rootMissing = true;
    await expect(make(mem).findMissing!(['a.pdf'])).rejects.toThrow(/injoignable/);
  });

  it('gère de grandes listes par lots', async () => {
    const mem = new MemFs();
    const ids: string[] = [];
    for (let i = 0; i < 45; i++) {
      if (i % 2 === 0) mem.add(`f${i}.pdf`);
      ids.push(`f${i}.pdf`);
    }
    const missing = await make(mem).findMissing!(ids);
    expect(missing).toHaveLength(22);
  });
});

describe('filesystem — droits d’origine POSIX', () => {
  async function aclFor(meta: Partial<MemFile>) {
    const mem = new MemFs();
    mem.add('a.pdf', meta);
    const c = make(mem);
    const [item] = (await c.listChanges(null, { pageSize: 10 })).items;
    return c.readOriginAcl(item!);
  }

  it('0o640 : propriétaire en écriture, groupe en lecture, pas de public', async () => {
    expect(await aclFor({ mode: 0o640, uid: 1000, gid: 50 })).toEqual({
      entries: [
        { principal: 'uid:1000', kind: 'user', access: 'write' },
        { principal: 'gid:50', kind: 'group', access: 'read' },
      ],
    });
  });

  it('0o664 : « autres » lisibles devient une entrée public', async () => {
    const acl = await aclFor({ mode: 0o664, uid: 1, gid: 2 });
    expect(acl?.entries).toContainEqual({ principal: '*', kind: 'public', access: 'read' });
    expect(acl?.entries.find((e) => e.kind === 'group')?.access).toBe('write');
  });

  it('0o600 : propriétaire seul', async () => {
    expect(await aclFor({ mode: 0o600, uid: 7 })).toEqual({
      entries: [{ principal: 'uid:7', kind: 'user', access: 'write' }],
    });
  });

  it('0o444 sans uid/gid : principaux génériques en lecture', async () => {
    expect(await aclFor({ mode: 0o444 })).toEqual({
      entries: [
        { principal: 'owner', kind: 'user', access: 'read' },
        { principal: 'group', kind: 'group', access: 'read' },
        { principal: '*', kind: 'public', access: 'read' },
      ],
    });
  });

  it('0o000 : aucune entrée (personne)', async () => {
    expect(await aclFor({ mode: 0 })).toEqual({ entries: [] });
  });

  it('mode inconnu (SMB/Windows) : null', async () => {
    expect(await aclFor({})).toBeNull();
  });
});

describe('filesystem — assertConfigSafe', () => {
  // Un disque simulé est injecté : les racines autorisées doivent être RÉSOLUBLES pour autoriser.
  const env = (extra: NodeJS.ProcessEnv = {}): ConnectorDeps => ({
    env: { GED_CONNECTOR_FS_ROOTS: ROOT, ...extra },
  });
  const check = (rootPath: string, deps: ConnectorDeps) =>
    filesystemConnector.assertConfigSafe({ rootPath }, { fs: deps.fs ?? new MemFs(), ...deps });

  it('accepte la racine autorisée et ses sous-dossiers', async () => {
    await expect(check(ROOT, env())).resolves.toBeUndefined();
    await expect(check(SCANS, env())).resolves.toBeUndefined();
  });

  it('accepte une racine parmi plusieurs (séparateur de la plateforme)', async () => {
    const roots = [path.resolve('/data/un'), ROOT].join(path.delimiter);
    await expect(check(SCANS, { env: { GED_CONNECTOR_FS_ROOTS: roots } })).resolves.toBeUndefined();
  });

  it('refuse un chemin relatif', async () => {
    await expect(check('scans/x', env())).rejects.toThrow(/absolu/);
  });

  it('refuse « .. »', async () => {
    await expect(check(`${SCANS}/../autre`, env())).rejects.toThrow(/\.\./);
    await expect(check(`${SCANS}\\..\\autre`, env())).rejects.toThrow(/\.\./);
  });

  it('refuse un octet nul', async () => {
    await expect(check(`${SCANS}\0`, env())).rejects.toThrow(/interdit/);
  });

  it('refuse un dossier hors des racines autorisées', async () => {
    await expect(check(OUTSIDE, env())).rejects.toThrow(/racines autorisées/);
  });

  it('refuse un dossier qui préfixe seulement le nom d’une racine', async () => {
    await expect(check(`${ROOT}-copie`, env())).rejects.toThrow(/racines autorisées/);
  });

  it('refuse tout quand les racines sont absentes, vides ou blanches', async () => {
    await expect(check(SCANS, { env: {} })).rejects.toThrow(/GED_CONNECTOR_FS_ROOTS/);
    await expect(check(SCANS, { env: { GED_CONNECTOR_FS_ROOTS: '' } })).rejects.toThrow(
      /GED_CONNECTOR_FS_ROOTS/,
    );
    await expect(check(SCANS, { env: { GED_CONNECTOR_FS_ROOTS: '  ' } })).rejects.toThrow(
      /GED_CONNECTOR_FS_ROOTS/,
    );
  });

  it('refuse ARCHIVES_PATH, ses parents et ses descendants', async () => {
    const archives = path.join(ROOT, 'archives');
    const deps = env({ ARCHIVES_PATH: archives });
    await expect(check(archives, deps)).rejects.toThrow(/coffre/);
    await expect(check(path.join(archives, '2026'), deps)).rejects.toThrow(/coffre/);
    await expect(check(ROOT, deps)).rejects.toThrow(/coffre/); // contient le coffre
    await expect(check(SCANS, deps)).resolves.toBeUndefined(); // voisin : autorisé
  });

  it('compare sans tenir compte de la casse sous Windows seulement', async () => {
    const upper = SCANS.toUpperCase();
    const run = check(upper, env());
    if (process.platform === 'win32') await expect(run).resolves.toBeUndefined();
    else await expect(run).rejects.toThrow(/racines autorisées/);
  });

  it('utilise process.env quand deps.env est absent', async () => {
    const saved = process.env.GED_CONNECTOR_FS_ROOTS;
    delete process.env.GED_CONNECTOR_FS_ROOTS;
    try {
      await expect(check(SCANS, {})).rejects.toThrow(/GED_CONNECTOR_FS_ROOTS/);
      process.env.GED_CONNECTOR_FS_ROOTS = ROOT;
      await expect(check(SCANS, {})).resolves.toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env.GED_CONNECTOR_FS_ROOTS;
      else process.env.GED_CONNECTOR_FS_ROOTS = saved;
    }
  });
});

describe('filesystem — schémas', () => {
  const schema = filesystemConnector.configSchema;
  it('applique les défauts', () => {
    expect(schema.parse({ rootPath: SCANS })).toEqual({
      rootPath: SCANS,
      recursive: true,
      minAgeSeconds: 30,
    });
  });
  it.each([
    [{ rootPath: SCANS, intrus: 1 }],
    [{}],
    [{ rootPath: SCANS, minAgeSeconds: -1 }],
    [{ rootPath: SCANS, minAgeSeconds: 86_401 }],
    [{ rootPath: SCANS, extensions: ['pdf'] }],
  ])('refuse %j', (cfg) => {
    expect(schema.safeParse(cfg).success).toBe(false);
  });
  it('n’accepte aucun identifiant', () => {
    expect(filesystemConnector.credentialsSchema.safeParse({}).success).toBe(true);
    expect(filesystemConnector.credentialsSchema.safeParse({ user: 'x' }).success).toBe(false);
  });
  it('authenticate vérifie la racine', async () => {
    const mem = new MemFs();
    await expect(make(mem).authenticate()).resolves.toBeUndefined();
    mem.rootMissing = true;
    await expect(make(mem).authenticate()).rejects.toThrow(/introuvable/);
  });
});

describe('filesystem — liens symboliques (garde sur chemins réels)', () => {
  const VAULT = path.resolve('/srv/coffre');
  const LEGIT = path.resolve('/srv/vrai-ged');
  const ENV = { GED_CONNECTOR_FS_ROOTS: ROOT, ARCHIVES_PATH: VAULT };
  const check = (mem: MemFs, rootPath: string, env: NodeJS.ProcessEnv = ENV) =>
    filesystemConnector.assertConfigSafe({ rootPath }, { fs: mem, env });

  function memWith(): MemFs {
    const mem = new MemFs();
    mem.dirs.add(OUTSIDE);
    mem.dirs.add(path.join(OUTSIDE, 'sous'));
    mem.dirs.add(VAULT);
    mem.dirs.add(path.join(VAULT, '2026'));
    mem.dirs.add(LEGIT);
    mem.dirs.add(path.join(LEGIT, 'scans'));
    return mem;
  }

  it('refuse une racine qui est un lien vers l’extérieur des racines autorisées', async () => {
    const mem = memWith();
    mem.links.set(path.join(ROOT, 'evasion'), OUTSIDE);
    await expect(check(mem, path.join(ROOT, 'evasion'))).rejects.toThrow(/racines autorisées/);
  });

  it('refuse une racine qui est un lien vers le coffre, ou vers un de ses sous-dossiers', async () => {
    const mem = memWith();
    mem.links.set(path.join(ROOT, 'coffre'), VAULT);
    mem.links.set(path.join(ROOT, 'annee'), path.join(VAULT, '2026'));
    // Le coffre est ici hors racines autorisées : on l'y place pour isoler l'exclusion du coffre.
    const env = {
      GED_CONNECTOR_FS_ROOTS: [ROOT, VAULT].join(path.delimiter),
      ARCHIVES_PATH: VAULT,
    };
    await expect(check(mem, path.join(ROOT, 'coffre'), env)).rejects.toThrow(/coffre/);
    await expect(check(mem, path.join(ROOT, 'annee'), env)).rejects.toThrow(/coffre/);
  });

  it('refuse un lien vers un dossier qui CONTIENT le coffre', async () => {
    const mem = memWith();
    const parent = path.resolve('/srv');
    mem.dirs.add(parent);
    mem.links.set(path.join(ROOT, 'haut'), parent);
    const env = { GED_CONNECTOR_FS_ROOTS: parent, ARCHIVES_PATH: VAULT };
    await expect(check(mem, path.join(ROOT, 'haut'), env)).rejects.toThrow(/coffre/);
  });

  it('refuse un lien dans un dossier PARENT (racine/lien/sous, lien → hors racines)', async () => {
    const mem = memWith();
    mem.links.set(path.join(ROOT, 'lien'), OUTSIDE);
    await expect(check(mem, path.join(ROOT, 'lien', 'sous'))).rejects.toThrow(/racines autorisées/);
  });

  it('refuse aussi quand la feuille n’existe pas encore (parent lié hors racines)', async () => {
    const mem = memWith();
    mem.links.set(path.join(ROOT, 'lien'), OUTSIDE);
    await expect(check(mem, path.join(ROOT, 'lien', 'a-creer', 'plus-bas'))).rejects.toThrow(
      /racines autorisées/,
    );
  });

  it('accepte une racine inexistante dont le plus proche parent réel reste autorisé', async () => {
    await expect(check(memWith(), path.join(ROOT, 'futur', 'dossier'))).resolves.toBeUndefined();
  });

  it('accepte une racine autorisée qui est elle-même un lien vers un dossier légitime', async () => {
    const mem = memWith();
    const allowedLink = path.resolve('/srv/ged-lien');
    mem.links.set(allowedLink, LEGIT);
    const env = { GED_CONNECTOR_FS_ROOTS: allowedLink, ARCHIVES_PATH: VAULT };
    // Chemin donné via le lien autorisé, ou directement via la cible réelle : même verdict.
    await expect(check(mem, path.join(allowedLink, 'scans'), env)).resolves.toBeUndefined();
    await expect(
      check(mem, path.join(LEGIT, 'scans'), { ...env, GED_CONNECTOR_FS_ROOTS: LEGIT }),
    ).resolves.toBeUndefined();
  });

  it('refuse quand la racine autorisée (lien) pointe ailleurs que la racine configurée', async () => {
    const mem = memWith();
    const allowedLink = path.resolve('/srv/ged-lien');
    mem.links.set(allowedLink, LEGIT);
    // `ROOT/scans` est lexicalement hors de `allowedLink` : la garde lexicale refuse déjà.
    const env = { GED_CONNECTOR_FS_ROOTS: allowedLink };
    await expect(check(mem, SCANS, env)).rejects.toThrow(/racines autorisées/);
  });

  it('ignore une racine autorisée non résolvable (jamais autorisante)', async () => {
    const mem = memWith();
    const absente = path.resolve('/srv/absente');
    await expect(
      check(mem, path.join(absente, 'x'), { GED_CONNECTOR_FS_ROOTS: absente }),
    ).rejects.toThrow(/racines autorisées/);
    // Une racine valide à côté d'une racine absente reste utilisable.
    const env = { GED_CONNECTOR_FS_ROOTS: [absente, ROOT].join(path.delimiter) };
    await expect(check(mem, SCANS, env)).resolves.toBeUndefined();
  });

  it('coffre inexistant : comparé sur le chemin normalisé ET sur le parent existant le plus proche', async () => {
    const mem = memWith();
    const absentVault = path.join(ROOT, 'coffre-futur');
    const env = { GED_CONNECTOR_FS_ROOTS: ROOT, ARCHIVES_PATH: absentVault };
    await expect(check(mem, absentVault, env)).rejects.toThrow(/coffre/);
    await expect(check(mem, SCANS, env)).resolves.toBeUndefined();
    // Coffre déclaré derrière un lien (parent existant lié) : la forme réelle le rattrape.
    const lien = path.join(ROOT, 'lien-coffre');
    mem.links.set(lien, VAULT);
    const env2 = {
      GED_CONNECTOR_FS_ROOTS: [ROOT, VAULT].join(path.delimiter),
      ARCHIVES_PATH: path.join(lien, 'futur'),
    };
    await expect(check(mem, path.join(VAULT, 'futur'), env2)).rejects.toThrow(/coffre/);
  });

  it('refuse par précaution quand la résolution échoue autrement que par « absent »', async () => {
    const mem = memWith();
    mem.realpath = async () => {
      throw Object.assign(new Error('interdit'), { code: 'EACCES' });
    };
    await expect(check(mem, SCANS)).rejects.toThrow(/refusé par précaution/);
  });

  it('authenticate détecte un lien posé APRÈS l’enregistrement', async () => {
    const mem = memWith();
    const c = make(mem, {}, { env: ENV });
    await expect(c.authenticate()).resolves.toBeUndefined();
    mem.links.set(SCANS, OUTSIDE); // le dossier surveillé est remplacé par un lien hors racines
    await expect(c.authenticate()).rejects.toBeInstanceOf(ConnectorAuthError);
    await expect(c.authenticate()).rejects.toThrow(/racines autorisées/);
    await expect(c.listChanges(null, { pageSize: 10 })).rejects.toBeInstanceOf(ConnectorAuthError);
  });

  it('authenticate détecte un lien posé après coup vers le coffre', async () => {
    const mem = memWith();
    const env = {
      GED_CONNECTOR_FS_ROOTS: [ROOT, VAULT].join(path.delimiter),
      ARCHIVES_PATH: VAULT,
    };
    const c = make(mem, {}, { env });
    await expect(c.authenticate()).resolves.toBeUndefined();
    mem.links.set(SCANS, VAULT);
    await expect(c.authenticate()).rejects.toThrow(/coffre/);
  });
});
