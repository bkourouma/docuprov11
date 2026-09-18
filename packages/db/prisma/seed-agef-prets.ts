/**
 * Seed AGEF — PRÊTS / COMMUNICATIONS DE DOCUMENTS :
 * `pnpm --filter @archivage/db db:seed:agef:prets`.
 *
 * Alimente les quatre écrans de communication, qui lisent tous la même table de DÉTAIL
 * (`lending_document_detail`) et ne se distinguent que par la date de retour :
 *  - « Historique des communications » → détails dont `returned_date` est renseignée ;
 *  - « Documents communiqués » et « Mes documents communiqués » → détails non rendus ;
 *  - un détail non rendu dont la date de retour prévue est passée s'affiche « en retard ».
 * C'est pourquoi ce seed produit les trois cas : un historique seul laisserait les autres écrans
 * vides, et un fonds sans retard ne montrerait pas la relance.
 *
 * Le RETOUR se pose au niveau du détail, pas de l'entête : un prêt de plusieurs pièces peut être
 * rendu pièce par pièce (cf. archives.prisma). La date d'entête n'est renseignée que lorsque le
 * dernier détail est rendu — même règle que `ArchivesLendingService.returnDocument`, sans quoi un
 * prêt partiellement rendu apparaîtrait à tort comme clos.
 *
 * À lancer APRÈS `db:seed:agef:acquisition` : il emprunte des documents réels du fonds.
 * Idempotent par remplacement : relancer purge les prêts existants.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const NB_PRETS = Number(process.env.NB_PRETS ?? 46);
/** Part des prêts entièrement rendus — ils alimentent « Historique des communications ». */
const PART_RENDUS = 0.72;
/** Part, parmi les prêts en cours, de ceux dont l'échéance est dépassée. */
const PART_RETARD = 0.3;

/** Graine fixe : deux exécutions produisent le même jeu de prêts. */
let graine = 20260916;
function alea(): number {
  graine = (graine * 1664525 + 1013904223) % 4294967296;
  return graine / 4294967296;
}
const piocher = <T>(xs: readonly T[]): T => xs[Math.floor(alea() * xs.length)]!;
const entre = (a: number, b: number): number => a + Math.floor(alea() * (b - a + 1));

const jours = (d: Date, n: number): Date => {
  const r = new Date(d);
  r.setUTCDate(r.getUTCDate() + n);
  return r;
};
const dateCivile = (d: Date): Date =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

/**
 * Durée de prêt attendue selon le motif. Le schéma n'attache AUCUNE durée au motif — c'est
 * volontaire, `lending_motive` ne porte qu'un libellé — mais l'agent qui saisit une date de retour
 * prévue s'appuie bien sur la nature de la démarche. On reproduit ce jugement ici plutôt que de
 * tirer une durée au hasard, sinon une consultation sur place s'étalerait sur trois mois.
 */
function dureePrevue(motif: string): number {
  if (/consultation sur place/i.test(motif)) return entre(1, 3);
  if (/copie certifiée|attestation/i.test(motif)) return entre(3, 10);
  if (/guichet unique|opération technique/i.test(motif)) return entre(7, 21);
  if (/instruction d'un dossier|recouvrement/i.test(motif)) return entre(15, 45);
  if (/justice|expertise/i.test(motif)) return entre(30, 90);
  if (/contrôle externe|audit interne|cour des comptes/i.test(motif)) return entre(20, 60);
  if (/archives|numérisation/i.test(motif)) return entre(10, 30);
  return entre(7, 30);
}

const COMMENTAIRES = [
  'Pièce remise en main propre contre décharge.',
  'Original sorti du coffre, copie de travail laissée en salle.',
  'Prolongation accordée à la demande du service demandeur.',
  'Retour constaté conforme, aucune dégradation du support.',
  'Dossier transmis complet, bordereau joint.',
  'Relance effectuée par téléphone, retour annoncé sous huitaine.',
  'Pièce restituée après audience, à reclasser au dossier client.',
];

async function main(): Promise<void> {
  const motifs = await prisma.lendingMotive.findMany({ where: { isActive: true } });
  if (!motifs.length) throw new Error('Aucun motif de prêt — lancer d’abord db:seed:agef.');

  // Bénéficiaires : la personne, via son compte-acteur. On écarte les comptes désactivés.
  const beneficiaires = await prisma.appUserGroup.findMany({
    where: { user: { isDisabled: false } },
    select: { userGroupId: true, user: { select: { username: true, fullName: true } } },
    orderBy: { userGroupId: 'asc' },
  });
  if (beneficiaires.length < 2) throw new Error('Pas assez de comptes pour simuler des prêts.');

  // On ne prête que des documents RÉELLEMENT archivés : un document encore en attente
  // d'indexation n'a pas vocation à sortir du magasin.
  const documents = await prisma.document.findMany({
    where: { isArchived: true },
    select: { documentId: true, label: true, cote: true },
    orderBy: { documentId: 'asc' },
  });
  if (documents.length < 10) throw new Error('Fonds trop petit — lancer db:seed:agef:acquisition.');

  const archiviste = beneficiaires[0]!;

  /* --- purge ------------------------------------------------------------- */
  const avant = await prisma.lendingDocument.count();
  if (avant > 0) {
    await prisma.lendingDocumentComment.deleteMany({});
    await prisma.lendingDocumentDetail.deleteMany({});
    await prisma.lendingDocument.deleteMany({});
    console.log(`  ${avant} prêt(s) précédent(s) purgé(s).`);
  }

  /* --- génération -------------------------------------------------------- */
  const aujourdhui = dateCivile(new Date());
  let rendus = 0;
  let enCours = 0;
  let enRetard = 0;
  let partiels = 0;
  let nbDetails = 0;
  let nbCommentaires = 0;
  const dejaPretes = new Set<number>();

  // « Mes documents communiqués » ne montre que les prêts du compte CONNECTÉ. Sans quota réservé,
  // le tirage aléatoire laisse cet écran vide pour le compte de démonstration — et on croit à un
  // écran cassé alors que la règle s'applique correctement.
  const QUOTA_COMPTE_DEMO = 4;
  let ouvertsCompteDemo = 0;

  for (let i = 0; i < NB_PRETS; i++) {
    const motif = piocher(motifs);
    const duree = dureePrevue(motif.label);

    // Un prêt clos peut être ancien ; un prêt en cours a forcément commencé récemment.
    const clos = alea() < PART_RENDUS;
    const retard = !clos && alea() < PART_RETARD;
    const pourCompteDemo = !clos && ouvertsCompteDemo < QUOTA_COMPTE_DEMO;
    if (pourCompteDemo) ouvertsCompteDemo += 1;
    const beneficiaire = pourCompteDemo ? archiviste : piocher(beneficiaires);
    const debut = clos
      ? jours(aujourdhui, -entre(duree + 2, 700))
      : retard
        ? jours(aujourdhui, -(duree + entre(3, 60)))
        : jours(aujourdhui, -entre(0, Math.max(1, duree - 1)));
    const echeance = jours(debut, duree);

    // 1 à 3 pièces par prêt, jamais deux fois la même pièce dans le même prêt.
    const nb = alea() < 0.62 ? 1 : entre(2, 3);
    const pieces: typeof documents = [];
    for (let k = 0; k < nb; k++) {
      const libre = documents.filter(
        (d) => !pieces.includes(d) && (clos || !dejaPretes.has(d.documentId)),
      );
      if (!libre.length) break;
      pieces.push(piocher(libre));
    }
    if (!pieces.length) continue;

    const pret = await prisma.lendingDocument.create({
      data: {
        startDate: debut,
        projectedReturnDate: echeance,
        lendingMotiveId: motif.lendingMotiveId,
        userGroupId: beneficiaire.userGroupId,
        createdBy: archiviste.userGroupId,
        createdAt: debut,
      },
    });

    // Un prêt clos peut avoir été rendu pièce par pièce : on garde ce cas, c'est précisément ce
    // que le niveau « détail » sert à représenter. Un prêt partiellement rendu apparaît alors
    // dans l'historique ET dans les prêts en cours — et c'est juste.
    const partiel = clos && pieces.length > 1 && alea() < 0.25;
    let dernierRetour: Date | null = null;
    let tousRendus = true;

    for (const [idx, piece] of pieces.entries()) {
      const rendu = clos && !(partiel && idx === pieces.length - 1);
      let dateRetour: Date | null = null;
      if (rendu) {
        // Rendu autour de l'échéance : un peu en avance le plus souvent, parfois en retard.
        const ecart = alea() < 0.7 ? -entre(0, 5) : entre(1, 25);
        dateRetour = jours(echeance, ecart);
        if (dateRetour > aujourdhui) dateRetour = jours(aujourdhui, -entre(0, 3));
        if (dateRetour < debut) dateRetour = jours(debut, 1);
        if (!dernierRetour || dateRetour > dernierRetour) dernierRetour = dateRetour;
      } else {
        tousRendus = false;
        dejaPretes.add(piece.documentId);
      }
      await prisma.lendingDocumentDetail.create({
        data: {
          lendingDocumentId: pret.lendingDocumentId,
          documentId: piece.documentId,
          returnedDate: dateRetour,
        },
      });
      nbDetails += 1;
    }

    // Le retour d'ENTÊTE n'est posé que si le dernier détail est rendu — règle du domaine.
    if (tousRendus && dernierRetour) {
      await prisma.lendingDocument.update({
        where: { lendingDocumentId: pret.lendingDocumentId },
        data: { returnedDate: dernierRetour },
      });
      rendus += 1;
    } else {
      if (partiel) partiels += 1;
      else enCours += 1;
      if (retard) enRetard += 1;
    }

    if (alea() < 0.45) {
      await prisma.lendingDocumentComment.create({
        data: {
          lendingDocumentId: pret.lendingDocumentId,
          userGroupId: archiviste.userGroupId,
          comments: piocher(COMMENTAIRES),
          createdAt: jours(debut, entre(0, Math.max(1, duree))),
        },
      });
      nbCommentaires += 1;
    }
  }

  /* --- rapport ------------------------------------------------------------ */
  const [historique, courants, total] = await Promise.all([
    prisma.lendingDocumentDetail.count({ where: { returnedDate: { not: null } } }),
    prisma.lendingDocumentDetail.count({ where: { returnedDate: null } }),
    prisma.lendingDocument.count(),
  ]);
  const retards = await prisma.lendingDocumentDetail.count({
    where: { returnedDate: null, lending: { projectedReturnDate: { lt: new Date() } } },
  });

  console.log('\n  PRÊTS ET COMMUNICATIONS AGEF :');
  console.log(`    ${total} prêts, ${nbDetails} pièces communiquées, ${nbCommentaires} commentaires`);
  console.log(`    ${historique} pièce(s) rendue(s) → « Historique des communications »`);
  console.log(`    ${courants} pièce(s) encore sortie(s) → « Documents communiqués »`);
  console.log(`    ${retards} pièce(s) en retard sur l’échéance prévue`);
  console.log(`    dont ${rendus} prêt(s) clos, ${enCours} en cours, ${partiels} partiellement rendu(s)\n`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
