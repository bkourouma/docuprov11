/**
 * Seed des CYCLES DE VIE PAR TYPE DE DOCUMENT — `pnpm --filter @archivage/db db:seed:life-cycles`.
 *
 * Propose, pour chacun des 20 types de document (`seed-document-types.ts`), une durée de
 * CONFORMITÉ (l'obligation légale/réglementaire de conservation) et une durée d'UTILITÉ
 * ADMINISTRATIVE — DUA — (la période d'usage courant avant que le document ne quitte le service
 * producteur), ainsi qu'un sort final ET un mode de destruction — les deux sont TOUJOURS
 * renseignés, y compris pour un « Versement aux archives » : ce sort n'est que la destination
 * immédiate à l'issue de la DUA (transfert au service d'archives), pas une garantie de
 * conservation éternelle ; le mode posé ici est celui qui s'appliquerait si l'archives, au terme
 * de sa propre durée de conservation, décide à son tour d'éliminer le document.
 *
 * ==========================================================================================
 * SOURCES ET LIMITES — À LIRE avant de considérer ces valeurs comme définitives
 * ==========================================================================================
 *
 * Le périmètre de l'application (cf. `seed-correspondants.ts`) est le paysage institutionnel
 * ivoirien. Les recherches menées pour ce seed n'ont pas permis de retrouver le texte détaillé
 * de la loi ivoirienne sur les archives (loi n° 94-427) ni la section « archivage » du Code
 * ivoirien des marchés publics — ces deux points auraient dû fixer directement certaines des
 * valeurs ci-dessous. À DÉFAUT, les durées de CONFORMITÉ s'appuient sur le socle juridique le
 * mieux documenté et directement applicable ou transposable au contexte ivoirien :
 *
 *  1. Droit comptable OHADA (Acte uniforme relatif au droit comptable et à l'information
 *     financière, AUDCIF) — la Côte d'Ivoire est État partie à l'OHADA, ce texte s'y applique
 *     directement. Il fixe à 10 ANS la conservation des livres comptables et pièces
 *     justificatives. Utilisé pour tout document qui sert de pièce justificative comptable
 *     (bons de commande/livraison, reçus, états financiers, ordres de mission générant une
 *     dépense). Source : https://www.ohada.org/en/uniform-act-relating-to-accounting-law-and-financial-information-audcif/
 *
 *  2. Pratique RH francophone (droit du travail français, largement repris comme référence de
 *     place dans l'espace OHADA à défaut de texte ivoirien plus précis disponible) — 5 ANS après
 *     le départ du salarié pour le dossier individuel (contrat, attestations, évaluations).
 *     Aucune durée minimale légale ivoirienne spécifique n'a été retrouvée pour le bulletin de
 *     paie ; la pratique usuelle relevée (jusqu'à 10 ans, alignée sur la règle comptable OHADA
 *     puisque le bulletin est une pièce justificative de paie) a été retenue par prudence.
 *     Sources : https://www.latribudesexperts.fr/durees-legales-conservation-documents-rh/ ,
 *     https://savetime.fr/archivage-documents-du-personnel/
 *
 *  3. Science archivistique francophone (DUA / tableaux de gestion, CDG86, CNIL) — c'est le
 *     cadre conceptuel même dont ce module reprend le vocabulaire (DUA, sort final). Les actes
 *     à portée normative ou décisionnelle (arrêtés, décisions, circulaires, PV, comptes rendus
 *     d'instances, rapports d'activité) y sont typiquement voués à une conservation de très
 *     longue durée puis au versement aux archives — non « éliminables » à terme fixe. Notre
 *     colonne étant un entier (des mois), ce « long terme » est représenté par un plafond
 *     conventionnel de 30 ANS plutôt qu'une valeur réellement illimitée ; c'est le SORT FINAL
 *     (« Versement aux archives ») qui porte le sens réel, pas le chiffre.
 *     Sources : https://www.cdg86.fr (tableaux de gestion), https://www.cnil.fr/sites/cnil/files/atoms/files/guide_durees_de_conservation.pdf
 *
 *  4. Marchés publics — en l'absence du texte ivoirien retrouvé, la disposition analogue du
 *     Code de la commande publique français (5 ans fournitures/services, 10 ans travaux) sert de
 *     repère, avec 5 ans retenu par défaut (le marché-type le plus courant).
 *
 * CE SONT DES VALEURS PAR DÉFAUT, PAS DES CITATIONS LÉGALES IVOIRIENNES VÉRIFIÉES POINT PAR
 * POINT. Chacune reste modifiable depuis l'écran « Cycles de vie des documents » ; ce seed ne
 * fait que poser un point de départ raisonnable et sourcé plutôt que des zéros. À faire
 * confirmer par le service juridique/archives de l'organisation avant toute campagne réelle
 * d'épuration — c'est justement ce que permet l'écran « DUA expirés » : rien n'est détruit tant
 * qu'un opérateur ne valide pas la sélection.
 *
 * La DUA (usage courant), elle, n'est par nature pas fixée par un texte externe — c'est un choix
 * de gestion interne. Les valeurs ci-dessous suivent la convention courante « DUA ≤ conformité »
 * (usage courant plus court que l'obligation légale globale).
 *
 * Idempotent : upsert sur `document_type_id` (unique) — un réglage déjà modifié à la main sera
 * cependant ramené à ces valeurs par défaut si ce script est relancé.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

type Sort = 'Destruction' | 'Versement aux archives';

interface Regle {
  type: string;
  duaAnnees: number;
  conformiteAnnees: number;
  sort: Sort;
  /**
   * Mode appliqué le jour où le document quitte définitivement le système — y compris pour un
   * « Versement aux archives » : ce sort final est la destination immédiate (transfert au
   * service d'archives à l'issue de la DUA), pas une garantie de conservation éternelle. Le
   * document y est réévalué à son tour ; le mode de destruction ici est celui qui s'appliquera
   * si l'archives, après sa propre durée de conservation, décide de l'éliminer.
   */
  destruction: string;
  /** Rappel bref de la source retenue, affiché dans le journal du seed. */
  base: string;
}

const REGLES: Regle[] = [
  // --- Ressources humaines --- (RH #2, cf. sources §2)
  { type: 'Contrat de travail', duaAnnees: 3, conformiteAnnees: 5, sort: 'Destruction', destruction: 'Broyage', base: 'RH — 5 ans après départ' },
  { type: 'Attestation de travail', duaAnnees: 3, conformiteAnnees: 5, sort: 'Destruction', destruction: 'Broyage', base: 'RH — 5 ans après délivrance' },
  { type: 'Fiche de poste', duaAnnees: 3, conformiteAnnees: 5, sort: 'Destruction', destruction: 'Broyage', base: 'RH — 5 ans (dossier individuel)' },
  { type: 'Bulletin de paie', duaAnnees: 5, conformiteAnnees: 10, sort: 'Destruction', destruction: 'Broyage', base: 'OHADA — pièce justificative de paie, 10 ans' },
  { type: 'Demande de congé', duaAnnees: 2, conformiteAnnees: 5, sort: 'Destruction', destruction: 'Broyage', base: 'RH — 5 ans (dossier individuel)' },
  { type: 'Ordre de mission', duaAnnees: 3, conformiteAnnees: 10, sort: 'Destruction', destruction: 'Broyage', base: 'OHADA — pièce justificative de dépense, 10 ans' },

  // --- Finances et comptabilité --- (OHADA AUDCIF, cf. sources §1)
  { type: 'Bon de commande', duaAnnees: 3, conformiteAnnees: 10, sort: 'Destruction', destruction: 'Broyage', base: 'OHADA — pièce comptable, 10 ans' },
  { type: 'Devis', duaAnnees: 2, conformiteAnnees: 5, sort: 'Destruction', destruction: 'Broyage', base: 'Correspondance commerciale — 5 ans' },
  { type: 'Bon de livraison', duaAnnees: 3, conformiteAnnees: 10, sort: 'Destruction', destruction: 'Broyage', base: 'OHADA — pièce comptable, 10 ans' },
  { type: 'Reçu', duaAnnees: 3, conformiteAnnees: 10, sort: 'Destruction', destruction: 'Broyage', base: 'OHADA — pièce comptable, 10 ans' },
  { type: 'État financier', duaAnnees: 5, conformiteAnnees: 10, sort: 'Versement aux archives', destruction: 'Broyage', base: 'OHADA — 10 ans minimum, valeur institutionnelle durable' },

  // --- Marchés publics --- (cf. sources §4, repère français par défaut)
  { type: 'Dossier d’appel d’offres', duaAnnees: 3, conformiteAnnees: 5, sort: 'Destruction', destruction: 'Broyage', base: 'Marché fournitures/services — 5 ans (repère)' },
  { type: 'Convention', duaAnnees: 5, conformiteAnnees: 10, sort: 'Versement aux archives', destruction: 'Broyage', base: 'Engagement contractuel durable — 10 ans (repère)' },

  // --- Direction et gouvernance --- (actes normatifs, cf. sources §3)
  { type: 'Arrêté', duaAnnees: 5, conformiteAnnees: 30, sort: 'Versement aux archives', destruction: 'Broyage', base: 'Acte réglementaire — valeur archivistique durable' },
  { type: 'Décision', duaAnnees: 5, conformiteAnnees: 30, sort: 'Versement aux archives', destruction: 'Broyage', base: 'Acte réglementaire — valeur archivistique durable' },
  { type: 'Circulaire', duaAnnees: 5, conformiteAnnees: 30, sort: 'Versement aux archives', destruction: 'Broyage', base: 'Acte réglementaire — valeur archivistique durable' },
  { type: 'Procès-verbal', duaAnnees: 5, conformiteAnnees: 30, sort: 'Versement aux archives', destruction: 'Broyage', base: 'Acte d’instance — valeur archivistique durable' },
  { type: 'Compte rendu de réunion', duaAnnees: 5, conformiteAnnees: 30, sort: 'Versement aux archives', destruction: 'Broyage', base: 'Acte d’instance — valeur archivistique durable' },
  { type: 'Note de service', duaAnnees: 2, conformiteAnnees: 5, sort: 'Destruction', destruction: 'Broyage', base: 'Note interne courante — durée courte' },
  { type: 'Rapport d’activité', duaAnnees: 5, conformiteAnnees: 30, sort: 'Versement aux archives', destruction: 'Broyage', base: 'Mémoire institutionnelle — valeur durable' },
];

async function main(): Promise<void> {
  const [types, fates, modes] = await Promise.all([
    prisma.documentType.findMany({ where: { isActive: true }, select: { documentTypeId: true, label: true } }),
    prisma.finalFate.findMany({ where: { isActive: true }, select: { finalFateId: true, label: true } }),
    prisma.destructionMode.findMany({ where: { isActive: true }, select: { destructionModeId: true, label: true } }),
  ]);
  const typeParLabel = new Map(types.map((t) => [t.label, t]));
  const fateParLabel = new Map(fates.map((f) => [f.label, f]));
  const modeParLabel = new Map(modes.map((m) => [m.label, m]));

  let poses = 0;
  const manquants: string[] = [];

  for (const r of REGLES) {
    const type = typeParLabel.get(r.type);
    const fate = fateParLabel.get(r.sort);
    const mode = modeParLabel.get(r.destruction);

    if (!type) {
      manquants.push(`type « ${r.type} »`);
      continue;
    }
    if (!fate) {
      manquants.push(`sort final « ${r.sort} » pour « ${r.type} »`);
      continue;
    }
    if (!mode) {
      manquants.push(`mode de destruction « ${r.destruction} » pour « ${r.type} »`);
      continue;
    }

    await prisma.documentTypeLifeCycle.upsert({
      where: { documentTypeId: type.documentTypeId },
      create: {
        documentTypeId: type.documentTypeId,
        usefulnessLifespan: r.duaAnnees * 12,
        complianceLifespan: r.conformiteAnnees * 12,
        finalFateId: fate.finalFateId,
        destructionModeId: mode.destructionModeId,
      },
      update: {
        usefulnessLifespan: r.duaAnnees * 12,
        complianceLifespan: r.conformiteAnnees * 12,
        finalFateId: fate.finalFateId,
        destructionModeId: mode.destructionModeId,
      },
    });
    poses += 1;
    console.log(
      `  ✓ ${r.type.padEnd(26)} DUA=${String(r.duaAnnees).padStart(2)} ans  conformité=${String(r.conformiteAnnees).padStart(2)} ans  → ${r.sort}  (${r.base})`,
    );
  }

  console.log(`\n  ${poses} règle(s) posée(s) sur ${REGLES.length}.`);
  if (manquants.length) {
    console.log(`  ⚠ Références introuvables, non posées :`);
    manquants.forEach((m) => console.log(`     · ${m}`));
  }
  console.log(`  Règles en base : ${await prisma.documentTypeLifeCycle.count()}.`);
  console.log(
    `  ⚠ Durées par défaut, sourcées mais NON VÉRIFIÉES texte par texte pour la Côte d'Ivoire —\n` +
      `    voir l'en-tête de ce fichier. À valider par le service juridique/archives.\n`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
