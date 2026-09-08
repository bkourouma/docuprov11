/**
 * Seed des CORRESPONDANTS Docu-Courriers — `pnpm --filter @archivage/db db:seed:correspondants`.
 *
 * Peuple les deux référentiels §16/§17 avec des organismes réels du paysage institutionnel et
 * économique ivoirien : types d'entité externe puis entités rattachées à leur type. Séparé du seed
 * de démo (`seed-demo.ts`) car ce ne sont PAS des données jetables — pas de suffixe « (démo) »,
 * elles ont vocation à rester.
 *
 * Idempotent : chaque libellé est recherché avant création, donc relançable sans doublon. Les
 * libellés déjà présents (dont « Non défini » du seed de prod) sont laissés intacts.
 *
 * E-mail et téléphone sont volontairement laissés vides : inventer des coordonnées pour des
 * organismes réels produirait des contacts faux mais crédibles. À compléter depuis l'écran
 * « Entités externes » avec les coordonnées officielles.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/** Types d'entité externe (§16) — les catégories de correspondants du courrier. */
const TYPES = [
  'Présidence de la République',
  'Primature',
  'Ministère',
  'Assemblée Nationale',
  'Sénat',
  'Institution constitutionnelle',
  'Juridiction',
  'Préfecture',
  'Collectivité territoriale',
  'Établissement public national',
  'Agence d’État',
  'Autorité de régulation',
  'Entreprise publique',
  'Société privée',
  'Banque',
  'Compagnie d’assurance',
  'Cabinet d’avocats',
  'Cabinet d’audit et de conseil',
  'Ambassade',
  'Organisation internationale',
  'Organisation non gouvernementale',
  'Établissement d’enseignement supérieur',
  'Établissement sanitaire',
  'Chambre consulaire',
  'Organisation patronale',
  'Organisation syndicale',
  'Organe de presse',
  'Institution religieuse',
  'Fournisseur / Prestataire',
  'Particulier',
] as const;

/** Entités externes (§17), rattachées à leur type par libellé. */
const ENTITES: Array<{ label: string; type: (typeof TYPES)[number] }> = [
  // Sommet de l'État et Parlement
  { label: 'Présidence de la République de Côte d’Ivoire', type: 'Présidence de la République' },
  { label: 'Cabinet du Premier Ministre', type: 'Primature' },
  { label: 'Assemblée Nationale de Côte d’Ivoire', type: 'Assemblée Nationale' },
  { label: 'Sénat de Côte d’Ivoire', type: 'Sénat' },

  // Ministères
  { label: 'Ministère de l’Économie et des Finances', type: 'Ministère' },
  { label: 'Ministère du Budget et du Portefeuille de l’État', type: 'Ministère' },
  { label: 'Ministère de la Santé et de l’Hygiène Publique', type: 'Ministère' },
  { label: 'Ministère de l’Éducation Nationale et de l’Alphabétisation', type: 'Ministère' },
  {
    label: 'Ministère de l’Enseignement Supérieur et de la Recherche Scientifique',
    type: 'Ministère',
  },
  { label: 'Ministère de l’Intérieur et de la Sécurité', type: 'Ministère' },
  { label: 'Ministère des Affaires Étrangères', type: 'Ministère' },
  { label: 'Ministère de la Fonction Publique', type: 'Ministère' },
  { label: 'Ministère de l’Équipement et de l’Entretien Routier', type: 'Ministère' },
  { label: 'Ministère de l’Agriculture et du Développement Rural', type: 'Ministère' },

  // Institutions et juridictions
  { label: 'Conseil Constitutionnel', type: 'Institution constitutionnelle' },
  { label: 'Conseil Économique, Social, Environnemental et Culturel', type: 'Institution constitutionnelle' },
  { label: 'Médiateur de la République', type: 'Institution constitutionnelle' },
  { label: 'Cour des Comptes', type: 'Juridiction' },
  { label: 'Cour Suprême', type: 'Juridiction' },

  // Administration territoriale
  { label: 'Préfecture d’Abidjan', type: 'Préfecture' },
  { label: 'District Autonome d’Abidjan', type: 'Collectivité territoriale' },
  { label: 'District Autonome de Yamoussoukro', type: 'Collectivité territoriale' },
  { label: 'Mairie de Cocody', type: 'Collectivité territoriale' },
  { label: 'Mairie de Plateau', type: 'Collectivité territoriale' },
  { label: 'Conseil Régional du Gbêkê', type: 'Collectivité territoriale' },

  // Établissements publics, agences, régulateurs
  { label: 'Caisse Nationale de Prévoyance Sociale (CNPS)', type: 'Établissement public national' },
  { label: 'Institut National de la Statistique (INS)', type: 'Établissement public national' },
  { label: 'Agence Nationale de la Salubrité Urbaine (ANASUR)', type: 'Agence d’État' },
  { label: 'Agence Nationale de la Sécurité Routière', type: 'Agence d’État' },
  {
    label: 'Autorité de Régulation des Télécommunications de Côte d’Ivoire (ARTCI)',
    type: 'Autorité de régulation',
  },
  {
    label: 'Autorité Nationale de Régulation des Marchés Publics (ANRMP)',
    type: 'Autorité de régulation',
  },

  // Entreprises publiques et sociétés
  { label: 'Compagnie Ivoirienne d’Électricité (CIE)', type: 'Entreprise publique' },
  { label: 'Société de Distribution d’Eau de Côte d’Ivoire (SODECI)', type: 'Entreprise publique' },
  { label: 'Port Autonome d’Abidjan', type: 'Entreprise publique' },
  { label: 'La Poste de Côte d’Ivoire', type: 'Entreprise publique' },
  { label: 'Orange Côte d’Ivoire', type: 'Société privée' },
  { label: 'MTN Côte d’Ivoire', type: 'Société privée' },

  // Banques et assurances
  { label: 'Banque Centrale des États de l’Afrique de l’Ouest (BCEAO)', type: 'Banque' },
  { label: 'Société Générale Côte d’Ivoire', type: 'Banque' },
  { label: 'Ecobank Côte d’Ivoire', type: 'Banque' },
  { label: 'NSIA Assurances', type: 'Compagnie d’assurance' },

  // Conseil
  { label: 'Cabinet Koffi & Associés', type: 'Cabinet d’avocats' },
  { label: 'Cabinet Diallo Audit & Conseil', type: 'Cabinet d’audit et de conseil' },

  // Diplomatie et international
  { label: 'Ambassade de France en Côte d’Ivoire', type: 'Ambassade' },
  { label: 'Ambassade du Royaume du Maroc', type: 'Ambassade' },
  { label: 'Banque Africaine de Développement (BAD)', type: 'Organisation internationale' },
  {
    label: 'Union Économique et Monétaire Ouest-Africaine (UEMOA)',
    type: 'Organisation internationale',
  },
  {
    label: 'Programme des Nations Unies pour le Développement (PNUD)',
    type: 'Organisation internationale',
  },
  { label: 'Croix-Rouge de Côte d’Ivoire', type: 'Organisation non gouvernementale' },

  // Enseignement et santé
  {
    label: 'Université Félix Houphouët-Boigny',
    type: 'Établissement d’enseignement supérieur',
  },
  {
    label: 'Institut National Polytechnique Félix Houphouët-Boigny (INP-HB)',
    type: 'Établissement d’enseignement supérieur',
  },
  { label: 'CHU de Cocody', type: 'Établissement sanitaire' },
  { label: 'CHU de Treichville', type: 'Établissement sanitaire' },

  // Corps intermédiaires et presse
  {
    label: 'Chambre de Commerce et d’Industrie de Côte d’Ivoire',
    type: 'Chambre consulaire',
  },
  {
    label: 'Confédération Générale des Entreprises de Côte d’Ivoire (CGECI)',
    type: 'Organisation patronale',
  },
  {
    label: 'Union Générale des Travailleurs de Côte d’Ivoire (UGTCI)',
    type: 'Organisation syndicale',
  },
  { label: 'Fraternité Matin', type: 'Organe de presse' },
  { label: 'Radiodiffusion Télévision Ivoirienne (RTI)', type: 'Organe de presse' },
];

async function main() {
  // ---- Types (§16) --------------------------------------------------------
  const typeIdByLabel = new Map<string, number>();
  let typesCrees = 0;
  for (const label of TYPES) {
    const existant = await prisma.externalEntityType.findFirst({ where: { label } });
    const row = existant ?? (await prisma.externalEntityType.create({ data: { label } }));
    if (!existant) typesCrees += 1;
    typeIdByLabel.set(label, row.externalEntityTypeId);
  }

  // ---- Entités (§17) ------------------------------------------------------
  let entitesCreees = 0;
  let entitesRattachees = 0;
  for (const { label, type } of ENTITES) {
    const externalEntityTypeId = typeIdByLabel.get(type);
    const existant = await prisma.externalEntity.findFirst({ where: { label } });
    if (!existant) {
      await prisma.externalEntity.create({ data: { label, externalEntityTypeId } });
      entitesCreees += 1;
      continue;
    }
    // Entité déjà là mais sans type (ou avec un autre) : on ne réécrit que le type manquant, pour
    // ne pas écraser un rattachement corrigé à la main depuis l'écran.
    if (existant.externalEntityTypeId == null) {
      await prisma.externalEntity.update({
        where: { externalEntityId: existant.externalEntityId },
        data: { externalEntityTypeId },
      });
      entitesRattachees += 1;
    }
  }

  console.log('Seed correspondants appliqué :');
  console.log(`  types créés            : ${typesCrees} (sur ${TYPES.length} attendus)`);
  console.log(`  entités créées         : ${entitesCreees} (sur ${ENTITES.length} attendues)`);
  console.log(`  entités rattachées     : ${entitesRattachees}`);
  console.log(`  total types en base    : ${await prisma.externalEntityType.count()}`);
  console.log(`  total entités en base  : ${await prisma.externalEntity.count()}`);
  console.log(
    '\nE-mail et téléphone volontairement vides : à renseigner avec les coordonnées officielles.',
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
