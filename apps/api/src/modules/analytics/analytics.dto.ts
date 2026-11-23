import { z } from 'zod';

/**
 * Date civile `AAAA-MM-JJ` EXISTANTE. La forme seule ne suffit pas : `2026-13-45` faisait lever
 * `toISOString()` (RangeError) dans le calcul de la période précédente, et `2026-02-30` était rejeté
 * par PostgreSQL au cast `::date` — deux erreurs 500 pour une simple faute de saisie. On vérifie donc
 * que la date se relit à l'identique une fois construite en UTC (JS « reporte » le 30 février au
 * 2 mars au lieu de le refuser).
 */
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, 'Date invalide (AAAA-MM-JJ attendu)');

/** Filtres globaux des tableaux de bord (période + dimensions). */
export const analyticsFilterSchema = z.object({
  // Bornes de période (incluses). Si absentes, le service applique les 30 derniers jours.
  dateFrom: isoDate.optional(),
  dateTo: isoDate.optional(),
  // Dimensions de filtrage (toutes optionnelles).
  dossierId: z.number().int().positive().optional(),
  documentTypeId: z.number().int().positive().optional(),
  locationId: z.number().int().positive().optional(),
  // Granularité de la série temporelle.
  granularity: z.enum(['day', 'week', 'month', 'quarter', 'year']).default('day'),
  // Colonne de date : created_at = débit technique (100% peuplé) ; document_date = date métier ;
  // validated_at = date d'archivage effective (NULL tant que non validé → exclu par les bornes).
  basis: z.enum(['created_at', 'document_date', 'validated_at']).default('created_at'),
});
export type AnalyticsFilterDto = z.infer<typeof analyticsFilterSchema>;

export const analyticsExportSchema = analyticsFilterSchema.extend({
  format: z.enum(['xlsx', 'csv', 'docx', 'pdf']),
});
export type AnalyticsExportDto = z.infer<typeof analyticsExportSchema>;

/** Liste « objectif vs réalisé » des cibles d'une période donnée. */
export const analyticsTargetsSchema = z.object({
  // Type de période ciblée (aligné sur analytics_target.period_kind).
  periodKind: z.enum(['month', 'quarter', 'year']).default('month'),
  // Début de période ; si absent, le service prend la période courante (date_trunc).
  periodStart: isoDate.optional(),
  // Filtre optionnel sur le périmètre des cibles.
  scope: z.enum(['global', 'programme', 'type']).optional(),
});
export type AnalyticsTargetsDto = z.infer<typeof analyticsTargetsSchema>;

/**
 * Agencement de widgets soumis par l'écran. Volontairement permissif sur les valeurs : le service
 * borne ensuite chaque position au catalogue (taille minimale, nombre de colonnes) plutôt que de
 * rejeter la requête — un arrondi de la grille ne doit pas faire échouer un enregistrement.
 */
export const agencementSchema = z
  .object({
    widgets: z
      .array(
        z
          .object({
            id: z.string().min(1).max(80),
            x: z.coerce.number().int().min(0).max(200),
            y: z.coerce.number().int().min(0).max(2000),
            w: z.coerce.number().int().min(1).max(48),
            h: z.coerce.number().int().min(1).max(200),
          })
          .strict(),
      )
      .max(50),
  })
  .strict();
export type AgencementDto = z.infer<typeof agencementSchema>;
