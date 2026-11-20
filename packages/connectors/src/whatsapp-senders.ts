// Lot 2c — expéditeurs WhatsApp : liste blanche et droits du document créé.
//
// Règles :
// - seuls les numéros de `config.senders` déposent (correspondance EXACTE sur le numéro normalisé ;
//   entrée invalide ou liste vide = refus) ;
// - le groupe DocuPro d'un expéditeur se déclare dans le mécanisme existant `rights.principalMap`
//   (`"wa:<chiffres>": user_group_id`), sinon repli `rights.fallbackUserGroupIds` ;
// - droits = Consultation sur ce(s) groupe(s) uniquement, via `mapOriginRights` et ses garde-fous
//   (`assertNeverWider`, `assertRestricted`). Un document sans droit étant visible de TOUS dans
//   DocuPro, l'absence de groupe lève une erreur « document non créé » : jamais de liste vide.
import { z } from 'zod';
import { ConnectorConfigError, splitStoredConfig } from './registry';
import {
  RightsWideningError,
  assertNeverWider,
  assertRestricted,
  mapOriginRights,
  type DocuProGrant,
  type RightsMappingInput,
} from './rights';
import { rightsConfigSchema, type RightsConfig } from './rights-config';
import type { OriginAcl } from './types';
import { whatsappConfigSchema, type WhatsappConfigParsed } from './whatsapp-config';
import { normalizePhone, principalForPhone } from './whatsapp-phone';

export type WhatsappSenderResolution =
  | { allowed: false }
  | { allowed: true; phone: string; principal: string; label?: string };

/**
 * Liste blanche : l'expéditeur `senderDigits` (champ `from` de Meta, chiffres sans `+`) est-il autorisé ?
 * Refus par défaut : numéro illisible, configuration ou liste absente/vide, aucune correspondance exacte.
 */
export function resolveWhatsappSender(
  settings: WhatsappConfigParsed,
  senderDigits: string,
): WhatsappSenderResolution {
  const phone = normalizePhone(senderDigits);
  if (phone === null) return { allowed: false };
  const senders: unknown = (settings as { senders?: unknown } | null | undefined)?.senders;
  if (!Array.isArray(senders)) return { allowed: false };
  for (const s of senders as unknown[]) {
    if (s === null || typeof s !== 'object') continue;
    const { phone: rawPhone, label } = s as { phone?: unknown; label?: unknown };
    // Défense en profondeur : la config est normalement déjà canonique (schéma), on renormalise quand même.
    if (normalizePhone(rawPhone) !== phone) continue;
    return {
      allowed: true,
      phone,
      principal: principalForPhone(phone),
      ...(typeof label === 'string' && label !== '' ? { label } : {}),
    };
  }
  return { allowed: false };
}

export interface WhatsappGrantsResult {
  /** Droits Consultation à poser, jamais vide. */
  grants: DocuProGrant[];
  /** `true` si l'expéditeur n'a pas d'entrée `wa:` utilisable et reçoit les groupes de repli. */
  usedFallback: boolean;
  /** Motif lisible (sans numéro de téléphone). */
  reason: string;
}

const NOT_CREATED =
  'Aucun groupe DocuPro pour cet expéditeur (ni correspondance « wa: » dans la table des droits, ni ' +
  'groupe de repli) : document non créé.';

/**
 * Droits du document déposé par l'expéditeur `phone` : ACL d'origine à une seule entrée
 * `wa:<chiffres>` (lecture), passée au mapping commun puis aux deux garde-fous.
 * Lève une erreur (« document non créé ») si le numéro est illisible ou si aucun groupe ne s'applique.
 */
export function resolveWhatsappGrants(input: {
  phone: string;
  rights: RightsConfig;
}): WhatsappGrantsResult {
  const phone = normalizePhone(input?.phone);
  if (phone === null) {
    throw new RightsWideningError('Numéro d’expéditeur illisible : document non créé.');
  }
  const acl: OriginAcl = { entries: [{ principal: principalForPhone(phone), kind: 'user', access: 'read' }] };
  const mappingInput: RightsMappingInput = {
    acl,
    principalMap: input?.rights?.principalMap ?? {},
    fallbackUserGroupIds: input?.rights?.fallbackUserGroupIds ?? [],
  };
  const result = mapOriginRights(mappingInput);
  // Carte ambiguë (« wa:X » et « WA:X » vers deux groupes différents) : `mapOriginRights` n'en retient
  // aucune et se replie, mais `assertNeverWider` (recalcul indépendant, sans notion d'ambiguïté)
  // refuse ce repli. On échoue donc ici, explicitement, plutôt que sur un message obscur du garde-fou.
  if (result.ambiguous !== undefined && result.ambiguous.length > 0) {
    throw new RightsWideningError(
      'Correspondance « wa: » ambiguë pour cet expéditeur (plusieurs entrées de la table des droits ' +
        'qui ne diffèrent que par la casse ou les espaces, vers des groupes différents) : document non créé.',
    );
  }
  if (result.grants.length === 0 || result.restricted === false) {
    throw new RightsWideningError(NOT_CREATED);
  }
  assertNeverWider(mappingInput, result);
  assertRestricted(result);
  return {
    grants: result.grants.map((g) => ({ userGroupId: g.userGroupId, permissionLevelId: g.permissionLevelId })),
    usedFallback: result.usedFallback,
    // Le motif du mapping ne cite que des nombres (pas les principaux) : aucun numéro n'y figure.
    reason: result.reason,
  };
}

/** Chemin d'un problème réduit à son premier segment connu (jamais une clé de `principalMap` = un numéro). */
function issueSummary(prefix: string, issue: z.ZodIssue, knownFields: readonly string[]): string {
  const head = issue.path[0];
  const field = typeof head === 'string' && knownFields.includes(head) ? head : '(racine)';
  return `${prefix} ${field} : ${issue.code}`;
}

const SETTINGS_FIELDS = Object.keys(whatsappConfigSchema.shape);
const RIGHTS_FIELDS = Object.keys(rightsConfigSchema.shape);

/**
 * Lecture de `ged_source_connector.config` d'un connecteur WhatsApp, pour le worker et l'API :
 * sépare la clé réservée `rights`, valide les deux parties. En cas d'échec, lève une
 * `ConnectorConfigError` générique : ni numéro, ni valeur, seulement les champs fautifs et le code.
 */
export function parseWhatsappStoredConfig(raw: unknown): {
  settings: WhatsappConfigParsed;
  rights: RightsConfig;
} {
  let parts: { settings: unknown; rights: unknown };
  try {
    parts = splitStoredConfig(raw);
  } catch {
    throw new ConnectorConfigError('Configuration du connecteur WhatsApp invalide.', [
      'configuration : objet attendu',
    ]);
  }
  const settings = whatsappConfigSchema.safeParse(parts.settings);
  const rights = rightsConfigSchema.safeParse(parts.rights ?? {});
  if (!settings.success || !rights.success) {
    const problems = [
      ...(settings.success ? [] : settings.error.issues.map((i) => issueSummary('réglage', i, SETTINGS_FIELDS))),
      ...(rights.success ? [] : rights.error.issues.map((i) => issueSummary('droits', i, RIGHTS_FIELDS))),
    ];
    throw new ConnectorConfigError('Configuration du connecteur WhatsApp invalide.', [
      ...new Set(problems),
    ]);
  }
  return { settings: settings.data, rights: rights.data };
}
