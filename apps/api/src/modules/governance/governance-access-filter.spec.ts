import { Prisma } from '@prisma/client';
import { GovernanceKind } from '@archivage/types';
import type { AuthUser } from '../auth/auth.types';
import { buildSemanticAccessFilter } from '../semantic-search/semantic-access-filter';
import {
  buildGovernanceAccessFilter,
  buildProposalVisibilityFilter,
  ORIGINAL_ID_PATTERN,
  VISIBILITY_DOCUMENT_ALIAS,
  VISIBILITY_ORIGINAL_ALIAS,
} from './governance-access-filter';

// Ces tests inspectent le TEXTE SQL et les paramètres liés, sans base de données. Ils prouvent
// l'identité des droits avec le lot 3 et la structure de la visibilité ; ils ne prouvent PAS
// l'évaluation par PostgreSQL sur des jeux de droits réels (test d'intégration requis).

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

/** Texte SQL compacté (espaces normalisés), même normalisation que le spec du lot 3. */
const compact = (s: string) =>
  s
    .replace(/\s+/g, ' ')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .trim();

/** Les trois conditions d'ÉTAT du lot 3, absentes de la gouvernance. */
const STATE_PREFIX = 'd.is_archived = true AND d.document_state <> ? AND d.is_frozen = false AND ';

/** Remplace l'alias `d.` du document par un autre alias. */
const realias = (sql: string, alias: string) => sql.replace(/\bd\./g, `${alias}.`);

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

const CORRUPT_IDS: Array<[string, number]> = [
  ['NaN', Number.NaN],
  ['flottant', 1.5],
  ['infini', Number.POSITIVE_INFINITY],
  ['chaîne', '42' as unknown as number],
  ['null', null as unknown as number],
  ['undefined', undefined as unknown as number],
  ['hors entier sûr', 2 ** 60],
];

const INVALID_ALIASES: Array<[string, unknown]> = [
  ['vide', ''],
  ['majuscule', 'D'],
  ['commence par un chiffre', '1d'],
  ['point-virgule', 'd;drop'],
  ['espace', 'd x'],
  ['guillemet', 'd"'],
  ['commentaire', 'd--'],
  ['parenthèse', 'd)'],
  ['point', 'd.x'],
  ['trop long', 'a'.repeat(17)],
  ['non chaîne', 42],
  ['alias réservé dg', 'dg'],
  ['alias réservé dn', 'dn'],
  ['alias réservé dp', 'dp'],
  ['alias réservé tp', 'tp'],
  ['alias réservé u', 'u'],
  ['alias réservé uc', 'uc'],
  ['alias réservé dc', 'dc'],
  ['alias interne document', VISIBILITY_DOCUMENT_ALIAS],
  ['alias interne original', VISIBILITY_ORIGINAL_ALIAS],
  ['nom de table document', 'document'],
  ['nom de table app_user', 'app_user'],
  ['nom de table app_user_group', 'app_user_group'],
  ['mot réservé', 'select'],
  ['mot réservé', 'user'],
];

// ===========================================================================
// 1. buildGovernanceAccessFilter
// ===========================================================================

describe('buildGovernanceAccessFilter — synchronisé avec le filtre du lot 3', () => {
  it('utilisateur ordinaire : SQL IDENTIQUE au lot 3 sans les trois conditions d’état', () => {
    const semantic = buildSemanticAccessFilter(ORDINARY);
    const governance = buildGovernanceAccessFilter(ORDINARY, 'd');

    const semanticSql = compact(semantic.sql);
    expect(semanticSql).toContain(STATE_PREFIX);
    expect(compact(governance.sql)).toBe(semanticSql.replace(STATE_PREFIX, ''));
    // Paramètres : ceux du lot 3, moins l'état « Épuré » lié en tête.
    expect(governance.values).toEqual(semantic.values.slice(1));
  });

  it('alias par défaut = `d`', () => {
    expect(compact(buildGovernanceAccessFilter(ORDINARY).sql)).toBe(
      compact(buildGovernanceAccessFilter(ORDINARY, 'd').sql),
    );
  });

  it('aucune condition d’état : un document gelé, épuré ou non archivé n’est pas exclu par l’état', () => {
    const sql = compact(buildGovernanceAccessFilter(ORDINARY).sql);
    expect(sql).not.toContain('is_frozen');
    expect(sql).not.toContain('is_archived');
    expect(sql).not.toContain('document_state');
  });

  it.each([
    ['administrateur', ADMIN],
    ['agent de numérisation', SCAN_AGENT],
  ])('%s : condition vraie `TRUE`, sans paramètre', (_l, u) => {
    const f = buildGovernanceAccessFilter(u);
    expect(compact(f.sql)).toBe('TRUE');
    expect(f.values).toEqual([]);
  });

  it('utilisateur ordinaire : refus explicite, confidentialité, droits par document et par type', () => {
    const sql = compact(buildGovernanceAccessFilter(ORDINARY).sql);
    expect(sql).toContain('d.confidentialite_id IS NULL');
    expect(sql).toContain('uc.rank >= dc.rank');
    expect(sql).toContain('dn.permission_level_id = 1');
    expect(sql).toContain('tp.role_id = (SELECT role_id FROM app_user WHERE user_id = ?)');
    for (const t of ['dg', 'dn', 'dp', 'tp']) {
      expect(sql).toContain(`(${t}.start_date IS NULL OR ${t}.start_date <= now())`);
    }
  });

  it('un autre alias remplace exactement `d.`, et seulement lui', () => {
    const base = compact(buildGovernanceAccessFilter(ORDINARY, 'd').sql);
    const other = compact(buildGovernanceAccessFilter(ORDINARY, 'doc_2').sql);
    expect(other).toBe(realias(base, 'doc_2'));
    expect(other).not.toMatch(/\bd\./);
  });

  it('lie l’identifiant utilisateur en paramètre, jamais dans le texte', () => {
    const f = buildGovernanceAccessFilter(user({ userId: 987654 }));
    expect(f.sql).not.toContain('987654');
    expect(f.values.length).toBeGreaterThan(5);
    expect(f.values.every((v) => v === 987654)).toBe(true);
    expect(f.text.match(/\$\d+/g)?.length).toBe(f.values.length);
  });

  it.each(CORRUPT_IDS)('jeton corrompu (%s) : lève, même pour un administrateur', (_l, id) => {
    expect(() => buildGovernanceAccessFilter(user({ userId: id }))).toThrow(/identifiant utilisateur invalide/);
    expect(() => buildGovernanceAccessFilter(user({ userId: id, isAdmin: true }))).toThrow(
      /identifiant utilisateur invalide/,
    );
  });

  it.each([0, -1, -42])('identifiant non positif (%s) pour un utilisateur ordinaire : lève', (id) => {
    expect(() => buildGovernanceAccessFilter(user({ userId: id }))).toThrow(/identifiant utilisateur invalide/);
  });

  it('lève sans utilisateur', () => {
    expect(() => buildGovernanceAccessFilter(undefined as unknown as AuthUser)).toThrow(/utilisateur absent/);
  });

  it('un drapeau privilégié non booléen ne déclenche pas le passe-droit', () => {
    for (const over of [
      { isAdmin: 'true' as unknown as boolean },
      { isAdmin: 1 as unknown as boolean },
      { isScanAgent: 'true' as unknown as boolean },
    ]) {
      const sql = compact(buildGovernanceAccessFilter(user(over)).sql);
      expect(sql).not.toBe('TRUE');
      expect(sql).toContain('dn.permission_level_id = 1');
    }
  });

  it.each(INVALID_ALIASES)('alias invalide (%s) : lève, même pour un administrateur', (_l, alias) => {
    expect(() => buildGovernanceAccessFilter(ORDINARY, alias as string)).toThrow(/alias de document invalide/);
    expect(() => buildGovernanceAccessFilter(ADMIN, alias as string)).toThrow(/alias de document invalide/);
  });

  it('se combine comme fragment dans une requête plus large', () => {
    const f = buildGovernanceAccessFilter(ORDINARY);
    const q = Prisma.sql`SELECT 1 FROM document d WHERE d.document_id = ${5} AND ${f}`;
    expect(q.values[0]).toBe(5);
    expect(q.values.slice(1)).toEqual(f.values);
  });
});

// ===========================================================================
// 2. buildProposalVisibilityFilter
// ===========================================================================

describe('buildProposalVisibilityFilter — aucun trou', () => {
  const docExists = `EXISTS (SELECT 1 FROM document ${VISIBILITY_DOCUMENT_ALIAS} WHERE`;
  const origExists = `EXISTS (SELECT 1 FROM document ${VISIBILITY_ORIGINAL_ALIAS} WHERE`;

  /** Découpe la SQL compactée en segments : avant l'EXISTS document, l'EXISTS document, l'EXISTS original. */
  function segments(sql: string) {
    const iDoc = sql.indexOf(docExists);
    const iOrig = sql.indexOf(origExists);
    expect(iDoc).toBeGreaterThan(-1);
    expect(iOrig).toBeGreaterThan(iDoc);
    return { head: sql.slice(0, iDoc), doc: sql.slice(iDoc, iOrig), orig: sql.slice(iOrig) };
  }

  it('utilisateur ordinaire : deux EXISTS (document + original), chacun portant le filtre de droits complet', () => {
    const f = buildProposalVisibilityFilter(ORDINARY);
    const sql = compact(f.sql);
    expect(count(sql, 'EXISTS (SELECT 1 FROM document ')).toBe(2);

    const rights = compact(buildGovernanceAccessFilter(ORDINARY, 'd').sql);
    const { head, doc, orig } = segments(sql);

    // (a) document de la proposition : existe, corrélé à a.document_id, et ouvrable.
    expect(head).toContain('a.document_id IS NOT NULL AND');
    expect(doc).toContain(`${VISIBILITY_DOCUMENT_ALIAS}.document_id = a.document_id AND `);
    expect(doc).toContain(realias(rights, VISIBILITY_DOCUMENT_ALIAS));

    // (b) original : existe, corrélé à output->>'originalDocumentId' (transtypage gardé), ouvrable.
    expect(orig).toContain(
      `${VISIBILITY_ORIGINAL_ALIAS}.document_id = (CASE WHEN a.output->>'originalDocumentId' ~ ? ` +
        `THEN (a.output->>'originalDocumentId')::int END) AND `,
    );
    expect(orig).toContain(realias(rights, VISIBILITY_ORIGINAL_ALIAS));
    // Aucune référence résiduelle à l'alias `d` : chaque filtre porte sur SON document.
    expect(sql).not.toMatch(/\bd\./);
  });

  it('le transtypage en int n’apparaît QUE dans la branche THEN du CASE gardé par l’expression régulière', () => {
    const sql = compact(buildProposalVisibilityFilter(ORDINARY).sql);
    expect(count(sql, '::int')).toBe(1);
    expect(sql).toMatch(/CASE WHEN a\.output->>'originalDocumentId' ~ \? THEN \(a\.output->>'originalDocumentId'\)::int END/);
    const f = buildProposalVisibilityFilter(ORDINARY);
    expect(f.values).toContain(ORIGINAL_ID_PATTERN);
    // Le motif refuse non numérique, négatif, décimal, vide et plus de 9 chiffres (int4 sûr).
    const re = new RegExp(ORIGINAL_ID_PATTERN);
    for (const ok of ['1', '42', '999999999']) expect(re.test(ok)).toBe(true);
    for (const ko of ['', '-1', '1.5', 'abc', '12a', '1234567890', ' 1', '1e3']) expect(re.test(ko)).toBe(false);
  });

  it('original absent : visible seulement si la proposition n’est PAS un doublon (paramètres liés)', () => {
    const f = buildProposalVisibilityFilter(ORDINARY);
    const sql = compact(f.sql);
    expect(sql).toContain(
      "(a.output->>'originalDocumentId' IS NULL AND COALESCE(a.output->>'kind', '') NOT IN (?, ?)) OR EXISTS",
    );
    expect(f.values).toEqual(expect.arrayContaining([GovernanceKind.DoublonExact, GovernanceKind.QuasiDoublon]));
  });

  it('paramètres : deux fois le filtre de droits + 2 natures + le motif, tout lié', () => {
    const f = buildProposalVisibilityFilter(user({ userId: 31337 }));
    const rights = buildGovernanceAccessFilter(user({ userId: 31337 }));
    expect(f.values.length).toBe(rights.values.length * 2 + 3);
    expect(f.values.filter((v) => v === 31337).length).toBe(rights.values.length * 2);
    expect(f.sql).not.toContain('31337');
    expect(f.text.match(/\$\d+/g)?.length).toBe(f.values.length);
  });

  it('administrateur : document_id NULL toujours exclu, les deux EXISTS restent (existence exigée)', () => {
    for (const u of [ADMIN, SCAN_AGENT]) {
      const sql = compact(buildProposalVisibilityFilter(u).sql);
      expect(sql).toContain('a.document_id IS NOT NULL AND');
      expect(count(sql, 'EXISTS (SELECT 1 FROM document ')).toBe(2);
      const { doc, orig } = segments(sql);
      expect(doc).toContain(`${VISIBILITY_DOCUMENT_ALIAS}.document_id = a.document_id AND TRUE`);
      expect(orig).toContain('::int END) AND TRUE');
      // Aucune clause de droits pour l'administrateur.
      expect(sql).not.toContain('permission_level_id');
    }
  });

  it('alias de proposition personnalisé : toutes les références utilisent cet alias', () => {
    const sql = compact(buildProposalVisibilityFilter(ORDINARY, 'gd').sql);
    expect(sql).toContain('gd.document_id IS NOT NULL');
    expect(sql).toContain(`${VISIBILITY_DOCUMENT_ALIAS}.document_id = gd.document_id`);
    expect(sql).toContain("gd.output->>'originalDocumentId'");
    expect(sql).toContain("gd.output->>'kind'");
    expect(sql).not.toMatch(/\ba\./);
  });

  it('un alias `d` pour la proposition ne se mélange pas aux documents (alias internes distincts)', () => {
    const sql = compact(buildProposalVisibilityFilter(ORDINARY, 'd').sql);
    expect(sql).toContain(`${VISIBILITY_DOCUMENT_ALIAS}.document_id = d.document_id`);
    expect(sql).toContain(`${VISIBILITY_DOCUMENT_ALIAS}.confidentialite_id IS NULL`);
    expect(sql).not.toContain('d.confidentialite_id');
  });

  it.each(INVALID_ALIASES)('alias de proposition invalide (%s) : lève', (_l, alias) => {
    expect(() => buildProposalVisibilityFilter(ORDINARY, alias as string)).toThrow(/alias de proposition invalide/);
    expect(() => buildProposalVisibilityFilter(ADMIN, alias as string)).toThrow(/alias de proposition invalide/);
  });

  it.each(CORRUPT_IDS)('jeton corrompu (%s) : lève, même pour un administrateur', (_l, id) => {
    expect(() => buildProposalVisibilityFilter(user({ userId: id }))).toThrow(/identifiant utilisateur invalide/);
    expect(() => buildProposalVisibilityFilter(user({ userId: id, isAdmin: true }))).toThrow(
      /identifiant utilisateur invalide/,
    );
  });

  it('lève sans utilisateur', () => {
    expect(() => buildProposalVisibilityFilter(null as unknown as AuthUser)).toThrow(/utilisateur absent/);
  });

  it('se combine comme fragment dans une requête plus large', () => {
    const f = buildProposalVisibilityFilter(ORDINARY);
    const q = Prisma.sql`SELECT a.ged_ai_decision_id FROM ged_ai_decision a WHERE a.status = ${0} AND ${f}`;
    expect(q.values[0]).toBe(0);
    expect(q.values.slice(1)).toEqual(f.values);
    expect(q.text.match(/\$\d+/g)?.length).toBe(q.values.length);
  });
});
