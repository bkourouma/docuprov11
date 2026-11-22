import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { WfActorKind } from '@archivage/types';
import { PrismaService } from '../prisma/prisma.service';
import type { WfAgentEventInput, WfAgentEventSink } from './agent.contracts';

const MAX_EXPLANATION = 2000;

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
}

/**
 * Journal d'agent hors transaction du moteur : événements qui ne sont PAS un effet (appel d'un outil de
 * lecture, refus de budget). Les effets (proposition, clôture) sont journalisés par le moteur DANS la même
 * transaction (`agent.proposed`, `agent.acted`, `agent.escalated`). Ajout seul ; ne lève jamais.
 */
@Injectable()
export class AgentEventSink implements WfAgentEventSink {
  private readonly logger = new Logger(AgentEventSink.name);

  constructor(private readonly prisma: PrismaService) {}

  async append(event: WfAgentEventInput): Promise<void> {
    try {
      await this.prisma.wfEventLog.create({
        data: {
          instanceId: BigInt(event.instanceId),
          taskId: event.taskId ? BigInt(event.taskId) : null,
          stepKey: event.stepKey ?? null,
          eventType: event.eventType,
          actorKind: WfActorKind.Agent,
          decision: event.decision === undefined ? undefined : toJson(event.decision),
          sources: event.sources === undefined ? undefined : toJson(event.sources),
          explanation: event.explanation ? event.explanation.slice(0, MAX_EXPLANATION) : null,
          autonomyLevel: event.autonomyLevel ?? null,
        },
      });
    } catch (err) {
      this.logger.warn(
        `journal d'agent non écrit (${event.eventType}) : ${err instanceof Error ? err.name : 'erreur inconnue'}`,
      );
    }
  }

  async countToolCalls(instanceId: string, toolKey: string): Promise<number> {
    const rows = await this.prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT COUNT(*)::bigint AS n FROM "wf_event_log"
       WHERE "instance_id" = ${BigInt(instanceId)}
         AND "event_type" = 'agent.tool_called'
         AND "decision"->>'tool' = ${toolKey}`;
    return Number(rows[0]?.n ?? 0n);
  }
}
