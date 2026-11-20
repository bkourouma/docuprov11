// Socle IA — masquage du texte avant envoi à un fournisseur. Règles et entités : contrat partagé
// `applyAiMasking` (@archivage/types) ; ici seulement le choix selon le mode et la lecture des règles.
import type { PrismaClient } from '@prisma/client';
import {
  applyAiMasking,
  GedAiMode,
  type GedAiMaskingKind,
  type GedAiMaskingRuleDef,
} from '@archivage/types';

/** Erreur de masquage (refus ou règle invalide) : le message est sûr, sans contenu de document. */
export class AiMaskingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiMaskingError';
  }
}

export interface MaskingOutcome {
  text: string;
  /** `true` si le masquage a été appliqué avant l'envoi. */
  masked: boolean;
  count: number;
}

/** Règles actives de `ged_ai_masking_rule`, dans l'ordre d'application. */
export async function loadMaskingRules(
  prisma: Pick<PrismaClient, 'gedAiMaskingRule'>,
): Promise<GedAiMaskingRuleDef[]> {
  const rows = await prisma.gedAiMaskingRule.findMany({
    where: { isActive: true },
    orderBy: [{ sortOrder: 'asc' }, { gedAiMaskingRuleId: 'asc' }],
    select: { kind: true, pattern: true, replacement: true },
  });
  return rows.map((r) => ({
    kind: r.kind as GedAiMaskingKind,
    pattern: r.pattern,
    replacement: r.replacement,
  }));
}

/**
 * Cloud : masquage OBLIGATOIRE (règles + entités par défaut) ; `masking_enabled = false` => refus.
 * Local : règles configurées seulement, et seulement si `masking_enabled`.
 */
export function maskForProvider(input: {
  text: string;
  mode: GedAiMode;
  maskingEnabled: boolean;
  rules: readonly GedAiMaskingRuleDef[];
}): MaskingOutcome {
  const { text, mode, maskingEnabled, rules } = input;
  if (mode === GedAiMode.Cloud && !maskingEnabled) {
    throw new AiMaskingError('Masquage désactivé : envoi vers un fournisseur cloud refusé.');
  }
  if (!maskingEnabled) return { text, masked: false, count: 0 };
  try {
    const res = applyAiMasking(text, rules, { includeDefaults: mode === GedAiMode.Cloud });
    return { text: res.text, masked: true, count: res.count };
  } catch (err) {
    // Échec fermé : on ne renvoie jamais le texte en clair si le masquage a échoué.
    throw new AiMaskingError(err instanceof Error ? err.message : 'Masquage impossible.');
  }
}
