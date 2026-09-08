/**
 * Seed du PLAN DE CLASSEMENT — `pnpm --filter @archivage/db db:seed:plan`.
 *
 * Plan de classement réel d'une administration, à cotation décimale (1, 1.1, 1.2 …). Complète
 * `seed-document-types.ts` et `seed-dossiers.ts` ; comme eux, ce ne sont PAS des données jetables.
 *
 * À NE PAS CONFONDRE avec les dossiers. Le dossier dit OÙ la pièce est rangée (l'unité de
 * rangement, physique ou logique) ; le plan de classement dit DE QUOI elle relève — c'est la
 * grille thématique qui porte la cote. Un même sous-dossier « Paie » peut ainsi être coté
 * 2.2 « Rémunération » ici. Les deux axes sont indépendants et le document porte les deux
 * (`document.dossier_id` et `document.plan_id`).
 *
 * Idempotent : chaque libellé est recherché parmi les éléments ACTIFS avant création, comme
 * l'exige l'index unique partiel du référentiel.
 *
 * `path` / `depth` reproduisent la convention de `HierarchyService`
 * (apps/api/src/common/hierarchy.service.ts) : racine `/{id}/` profondeur 0, enfant
 * `/{idParent}/{id}/` profondeur 1. Le calcul de sous-arbre (`path LIKE '<ancêtre>%'`) en dépend.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

interface Rubrique {
  code: string;
  label: string;
  sous: Array<{ code: string; label: string }>;
}

const PLAN: Rubrique[] = [
  {
    code: '1',
    label: 'Administration générale',
    sous: [
      { code: '1.1', label: 'Textes constitutifs et statuts' },
      { code: '1.2', label: 'Instances et organes de décision' },
      { code: '1.3', label: 'Organisation et procédures' },
      { code: '1.4', label: 'Correspondance générale' },
    ],
  },
  {
    code: '2',
    label: 'Ressources humaines',
    sous: [
      { code: '2.1', label: 'Recrutement et carrière' },
      { code: '2.2', label: 'Rémunération' },
      { code: '2.3', label: 'Temps de travail et absences' },
      { code: '2.4', label: 'Formation' },
      { code: '2.5', label: 'Dialogue social et discipline' },
    ],
  },
  {
    code: '3',
    label: 'Finances et budget',
    sous: [
      { code: '3.1', label: 'Budget et programmation' },
      { code: '3.2', label: 'Exécution des dépenses' },
      { code: '3.3', label: 'Recettes et recouvrement' },
      { code: '3.4', label: 'Comptabilité et états financiers' },
      { code: '3.5', label: 'Contrôle et audit' },
    ],
  },
  {
    code: '4',
    label: 'Commande publique',
    sous: [
      { code: '4.1', label: 'Passation des marchés' },
      { code: '4.2', label: 'Exécution et suivi des marchés' },
      { code: '4.3', label: 'Conventions et partenariats' },
    ],
  },
  {
    code: '5',
    label: 'Patrimoine et moyens généraux',
    sous: [
      { code: '5.1', label: 'Biens immobiliers' },
      { code: '5.2', label: 'Matériel et équipements' },
      { code: '5.3', label: 'Parc automobile' },
      { code: '5.4', label: 'Assurances' },
    ],
  },
  {
    code: '6',
    label: 'Affaires juridiques',
    sous: [
      { code: '6.1', label: 'Actes réglementaires' },
      { code: '6.2', label: 'Contentieux' },
      { code: '6.3', label: 'Conseil et veille juridique' },
    ],
  },
];

/**
 * Crée l'élément s'il n'existe pas, puis fixe `path` et `depth`. L'id n'étant connu qu'après
 * insertion et le chemin en dépendant, la création se fait en deux temps — comme
 * `ReferentialsService.createPlan`.
 */
async function creerElement(
  label: string,
  code: string,
  parent: { planId: number; path: string } | null,
): Promise<{ planId: number; path: string; cree: boolean }> {
  const existant = await prisma.classificationPlan.findFirst({
    where: { label, isActive: true },
    select: { planId: true, path: true },
  });
  if (existant) return { ...existant, cree: false };

  const node = await prisma.classificationPlan.create({
    data: { label, code, parentId: parent?.planId ?? null, depth: 0, path: '/' },
  });
  const base = parent && parent.path !== '/' ? parent.path : '/';
  const path = `${base}${node.planId}/`;
  const depth = path.split('/').filter(Boolean).length - 1;
  await prisma.classificationPlan.update({ where: { planId: node.planId }, data: { path, depth } });
  return { planId: node.planId, path, cree: true };
}

async function main(): Promise<void> {
  let crees = 0;
  let existants = 0;

  for (const rubrique of PLAN) {
    const parent = await creerElement(rubrique.label, rubrique.code, null);
    if (parent.cree) crees += 1;
    else existants += 1;
    console.log(`\n  ${parent.cree ? '✓' : '·'} ${rubrique.code}  ${rubrique.label}`);

    for (const sous of rubrique.sous) {
      const node = await creerElement(sous.label, sous.code, parent);
      if (node.cree) crees += 1;
      else existants += 1;
      console.log(`     ${node.cree ? '✓' : '·'} ${sous.code}  ${sous.label}`);
    }
  }

  const total = await prisma.classificationPlan.count({ where: { isActive: true } });
  console.log(
    `\n  ${crees} élément(s) créé(s)${existants ? `, ${existants} déjà présent(s)` : ''}.` +
      ` Plan de classement : ${total} élément(s) actif(s).\n`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
