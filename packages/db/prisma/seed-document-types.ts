/**
 * Seed des TYPES DE DOCUMENT — `pnpm --filter @archivage/db db:seed:types`.
 *
 * Typologie documentaire réelle d'une administration / institution francophone, organisée par
 * domaine de gestion. Séparé du seed de démo (`seed-demo.ts`) car ce ne sont PAS des données
 * jetables : pas de suffixe « (démo) », elles ont vocation à rester et à porter de vrais
 * documents. Même parti pris que `seed-correspondants.ts`.
 *
 * Idempotent : chaque libellé est recherché parmi les types ACTIFS avant création, donc
 * relançable sans doublon. C'est aussi ce qu'exige l'index unique partiel
 * `ux_document_type_label_active` — sans ce contrôle, une seconde exécution échouerait sur une
 * violation de contrainte au lieu de ne rien faire.
 *
 * Les trois types déjà en base (« Facture », « Contrat », « Courrier », issus du seed de prod)
 * sont laissés intacts : ce sont eux aussi des types légitimes, ils complètent cette liste.
 *
 * Le champ `code` est volontairement laissé vide. L'écran « Types de document » ne gère que le
 * libellé : un code posé ici ne serait ni visible ni modifiable, et tout type créé ensuite depuis
 * l'interface n'en aurait pas — le référentiel deviendrait incohérent. À remplir le jour où
 * l'écran exposera la colonne.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Regroupés par domaine pour la relecture ; l'ordre d'insertion n'a pas d'importance, l'écran
 * trie par libellé.
 */
const DOCUMENT_TYPES: Array<{ domaine: string; libelles: string[] }> = [
  {
    domaine: 'Achats et dépenses',
    libelles: ['Bon de commande', 'Bon de livraison', 'Devis', 'Reçu'],
  },
  {
    domaine: 'Ressources humaines',
    libelles: [
      'Contrat de travail',
      'Bulletin de paie',
      'Ordre de mission',
      'Demande de congé',
      'Attestation de travail',
      'Fiche de poste',
    ],
  },
  {
    domaine: 'Actes et gouvernance',
    libelles: [
      'Note de service',
      'Compte rendu de réunion',
      'Procès-verbal',
      'Décision',
      'Arrêté',
      'Circulaire',
      'Convention',
    ],
  },
  {
    domaine: 'Marchés et pilotage',
    libelles: ["Dossier d’appel d’offres", 'Rapport d’activité', 'État financier'],
  },
];

async function main(): Promise<void> {
  let crees = 0;
  const ignores: string[] = [];

  for (const { domaine, libelles } of DOCUMENT_TYPES) {
    console.log(`\n  ${domaine}`);
    for (const label of libelles) {
      const existant = await prisma.documentType.findFirst({ where: { label, isActive: true } });
      if (existant) {
        ignores.push(label);
        console.log(`   · ${label} — déjà présent`);
        continue;
      }
      await prisma.documentType.create({ data: { label } });
      crees += 1;
      console.log(`   ✓ ${label}`);
    }
  }

  const total = await prisma.documentType.count({ where: { isActive: true } });
  console.log(
    `\n  ${crees} type(s) créé(s)${ignores.length ? `, ${ignores.length} déjà présent(s)` : ''}.` +
      ` Référentiel : ${total} type(s) actif(s).\n`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
