// Lot 2a — implémentation Prisma de `SyncStore` (accès base du moteur de synchronisation).
import { Prisma, type PrismaClient } from '@prisma/client';
import { GedSourceItemState, GedSyncRunStatus } from '@archivage/types';
import type {
  ConnectorPatch,
  ItemPatch,
  ItemProvenance,
  ItemRow,
  RunPatch,
  SyncStore,
} from './sync-engine';

export type StorePrisma = Pick<
  PrismaClient,
  'gedSourceConnector' | 'gedSourceSyncRun' | 'gedSourceItem'
>;

const ITEM_SELECT = {
  gedSourceItemId: true,
  externalId: true,
  state: true,
  documentId: true,
  contentHash: true,
  remoteVersion: true,
  duplicateOfId: true,
} as const;

function toRow(r: {
  gedSourceItemId: bigint;
  externalId: string;
  state: number;
  documentId: number | null;
  contentHash: string | null;
  remoteVersion: string | null;
  duplicateOfId: bigint | null;
}): ItemRow {
  return {
    id: r.gedSourceItemId,
    externalId: r.externalId,
    state: r.state,
    documentId: r.documentId,
    contentHash: r.contentHash,
    remoteVersion: r.remoteVersion,
    duplicateOfId: r.duplicateOfId,
  };
}

/** JSON Prisma : `null` se code `DbNull`, jamais `undefined` (qui laisserait la valeur précédente). */
function json(value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return value == null ? Prisma.DbNull : (value as Prisma.InputJsonValue);
}

function provenanceData(p: ItemProvenance) {
  return {
    name: p.name,
    originUrl: p.originUrl,
    originPath: p.originPath,
    mimeType: p.mimeType,
    byteLength: p.byteLength == null ? null : BigInt(p.byteLength),
    originAuthor: p.originAuthor,
    originCreatedAt: p.originCreatedAt,
    originModifiedAt: p.originModifiedAt,
    originMetadata: json(p.originMetadata),
  };
}

export function createPrismaSyncStore(prisma: StorePrisma): SyncStore {
  return {
    async findOpenRuns(connectorId) {
      const runs = await prisma.gedSourceSyncRun.findMany({
        where: { connectorId, status: GedSyncRunStatus.EnCours },
        select: { gedSourceSyncRunId: true, startedAt: true },
      });
      return runs.map((r) => ({ id: r.gedSourceSyncRunId, startedAt: r.startedAt }));
    },

    async createRun(connectorId, startedAt, tokenBefore) {
      const run = await prisma.gedSourceSyncRun.create({
        data: {
          connectorId,
          status: GedSyncRunStatus.EnCours,
          startedAt,
          changeTokenBefore: tokenBefore,
        },
        select: { gedSourceSyncRunId: true },
      });
      return run.gedSourceSyncRunId;
    },

    async deleteRun(runId) {
      await prisma.gedSourceSyncRun.deleteMany({ where: { gedSourceSyncRunId: runId } });
    },

    async updateRun(runId, patch: RunPatch) {
      await prisma.gedSourceSyncRun.update({
        where: { gedSourceSyncRunId: runId },
        data: patch,
      });
    },

    async setChangeToken(connectorId, token) {
      await prisma.gedSourceConnector.update({
        where: { gedSourceConnectorId: connectorId },
        data: { changeToken: token },
      });
    },

    async updateConnector(connectorId, patch: ConnectorPatch) {
      await prisma.gedSourceConnector.update({
        where: { gedSourceConnectorId: connectorId },
        data: patch,
      });
    },

    async findItem(connectorId, externalId) {
      const r = await prisma.gedSourceItem.findUnique({
        where: { connectorId_externalId: { connectorId, externalId } },
        select: ITEM_SELECT,
      });
      return r ? toRow(r) : null;
    },

    async upsertItem(connectorId, externalId, provenance, now) {
      const data = provenanceData(provenance);
      // `originAcl` absent = on ne touche pas aux droits d'origine déjà enregistrés. Le marqueur
      // de version (`remoteVersion`) N'EST PAS écrit ici : il l'est avec l'état final, pour qu'un
      // plantage au milieu du traitement fasse rejouer l'élément au lieu de le croire à jour.
      const acl = 'originAcl' in provenance ? { originAcl: json(provenance.originAcl) } : {};
      const r = await prisma.gedSourceItem.upsert({
        where: { connectorId_externalId: { connectorId, externalId } },
        create: {
          connectorId,
          externalId,
          ...data,
          originAcl: json(provenance.originAcl ?? null),
          state: GedSourceItemState.Decouvert,
          firstSeenAt: now,
          lastSeenAt: now,
        },
        update: { ...data, ...acl, lastSeenAt: now },
        select: ITEM_SELECT,
      });
      return toRow(r);
    },

    async touchItem(itemId, now) {
      await prisma.gedSourceItem.update({
        where: { gedSourceItemId: itemId },
        data: { lastSeenAt: now },
      });
    },

    async updateItem(itemId, patch: ItemPatch) {
      const { originMetadata, ...rest } = patch;
      await prisma.gedSourceItem.update({
        where: { gedSourceItemId: itemId },
        data: {
          ...rest,
          ...(originMetadata !== undefined ? { originMetadata: json(originMetadata) } : {}),
        },
      });
    },

    async findDuplicateOriginal(contentHash, excludeItemId) {
      const r = await prisma.gedSourceItem.findFirst({
        where: {
          contentHash,
          gedSourceItemId: { not: excludeItemId },
          // Jamais un doublon ni un élément supprimé à la source : seul un contenu réellement
          // présent (copié ou indexé) peut servir d'original.
          state: { in: [GedSourceItemState.Copie, GedSourceItemState.IndexeEnPlace] },
        },
        orderBy: [{ firstSeenAt: 'asc' }, { gedSourceItemId: 'asc' }],
        select: { gedSourceItemId: true },
      });
      return r ? { id: r.gedSourceItemId } : null;
    },

    async markDeleted(connectorId, externalIds) {
      if (externalIds.length === 0) return 0;
      const res = await prisma.gedSourceItem.updateMany({
        where: {
          connectorId,
          externalId: { in: externalIds },
          state: { not: GedSourceItemState.SupprimeSource },
        },
        // La copie DocuPro (document + fichier) n'est PAS touchée : seul l'état de provenance change.
        data: { state: GedSourceItemState.SupprimeSource },
      });
      return res.count;
    },

    async listKnownItems(connectorId, states, afterId, limit) {
      const rows = await prisma.gedSourceItem.findMany({
        where: {
          connectorId,
          state: { in: states },
          ...(afterId != null ? { gedSourceItemId: { gt: afterId } } : {}),
        },
        orderBy: { gedSourceItemId: 'asc' },
        take: limit,
        select: { gedSourceItemId: true, externalId: true },
      });
      return rows.map((r) => ({ id: r.gedSourceItemId, externalId: r.externalId }));
    },
  };
}
