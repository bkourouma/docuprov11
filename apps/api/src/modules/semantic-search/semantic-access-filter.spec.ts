import { Prisma } from '@prisma/client';
import { DocumentState } from '@archivage/types';
import type { AuthUser } from '../auth/auth.types';
import { SearchService } from '../search/search.service';
import type { SearchDto } from '../search/search.dto';
import { buildSemanticAccessFilter } from './semantic-access-filter';

// ===========================================================================
// 1. SQL générée (sans base : on inspecte le texte et les paramètres liés)
// ===========================================================================

const user = (over: Partial<AuthUser> = {}): AuthUser => ({
  userId: 42,
  username: 'agent',
  isAdmin: false,
  userGroupId: 7,
  ...over,
});
const ADMIN = user({ userId: 1, isAdmin: true });
const SCAN_AGENT = user({ userId: -1, username: 'scan-agent', userGroupId: null, isScanAgent: true });
const ORDINARY = user();

/** Texte SQL compacté (espaces normalisés) pour des comparaisons lisibles. */
const compact = (s: string) =>
  s
    .replace(/\s+/g, ' ')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .trim();

const STATE_SQL = 'd.is_archived = true AND d.document_state <> ? AND d.is_frozen = false';

describe('buildSemanticAccessFilter — SQL', () => {
  it.each([
    ['administrateur', ADMIN],
    ['agent de numérisation', SCAN_AGENT],
    ['utilisateur ordinaire', ORDINARY],
  ])('pose les conditions d’état (archivé, non épuré, non gelé) pour %s', (_label, u) => {
    const f = buildSemanticAccessFilter(u);
    const sql = compact(f.sql);
    expect(sql.startsWith(`(${STATE_SQL}`)).toBe(true);
    expect(sql.endsWith(')')).toBe(true);
    // L'état « Épuré » est un paramètre lié, en première position.
    expect(f.values[0]).toBe(DocumentState.Epure);
    expect(f.values[0]).toBe(3);
    // Pas de WHERE : c'est une expression à AND-er.
    expect(sql).not.toMatch(/\bWHERE\s+d\./);
    expect(sql.startsWith('WHERE')).toBe(false);
  });

  it('administrateur et agent de numérisation : seulement les conditions d’état (comme canAccess)', () => {
    for (const u of [ADMIN, SCAN_AGENT]) {
      const f = buildSemanticAccessFilter(u);
      expect(compact(f.sql)).toBe(`(${STATE_SQL})`);
      expect(f.values).toEqual([DocumentState.Epure]);
    }
  });

  it('utilisateur ordinaire : confidentialité, droits, refus explicite, fenêtre de validité', () => {
    const f = buildSemanticAccessFilter(ORDINARY);
    const sql = compact(f.sql);

    // Confidentialité : sans exigence, créateur, rang suffisant.
    expect(sql).toContain('d.confidentialite_id IS NULL');
    expect(sql).toContain('uc.rank >= dc.rank');
    expect(sql).toContain('d.created_by IN (SELECT user_group_id FROM app_user_group WHERE user_id = ?)');
    // Refus explicite (niveau 1) — il précède le passe-droit du créateur dans la conjonction.
    expect(sql).toContain('dn.permission_level_id = 1');
    expect(sql.indexOf('NOT EXISTS (SELECT 1 FROM document_permission dn')).toBeGreaterThan(-1);
    // Droits accordés : document (compte-groupe ou profil) et type (compte-groupe ou rôle).
    expect(sql).toContain('dg.permission_level_id >= 2');
    expect(sql).toContain('dg.group_id IN (SELECT group_id FROM app_user_group WHERE user_id = ?)');
    expect(sql).toContain('tp.role_id = (SELECT role_id FROM app_user WHERE user_id = ?)');
    // Document / type non restreints.
    expect(sql).toContain('NOT EXISTS (SELECT 1 FROM document_permission dp');
    expect(sql).toContain('NOT EXISTS (SELECT 1 FROM document_type_permission tp');
    // Fenêtre de validité sur chaque table de droits.
    for (const t of ['dg', 'dn', 'dp', 'tp']) {
      expect(sql).toContain(`(${t}.start_date IS NULL OR ${t}.start_date <= now())`);
      expect(sql).toContain(`(${t}.end_date IS NULL OR ${t}.end_date >= now())`);
    }
  });

  it('lie l’identifiant utilisateur en paramètre, jamais dans le texte', () => {
    const f = buildSemanticAccessFilter(user({ userId: 987654 }));
    expect(f.sql).not.toContain('987654');
    expect(f.text).not.toContain('987654');
    const userValues = f.values.slice(1);
    expect(userValues.length).toBeGreaterThan(5);
    expect(userValues.every((v) => v === 987654)).toBe(true);
    // Autant de paramètres que de marqueurs `$n`.
    expect(f.text.match(/\$\d+/g)?.length).toBe(f.values.length);
  });

  it('se combine comme fragment dans une requête plus large', () => {
    const f = buildSemanticAccessFilter(ORDINARY);
    const q = Prisma.sql`SELECT 1 FROM document d WHERE d.document_id = ${5} AND ${f}`;
    expect(q.values[0]).toBe(5);
    expect(q.values.slice(1)).toEqual(f.values);
  });

  it.each([
    ['NaN', Number.NaN],
    ['flottant', 1.5],
    ['infini', Number.POSITIVE_INFINITY],
    ['chaîne', '42' as unknown as number],
    ['null', null as unknown as number],
    ['undefined', undefined as unknown as number],
    ['hors entier sûr', 2 ** 60],
  ])('lève sur un identifiant invalide (%s), même pour un administrateur', (_l, id) => {
    expect(() => buildSemanticAccessFilter(user({ userId: id }))).toThrow(/identifiant utilisateur invalide/);
    expect(() => buildSemanticAccessFilter(user({ userId: id, isAdmin: true }))).toThrow(
      /identifiant utilisateur invalide/,
    );
  });

  it.each([0, -1, -42])('lève sur un identifiant non positif (%s) pour un utilisateur ordinaire', (id) => {
    expect(() => buildSemanticAccessFilter(user({ userId: id }))).toThrow(/identifiant utilisateur invalide/);
  });

  it('lève sans utilisateur', () => {
    expect(() => buildSemanticAccessFilter(undefined as unknown as AuthUser)).toThrow(/utilisateur absent/);
  });

  it('un drapeau privilégié non booléen ne déclenche pas le passe-droit', () => {
    const f = buildSemanticAccessFilter(user({ isAdmin: 'true' as unknown as boolean }));
    expect(compact(f.sql)).toContain('dn.permission_level_id = 1');
  });
});

// ===========================================================================
// 2. Synchronisation avec SearchService.buildWhere (règle de droits copiée)
// ===========================================================================

describe('buildSemanticAccessFilter — synchronisé avec /search', () => {
  const searchService = new SearchService({} as never);
  const buildWhere = (u: AuthUser): Prisma.Sql =>
    (
      searchService as unknown as { buildWhere(p: SearchDto, u: AuthUser): Prisma.Sql }
    ).buildWhere({ page: 1, pageSize: 20 } as SearchDto, u);

  it.each([
    ['utilisateur ordinaire', ORDINARY],
    ['administrateur', ADMIN],
    ['agent de numérisation', SCAN_AGENT],
  ])('les droits sont exactement ceux de buildWhere (%s)', (_l, u) => {
    const where = buildWhere(u);
    const filter = buildSemanticAccessFilter(u);

    // On retire de notre filtre les deux conditions d'état propres à la GED IA (épuré, gelé) :
    // le reste doit être IDENTIQUE à la clause WHERE de /search, texte et paramètres.
    const ours = compact(filter.sql)
      .replace(' AND d.document_state <> ? AND d.is_frozen = false', '')
      .replace(/^\(/, '')
      .replace(/\)$/, '');
    expect(`WHERE ${ours}`).toBe(compact(where.sql));
    expect(filter.values.slice(1)).toEqual(where.values);
  });
});

// ===========================================================================
// 3. Évaluateur EN MÉMOIRE de la même règle (documentation exécutable)
// ===========================================================================
// Il NE PROUVE PAS la SQL : il décrit la règle métier attendue sous une forme lisible et teste la
// matrice de cas. Seul un test d'intégration sur PostgreSQL vérifierait la SQL elle-même.

interface Grant {
  /** 1 = refus explicite, >= 2 = accordé. */
  level: number;
  startDate: Date | null;
  endDate: Date | null;
  userGroupId?: number | null;
  groupId?: number | null;
  roleId?: number | null;
}

interface DocFacts {
  isArchived: boolean;
  documentState: number;
  isFrozen: boolean;
  /** `user_group_id` du créateur. */
  createdBy: number | null;
  /** `null` = aucune confidentialité requise ; `'orpheline'` = référence introuvable. */
  confidentialityRank: number | null | 'orpheline';
  documentGrants: Grant[];
  typeGrants: Grant[];
}

interface ActorFacts {
  now: Date;
  /** Tous les comptes-groupes de la personne. */
  userGroupIds: number[];
  /** Profils (`group_id`) de ces comptes-groupes. */
  groupIds: number[];
  roleId: number | null;
  /** Rang de confidentialité de l'utilisateur ; `null` = aucune habilitation. */
  userRank: number | null;
}

function evaluateSemanticAccess(u: AuthUser, doc: DocFacts, facts: ActorFacts): boolean {
  if (!Number.isSafeInteger(u.userId)) throw new Error('identifiant utilisateur invalide');
  // État : pour tous.
  if (!doc.isArchived || doc.documentState === DocumentState.Epure || doc.isFrozen) return false;
  if (u.isAdmin === true || u.isScanAgent === true) return true;
  if (u.userId <= 0) throw new Error('identifiant utilisateur invalide');

  const inForce = (g: Grant) =>
    (g.startDate == null || g.startDate <= facts.now) && (g.endDate == null || g.endDate >= facts.now);
  const mineOnDoc = (g: Grant) =>
    (g.userGroupId != null && facts.userGroupIds.includes(g.userGroupId)) ||
    (g.groupId != null && facts.groupIds.includes(g.groupId));
  const isCreator = doc.createdBy != null && facts.userGroupIds.includes(doc.createdBy);
  const ownDocumentGrant = doc.documentGrants.some((g) => g.level >= 2 && inForce(g) && mineOnDoc(g));

  // Axe confidentialité (référence orpheline : exclue, comme la SQL).
  const confidentialityOk =
    doc.confidentialityRank === null ||
    isCreator ||
    ownDocumentGrant ||
    (doc.confidentialityRank !== 'orpheline' &&
      facts.userRank != null &&
      facts.userRank >= doc.confidentialityRank);
  if (!confidentialityOk) return false;

  // Axe droits explicites.
  const denied = doc.documentGrants.some((g) => g.level === 1 && inForce(g) && mineOnDoc(g));
  if (denied) return false;
  if (isCreator) return true;
  const docRestricted = doc.documentGrants.some((g) => g.level >= 2 && inForce(g));
  const typeRestricted = doc.typeGrants.some((g) => g.level >= 2 && inForce(g));
  if (!docRestricted && !typeRestricted) return true;
  if (ownDocumentGrant) return true;
  return doc.typeGrants.some(
    (g) =>
      g.level >= 2 &&
      inForce(g) &&
      ((g.userGroupId != null && facts.userGroupIds.includes(g.userGroupId)) ||
        (g.roleId != null && facts.roleId != null && g.roleId === facts.roleId)),
  );
}

describe('evaluateSemanticAccess — matrice métier (référence, ne prouve pas la SQL)', () => {
  const NOW = new Date('2026-11-20T12:00:00Z');
  const PAST = new Date('2026-01-01T00:00:00Z');
  const FUTURE = new Date('2027-01-01T00:00:00Z');
  const facts: ActorFacts = { now: NOW, userGroupIds: [7, 8], groupIds: [70], roleId: 3, userRank: 1 };
  const doc = (over: Partial<DocFacts> = {}): DocFacts => ({
    isArchived: true,
    documentState: DocumentState.Archive,
    isFrozen: false,
    createdBy: 99,
    confidentialityRank: null,
    documentGrants: [],
    typeGrants: [],
    ...over,
  });
  const grant = (over: Partial<Grant>): Grant => ({ level: 2, startDate: null, endDate: null, ...over });

  it('autorisé : document archivé, sans confidentialité ni droit', () => {
    expect(evaluateSemanticAccess(ORDINARY, doc(), facts)).toBe(true);
  });

  it('autorisé : rang suffisant', () => {
    expect(evaluateSemanticAccess(ORDINARY, doc({ confidentialityRank: 1 }), facts)).toBe(true);
  });

  it('interdit par confidentialité : rang insuffisant', () => {
    expect(evaluateSemanticAccess(ORDINARY, doc({ confidentialityRank: 3 }), facts)).toBe(false);
  });

  it('interdit par confidentialité : aucune habilitation', () => {
    expect(
      evaluateSemanticAccess(ORDINARY, doc({ confidentialityRank: 1 }), { ...facts, userRank: null }),
    ).toBe(false);
  });

  it('interdit : confidentialité orpheline (la SQL exclut ; canAccess laisserait passer)', () => {
    expect(evaluateSemanticAccess(ORDINARY, doc({ confidentialityRank: 'orpheline' }), facts)).toBe(false);
  });

  it('autorisé : le créateur (sur un AUTRE de ses comptes-groupes) malgré la confidentialité', () => {
    expect(evaluateSemanticAccess(ORDINARY, doc({ createdBy: 8, confidentialityRank: 5 }), facts)).toBe(true);
  });

  it('refus explicite en vigueur : interdit, même pour le créateur', () => {
    const d = doc({ createdBy: 7, documentGrants: [grant({ level: 1, userGroupId: 7 })] });
    expect(evaluateSemanticAccess(ORDINARY, d, facts)).toBe(false);
  });

  it('refus explicite par profil : interdit, même avec un droit accordé', () => {
    const d = doc({
      documentGrants: [grant({ level: 1, groupId: 70 }), grant({ level: 3, userGroupId: 7 })],
    });
    expect(evaluateSemanticAccess(ORDINARY, d, facts)).toBe(false);
  });

  it('refus explicite hors fenêtre de validité : sans effet', () => {
    const d = doc({ documentGrants: [grant({ level: 1, userGroupId: 7, endDate: PAST })] });
    expect(evaluateSemanticAccess(ORDINARY, d, facts)).toBe(true);
  });

  it('droit nominatif sur le document : lève la confidentialité', () => {
    const d = doc({ confidentialityRank: 5, documentGrants: [grant({ userGroupId: 8 })] });
    expect(evaluateSemanticAccess(ORDINARY, d, facts)).toBe(true);
  });

  it('droit par profil sur le document : lève aussi la confidentialité', () => {
    const d = doc({ confidentialityRank: 5, documentGrants: [grant({ groupId: 70 })] });
    expect(evaluateSemanticAccess(ORDINARY, d, facts)).toBe(true);
  });

  it('droit nominatif pas encore en vigueur : ne lève rien', () => {
    const d = doc({ confidentialityRank: 5, documentGrants: [grant({ userGroupId: 8, startDate: FUTURE })] });
    expect(evaluateSemanticAccess(ORDINARY, d, facts)).toBe(false);
  });

  it('droit par TYPE : ne lève PAS la confidentialité', () => {
    const d = doc({ confidentialityRank: 5, typeGrants: [grant({ roleId: 3 })] });
    expect(evaluateSemanticAccess(ORDINARY, d, facts)).toBe(false);
  });

  it('type restreint sans droit : interdit', () => {
    const d = doc({ typeGrants: [grant({ userGroupId: 555 })] });
    expect(evaluateSemanticAccess(ORDINARY, d, facts)).toBe(false);
  });

  it('type restreint avec droit par rôle : autorisé', () => {
    const d = doc({ typeGrants: [grant({ userGroupId: 555 }), grant({ roleId: 3 })] });
    expect(evaluateSemanticAccess(ORDINARY, d, facts)).toBe(true);
  });

  it('document restreint à un autre : interdit', () => {
    const d = doc({ documentGrants: [grant({ userGroupId: 555 })] });
    expect(evaluateSemanticAccess(ORDINARY, d, facts)).toBe(false);
  });

  it.each([
    ['épuré', { documentState: DocumentState.Epure }],
    ['gelé', { isFrozen: true }],
    ['non archivé', { isArchived: false }],
  ])('%s : exclu pour tous, administrateur et agent compris', (_l, over) => {
    for (const u of [ORDINARY, ADMIN, SCAN_AGENT]) {
      expect(evaluateSemanticAccess(u, doc(over), facts)).toBe(false);
    }
  });

  it('administrateur et agent : passe-droit sur les deux axes (comme canAccess)', () => {
    const d = doc({ confidentialityRank: 9, documentGrants: [grant({ level: 1, userGroupId: 7 })] });
    expect(evaluateSemanticAccess(ADMIN, d, facts)).toBe(true);
    expect(evaluateSemanticAccess(SCAN_AGENT, d, facts)).toBe(true);
    expect(evaluateSemanticAccess(ORDINARY, d, facts)).toBe(false);
  });
});
