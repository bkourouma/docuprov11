/**
 * Seed AGEF — remplace INTÉGRALEMENT le paramétrage Docu-Archives par celui de l'Agence de
 * Gestion Foncière de Côte d'Ivoire : `pnpm --filter @archivage/db db:seed:agef -- --confirm`.
 *
 * ⚠️ DESTRUCTIF, et volontairement pas idempotent au sens des autres seeds. Contrairement à
 * `seed-document-types.ts` & co., qui ajoutent ce qui manque, celui-ci VIDE d'abord le fonds
 * documentaire et le référentiel existants (typologie générique « administration francophone »),
 * puis pose le référentiel AGEF à la place. Le drapeau `--confirm` est exigé pour qu'un `pnpm
 * db:seed:*` lancé de mémoire ne puisse pas effacer une base de travail.
 *
 * SUPPRESSION FRANCHE plutôt que désactivation logique (`is_active = false`, geste de l'écran
 * « Types de document »). La désactivation convient pour retirer un type d'un fonds vivant, où
 * les documents déjà classés doivent continuer à pointer vers leur type. Ici on repart d'un
 * fonds vide : conserver 20 types inactifs et leurs 87 liens de métadonnées ne laisserait que du
 * bruit dans les écrans d'administration et dans les exports.
 *
 * Ce que le script NE touche pas :
 *  - les utilisateurs, rôles, profils et permissions de menu ;
 *  - les niveaux de confidentialité (déjà semés, et le rang porte la règle d'accès) ;
 *  - Docu-Courriers, hors les liaisons courrier ↔ document qui référencent les documents purgés ;
 *  - les binaires sous ARCHIVES_PATH : les lignes partent, les fichiers restent sur le disque.
 *    Ils deviennent orphelins et se purgent séparément, une fois la reprise validée.
 *
 * Sources du paramétrage : `data/agef-parametrage.json`, produit par la campagne de recherche
 * documentée dans `docs/AGEF-COLLECTE-DOCU-ARCHIVES.md`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/** Miroir de `MetaDataType` (@archivage/types) — pas d'import, pour garder le script autonome. */
const DataType: Record<string, number> = {
  Texte: 1,
  Entier: 2,
  Date: 3,
  'Texte long': 4,
  Booleen: 5,
  'Booléen': 5,
  Liste: 6,
};

interface Noeud {
  code?: string;
  label: string;
  enfants?: Noeud[];
}

interface Champ {
  label: string;
  dataType: string;
  valeurs?: string[];
}

interface TypeDoc {
  label: string;
  code: string;
  description: string;
  confidentialite: string;
  duaAnnees: number;
  conformiteAnnees: number;
  sortFinal: string;
  modeDestruction: string;
  baseLegale: string;
  dossier: string;
  plan: string;
  champs: string[];
}

interface Parametrage {
  dossiers: Noeud[];
  plan: Noeud[];
  locations: Noeud[];
  metadata: Champ[];
  types: TypeDoc[];
  motifsPret: string[];
  motifsSortie: string[];
}

const PARAM: Parametrage = JSON.parse(
  readFileSync(join(__dirname, 'data', 'agef-parametrage.json'), 'utf8'),
);

/* ========================================================================== */
/* 1. PURGE                                                                    */
/* ========================================================================== */

/**
 * L'ordre suit les clés étrangères, du plus dépendant au plus référencé.
 *
 * Deux relations imposent un passage explicite alors qu'on pourrait les croire automatiques :
 *  - `mail_document` pointe le document SANS `onDelete` (courriers.prisma) : la contrainte est
 *    donc restrictive et bloquerait la purge des documents ;
 *  - `acquisition_batch` est référencé PAR le document (`document.batch_id`), pas l'inverse :
 *    les lots se suppriment après les documents, jamais avant.
 *
 * En revanche `document_version` → `document_file`, `document_metadata_value`,
 * `document_life_cycle`, `document_permission` et `lending_document_detail` cascadent depuis
 * `document` : on les compte pour le rapport, on n'a pas à les supprimer un à un.
 */
async function purger(): Promise<void> {
  const compte = {
    documents: await prisma.document.count(),
    fichiers: await prisma.documentFile.count(),
    valeurs: await prisma.documentMetadataValue.count(),
    droits: await prisma.documentPermission.count(),
    prets: await prisma.lendingDocument.count(),
    lots: await prisma.acquisitionBatch.count(),
    types: await prisma.documentType.count(),
    metadonnees: await prisma.metaData.count(),
    dossiers: await prisma.dossier.count(),
    plan: await prisma.classificationPlan.count(),
  };
  console.log('\n  PURGE — état avant :');
  Object.entries(compte).forEach(([k, v]) => console.log(`    ${String(v).padStart(5)}  ${k}`));

  // --- fonds documentaire ---
  await prisma.mailDocument.deleteMany({});
  await prisma.mailScannedDocument.updateMany({ data: { documentId: null } });
  await prisma.lendingDocumentComment.deleteMany({});
  await prisma.lendingDocumentDetail.deleteMany({});
  await prisma.lendingDocument.deleteMany({});
  await prisma.documentAccessInquiry.deleteMany({});
  await prisma.document.deleteMany({}); // cascade : versions, fichiers, valeurs, droits, cycle de vie
  await prisma.acquisitionBatch.deleteMany({});

  // --- référentiel remplacé ---
  await prisma.metaDataDocumentType.deleteMany({});
  await prisma.metaDataListItem.deleteMany({});
  await prisma.metaData.deleteMany({});
  await prisma.documentTypePermission.deleteMany({});
  await prisma.documentTypeSetting.deleteMany({});
  await prisma.documentTypeLifeCycle.deleteMany({});
  await prisma.documentType.deleteMany({});

  // Arbres : les feuilles d'abord, sinon la clé étrangère parent_id bloque.
  await supprimerArbre('dossier');
  await supprimerArbre('classificationPlan');
  await supprimerArbre('location');

  console.log('  PURGE — terminée.');
}

/** Supprime un arbre en partant des nœuds les plus profonds. */
async function supprimerArbre(modele: 'dossier' | 'classificationPlan' | 'location'): Promise<void> {
  const table = prisma[modele] as unknown as {
    findMany(a: unknown): Promise<Array<Record<string, number>>>;
    delete(a: unknown): Promise<unknown>;
  };
  const idField = { dossier: 'dossierId', classificationPlan: 'planId', location: 'locationId' }[modele];
  const noeuds = await table.findMany({ orderBy: { depth: 'desc' }, select: { [idField]: true, depth: true } });
  for (const n of noeuds) await table.delete({ where: { [idField]: n[idField] } });
}

/* ========================================================================== */
/* 2. HIÉRARCHIES                                                              */
/* ========================================================================== */

/**
 * `path` / `depth` reproduisent la convention des chemins matérialisés de `HierarchyService`
 * (apps/api/src/common/hierarchy.service.ts) : racine `/{id}/`, enfant `/{idParent}/{id}/`.
 * Toute divergence casserait le calcul de sous-arbre, qui s'appuie sur `path LIKE '<ancêtre>%'`.
 * L'id n'étant connu qu'après insertion et le chemin en dépendant, la création se fait en deux
 * temps — exactement comme `ReferentialsService.createDossier`.
 */
async function creerArbre(
  modele: 'dossier' | 'classificationPlan' | 'location',
  noeuds: Noeud[],
  parent: { id: number; path: string } | null = null,
  index: Map<string, number> = new Map(),
): Promise<Map<string, number>> {
  const idField = { dossier: 'dossierId', classificationPlan: 'planId', location: 'locationId' }[modele];
  const table = prisma[modele] as unknown as {
    create(a: unknown): Promise<Record<string, number>>;
    update(a: unknown): Promise<unknown>;
  };
  for (const n of noeuds) {
    const data: Record<string, unknown> = { label: n.label, depth: 0, path: '/' };
    if (n.code !== undefined) data.code = n.code;
    if (parent) data.parentId = parent.id;
    const cree = await table.create({ data });
    const id = cree[idField];
    const base = parent && parent.path !== '/' ? parent.path : '/';
    const path = `${base}${id}/`;
    const depth = path.split('/').filter(Boolean).length - 1;
    await table.update({ where: { [idField]: id }, data: { path, depth } });
    index.set(n.code ?? n.label, id);
    if (n.enfants?.length) await creerArbre(modele, n.enfants, { id, path }, index);
  }
  return index;
}

/* ========================================================================== */
/* 3. SEED                                                                     */
/* ========================================================================== */

async function main(): Promise<void> {
  if (!process.argv.includes('--confirm')) {
    console.error(
      '\n  Ce script SUPPRIME le fonds documentaire et le référentiel Docu-Archives existants.\n' +
        '  Relancer avec --confirm pour l’exécuter :\n' +
        '    pnpm --filter @archivage/db db:seed:agef -- --confirm\n',
    );
    process.exitCode = 1;
    return;
  }

  await purger();

  /* --- 3.1 référentiels plats ------------------------------------------- */
  // « Tri » manque au référentiel des sorts finaux : c'est le sort des états de créances et des
  // mises en demeure, dont une partie seulement se conserve. Sans lui, tout finirait en
  // conservation définitive et l'écran « DUA expirés » n'aurait jamais rien à proposer.
  for (const label of ['Conservation définitive', 'Destruction', 'Versement aux archives', 'Tri']) {
    const existe = await prisma.finalFate.findFirst({ where: { label, isActive: true } });
    if (!existe) await prisma.finalFate.create({ data: { label } });
  }
  for (const label of ['Broyage', 'Incinération', 'Effacement numérique']) {
    const existe = await prisma.destructionMode.findFirst({ where: { label, isActive: true } });
    if (!existe) await prisma.destructionMode.create({ data: { label } });
  }

  // Les motifs de prêt génériques (« Consultation », « Contrôle », « Litige ») sont remplacés :
  // ils ne disent pas POURQUOI un original sort, or c'est cela que trace un registre de prêt.
  await prisma.lendingMotive.deleteMany({});
  for (const label of PARAM.motifsPret) await prisma.lendingMotive.create({ data: { label } });

  await prisma.dossierExitMotive.deleteMany({});
  for (const label of PARAM.motifsSortie) await prisma.dossierExitMotive.create({ data: { label } });

  /* --- 3.2 hiérarchies --------------------------------------------------- */
  const dossiers = await creerArbre('dossier', PARAM.dossiers);
  const plans = await creerArbre('classificationPlan', PARAM.plan);
  await creerArbre('location', PARAM.locations);

  /* --- 3.3 métadonnées --------------------------------------------------- */
  const champs = new Map<string, number>();
  for (const c of PARAM.metadata) {
    const dataType = DataType[c.dataType];
    if (!dataType) throw new Error(`type de donnée inconnu « ${c.dataType} » pour « ${c.label} »`);
    const cree = await prisma.metaData.create({ data: { label: c.label, dataType } });
    champs.set(c.label, cree.metaDataId);
    for (const v of c.valeurs ?? []) {
      await prisma.metaDataListItem.create({ data: { metaDataId: cree.metaDataId, label: v } });
    }
  }

  /* --- 3.4 types de document, paramétrage, cycle de vie, champs ----------- */
  const confidentialites = new Map(
    (await prisma.confidentialite.findMany()).map((c) => [c.label, c.confidentialiteId]),
  );
  const sorts = new Map((await prisma.finalFate.findMany()).map((f) => [f.label, f.finalFateId]));
  const modes = new Map(
    (await prisma.destructionMode.findMany()).map((m) => [m.label, m.destructionModeId]),
  );

  let liens = 0;
  for (const t of PARAM.types) {
    const confidentialiteId = confidentialites.get(t.confidentialite);
    if (!confidentialiteId) throw new Error(`confidentialité inconnue « ${t.confidentialite} » (${t.code})`);
    const finalFateId = sorts.get(t.sortFinal);
    if (!finalFateId) throw new Error(`sort final inconnu « ${t.sortFinal} » (${t.code})`);
    const destructionModeId = modes.get(t.modeDestruction) ?? null;
    const dossierId = dossiers.get(t.dossier);
    if (!dossierId) throw new Error(`dossier inconnu « ${t.dossier} » (${t.code})`);
    const planId = plans.get(t.plan);
    if (!planId) throw new Error(`rubrique de plan inconnue « ${t.plan} » (${t.code})`);

    const type = await prisma.documentType.create({ data: { label: t.label, code: t.code } });

    await prisma.documentTypeSetting.create({
      data: {
        documentTypeId: type.documentTypeId,
        dossierId,
        planId,
        confidentialiteId,
        // Consigne de numérisation, DOCUMENTAIRE : V6 ne pilote aucun scanner (cf. archives.prisma).
        // Elle rappelle à l'opérateur ce qu'il doit appliquer. L'OCR est demandé partout — un fonds
        // foncier ne vaut que s'il est cherchable en plein texte —, le chiffrement sur les seules
        // pièces classées Secret.
        ocr: true,
        cryptage: t.confidentialite === 'Secret',
        tauxCompression: 80,
      },
    });

    // DUA et conformité sont stockées EN MOIS (l'écran saisit en années et convertit).
    // 99 ans = 1188 mois : la colonne est un entier, il n'existe pas de valeur « illimité ».
    // C'est la convention retenue pour la chaîne du droit de propriété (lettre d'attribution,
    // ACP, ACD, titre), dont le sort final porte le sens réel : jamais éliminable.
    await prisma.documentTypeLifeCycle.create({
      data: {
        documentTypeId: type.documentTypeId,
        usefulnessLifespan: Math.round(t.duaAnnees * 12),
        complianceLifespan: Math.round(t.conformiteAnnees * 12),
        finalFateId,
        destructionModeId,
      },
    });

    for (const nom of t.champs) {
      const metaDataId = champs.get(nom);
      if (!metaDataId) throw new Error(`champ inconnu « ${nom} » (${t.code})`);
      await prisma.metaDataDocumentType.create({
        data: { documentTypeId: type.documentTypeId, metaDataId },
      });
      liens += 1;
    }
  }

  /* --- 3.5 rapport ------------------------------------------------------- */
  console.log('\n  SEED AGEF — posé :');
  console.log(`    ${await prisma.documentType.count()} types de document`);
  console.log(`    ${await prisma.documentTypeSetting.count()} paramétrages de rangement`);
  console.log(`    ${await prisma.documentTypeLifeCycle.count()} règles de cycle de vie`);
  console.log(`    ${await prisma.metaData.count()} métadonnées, ${await prisma.metaDataListItem.count()} valeurs de liste`);
  console.log(`    ${liens} associations métadonnée ↔ type`);
  console.log(`    ${await prisma.dossier.count()} dossiers, ${await prisma.classificationPlan.count()} rubriques de plan`);
  console.log(`    ${await prisma.location.count()} localisations`);
  console.log(`    ${await prisma.lendingMotive.count()} motifs de prêt, ${await prisma.dossierExitMotive.count()} motifs de sortie`);
  console.log(`    ${await prisma.finalFate.count()} sorts finaux, ${await prisma.destructionMode.count()} modes de destruction`);
  console.log(`    ${await prisma.document.count()} document(s) en base — le fonds est vide, prêt pour l'acquisition.\n`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
