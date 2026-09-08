/**
 * Seed du PARAMÉTRAGE DES TYPES DE DOCUMENTS — `pnpm --filter @archivage/db db:seed:type-settings`.
 *
 * Relie chaque type de document à ses DEUX AXES DE RANGEMENT :
 *  - le DOSSIER (`seed-dossiers.ts`) — où la pièce est classée ;
 *  - la rubrique du PLAN DE CLASSEMENT (`seed-classification-plan.ts`) — de quoi elle relève.
 *
 * C'est ce qui rend la correspondance opérante et pas seulement nominale : à l'indexation,
 * choisir « Bulletin de paie » pré-remplit le dossier « Paie » et la rubrique « 2.2 Rémunération ».
 * Chaque ligne reste modifiable ou supprimable depuis l'écran « Paramétrage des types de
 * documents » — ce seed pose une proposition de départ, pas une règle figée.
 *
 * PRÉREQUIS : lancer d'abord `db:seed:types`, `db:seed:dossiers` et `db:seed:plan`. Les
 * références manquantes ne sont pas inventées, elles sont signalées en fin d'exécution.
 *
 * Idempotent : upsert sur `document_type_id` (unique), donc relançable — un rattachement modifié
 * à la main sera cependant ramené à la valeur d'origine.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/** type de document → [code du dossier, cote de la rubrique du plan]. */
const RATTACHEMENTS: Array<{ type: string; dossier: string; plan: string }> = [
  // --- Ressources humaines ---
  { type: 'Contrat de travail', dossier: 'RH-PERS', plan: '2.1' },
  { type: 'Attestation de travail', dossier: 'RH-PERS', plan: '2.1' },
  { type: 'Fiche de poste', dossier: 'RH-PERS', plan: '2.1' },
  { type: 'Bulletin de paie', dossier: 'RH-PAIE', plan: '2.2' },
  { type: 'Demande de congé', dossier: 'RH-CONG', plan: '2.3' },
  { type: 'Ordre de mission', dossier: 'RH-MISS', plan: '2.3' },

  // --- Finances et comptabilité ---
  { type: 'Bon de commande', dossier: 'FIN-ACHA', plan: '3.2' },
  { type: 'Devis', dossier: 'FIN-ACHA', plan: '3.2' },
  { type: 'Bon de livraison', dossier: 'FIN-ACHA', plan: '3.2' },
  { type: 'Reçu', dossier: 'FIN-RECE', plan: '3.3' },
  { type: 'État financier', dossier: 'FIN-ETAT', plan: '3.4' },

  // --- Marchés publics ---
  { type: 'Dossier d’appel d’offres', dossier: 'MP-AO', plan: '4.1' },
  { type: 'Convention', dossier: 'MP-CONV', plan: '4.3' },

  // --- Direction et gouvernance ---
  // Les actes réglementaires relèvent des affaires juridiques (6.1), pas de l'administration
  // générale : c'est la nature de l'acte qui commande la cote, pas le service qui l'émet.
  { type: 'Arrêté', dossier: 'DIR-ACTE', plan: '6.1' },
  { type: 'Décision', dossier: 'DIR-ACTE', plan: '6.1' },
  { type: 'Circulaire', dossier: 'DIR-ACTE', plan: '6.1' },
  { type: 'Procès-verbal', dossier: 'DIR-INST', plan: '1.2' },
  { type: 'Compte rendu de réunion', dossier: 'DIR-INST', plan: '1.2' },
  { type: 'Note de service', dossier: 'DIR-NOTE', plan: '1.3' },
  // Le rapport d'activité est le document présenté aux organes de décision : 1.2, faute d'une
  // rubrique « pilotage » distincte dans le plan.
  { type: 'Rapport d’activité', dossier: 'DIR-RAPP', plan: '1.2' },
];

async function main(): Promise<void> {
  const [types, dossiers, plans] = await Promise.all([
    prisma.documentType.findMany({ where: { isActive: true }, select: { documentTypeId: true, label: true } }),
    prisma.dossier.findMany({ where: { isActive: true }, select: { dossierId: true, code: true, label: true } }),
    prisma.classificationPlan.findMany({
      where: { isActive: true },
      select: { planId: true, code: true, label: true },
    }),
  ]);

  const typeParLabel = new Map(types.map((t) => [t.label, t]));
  const dossierParCode = new Map(dossiers.filter((d) => d.code).map((d) => [d.code as string, d]));
  const planParCode = new Map(plans.filter((p) => p.code).map((p) => [p.code as string, p]));

  let poses = 0;
  const manquants: string[] = [];

  for (const r of RATTACHEMENTS) {
    const type = typeParLabel.get(r.type);
    const dossier = dossierParCode.get(r.dossier);
    const plan = planParCode.get(r.plan);

    if (!type) {
      manquants.push(`type « ${r.type} »`);
      continue;
    }
    if (!dossier) {
      manquants.push(`dossier [${r.dossier}] pour « ${r.type} »`);
      continue;
    }
    if (!plan) {
      manquants.push(`rubrique ${r.plan} pour « ${r.type} »`);
      continue;
    }

    await prisma.documentTypeSetting.upsert({
      where: { documentTypeId: type.documentTypeId },
      create: { documentTypeId: type.documentTypeId, dossierId: dossier.dossierId, planId: plan.planId },
      update: { dossierId: dossier.dossierId, planId: plan.planId },
    });
    poses += 1;
    console.log(`  ✓ ${r.type.padEnd(26)} → ${dossier.label}  |  ${r.plan} ${plan.label}`);
  }

  console.log(`\n  ${poses} type(s) rattaché(s) sur ${RATTACHEMENTS.length}.`);
  if (manquants.length) {
    console.log(`  ⚠ Références introuvables, non rattachées :`);
    manquants.forEach((m) => console.log(`     · ${m}`));
    console.log(`    Lancez d'abord db:seed:types, db:seed:dossiers et db:seed:plan.`);
  }
  console.log(`  Paramétrages en base : ${await prisma.documentTypeSetting.count()}.\n`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
