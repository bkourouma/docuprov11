import { Prisma } from '@prisma/client';

/** Préfixe des messages de relance interne (sert aussi de repère pour compter les relances du jour). */
export const RELANCE_MESSAGE_PREFIX = 'Relance : ';

/** Début du jour UTC contenant `now`. */
export function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

type Db = Prisma.TransactionClient | { $queryRaw: Prisma.TransactionClient['$queryRaw']; notification: Prisma.TransactionClient['notification'] };

/** Relances internes déjà envoyées aujourd'hui (jour UTC) à `recipientUserGroupId` pour ce courrier (tâche = imputation). */
export async function countTargetRelancesToday(
  db: Pick<Prisma.TransactionClient, 'notification'>,
  mailId: number,
  recipientUserGroupId: number,
  now: Date,
): Promise<number> {
  return db.notification.count({
    where: {
      recipientUserGroupId,
      targetType: 'mail',
      targetId: mailId,
      message: { startsWith: RELANCE_MESSAGE_PREFIX },
      createdAt: { gte: utcDayStart(now) },
    },
  });
}

/**
 * Relances (effets `proposer_relance`) déjà appliquées aujourd'hui (jour UTC) dans une instance, d'après le
 * journal `agent.acted` / `decision.kind = 'effects_applied'` écrit par le moteur dans la transaction de validation.
 */
export async function countInstanceRelancesToday(
  db: Pick<Db, '$queryRaw'>,
  instanceId: string,
  now: Date,
): Promise<number> {
  if (!/^[1-9]\d{0,17}$/.test(instanceId)) return 0;
  const rows = await db.$queryRaw<Array<{ n: bigint }>>(Prisma.sql`
    SELECT count(*)::bigint AS n
      FROM wf_event_log e
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(e.decision -> 'effects') = 'array' THEN e.decision -> 'effects' ELSE '[]'::jsonb END
      ) x
     WHERE e.instance_id = ${BigInt(instanceId)}
       AND e.event_type = 'agent.acted'
       AND e.decision ->> 'kind' = 'effects_applied'
       AND x ->> 'tool' = 'proposer_relance'
       AND e.occurred_at >= ${utcDayStart(now)}`);
  return Number(rows[0]?.n ?? 0);
}
