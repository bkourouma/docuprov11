import {
  canonicalSealPayload,
  loadOrCreateSealingKey,
  resolveKeyPath,
  sealTimestamp,
  signPayload,
  SEAL_ALGORITHM,
  type SealingKey,
} from '@archivage/sealing';
import { prisma } from '../db';
import { logger } from '../logger';

/**
 * Clé de l'installation, chargée une fois pour la durée de vie du worker.
 *
 * Le worker tourne des semaines : relire le PEM à chaque document serait un gaspillage, et la clé
 * ne change pas en cours de route. La promesse elle-même est mise en cache — deux documents
 * ingérés en parallèle ne doivent pas déclencher deux générations concurrentes de la MÊME clé
 * absente, ce qui laisserait un cachet signé par une clé aussitôt écrasée.
 */
let clePromise: Promise<SealingKey> | null = null;

function cle(archivesPath: string): Promise<SealingKey> {
  clePromise ??= loadOrCreateSealingKey(
    resolveKeyPath({ SEALING_KEY_PATH: process.env.SEALING_KEY_PATH, ARCHIVES_PATH: archivesPath }),
    (msg) => logger.warn(msg),
  );
  return clePromise;
}

/**
 * Appose le cachet sur un document fraîchement ingéré (2026-09-15).
 *
 * Pourquoi dès l'ingestion et non à la validation de l'indexation : la charge signée ne couvre que
 * les EMPREINTES DES BINAIRES, jamais les métadonnées. Indexer, classer ou renommer un document ne
 * l'invalide donc pas. Attendre la validation laissait au contraire une fenêtre — de quelques
 * heures à plusieurs semaines — pendant laquelle la pièce était mesurable mais attestée par
 * personne. Sceller ici ferme cette fenêtre : le document est couvert dès la seconde où il entre
 * au coffre.
 *
 * Le scellement n'est JAMAIS bloquant pour l'acquisition : un lot de documents correctement
 * numérisés et rangés ne doit pas être mis en échec parce que la clé est illisible. L'échec est
 * journalisé, le document reste vérifiable par son empreinte, et le scellement en lot de l'écran
 * « Intégrité du fonds » le rattrapera.
 */
export async function sealFreshDocument(documentId: number, archivesPath: string): Promise<void> {
  try {
    const version = await prisma.documentVersion.findFirst({
      where: { documentId, isCurrent: true },
      select: { files: { select: { fileId: true, hash: true } } },
    });
    const files = version?.files ?? [];
    // Sans empreinte, il n'y a rien à attester : `empreinte()` la pose à la création, donc ce cas
    // ne devrait pas se produire — on le traite plutôt que de signer une charge vide.
    if (files.length === 0 || files.some((f) => !f.hash)) {
      logger.warn({ documentId }, 'scellement ignoré : empreinte de référence manquante');
      return;
    }

    const key = await cle(archivesPath);
    const sealedAt = sealTimestamp(new Date());
    const payload = canonicalSealPayload({
      documentId,
      files: files.map((f) => ({ fileId: f.fileId, hash: f.hash! })),
      sealedAt,
    });

    await prisma.documentSeal.upsert({
      where: { documentId },
      create: {
        documentId,
        algorithm: SEAL_ALGORITHM,
        keyFingerprint: key.fingerprint,
        payload,
        signature: signPayload(payload, key.privateKey),
        sealedAt,
        // `sealedBy` reste nul : le cachet est posé par la CHAÎNE D'ACQUISITION, pas par une
        // personne. Lui attribuer l'agent qui a déposé le lot laisserait croire à un geste humain
        // d'attestation qui n'a pas eu lieu.
        sealedBy: null,
      },
      update: {
        algorithm: SEAL_ALGORITHM,
        keyFingerprint: key.fingerprint,
        payload,
        signature: signPayload(payload, key.privateKey),
        sealedAt,
        sealedBy: null,
      },
    });
    logger.debug({ documentId }, 'cachet apposé à l’ingestion');
  } catch (err) {
    logger.error(
      { documentId, err: err instanceof Error ? err.message : String(err) },
      'scellement à l’ingestion impossible — le document reste vérifiable par son empreinte',
    );
  }
}
