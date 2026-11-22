import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { WF_TOOL_REGISTRY, type WfToolRegistryPort } from '../agent.contracts';

/**
 * Synchronise les outils du code vers `wf_tool` au démarrage. Upsert idempotent. NE TOUCHE JAMAIS à
 * `is_enabled` d'une ligne existante : un outil désactivé par l'administrateur le reste (la ligne créée
 * l'est activée par défaut de colonne). Une erreur est journalisée (clé et type d'erreur seulement) sans
 * bloquer le démarrage.
 */
@Injectable()
export class WfToolSyncService implements OnApplicationBootstrap {
  private readonly logger = new Logger(WfToolSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(WF_TOOL_REGISTRY) private readonly registry: WfToolRegistryPort,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.sync();
    } catch (err) {
      this.logger.error(`Synchronisation des outils d'agent impossible (${errorName(err)}).`);
    }
  }

  /** Retourne le nombre d'outils synchronisés. */
  async sync(): Promise<number> {
    let count = 0;
    for (const tool of this.registry.list()) {
      const fields = {
        label: tool.label,
        description: tool.description,
        sideEffect: tool.sideEffect,
        requiresValidation: tool.requiresValidation,
        inputSchema: tool.jsonSchema as Prisma.InputJsonValue,
      };
      try {
        await this.prisma.wfTool.upsert({
          where: { toolKey: tool.key },
          create: { toolKey: tool.key, ...fields },
          update: fields, // pas d'`isEnabled` : jamais de réactivation
        });
        count += 1;
      } catch (err) {
        this.logger.error(`Outil ${tool.key} non synchronisé (${errorName(err)}).`);
      }
    }
    return count;
  }
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : 'erreur inconnue';
}
