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
