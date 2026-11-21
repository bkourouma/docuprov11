import { Injectable } from '@nestjs/common';
import { applyAiMasking } from '@archivage/types';
import type { GedAiMaskingKind } from '@archivage/types';
import { PrismaService } from '../prisma/prisma.service';

export interface AiMaskOptions {
  /** `true` : envoi vers un fournisseur cloud → règles de la table + entités prédéfinies, toujours. */
  cloud: boolean;
  /** Réglage `masking_enabled` ; ne concerne que le mode local (le cloud masque toujours). Défaut : `true`. */
  maskingEnabled?: boolean;
}

export interface AiMaskResult {
  text: string;
  /** Nombre de substitutions effectuées. */
  count: number;
  /** `false` si aucun masquage n'a été appliqué (local avec masquage coupé). */
  masked: boolean;
}

/**
 * Masquage du texte avant envoi à un fournisseur IA. Les règles actives de `ged_ai_masking_rule` sont
 * relues à chaque appel (peu nombreuses, et une règle modifiée doit valoir immédiatement). Une règle
 * invalide fait ÉCHOUER le masquage (`applyAiMasking` échoue fermé) : rien ne part en clair.
 */
@Injectable()
export class AiMaskingService {
  constructor(private readonly prisma: PrismaService) {}

  async mask(text: string, options: AiMaskOptions): Promise<AiMaskResult> {
    const enabled = options.cloud || (options.maskingEnabled ?? true);
    if (!enabled) return { text, count: 0, masked: false };

    const rules = await this.prisma.gedAiMaskingRule.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { gedAiMaskingRuleId: 'asc' }],
    });
    const result = applyAiMasking(
      text,
      rules.map((r) => ({
        kind: r.kind as GedAiMaskingKind,
        pattern: r.pattern,
        replacement: r.replacement,
      })),
      { includeDefaults: options.cloud },
    );
    return { text: result.text, count: result.count, masked: true };
  }
}
