/**
 * Seed des MÉTADONNÉES et de leur rattachement aux types de document —
 * `pnpm --filter @archivage/db db:seed:metadata`.
 *
 * Complète le triptyque type de document / dossier / plan de classement déjà semé
 * (`seed-document-types.ts`, `seed-dossiers.ts`, `seed-type-settings.ts`) par le dernier axe du
 * formulaire d'indexation : les CHAMPS SUPPLÉMENTAIRES propres à chaque type (§7/§8).
 *
 * Conception : un jeu RÉDUIT et RÉUTILISABLE de métadonnées génériques (18), plutôt qu'un champ
 * bespoke par type — c'est la nature même de la relation many-to-many
 * (`metadata_document_type`) : « Montant » sert aussi bien au bon de commande qu'au reçu, pas la
 * peine de le dupliquer sous deux noms. Les 6 types de saisie (`MetaDataType`) sont tous
 * représentés au moins une fois, pour que l'écran « Gestion des métadonnées » les illustre tous.
 *
 * Idempotent :
 *  - métadonnées et valeurs de liste : recherchées par libellé parmi les actives avant création
 *    (même garde que `seed-document-types.ts`, exigée par l'index unique partiel) ;
 *  - liens type ↔ métadonnée : `createMany` avec `skipDuplicates`, sur l'unique
 *    `(document_type_id, metadata_id)`.
 *
 * Rattachements par défaut, modifiables ensuite depuis l'écran « Métadonnées par type de
 * document » (geste « Remplacer » pour corriger un type, « Associer » pour en ajouter en masse).
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Miroir de `MetaDataType` (@archivage/types) — pas d'import direct pour garder ce script
// autonome, comme les seeds précédents.
const DataType = { Texte: 1, Entier: 2, Date: 3, TexteLong: 4, Booleen: 5, Liste: 6 } as const;

interface Champ {
  label: string;
  dataType: number;
  /** Valeurs proposées — uniquement pour `Liste`. */
  valeurs?: string[];
}

const METADATA: Champ[] = [
  { label: 'Numéro de référence', dataType: DataType.Texte },
  { label: 'Objet', dataType: DataType.TexteLong },
  { label: 'Signataire', dataType: DataType.Texte },
  { label: 'Date de signature', dataType: DataType.Date },
  { label: 'Instance', dataType: DataType.Texte },
  { label: 'Date de réunion', dataType: DataType.Date },
  { label: 'Bénéficiaire', dataType: DataType.Texte },
  { label: 'Date de début', dataType: DataType.Date },
  { label: 'Date de fin', dataType: DataType.Date },
  { label: 'Date d’échéance', dataType: DataType.Date },
  { label: 'Destination', dataType: DataType.Texte },
  { label: 'Type de contrat', dataType: DataType.Liste, valeurs: ['CDI', 'CDD', 'Stage', 'Consultant'] },
  { label: 'Fournisseur', dataType: DataType.Texte },
  { label: 'Montant', dataType: DataType.Entier },
  { label: 'Devise', dataType: DataType.Liste, valeurs: ['XOF', 'EUR', 'USD'] },
  { label: 'Exercice', dataType: DataType.Texte },
  { label: 'Statut', dataType: DataType.Liste, valeurs: ['En cours', 'Validé', 'Clôturé', 'Annulé'] },
  { label: 'Confidentiel', dataType: DataType.Booleen },
];

/** type de document → métadonnées attendues (labels ci-dessus). */
const RATTACHEMENTS: Record<string, string[]> = {
  // --- Ressources humaines ---
  'Contrat de travail': ['Signataire', 'Date de début', 'Date de fin', 'Type de contrat', 'Bénéficiaire', 'Confidentiel'],
  'Attestation de travail': ['Bénéficiaire', 'Date de début', 'Date de fin', 'Signataire'],
  'Fiche de poste': ['Bénéficiaire', 'Objet'],
  'Bulletin de paie': ['Bénéficiaire', 'Exercice', 'Montant', 'Devise', 'Confidentiel'],
  'Demande de congé': ['Bénéficiaire', 'Date de début', 'Date de fin'],
  'Ordre de mission': ['Bénéficiaire', 'Destination', 'Date de début', 'Date de fin', 'Montant', 'Devise'],

  // --- Finances et comptabilité ---
  'Bon de commande': ['Numéro de référence', 'Fournisseur', 'Montant', 'Devise', 'Statut'],
  Devis: ['Numéro de référence', 'Fournisseur', 'Montant', 'Devise', 'Date d’échéance', 'Statut'],
  'Bon de livraison': ['Numéro de référence', 'Fournisseur'],
  Reçu: ['Numéro de référence', 'Montant', 'Devise'],
  'État financier': ['Exercice', 'Montant', 'Devise'],

  // --- Marchés publics ---
  'Dossier d’appel d’offres': ['Numéro de référence', 'Objet', 'Date d’échéance', 'Montant', 'Devise', 'Statut'],
  Convention: [
    'Numéro de référence', 'Fournisseur', 'Signataire', 'Date de début', 'Date de fin',
    'Date d’échéance', 'Montant', 'Devise', 'Statut', 'Confidentiel',
  ],

  // --- Direction et gouvernance ---
  Arrêté: ['Numéro de référence', 'Date de signature', 'Signataire', 'Objet', 'Confidentiel'],
  Décision: ['Numéro de référence', 'Date de signature', 'Signataire', 'Objet', 'Instance'],
  Circulaire: ['Numéro de référence', 'Date de signature', 'Signataire', 'Objet'],
  'Procès-verbal': ['Instance', 'Date de réunion', 'Objet'],
  'Compte rendu de réunion': ['Instance', 'Date de réunion', 'Objet'],
  'Note de service': ['Numéro de référence', 'Signataire', 'Objet'],
  'Rapport d’activité': ['Exercice', 'Instance', 'Objet'],
};

async function main(): Promise<void> {
  // ---- 1. Métadonnées + valeurs de liste --------------------------------
  const idParLabel = new Map<string, number>();
  let champsCrees = 0;
  let valeursCreees = 0;

  for (const champ of METADATA) {
    let row = await prisma.metaData.findFirst({
      where: { label: champ.label, isActive: true },
      select: { metaDataId: true, dataType: true },
    });
    if (!row) {
      row = await prisma.metaData.create({
        data: { label: champ.label, dataType: champ.dataType },
        select: { metaDataId: true, dataType: true },
      });
      champsCrees += 1;
    } else if (row.dataType !== champ.dataType) {
      await prisma.metaData.update({ where: { metaDataId: row.metaDataId }, data: { dataType: champ.dataType } });
    }
    idParLabel.set(champ.label, row.metaDataId);
    console.log(`  ✓ ${champ.label}`);

    if (champ.valeurs) {
      for (const valeur of champ.valeurs) {
        const existante = await prisma.metaDataListItem.findFirst({
          where: { metaDataId: row.metaDataId, label: valeur, isActive: true },
          select: { metaDataListItemId: true },
        });
        if (!existante) {
          await prisma.metaDataListItem.create({ data: { metaDataId: row.metaDataId, label: valeur } });
          valeursCreees += 1;
        }
      }
      console.log(`     → valeurs : ${champ.valeurs.join(', ')}`);
    }
  }

  // ---- 2. Rattachement aux types de document -----------------------------
  const types = await prisma.documentType.findMany({
    where: { isActive: true },
    select: { documentTypeId: true, label: true },
  });
  const typeIdParLabel = new Map(types.map((t) => [t.label, t.documentTypeId]));

  let liensPoses = 0;
  const manquants: string[] = [];

  for (const [typeLabel, champsLabels] of Object.entries(RATTACHEMENTS)) {
    const documentTypeId = typeIdParLabel.get(typeLabel);
    if (!documentTypeId) {
      manquants.push(`type « ${typeLabel} »`);
      continue;
    }
    const metaDataIds = champsLabels
      .map((l) => idParLabel.get(l))
      .filter((id): id is number => id !== undefined);

    const { count } = await prisma.metaDataDocumentType.createMany({
      data: metaDataIds.map((metaDataId) => ({ documentTypeId, metaDataId })),
      skipDuplicates: true,
    });
    liensPoses += count;
  }

  console.log(
    `\n  ${champsCrees} métadonnée(s) créée(s), ${valeursCreees} valeur(s) de liste créée(s).\n` +
      `  ${liensPoses} nouveau(x) lien(s) type ↔ métadonnée posé(s).`,
  );
  if (manquants.length) {
    console.log(`  ⚠ Références introuvables, non rattachées :`);
    manquants.forEach((m) => console.log(`     · ${m}`));
  }
  console.log(
    `  Total : ${await prisma.metaData.count({ where: { isActive: true } })} métadonnée(s) active(s), ` +
      `${await prisma.metaDataDocumentType.count()} association(s).\n`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
