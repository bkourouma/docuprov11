import { Prisma } from '@prisma/client';

/** Sous-ensemble du client transactionnel nécessaire aux verrous de ligne. */
export type LockDb = Pick<Prisma.TransactionClient, '$queryRaw'>;

/**
 * Verrous de ligne (`SELECT … FOR UPDATE`) pris dans la transaction de validation, AVANT tout comptage ou
 * contrôle de doublon : le moteur sérialise les transitions d'UNE instance, pas deux instances (ou deux
 * valideurs) qui visent le même courrier ou la même imputation. Sous READ COMMITTED, la seconde transaction
 * attend la fin de la première, puis relit les lignes validées : plafonds et doublons sont alors fiables.
 *
 * ORDRE FIXE à respecter partout : courrier PUIS imputation (évite les interblocages).
 * Requêtes paramétrées (`Prisma.sql`), jamais de concaténation. Un identifiant inconnu ne verrouille rien
 * (aucune erreur : le contrôle d'existence reste à l'appelant).
 */
export async function lockMailRow(db: LockDb, mailId: number): Promise<void> {
  await db.$queryRaw(Prisma.sql`SELECT mail_id FROM mail WHERE mail_id = ${mailId} FOR UPDATE`);
}

export async function lockMailInputationRow(db: LockDb, mailInputationId: number): Promise<void> {
  await db.$queryRaw(
    Prisma.sql`SELECT mail_inputation_id FROM mail_inputation WHERE mail_inputation_id = ${mailInputationId} FOR UPDATE`,
  );
}
