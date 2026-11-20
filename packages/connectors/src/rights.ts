// Mapping des droits d'origine d'un élément vers des droits DocuPro (modes copie/synchro).
//
// Règle métier impérative : le document créé n'est JAMAIS plus ouvert qu'à la source. Un fichier
// visible par trois personnes à la source ne devient jamais visible par tous dans DocuPro.
//
// ATTENTION — ce que signifie « aucune permission » dans DocuPro (vérifié le 2026-11-20) :
// `DocumentsService.canAccess` → `isVisibleByPermissions` (apps/api/src/modules/documents/
// documents.service.ts) considère qu'un document SANS aucun droit `document_permission` ni
// `document_type_permission` en vigueur n'est PAS restreint : il est visible par TOUT utilisateur
// authentifié (sauf confidentialité posée). `SearchService.permissionCondition` applique la même
// règle. Autrement dit, `grants: []` = OUVERT À TOUS, pas « fermé ». D'où le champ `restricted`
// du résultat : quand il vaut `false`, l'appelant NE DOIT PAS créer le document tel quel (le mettre
// en erreur / quarantaine, ou poser au moins un droit) — cf. `assertRestricted`.
//
// Pourquoi toujours Consultation (niveau 2) : DocuPro ne délivre jamais automatiquement plus que la
// lecture ; un droit d'écriture ou de propriété à la source ne se traduit pas en droit de
// modification ici (il se décide dans « Sécurité Documentaire »). Et jamais le niveau 1 (`Denied`) :
// c'est un refus opposable qui l'emporte même sur le passe-droit du créateur.
import type { OriginAcl, OriginAclEntry } from './types';

/** Niveau de permission DocuPro posé sur les documents créés : 2 = Consultation (cf. grant-permission.ts). */
export const CONSULTATION_LEVEL = 2;

export interface DocuProGrant {
  userGroupId: number;
  permissionLevelId: number;
}
export interface RightsMappingInput {
  /** Droits d'origine normalisés, ou `null` si illisibles. */
  acl: OriginAcl | null;
  /** Principal de la source (e-mail, uid…) -> `user_group_id` DocuPro. Fourni par l'admin dans la config. */
  principalMap: Record<string, number>;
  /** Groupes à qui rendre le document en dernier recours (ex. groupe de l'administrateur qui a créé le connecteur). */
  fallbackUserGroupIds: number[];
}
export interface RightsMappingResult {
  grants: DocuProGrant[];
  /** Principaux de la source sans équivalent DocuPro (journalisés, jamais élargis). */
  unmapped: string[];
  usedFallback: boolean;
  reason: string;
  /**
   * `true` si au moins un droit est posé, donc si le document sera effectivement restreint.
   * `false` = aucun droit : avec le modèle d'accès actuel, le document serait VISIBLE PAR TOUS les
   * utilisateurs authentifiés. L'appelant doit alors refuser de le créer (cf. `assertRestricted`).
   */
  restricted?: boolean;
  /** Principaux présents dans plusieurs clés de `principalMap` qui ne diffèrent que par la casse/les espaces, avec des groupes différents : non mappés par prudence. */
  ambiguous?: string[];
  /** Entrées écartées : `public`/`unknown`, accès inconnu, entrées mal formées. Compte, sans détail. */
  ignoredEntries?: number;
}

/** Comparaison des principaux : insensible à la casse et aux espaces de bord, rien d'autre. */
function normalizePrincipal(p: string): string {
  return p.trim().toLowerCase();
}

function isValidGroupId(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
}

const READABLE_ACCESS = new Set(['read', 'write', 'owner']);
const MAPPABLE_KINDS = new Set(['user', 'group']);

/** Entrée user/group lisible et bien formée, ou `null` (ignorée). Jamais d'exception. */
function readableEntry(e: unknown): { principal: string; key: string } | null {
  if (e === null || typeof e !== 'object') return null;
  const { principal, kind, access } = e as Partial<Record<keyof OriginAclEntry, unknown>>;
  if (typeof kind !== 'string' || !MAPPABLE_KINDS.has(kind)) return null;
  if (typeof access !== 'string' || !READABLE_ACCESS.has(access)) return null;
  if (typeof principal !== 'string') return null;
  const key = normalizePrincipal(principal);
  if (key === '') return null;
  return { principal: principal.trim(), key };
}

function aclEntries(acl: unknown): unknown[] {
  if (acl === null || typeof acl !== 'object') return [];
  const entries = (acl as { entries?: unknown }).entries;
  return Array.isArray(entries) ? entries : [];
}

/**
 * Index normalisé de `principalMap`. Clés PROPRES uniquement (`Object.keys` + `Object.hasOwn`) :
 * un principal nommé `constructor`, `toString` ou `__proto__` à la source ne doit jamais
 * « trouver » une propriété héritée d'`Object.prototype`. Deux clés qui se confondent après
 * normalisation mais pointent vers des groupes différents sont AMBIGUËS : on n'en retient aucune
 * plutôt que d'accorder aux deux (ce qui élargirait).
 */
function indexPrincipalMap(map: unknown): { index: Map<string, number>; ambiguous: Set<string> } {
  const index = new Map<string, number>();
  const ambiguous = new Set<string>();
  if (map === null || typeof map !== 'object' || Array.isArray(map)) return { index, ambiguous };
  for (const rawKey of Object.keys(map)) {
    if (!Object.hasOwn(map, rawKey)) continue;
    const value = (map as Record<string, unknown>)[rawKey];
    if (!isValidGroupId(value)) continue;
    const key = normalizePrincipal(rawKey);
    if (key === '' || ambiguous.has(key)) continue;
    const prev = index.get(key);
    if (prev === undefined) index.set(key, value);
    else if (prev !== value) {
      index.delete(key);
      ambiguous.add(key);
    }
  }
  return { index, ambiguous };
}

function sanitizeFallback(ids: unknown): number[] {
  if (!Array.isArray(ids)) return [];
  return [...new Set(ids.filter(isValidGroupId))].sort((a, b) => a - b);
}

function toGrants(ids: number[]): DocuProGrant[] {
  return ids.map((userGroupId) => ({ userGroupId, permissionLevelId: CONSULTATION_LEVEL }));
}

/** Droits DocuPro du document créé : le plus restrictif des droits d'origine mappables, JAMAIS plus ouverts. */
export function mapOriginRights(input: RightsMappingInput): RightsMappingResult {
  const { index, ambiguous } = indexPrincipalMap(input?.principalMap);
  const entries = aclEntries(input?.acl);
  const aclReadable = input?.acl != null && entries.length > 0;

  const granted = new Set<number>();
  const unmapped = new Map<string, string>(); // clé normalisée -> forme d'origine (première vue)
  const ambiguousSeen = new Set<string>();
  let ignored = 0;

  for (const raw of entries) {
    const entry = readableEntry(raw);
    if (!entry) {
      // `public`/`unknown` (tout le monde, lien public, « autres » POSIX), accès inconnu, entrée
      // mal formée : n'accorde rien et n'élargit rien. On ne fait que compter.
      ignored++;
      continue;
    }
    const groupId = index.get(entry.key);
    if (groupId !== undefined) {
      granted.add(groupId);
      continue;
    }
    if (ambiguous.has(entry.key)) ambiguousSeen.add(entry.principal);
    if (!unmapped.has(entry.key)) unmapped.set(entry.key, entry.principal);
  }

  const unmappedList = [...unmapped.values()].sort();
  const extra = {
    ...(ambiguousSeen.size > 0 ? { ambiguous: [...ambiguousSeen].sort() } : {}),
    ignoredEntries: ignored,
  };

  if (granted.size > 0) {
    const ids = [...granted].sort((a, b) => a - b);
    const parts = [`${ids.length} groupe(s) DocuPro en Consultation, d'après les droits d'origine`];
    if (unmappedList.length > 0) {
      parts.push(`${unmappedList.length} principal(aux) d'origine sans équivalent, non accordé(s)`);
    }
    if (ignored > 0)
      parts.push(`${ignored} entrée(s) publique(s), inconnue(s) ou illisible(s) ignorée(s)`);
    return {
      grants: toGrants(ids),
      unmapped: unmappedList,
      usedFallback: false,
      reason: `${parts.join(' ; ')}.`,
      restricted: true,
      ...extra,
    };
  }

  // Rien de mappable : repli sur les groupes choisis par l'administrateur. On NE complète JAMAIS
  // des droits mappés avec le repli (ce serait ajouter des lecteurs absents de la source).
  const fallback = sanitizeFallback(input?.fallbackUserGroupIds);
  const cause = !aclReadable
    ? 'droits d’origine illisibles ou absents'
    : unmappedList.length > 0
      ? `aucun des ${unmappedList.length} principal(aux) d’origine n’a d’équivalent DocuPro`
      : 'aucune entrée nominative lisible (accès public/inconnu ignoré)';

  if (fallback.length > 0) {
    return {
      grants: toGrants(fallback),
      unmapped: unmappedList,
      usedFallback: true,
      reason: `${cause} : repli sur ${fallback.length} groupe(s) de repli en Consultation.`,
      restricted: true,
      ...extra,
    };
  }
  return {
    grants: [],
    unmapped: unmappedList,
    usedFallback: true,
    reason:
      `${cause} et aucun groupe de repli : aucun droit posé. Attention, dans le modèle d’accès actuel ` +
      `un document sans aucun droit est visible par TOUS les utilisateurs authentifiés (hors ` +
      `confidentialité) ; il ne doit pas être créé tel quel.`,
    restricted: false,
    ...extra,
  };
}

/** Erreur levée quand un résultat de mapping ouvrirait le document plus qu'à la source. */
export class RightsWideningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RightsWideningError';
  }
}

/**
 * Garde-fou indépendant (défense en profondeur, à appeler par le worker juste avant d'écrire les
 * droits) : vérifie qu'un résultat n'accorde rien au-delà de
 *   (groupes mappés depuis les entrées user/group lisibles) ∪ (groupes de repli valides),
 * que le repli n'est utilisé que si rien n'est mappé, et que tout est en Consultation.
 * Recalcule volontairement sans réutiliser `mapOriginRights` : un bug commun ne passerait pas.
 */
export function assertNeverWider(input: RightsMappingInput, result: RightsMappingResult): void {
  const map = input?.principalMap;
  const mappedAllowed = new Set<number>();
  if (map !== null && typeof map === 'object') {
    const ownKeys = Object.keys(map).filter((k) => Object.hasOwn(map, k));
    for (const raw of aclEntries(input?.acl)) {
      const e = readableEntry(raw);
      if (!e) continue;
      for (const k of ownKeys) {
        const v = (map as Record<string, unknown>)[k];
        if (normalizePrincipal(k) === e.key && isValidGroupId(v)) mappedAllowed.add(v);
      }
    }
  }
  const fallbackAllowed = new Set(sanitizeFallback(input?.fallbackUserGroupIds));
  const grants = Array.isArray(result?.grants) ? result.grants : null;
  if (!grants) throw new RightsWideningError('Résultat de mapping des droits invalide');

  const seen = new Set<number>();
  for (const g of grants) {
    if (!g || !isValidGroupId(g.userGroupId)) {
      throw new RightsWideningError('Droit DocuPro invalide (groupe non entier positif)');
    }
    if (g.permissionLevelId !== CONSULTATION_LEVEL) {
      throw new RightsWideningError('Droit DocuPro au-delà de la Consultation');
    }
    if (seen.has(g.userGroupId)) throw new RightsWideningError('Droit DocuPro en double');
    seen.add(g.userGroupId);
    const allowed = result.usedFallback
      ? mappedAllowed.size === 0 && fallbackAllowed.has(g.userGroupId)
      : mappedAllowed.has(g.userGroupId);
    if (!allowed) {
      throw new RightsWideningError(
        'Droit DocuPro sans fondement dans les droits d’origine ni le repli',
      );
    }
  }
}

/**
 * À appeler avant de créer le document : refuse un résultat qui ne pose aucun droit, puisqu'un
 * document sans droit est ouvert à tous dans DocuPro (cf. en-tête de ce fichier).
 */
export function assertRestricted(result: RightsMappingResult): void {
  if (!Array.isArray(result?.grants) || result.grants.length === 0) {
    throw new RightsWideningError(
      'Aucun droit DocuPro applicable : le document serait visible par tous, il n’est pas créé',
    );
  }
}
