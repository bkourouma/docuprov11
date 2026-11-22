import type { ZodType } from 'zod';
import { EffectRefusedError } from '../../catalog.contracts';

/**
 * Revalidation STRICTE des arguments stockés d'une action préparée (jamais de confiance dans le JSON stocké).
 * Le message d'erreur ne cite que les noms de champs et le type d'anomalie : jamais une valeur (pas de contenu
 * de courrier dans un refus).
 */
export function parseStrict<T>(schema: ZodType<T>, args: unknown, toolKey: string): T {
  const parsed = schema.safeParse(args);
  if (parsed.success) return parsed.data;
  const fields = [
    ...new Set(
      parsed.error.issues.map((issue) => {
        const path = issue.path.join('.');
        if (issue.code === 'unrecognized_keys') return `champ non prévu${path ? ` dans « ${path} »` : ''}`;
        return path ? `« ${path} »` : 'arguments';
      }),
    ),
  ].slice(0, 6);
  throw new EffectRefusedError(
    `Action « ${toolKey} » refusée : arguments invalides (${fields.join(', ')}).`,
    'invalid_arguments',
  );
}

/** Longueur maximale d'un titre de courrier repris dans une notification in-app. */
export const NOTIFICATION_TITLE_MAX = 300;

/** Tronque `text` à `max` caractères (points de code), avec une ellipse finale. */
export function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
}
