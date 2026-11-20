import {
  CONSULTATION_LEVEL,
  RightsWideningError,
  assertNeverWider,
  assertRestricted,
  mapOriginRights,
  type RightsMappingInput,
  type RightsMappingResult,
} from './rights';
import type { OriginAcl, OriginAclEntry } from './types';

const user = (principal: string, access: OriginAclEntry['access'] = 'read'): OriginAclEntry => ({
  principal,
  kind: 'user',
  access,
});
const group = (principal: string, access: OriginAclEntry['access'] = 'read'): OriginAclEntry => ({
  principal,
  kind: 'group',
  access,
});
const pub = (access: OriginAclEntry['access'] = 'read'): OriginAclEntry => ({
  principal: '*',
  kind: 'public',
  access,
});
const acl = (...entries: OriginAclEntry[]): OriginAcl => ({ entries });
const ids = (r: RightsMappingResult): number[] => r.grants.map((g) => g.userGroupId);

const MAP = { 'alice@ex.org': 11, 'bob@ex.org': 12, 'carol@ex.org': 13, compta: 20 };

describe('mapOriginRights — cas nominaux', () => {
  it('3 personnes mappées → exactement 3 droits Consultation', () => {
    const r = mapOriginRights({
      acl: acl(user('alice@ex.org'), user('bob@ex.org', 'write'), user('carol@ex.org', 'owner')),
      principalMap: MAP,
      fallbackUserGroupIds: [99],
    });
    expect(r.grants).toEqual([
      { userGroupId: 11, permissionLevelId: CONSULTATION_LEVEL },
      { userGroupId: 12, permissionLevelId: CONSULTATION_LEVEL },
      { userGroupId: 13, permissionLevelId: CONSULTATION_LEVEL },
    ]);
    expect(r.usedFallback).toBe(false);
    expect(r.restricted).toBe(true);
    expect(r.unmapped).toEqual([]);
    expect(r.reason).toMatch(/3 groupe\(s\)/);
  });

  it('écriture/propriété à la source → jamais plus que Consultation (2), jamais Denied (1)', () => {
    const r = mapOriginRights({
      acl: acl(user('alice@ex.org', 'owner')),
      principalMap: MAP,
      fallbackUserGroupIds: [],
    });
    expect(r.grants.every((g) => g.permissionLevelId === 2)).toBe(true);
  });

  it('3 personnes dont 1 non mappée → 2 droits + unmapped, sans repli', () => {
    const r = mapOriginRights({
      acl: acl(user('alice@ex.org'), user('bob@ex.org'), user('  Mallory@Ex.org ')),
      principalMap: MAP,
      fallbackUserGroupIds: [99],
    });
    expect(ids(r)).toEqual([11, 12]);
    expect(r.unmapped).toEqual(['Mallory@Ex.org']);
    expect(r.usedFallback).toBe(false);
    expect(r.reason).toMatch(/sans équivalent/);
  });

  it('public seul → repli (le public n’élargit jamais)', () => {
    const r = mapOriginRights({
      acl: acl(pub(), pub('owner')),
      principalMap: MAP,
      fallbackUserGroupIds: [99, 7, 99],
    });
    expect(ids(r)).toEqual([7, 99]);
    expect(r.usedFallback).toBe(true);
    expect(r.ignoredEntries).toBe(2);
  });

  it('public + personnes mappées → seulement les personnes (aucun élargissement)', () => {
    const r = mapOriginRights({
      acl: acl(pub(), user('alice@ex.org')),
      principalMap: MAP,
      fallbackUserGroupIds: [99],
    });
    expect(ids(r)).toEqual([11]);
    expect(r.usedFallback).toBe(false);
  });

  it.each([
    ['null', null],
    ['vide', acl()],
    ['sans entries', {} as OriginAcl],
    ['entries non tableau', { entries: 'x' } as unknown as OriginAcl],
  ])('ACL %s → repli', (_l, a) => {
    const r = mapOriginRights({ acl: a, principalMap: MAP, fallbackUserGroupIds: [5] });
    expect(ids(r)).toEqual([5]);
    expect(r.usedFallback).toBe(true);
    expect(r.restricted).toBe(true);
    expect(r.reason).toMatch(/illisibles ou absents/);
  });

  it('propriétaire POSIX seul (uid mappé, « autres » = unknown/public ignorés)', () => {
    const r = mapOriginRights({
      acl: acl(user('1001', 'owner'), group('2001', 'unknown'), {
        principal: 'other',
        kind: 'unknown',
        access: 'read',
      }),
      principalMap: { '1001': 31 },
      fallbackUserGroupIds: [99],
    });
    expect(ids(r)).toEqual([31]);
    expect(r.ignoredEntries).toBe(2);
    expect(r.unmapped).toEqual([]);
  });

  it('casse et espaces de bord ignorés, mais pas de correspondance partielle ni de joker', () => {
    const r = mapOriginRights({
      acl: acl(
        user(' ALICE@EX.ORG '),
        user('alice'),
        user('alice@ex.org.evil'),
        user('*'),
        group('COMPTA'),
      ),
      principalMap: { 'Alice@Ex.Org': 11, 'compta ': 20, '*': 50, 'alice@*': 51 },
      fallbackUserGroupIds: [],
    });
    // `*` est un principal NOMMÉ « * » ici (clé exacte), pas un joker : il ne fait correspondre que lui-même.
    expect(ids(r)).toEqual([11, 20, 50]);
    expect(r.unmapped).toEqual(['alice', 'alice@ex.org.evil']);
  });

  it('principalMap malicieux (__proto__, constructor, toString) sans effet', () => {
    const map = JSON.parse('{"__proto__": 66, "alice@ex.org": 11}') as Record<string, number>;
    const r = mapOriginRights({
      acl: acl(
        user('constructor'),
        user('toString'),
        user('hasOwnProperty'),
        user('__proto__'),
        user('alice@ex.org'),
      ),
      principalMap: map,
      fallbackUserGroupIds: [],
    });
    // `__proto__` est ici une clé PROPRE explicitement configurée (JSON.parse) : elle se mappe
    // normalement, comme n'importe quel nom. Les noms hérités d'Object.prototype, eux, ne trouvent rien.
    expect(ids(r)).toEqual([11, 66]);
    expect(r.unmapped).toEqual(['constructor', 'hasOwnProperty', 'toString']);

    const plain = mapOriginRights({
      acl: acl(user('constructor'), user('__proto__'), user('valueOf')),
      principalMap: { ...MAP },
      fallbackUserGroupIds: [],
    });
    expect(plain.grants).toEqual([]);
    expect(plain.unmapped).toEqual(['__proto__', 'constructor', 'valueOf']);
  });

  it('valeurs invalides de principalMap ignorées (0, négatif, décimal, chaîne, NaN, énorme)', () => {
    const r = mapOriginRights({
      acl: acl(user('a'), user('b'), user('c'), user('d'), user('e'), user('f'), user('g')),
      principalMap: {
        a: 0,
        b: -3,
        c: 1.5,
        d: '4',
        e: Number.NaN,
        f: 2 ** 60,
        g: 7,
      } as unknown as Record<string, number>,
      fallbackUserGroupIds: [],
    });
    expect(ids(r)).toEqual([7]);
    expect(r.unmapped).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });

  it('clés ambiguës (« Alice » → 11, « alice » → 12) : aucune retenue', () => {
    const r = mapOriginRights({
      acl: acl(user('alice')),
      principalMap: { Alice: 11, alice: 12 },
      fallbackUserGroupIds: [99],
    });
    expect(r.grants.map((g) => g.userGroupId)).toEqual([99]);
    expect(r.usedFallback).toBe(true);
    expect(r.ambiguous).toEqual(['alice']);
    // Même groupe des deux côtés : pas d'ambiguïté.
    expect(
      ids(
        mapOriginRights({
          acl: acl(user('alice')),
          principalMap: { Alice: 11, alice: 11 },
          fallbackUserGroupIds: [],
        }),
      ),
    ).toEqual([11]);
  });

  it('dédoublonnage par groupe et ordre déterministe', () => {
    const r1 = mapOriginRights({
      acl: acl(
        user('carol@ex.org'),
        group('compta'),
        user('alice@ex.org'),
        user('Alice@ex.org', 'owner'),
        user('x'),
        user('x'),
      ),
      principalMap: { ...MAP, 'x@y': 11 },
      fallbackUserGroupIds: [],
    });
    const r2 = mapOriginRights({
      acl: acl(user('x'), user('alice@ex.org'), group('compta'), user('carol@ex.org')),
      principalMap: { compta: 20, 'carol@ex.org': 13, 'alice@ex.org': 11 },
      fallbackUserGroupIds: [],
    });
    expect(ids(r1)).toEqual([11, 13, 20]);
    expect(r1.grants).toEqual(r2.grants);
    expect(r1.unmapped).toEqual(['x']);
  });

  it('entrées mal formées ignorées sans exception', () => {
    const entries = [
      null,
      42,
      'alice@ex.org',
      {},
      { principal: 'alice@ex.org' },
      { principal: 'alice@ex.org', kind: 'user' },
      { principal: 'alice@ex.org', kind: 'admin', access: 'read' },
      { principal: 'alice@ex.org', kind: 'user', access: 'full' },
      { principal: 11, kind: 'user', access: 'read' },
      { principal: '   ', kind: 'user', access: 'read' },
      { principal: 'bob@ex.org', kind: 'user', access: 'read' },
    ] as unknown as OriginAclEntry[];
    const r = mapOriginRights({ acl: { entries }, principalMap: MAP, fallbackUserGroupIds: [] });
    expect(ids(r)).toEqual([12]);
    expect(r.ignoredEntries).toBe(10);
  });

  it('entrée totalement invalide (input nul) → aucun droit, pas d’exception', () => {
    const r = mapOriginRights(null as unknown as RightsMappingInput);
    expect(r.grants).toEqual([]);
    expect(r.restricted).toBe(false);
  });

  it('repli vide aussi → aucun droit, restricted=false et raison explicite (visible par tous)', () => {
    const r = mapOriginRights({
      acl: acl(pub()),
      principalMap: MAP,
      fallbackUserGroupIds: [0, -1, 1.5, Number.NaN],
    });
    expect(r.grants).toEqual([]);
    expect(r.usedFallback).toBe(true);
    expect(r.restricted).toBe(false);
    expect(r.reason).toMatch(/visible par TOUS/);
    expect(() => assertRestricted(r)).toThrow(RightsWideningError);
  });

  it('aucun mappé + non mappés → repli, et unmapped listé', () => {
    const r = mapOriginRights({
      acl: acl(user('zed'), group('Ops')),
      principalMap: MAP,
      fallbackUserGroupIds: [4],
    });
    expect(ids(r)).toEqual([4]);
    expect(r.unmapped).toEqual(['Ops', 'zed']);
    expect(r.reason).toMatch(/aucun des 2/);
  });
});

describe('assertNeverWider / assertRestricted', () => {
  const input: RightsMappingInput = {
    acl: acl(user('alice@ex.org'), pub()),
    principalMap: MAP,
    fallbackUserGroupIds: [99],
  };

  it('accepte le résultat de mapOriginRights', () => {
    const r = mapOriginRights(input);
    expect(() => assertNeverWider(input, r)).not.toThrow();
    expect(() => assertRestricted(r)).not.toThrow();
  });

  it.each<[string, Partial<RightsMappingResult>]>([
    [
      'groupe non mappé',
      { grants: [{ userGroupId: 12, permissionLevelId: 2 }], usedFallback: false },
    ],
    [
      'niveau au-delà de la Consultation',
      { grants: [{ userGroupId: 11, permissionLevelId: 3 }], usedFallback: false },
    ],
    ['niveau Denied', { grants: [{ userGroupId: 11, permissionLevelId: 1 }], usedFallback: false }],
    [
      'repli ajouté alors que des droits sont mappés',
      { grants: [{ userGroupId: 99, permissionLevelId: 2 }], usedFallback: true },
    ],
    [
      'repli mêlé aux droits mappés',
      {
        grants: [
          { userGroupId: 11, permissionLevelId: 2 },
          { userGroupId: 99, permissionLevelId: 2 },
        ],
        usedFallback: false,
      },
    ],
    [
      'doublon',
      {
        grants: [
          { userGroupId: 11, permissionLevelId: 2 },
          { userGroupId: 11, permissionLevelId: 2 },
        ],
        usedFallback: false,
      },
    ],
    [
      'groupe invalide',
      { grants: [{ userGroupId: 0, permissionLevelId: 2 }], usedFallback: false },
    ],
    ['grants absent', { grants: undefined as unknown as [] }],
  ])('refuse un résultat élargi : %s', (_l, patch) => {
    const r = { ...mapOriginRights(input), ...patch };
    expect(() => assertNeverWider(input, r)).toThrow(RightsWideningError);
  });

  it('refuse un repli qui n’est pas dans la liste de repli', () => {
    const inp: RightsMappingInput = { acl: null, principalMap: MAP, fallbackUserGroupIds: [99] };
    const r = { ...mapOriginRights(inp), grants: [{ userGroupId: 98, permissionLevelId: 2 }] };
    expect(() => assertNeverWider(inp, r)).toThrow(RightsWideningError);
  });
});

// ---------------------------------------------------------------------------
// Propriété : tirages pseudo-aléatoires à graine fixe (reproductibles)
// ---------------------------------------------------------------------------

/** mulberry32 : générateur déterministe minimal (pas besoin de qualité cryptographique ici). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('propriété : jamais plus ouvert qu’à la source', () => {
  const rand = mulberry32(0x5eed2a);
  const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)] as T;
  const BASE = [
    'alice',
    'bob',
    'carol',
    'dave',
    'compta',
    'rh',
    '1001',
    '2001',
    '__proto__',
    'constructor',
    'toString',
    '*',
    'everyone',
    '',
  ];
  // Variantes : majorité équivalentes après normalisation (casse, espaces), minorité « presque »
  // identiques (suffixe, préfixe tronqué) qui ne doivent JAMAIS correspondre.
  const variant = (p: string): string =>
    pick([p, p, p.toUpperCase(), ` ${p} `, `${p}x`, p.slice(1)]);
  const KINDS = [
    'user',
    'user',
    'group',
    'group',
    'public',
    'unknown',
    'admin',
    undefined,
  ] as const;
  const ACCESS = ['read', 'read', 'write', 'owner', 'unknown', 'full', undefined] as const;
  const GROUP_VALUES = [1, 2, 3, 5, 8, 13, 21, 0, -1, 1.5, Number.NaN, '7', 2 ** 60];

  /** Entrée d'ACL ; la moitié des principaux sont tirés des clés de la table (pour exercer les correspondances). */
  function randomEntry(mapKeys: string[]): unknown {
    if (rand() < 0.05) return pick([null, 42, 'x', [], {}]);
    const source = mapKeys.length > 0 && rand() < 0.5 ? pick(mapKeys).trim() : pick(BASE);
    return {
      principal: rand() < 0.05 ? 7 : variant(source),
      kind: pick(KINDS),
      access: pick(ACCESS),
    };
  }
  function randomInput(): RightsMappingInput {
    const principalMap: Record<string, unknown> = {};
    const m = Math.floor(rand() * 9);
    for (let i = 0; i < m; i++) {
      const key = variant(pick(BASE));
      // Affectation par defineProperty : `__proto__` devient une clé propre (comme après JSON.parse).
      Object.defineProperty(principalMap, key, {
        value: pick(GROUP_VALUES),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    const keys = Object.keys(principalMap);
    const n = Math.floor(rand() * 7);
    const acl =
      rand() < 0.1 ? null : { entries: Array.from({ length: n }, () => randomEntry(keys)) };
    const fallbackUserGroupIds = Array.from({ length: Math.floor(rand() * 4) }, () =>
      pick(GROUP_VALUES),
    );
    return {
      acl: acl as OriginAcl | null,
      principalMap: principalMap as Record<string, number>,
      fallbackUserGroupIds: fallbackUserGroupIds as number[],
    };
  }

  /** Oracle indépendant : groupes atteignables depuis les entrées user/group lisibles. */
  function oracleMapped(input: RightsMappingInput): Set<number> {
    const out = new Set<number>();
    const raw: unknown = input.acl?.entries;
    const entries: unknown[] = Array.isArray(raw) ? raw : [];
    for (const e of entries) {
      if (!e || typeof e !== 'object') continue;
      const { principal, kind, access } = e as Record<string, unknown>;
      if (kind !== 'user' && kind !== 'group') continue;
      if (access !== 'read' && access !== 'write' && access !== 'owner') continue;
      if (typeof principal !== 'string' || principal.trim() === '') continue;
      for (const [k, v] of Object.entries(input.principalMap)) {
        if (
          k.trim().toLowerCase() === principal.trim().toLowerCase() &&
          Number.isSafeInteger(v) &&
          v > 0
        )
          out.add(v);
      }
    }
    return out;
  }

  it('500 tirages : groupes accordés ⊆ mappés ∪ repli, Consultation seulement, public sans effet', () => {
    let withGrants = 0;
    let withFallback = 0;
    let empty = 0;
    for (let i = 0; i < 500; i++) {
      const input = randomInput();
      const r = mapOriginRights(input);

      // 1. Garde-fou indépendant.
      expect(() => assertNeverWider(input, r)).not.toThrow();

      // 2. Inclusion explicite, niveaux, forme.
      const mapped = oracleMapped(input);
      const fallback = new Set(
        input.fallbackUserGroupIds.filter((v) => Number.isSafeInteger(v) && v > 0),
      );
      for (const g of r.grants) {
        expect(Number.isSafeInteger(g.userGroupId) && g.userGroupId > 0).toBe(true);
        expect(g.permissionLevelId).toBe(CONSULTATION_LEVEL);
        expect(mapped.has(g.userGroupId) || fallback.has(g.userGroupId)).toBe(true);
        if (!r.usedFallback) expect(mapped.has(g.userGroupId)).toBe(true);
      }
      const got = ids(r);
      expect(got).toEqual([...new Set(got)].sort((a, b) => a - b));
      expect(r.restricted).toBe(got.length > 0);
      expect(typeof r.reason).toBe('string');

      // 3. Ajouter des entrées public/unknown ne change RIEN aux droits accordés.
      const widened: RightsMappingInput = {
        ...input,
        acl: {
          entries: [
            ...((input.acl?.entries ?? []) as OriginAclEntry[]),
            { principal: '*', kind: 'public', access: 'owner' },
            { principal: 'alice', kind: 'unknown', access: 'read' },
            { principal: 'Everyone', kind: 'public', access: 'read' },
          ],
        },
      };
      const r2 = mapOriginRights(widened);
      expect(r2.grants).toEqual(r.grants);

      // 4. Le repli n'est jamais mêlé à des droits mappés.
      if (r.usedFallback) expect(r.grants.every((g) => fallback.has(g.userGroupId))).toBe(true);

      if (r.grants.length === 0) empty++;
      else if (r.usedFallback) withFallback++;
      else withGrants++;
    }
    // Le générateur couvre bien les trois issues (sinon la propriété serait testée à vide).
    expect(withGrants).toBeGreaterThan(50);
    expect(withFallback).toBeGreaterThan(20);
    expect(empty).toBeGreaterThan(20);
  });
});
