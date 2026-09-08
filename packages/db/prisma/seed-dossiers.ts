/**
 * Seed des DOSSIERS d'archive — `pnpm --filter @archivage/db db:seed:dossiers`.
 *
 * Plan de rangement réel d'une administration, calqué sur la typologie documentaire de
 * `seed-document-types.ts` : quatre dossiers racines (les quatre domaines de gestion) et leurs
 * sous-dossiers. Comme le seed des types, ce ne sont PAS des données jetables.
 *
 * Ce script ne crée QUE l'arborescence. Le rattachement des types de documents à leur dossier
 * (et à leur rubrique de plan de classement) est l'affaire de `seed-type-settings.ts` : il porte
 * les deux axes de rangement à la fois, les tenir en deux endroits les ferait diverger.
 *
 * Idempotent : chaque libellé est recherché parmi les dossiers ACTIFS avant création, comme
 * l'exige l'index unique partiel `ux_dossier_label_active`.
 *
 * `path` / `depth` reproduisent la convention des chemins matérialisés de `HierarchyService`
 * (apps/api/src/common/hierarchy.service.ts) : racine `/{id}/` à la profondeur 0, enfant
 * `/{idParent}/{id}/` à la profondeur 1. Toute divergence casserait le calcul de sous-arbre
 * (suppression en cascade, déplacement), qui s'appuie sur `path LIKE '<ancêtre>%'`.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

interface Racine {
  label: string;
  code: string;
  enfants: Array<{ label: string; code: string }>;
}

const ARBORESCENCE: Racine[] = [
  {
    label: 'Ressources humaines',
    code: 'RH',
    enfants: [
      { label: 'Dossiers individuels du personnel', code: 'RH-PERS' },
      { label: 'Paie', code: 'RH-PAIE' },
      { label: 'Congés et absences', code: 'RH-CONG' },
      { label: 'Missions et déplacements', code: 'RH-MISS' },
    ],
  },
  {
    label: 'Finances et comptabilité',
    code: 'FIN',
    enfants: [
      { label: 'Achats et commandes', code: 'FIN-ACHA' },
      { label: 'Recettes et règlements', code: 'FIN-RECE' },
      { label: 'États financiers', code: 'FIN-ETAT' },
    ],
  },
  {
    label: 'Marchés publics',
    code: 'MP',
    enfants: [
      { label: 'Appels d’offres', code: 'MP-AO' },
      { label: 'Conventions et contrats', code: 'MP-CONV' },
    ],
  },
  {
    label: 'Direction et gouvernance',
    code: 'DIR',
    enfants: [
      { label: 'Actes réglementaires', code: 'DIR-ACTE' },
      { label: 'Instances et réunions', code: 'DIR-INST' },
      { label: 'Notes de service', code: 'DIR-NOTE' },
      { label: 'Rapports d’activité', code: 'DIR-RAPP' },
    ],
  },
];

/**
 * Crée le dossier s'il n'existe pas, puis fixe son `path` et sa `depth`. L'id n'étant connu
 * qu'après insertion et le chemin en dépendant, la création se fait en deux temps — c'est
 * exactement ce que fait `ReferentialsService.createDossier`.
 */
async function creerDossier(
  label: string,
  code: string,
  parent: { dossierId: number; path: string } | null,
): Promise<{ dossierId: number; path: string; cree: boolean }> {
  const existant = await prisma.dossier.findFirst({
    where: { label, isActive: true },
    select: { dossierId: true, path: true },
  });
  if (existant) return { ...existant, cree: false };

  const node = await prisma.dossier.create({
    data: { label, code, parentId: parent?.dossierId ?? null, depth: 0, path: '/' },
  });
  const base = parent && parent.path !== '/' ? parent.path : '/';
  const path = `${base}${node.dossierId}/`;
  const depth = path.split('/').filter(Boolean).length - 1;
  await prisma.dossier.update({ where: { dossierId: node.dossierId }, data: { path, depth } });
  return { dossierId: node.dossierId, path, cree: true };
}

async function main(): Promise<void> {
  let crees = 0;
  let existants = 0;

  for (const racine of ARBORESCENCE) {
    const parent = await creerDossier(racine.label, racine.code, null);
    if (parent.cree) crees += 1;
    else existants += 1;
    console.log(`\n  ${parent.cree ? '✓' : '·'} ${racine.label}  [${racine.code}]`);

    for (const enfant of racine.enfants) {
      const node = await creerDossier(enfant.label, enfant.code, parent);
      if (node.cree) crees += 1;
      else existants += 1;
      console.log(`     ${node.cree ? '✓' : '·'} ${enfant.label}  [${enfant.code}]`);
    }
  }

  console.log(
    `\n  ${crees} dossier(s) créé(s)${existants ? `, ${existants} déjà présent(s)` : ''}.` +
      ` Arborescence : ${await prisma.dossier.count({ where: { isActive: true } })} dossier(s) actif(s).\n`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
