/**
 * Aides GED (T3) : éditeur collaboratif (`/editeur/*`, `/api/collab/*`) et rédaction assistée.
 *
 * Écrites contre le contrat des fixtures (`apps/e2e/fixtures`, lot 0). Aucune dépendance d'exécution
 * hors Node : les imports Playwright sont des imports de TYPE (effacés à la compilation), et le DOCX
 * de test est fabriqué ici (ZIP « stocké », sans compression) pour ne dépendre ni du paquet `docx`
 * ni de son hissage dans `node_modules`.
 */
import { inflateRawSync } from 'node:zlib';
import type { APIResponse, Browser, BrowserContext, Locator, Page } from '@playwright/test';
import type { ApiClient } from '../../../fixtures';
import { createRestrictedUser, type ApiAs, type GedApi, type GedUser } from './users';

// --------------------------------------------------------------------------------- constantes

/** Niveaux de permission du seed (`packages/db/prisma/seed.ts`). */
export const PERMISSION = { Consultation: 2, Modification: 3, Administration: 4 } as const;

/** Identifiant hors de toute donnée réelle, mais valide (entier 32 bits signé). */
export const MISSING_DOCUMENT_ID = 2_147_483_000;

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/**
 * Connexion temps réel : poignée de main WebSocket relayée par Next (rewrite `/api/:path*`), puis
 * authentification Hocuspocus. 20 s couvrent une première compilation de page en dev.
 */
export const COLLAB_TIMEOUT = 20_000;

// ----------------------------------------------------------------------------------- données

export interface CollabCreated {
  documentId: number;
  label: string;
  warnings: string[];
}

export interface CollabSession {
  documentId: number;
  label: string;
  mode: 'read' | 'write';
  wsPath: string;
  currentVersionNumber: number;
  me: { userGroupId: number; name: string };
}

export interface VersionRow {
  documentVersionId: number;
  versionNumber: number;
  isCurrent: boolean;
  changeKind: number;
  changeSummary: string | null;
  restoredFromVersionNumber: number | null;
}

/** Espace privé de l'administrateur (il en est propriétaire, donc contributeur). */
export async function createSpace(api: GedApi, label: string): Promise<{ gedSpaceId: number; label: string }> {
  const space = await api.post<{ gedSpaceId: number; label: string }>('/spaces', { label, kind: 0 });
  return { gedSpaceId: space.gedSpaceId, label: space.label };
}

/** Document texte vide (`POST /collab/documents`), créé par l'administrateur. */
export async function createTextDocument(
  api: GedApi,
  spaceId: number,
  label: string,
): Promise<CollabCreated> {
  return api.post<CollabCreated>('/collab/documents', { spaceId, label });
}

/** Espace + document texte vide, pour les tests qui ne portent pas sur la création. */
export async function createSpaceAndDocument(
  api: GedApi,
  uniq: (p: string) => string,
  prefix = 'ged-ed',
): Promise<{ spaceId: number; spaceLabel: string; documentId: number; label: string }> {
  const space = await createSpace(api, `Espace ${uniq(prefix)}`);
  const label = `Doc ${uniq(prefix)}`;
  const doc = await createTextDocument(api, space.gedSpaceId, label);
  return { spaceId: space.gedSpaceId, spaceLabel: space.label, documentId: doc.documentId, label };
}

export async function listVersions(api: GedApi, documentId: number): Promise<VersionRow[]> {
  return api.get<VersionRow[]>(`/documents/${documentId}/versions`);
}

/** Droit nominatif sur un document (rend le document « restreint » : seuls les bénéficiaires le voient). */
export async function grantDocument(
  api: GedApi,
  documentId: number,
  userGroupId: number,
  permissionLevelId: number,
): Promise<void> {
  await api.post(`/documents/${documentId}/permissions`, { userGroupId, permissionLevelId });
}

// --------------------------------------------------------------------------- utilisateurs

/** Réponse brute (`api.raw.<verbe>`) : `APIResponse` de Playwright. */
export type RawResponse = APIResponse;

/** Client REST des fixtures, avec sa variante `raw` (ne lève pas sur un statut >= 400). */
export type RawApi = ApiClient;

export interface EditorUser extends GedUser {
  /** Compte-groupe par défaut : sans lui, l'éditeur répond 403 (« Aucun profil actif »). */
  userGroupId: number;
  /** Nom affiché (présence, mentions) : `fullName` du compte. */
  name: string;
  /** Client REST de cet utilisateur (jeton émis APRÈS l'affectation du profil). */
  api: RawApi;
}

/**
 * Utilisateur non administrateur AVEC un profil par défaut. `createRestrictedUser` ne pose aucun
 * compte-groupe : le jeton porterait alors `userGroupId: null`, et `GET /collab/.../session` comme
 * la création de document répondraient 403. On crée donc un profil dédié et on l'affecte par défaut,
 * puis on rouvre une session (le jeton doit porter le nouveau `userGroupId`).
 */
export async function createEditorUser(
  api: GedApi,
  apiAs: ApiAs,
  prefix: string,
  menuKeys: string[] = [],
): Promise<EditorUser> {
  const user = await createRestrictedUser(api, apiAs, prefix, menuKeys);
  const group = await api.post<{ groupId: number }>('/users/groups/all', { name: `Profil ${user.username}` });
  await api.post(`/users/${user.userId}/groups`, { groupId: group.groupId, isDefault: true });
  const self = (await apiAs(user.username, user.password)) as EditorUser['api'];
  const me = await self.get<{ userGroupId: number | null; fullName: string | null; username: string }>('/auth/me');
  if (me.userGroupId == null) {
    throw new Error(`createEditorUser : ${user.username} n'a toujours pas de compte-groupe par défaut`);
  }
  return { ...user, userGroupId: me.userGroupId, name: me.fullName?.trim() || me.username, api: self };
}

// ------------------------------------------------------------------------------- écran

/** Zone d'édition ProseMirror (`role=textbox`, libellé posé par `EditorShell`). */
export function editorBox(page: Page, readOnly = false): Locator {
  return page.getByRole('textbox', {
    name: readOnly ? 'Contenu du document (lecture seule)' : 'Contenu du document',
    exact: true,
  });
}

/**
 * `/editeur/nouveau` : choisit un espace dans le Select Ant Design (recherche activée). Les libellés
 * d'espace sont uniques par test : le filtre ne laisse qu'une option, désignée par son `title`.
 */
export async function pickSpace(page: Page, label: string): Promise<void> {
  const select = page.getByLabel('Espace', { exact: true });
  await select.click();
  await select.fill(label);
  await page.getByTitle(label, { exact: true }).click();
}

/** Région `aria-live` d'état de connexion / d'enregistrement de la barre d'état. */
export function connectionStatus(page: Page): Locator {
  return page.getByRole('status').filter({ hasText: /Connecté|Connexion…|Reconnexion…|Hors ligne/ });
}

/**
 * « Version N » de la barre d'état (groupe parent de la région d'état), distinct des « Version N »
 * de l'historique quand le panneau est ouvert.
 */
export function statusBarVersion(page: Page, versionNumber: number): Locator {
  return connectionStatus(page).locator('xpath=..').getByText(`Version ${versionNumber}`, { exact: true });
}

/** Attend la connexion temps réel établie (sinon : échec explicite, voir rapport T3). */
export async function waitConnected(page: Page, expect: ExpectLike): Promise<void> {
  await expect(connectionStatus(page), 'connexion WebSocket /api/collab non établie').toContainText('Connecté', {
    timeout: COLLAB_TIMEOUT,
  });
}

/** Attend « Connecté · Enregistré » : le serveur a reçu toutes les modifications locales. */
export async function waitSaved(page: Page, expect: ExpectLike): Promise<void> {
  await expect(connectionStatus(page)).toContainText(/Connecté\s*·\s*Enregistré/, { timeout: COLLAB_TIMEOUT });
}

/** Ouvre `/editeur/:id` et attend l'éditeur connecté. */
export async function openEditor(
  page: Page,
  expect: ExpectLike,
  documentId: number,
  opts: { readOnly?: boolean } = {},
): Promise<Locator> {
  await page.goto(`/editeur/${documentId}`);
  const box = editorBox(page, opts.readOnly);
  await expect(box).toBeVisible({ timeout: COLLAB_TIMEOUT });
  await waitConnected(page, expect);
  return box;
}

/** Saisit du texte à la fin du document puis attend qu'il soit affiché et reçu par le serveur. */
export async function typeAtEnd(page: Page, expect: ExpectLike, box: Locator, text: string): Promise<void> {
  await box.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(text);
  await expect(box).toContainText(text);
  await waitSaved(page, expect);
}

/**
 * Recharge la page en acceptant un éventuel `beforeunload` (posé tant que des modifications ne sont
 * pas reçues par le serveur) : un rechargement bloqué masquerait la vraie cause (perte de données).
 */
export async function reloadAccepting(page: Page): Promise<void> {
  const accept = (d: { type(): string; accept(): Promise<void> }) => {
    if (d.type() === 'beforeunload') void d.accept();
  };
  page.on('dialog', accept);
  try {
    await page.reload();
  } finally {
    page.off('dialog', accept);
  }
}

/**
 * Ouvre un NOUVEAU contexte navigateur, vierge (aucun jeton administrateur hérité du storageState du
 * projet), et y connecte `user` par l'écran de connexion (`loginAs` des fixtures).
 * `baseURL` : `test.info().project.use.baseURL` (un `browser.newContext()` brut ne le reçoit pas
 * forcément du fichier de configuration).
 */
export async function openUserPage(
  browser: Browser,
  loginAs: (page: Page, username: string, password: string) => Promise<unknown>,
  user: { username: string; password: string },
  baseURL: string | undefined,
): Promise<{ page: Page; context: BrowserContext }> {
  const context = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await loginAs(page, user.username, user.password);
  return { page, context };
}

/** Forme minimale de `expect` (celui des fixtures) utilisée par ces aides. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ExpectLike = (actual: any, message?: string) => any;

// --------------------------------------------------------------------------------- DOCX

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = (CRC_TABLE[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Archive ZIP minimale, entrées « stockées » (méthode 0), noms UTF-8. */
export function buildZip(entries: ReadonlyArray<{ name: string; data: Buffer }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  const DOS_DATE = 0x21; // 1980-01-01
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const crc = crc32(e.data);
    const size = e.data.length;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4); // version requise
    lh.writeUInt16LE(0x0800, 6); // drapeau UTF-8
    lh.writeUInt16LE(0, 8); // stocké
    lh.writeUInt16LE(0, 10); // heure
    lh.writeUInt16LE(DOS_DATE, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(size, 18);
    lh.writeUInt32LE(size, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, name, e.data);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(DOS_DATE, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(size, 20);
    ch.writeUInt32LE(size, 24);
    ch.writeUInt16LE(name.length, 28);
    // 30 extra, 32 commentaire, 34 disque, 36 attributs internes : 0
    ch.writeUInt32LE(0, 38); // attributs externes
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += 30 + name.length + size;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const xmlEscape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** DOCX minimal valide (lu par mammoth) : un paragraphe par entrée. */
export function minimalDocx(paragraphs: readonly string[]): Buffer {
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const body = paragraphs
    .map((p) => `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(p)}</w:t></w:r></w:p>`)
    .join('');
  const files = [
    {
      name: '[Content_Types].xml',
      xml:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        '</Types>',
    },
    {
      name: '_rels/.rels',
      xml:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
        '</Relationships>',
    },
    {
      name: 'word/document.xml',
      xml:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        `<w:document xmlns:w="${W}"><w:body>${body}<w:sectPr/></w:body></w:document>`,
    },
  ];
  return buildZip(files.map((f) => ({ name: f.name, data: Buffer.from(f.xml, 'utf8') })));
}

/** Contenu (décompressé) d'une entrée d'archive ZIP, lu par le répertoire central ; `null` si absente. */
export function unzipEntry(zip: Buffer, entryName: string): Buffer | null {
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Archive ZIP illisible : fin de répertoire central introuvable');
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error('Archive ZIP illisible : répertoire central');
    const method = zip.readUInt16LE(p + 10);
    const compSize = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const localOffset = zip.readUInt32LE(p + 42);
    const name = zip.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    if (name === entryName) {
      const lNameLen = zip.readUInt16LE(localOffset + 26);
      const lExtraLen = zip.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + lNameLen + lExtraLen;
      const data = zip.subarray(start, start + compSize);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return inflateRawSync(data);
      throw new Error(`Méthode de compression ZIP non gérée : ${method}`);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

/** Texte du corps d'un DOCX (concaténation des `<w:t>` de `word/document.xml`). */
export function docxText(docx: Buffer): string {
  const xml = unzipEntry(docx, 'word/document.xml');
  if (!xml) throw new Error('DOCX sans word/document.xml');
  const out: string[] = [];
  for (const m of xml.toString('utf8').matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)) out.push(m[1] ?? '');
  return out
    .join(' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Échappe un texte pour l'insérer tel quel dans une expression régulière. */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
