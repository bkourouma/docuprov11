/**
 * Seed AGEF — FONDS DE DÉMONSTRATION : `pnpm --filter @archivage/db db:seed:agef:acquisition`.
 *
 * Crée des lots d'acquisition réalistes, chacun avec son document et son PDF sur le coffre, sur
 * le référentiel posé par `seed-agef.ts`. À lancer APRÈS lui.
 *
 * Reproduit fidèlement ce que fait le worker (`apps/worker/src/processors/ingestion.ts`) :
 * `document` + `document_version` (n° 1, courante) + `document_file`, binaire écrit sous
 * ARCHIVES_PATH au nom `{fileId}.pdf` (convention de `DiskFileStore`), texte OCR renseigné pour
 * que la recherche plein-texte réponde (index GIN `ix_document_file_ocr_tsv`).
 *
 * Il va PLUS LOIN que le worker sur un point : les documents sont ici INDEXÉS (cote, date métier,
 * année d'archivage, valeurs de métadonnées, validation). Le worker, lui, dépose des documents
 * bruts que l'agent indexe ensuite à l'écran. Un fonds de démonstration non indexé n'aurait ni
 * cycle de vie exploitable, ni recherche, ni « DUA expirées » — c'est-à-dire rien à montrer.
 *
 * DUA EXPIRÉES — le point délicat. L'écran `/archives/dua-expirees` liste les documents dont
 * `COALESCE(document_date, created_at) + DUA` est atteint (archives-compliance.service.ts). La
 * date métier est donc le seul levier : une part des documents reçoit volontairement une date
 * antérieure à sa DUA. Les types de la chaîne du droit de propriété (DUA 99 ans) n'expirent
 * jamais par construction — c'est voulu, et c'est justement ce que la démonstration doit montrer.
 *
 * Idempotent par remplacement : relancer purge d'abord les documents et lots existants.
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const ARCHIVES = resolve(process.env.ARCHIVES_PATH ?? 'D:/ARCHIVES');
const NB_LOTS = Number(process.env.NB_LOTS ?? 120);
/** Part des documents dont la date métier est reculée au-delà de leur DUA. */
const PART_EXPIREE = 0.32;
/** Pièces réservées nominativement, pour illustrer l'onglet « Accès par utilisateur ». */
const NB_RESTREINTS = 6;

/** permission_level 2 = Consultation (1 = Denied, jamais accordable). */
const CONSULTATION = 2;
/** document_state : 0 NonArchivé, 1 Archivé. */
const ETAT_NON_ARCHIVE = 0;
const ETAT_ARCHIVE = 1;

/* -------------------------------------------------------------------------- */
/* Générateur pseudo-aléatoire DÉTERMINISTE                                    */
/* -------------------------------------------------------------------------- */
/**
 * Graine fixe : deux exécutions produisent le même fonds. Sans cela, impossible de reprendre une
 * démonstration là où on l'a laissée, ni de rejouer un bug sur un document précis.
 */
let graine = 20260915;
function alea(): number {
  graine = (graine * 1664525 + 1013904223) % 4294967296;
  return graine / 4294967296;
}
const piocher = <T>(xs: readonly T[]): T => xs[Math.floor(alea() * xs.length)]!;
const entre = (a: number, b: number): number => a + Math.floor(alea() * (b - a + 1));

/* -------------------------------------------------------------------------- */
/* Données métier de démonstration                                             */
/* -------------------------------------------------------------------------- */

/** Patronymes ivoiriens plausibles — personnes FICTIVES, pour un jeu de démonstration. */
const NOMS = [
  'KOUASSI Adjoua', 'N’GUESSAN Koffi', 'TRAORÉ Mariam', 'BAMBA Souleymane', 'YAO Akissi',
  'KONÉ Fatoumata', 'DIABATÉ Ibrahim', 'ASSI Marie-Louise', 'OUATTARA Salimata', 'KOUADIO Konan',
  'GNAGNE Serge', 'TOURÉ Aminata', 'ADJÉ Bernadette', 'SORO Gnénéma', 'ZADI Blaise',
  'AKA Djédjé', 'COULIBALY Drissa', 'GBAGBO Aya', 'ANOH Kouamé', 'SYLLA Rokia',
];
const SOCIETES = [
  'SCI LES PALMIERS', 'ENTREPRISE BTP IVOIRE SARL', 'SOCIÉTÉ IMMOBILIÈRE DU BANDAMA',
  'GROUPE SIFCOM SA', 'CABINET GÉOMÈTRE AKWABA', 'ETS KOFFI ET FRÈRES',
  'COOPÉRATIVE D’HABITAT LA LAGUNE', 'SOCIÉTÉ GÉNÉRALE DE TRAVAUX PUBLICS',
];
const VILLAGES = [
  'Akouédo', 'Anonkoua-Kouté', 'M’Badon', 'Abatta', 'Adjin', 'Songon-Té', 'Niangon-Lokoa',
  'Abia-Koumassi', 'Gbamblé', 'Kouté',
];

/** Familles documentaires, déduites de la racine du dossier de rattachement. */
type Famille = 'terrain' | 'client' | 'affaire' | 'mission' | 'marche' | 'exercice' | 'agent' | 'interne';

function famille(codeDossierRacine: string): Famille {
  switch (codeDossierRacine) {
    case 'OPE': return 'terrain';
    case 'CLI': return 'client';
    case 'CTX': return 'affaire';
    case 'ING': return 'mission';
    case 'MP': return 'marche';
    case 'FIN': case 'DIR': return 'exercice';
    case 'RH': return 'agent';
    default: return 'interne';
  }
}

/**
 * Où se trouve chaque opération. Tirer la commune au sort produirait des fiches qui se
 * contredisent — « Biétry zone 4C » à Grand-Bassam —, et c'est exactement ce qu'un cadre de
 * l'AGEF repère en trois secondes. Les opérations hors district d'Abidjan, ou dont la commune
 * n'est pas établie, retombent sur la valeur ouverte du référentiel.
 */
const COMMUNE_OPERATION: Record<string, string> = {
  'Yopougon Niangon Nord': 'Yopougon',
  'Yopougon Ananeraie': 'Yopougon',
  'Yopougon Kouté': 'Yopougon',
  'Cocody II Plateaux 1re tranche': 'Cocody',
  'Cocody II Plateaux 2e tranche': 'Cocody',
  'Cocody II Plateaux 3e tranche': 'Cocody',
  'Cocody II Plateaux 4e tranche': 'Cocody',
  'Cocody II Plateaux 5e tranche': 'Cocody',
  'Cocody II Plateaux 6e tranche': 'Cocody',
  'Cocody II Plateaux 7e tranche': 'Cocody',
  'Riviera 4 Beverly Hills': 'Cocody',
  'Riviera Africaine zone 2 Golf': 'Cocody',
  'Cocody Bessikoi': 'Cocody',
  'Banco Nord tranche 1': 'Yopougon',
  'Banco Nord tranche 2': 'Yopougon',
  'Banco Nord tranche 3': 'Yopougon',
  'Banco recasement': 'Attécoubé',
  'Koumassi Nord-Est tranche 1': 'Koumassi',
  'Biétry zone 4C': 'Marcory',
  'Songon Ayiwayi': 'Songon',
  'Bingerville Blanchon': 'Bingerville',
};

/** Le district autonome d'Abidjan couvre aussi Songon, Bingerville et Anyama. */
const HORS_ABIDJAN = new Set(['Autre commune']);

interface Contexte {
  operation: string;
  commune: string;
  district: string;
  ilot: string;
  lot: string;
  superficie: number;
  tiers: string;
  tiersEstMorale: boolean;
  village: string;
  exercice: string;
  numeroDossier: string;
  numeroMarche: string;
  titreFoncier: string;
  idufci: string;
}

function contexte(operations: string[], communes: string[], districts: string[], annee: number): Contexte {
  const op = piocher(operations);
  const communeVoulue = COMMUNE_OPERATION[op] ?? 'Autre commune';
  const commune = communes.includes(communeVoulue) ? communeVoulue : (communes[0] ?? communeVoulue);
  const districtVoulu = HORS_ABIDJAN.has(commune) ? 'Autre région' : "District autonome d'Abidjan";
  const estMorale = alea() >= 0.75;
  return {
    operation: op,
    commune,
    district: districts.includes(districtVoulu) ? districtVoulu : (districts[0] ?? districtVoulu),
    tiersEstMorale: estMorale,
    ilot: String(entre(1, 240)),
    lot: String(entre(1, 980)),
    superficie: entre(250, 1200),
    tiers: estMorale ? piocher(SOCIETES) : piocher(NOMS),
    village: piocher(VILLAGES),
    exercice: String(annee),
    numeroDossier: `DOS-${annee}-${String(entre(1, 9999)).padStart(4, '0')}`,
    numeroMarche: `M-${annee}-${String(entre(1, 199)).padStart(3, '0')}`,
    titreFoncier: `TF ${entre(1000, 99999)}/${piocher(['ABJ', 'BGV', 'BSM', 'SNG'])}`,
    idufci: `CI-${String(entre(1, 99)).padStart(2, '0')}-${String(entre(1, 9999)).padStart(4, '0')}-${String(entre(1, 999)).padStart(3, '0')}`,
  };
}

/** Intitulé du document : ce que l'agent d'archives lirait sur la chemise. */
function intituler(typeLabel: string, f: Famille, c: Contexte): string {
  const court = typeLabel.length > 58 ? `${typeLabel.slice(0, 55)}…` : typeLabel;
  switch (f) {
    case 'terrain': return `${court} — Îlot ${c.ilot}, lot ${c.lot} — ${c.operation}`;
    case 'client': return `${court} — ${c.tiers} — lot ${c.lot}, ${c.operation}`;
    case 'affaire': return `${court} — Affaire ${c.tiers} — lot ${c.lot}`;
    case 'mission': return `${court} — ${c.tiers} — ${c.numeroDossier}`;
    case 'marche': return `${court} — ${c.numeroMarche}`;
    case 'exercice': return `${court} — exercice ${c.exercice}`;
    case 'agent': return `${court} — ${c.tiers}`;
    default: return `${court} — ${c.exercice}`;
  }
}

/* -------------------------------------------------------------------------- */
/* Valeurs de métadonnées                                                      */
/* -------------------------------------------------------------------------- */

interface ChampDef {
  metaDataId: number;
  label: string;
  dataType: number;
  items: Array<{ id: number; label: string }>;
}

const iso = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * Valeur d'un champ pour un document donné. Les listes sont résolues par CLÉ ÉTRANGÈRE (le
 * schéma l'exige : `document_metadata_value.metadata_list_item_id`), les autres types par une
 * chaîne normalisée — entier en base 10, date ISO — comme le prévoit `archives.prisma`.
 *
 * On cherche d'abord une valeur de liste COHÉRENTE avec le contexte (la commune du lot, son
 * opération) avant de tirer au sort : une fiche dont la commune contredit l'opération se repère
 * immédiatement en démonstration.
 */
function valeurChamp(
  champ: ChampDef,
  c: Contexte,
  dateDoc: Date,
): { value: string | null; metaDataListItemId: number | null } | null {
  if (champ.dataType === 6) {
    if (!champ.items.length) return null;
    const cible =
      champ.label === 'Commune' ? c.commune
      : champ.label === "Opération d'aménagement" ? c.operation
      : champ.label === 'District ou région' ? c.district
      // La qualité doit suivre la nature du tiers effectivement tiré, sinon une SARL se
      // retrouve « Personne physique » sur la fiche d'indexation.
      : champ.label === 'Qualité du tiers' ? (c.tiersEstMorale ? 'Personne morale' : 'Personne physique')
      : null;
    const exact = cible ? champ.items.find((i) => i.label === cible) : undefined;
    const choisi = exact ?? piocher(champ.items);
    return { value: null, metaDataListItemId: choisi.id };
  }

  const texte = ((): string | null => {
    switch (champ.label) {
      case 'Numéro de dossier': return c.numeroDossier;
      case 'Îlot': return c.ilot;
      case 'Lot de terrain': return c.lot;
      case 'Superficie (m²)': return String(c.superficie);
      case 'Contenance portée au titre': {
        const ha = Math.floor(c.superficie / 10000);
        const a = Math.floor((c.superficie % 10000) / 100);
        const ca = c.superficie % 100;
        return `${ha} ha ${String(a).padStart(2, '0')} a ${String(ca).padStart(2, '0')} ca`;
      }
      case 'Village ou communauté villageoise': return c.village;
      case 'Identifiant unique du foncier': return c.idufci;
      case 'Numéro de titre foncier': return c.titreFoncier;
      case 'Circonscription foncière compétente': return piocher(['Abidjan', 'Bingerville', 'Grand-Bassam', 'Dabou']);
      case "Référence de l'arrêté d'approbation du lotissement":
        return `Arrêté n° ${entre(100, 999)}/MCLU/DGUF du ${iso(dateDoc)}`;
      case 'Tiers concerné (nom ou raison sociale)': return c.tiers;
      case 'Signataire': return piocher(NOMS);
      case 'Numéro de référence': return `REF-${c.exercice}-${String(entre(1, 9999)).padStart(4, '0')}`;
      case 'Exercice': return c.exercice;
      case 'Numéro de marché': return c.numeroMarche;
      case 'Identifiant du compte réservataire': return `CPT-${String(entre(1, 99999)).padStart(5, '0')}`;
      case 'Montant': return String(entre(150, 95000) * 1000);
      case 'Barème de purge appliqué au mètre carré': return String(piocher([600, 750, 1000, 1500, 2000]));
      case 'Date de signature': return iso(dateDoc);
      case 'Date de réunion': return iso(dateDoc);
      case "Date d'échéance": {
        const e = new Date(dateDoc);
        e.setUTCMonth(e.getUTCMonth() + entre(6, 48));
        return iso(e);
      }
      case 'Objet': return `Dossier ${c.numeroDossier} — ${c.operation}, îlot ${c.ilot}, lot ${c.lot}.`;
      case 'Observations': return piocher([
        'Pièce versée au dossier client.',
        'Original conservé au coffre, copie de travail en salle.',
        'Dossier repris du fonds hérité, support fragile.',
        'Transmis au Guichet Unique du Foncier pour instruction.',
        'Pièce complémentaire attendue du demandeur.',
      ]);
      default: return null;
    }
  })();

  if (texte === null) return null;
  if (champ.dataType === 2 && !/^\d+$/.test(texte)) return null; // entier : refuse toute valeur non numérique
  return { value: texte, metaDataListItemId: null };
}

/* -------------------------------------------------------------------------- */
/* PDF                                                                         */
/* -------------------------------------------------------------------------- */

const ENCRE = rgb(0.09, 0.15, 0.17);
const GRIS = rgb(0.42, 0.48, 0.5);
const FILET = rgb(0.78, 0.82, 0.84);

/**
 * Une page A4 par document : bandeau AGEF, cote, libellé, puis les métadonnées effectivement
 * saisies. Le texte rendu est EXACTEMENT celui stocké dans `ocr_text` : le plein-texte doit
 * retrouver ce que l'œil lit sur la page, sans quoi la recherche mentirait.
 */
async function fabriquerPdf(
  titre: string,
  cote: string,
  typeLabel: string,
  dateDoc: Date,
  lignes: Array<[string, string]>,
): Promise<{ bytes: Uint8Array; texte: string }> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595.28, 841.89]); // A4
  const gras = await pdf.embedFont(StandardFonts.HelveticaBold);
  const normal = await pdf.embedFont(StandardFonts.Helvetica);
  const { width, height } = page.getSize();
  const M = 56;

  page.drawText('AGEF', { x: M, y: height - M, size: 20, font: gras, color: ENCRE });
  page.drawText('AGENCE DE GESTION FONCIÈRE — RÉPUBLIQUE DE CÔTE D’IVOIRE', {
    x: M, y: height - M - 15, size: 7.5, font: normal, color: GRIS,
  });
  page.drawText(cote, { x: width - M - gras.widthOfTextAtSize(cote, 10), y: height - M, size: 10, font: gras, color: ENCRE });
  page.drawLine({ start: { x: M, y: height - M - 26 }, end: { x: width - M, y: height - M - 26 }, thickness: 1, color: ENCRE });

  let y = height - M - 58;
  page.drawText(typeLabel.toUpperCase(), { x: M, y, size: 8, font: gras, color: GRIS });
  y -= 22;

  // Titre sur deux lignes au plus, coupé aux mots.
  const mots = titre.split(' ');
  let ligne = '';
  const titreLignes: string[] = [];
  for (const mot of mots) {
    const essai = ligne ? `${ligne} ${mot}` : mot;
    if (gras.widthOfTextAtSize(essai, 14) > width - 2 * M && ligne) { titreLignes.push(ligne); ligne = mot; }
    else ligne = essai;
  }
  if (ligne) titreLignes.push(ligne);
  for (const l of titreLignes.slice(0, 2)) {
    page.drawText(l, { x: M, y, size: 14, font: gras, color: ENCRE });
    y -= 19;
  }

  y -= 14;
  page.drawLine({ start: { x: M, y }, end: { x: width - M, y }, thickness: 0.5, color: FILET });
  y -= 24;

  for (const [cle, val] of lignes) {
    if (y < M + 40) break;
    page.drawText(cle.toUpperCase(), { x: M, y, size: 7, font: gras, color: GRIS });
    const texte = val.length > 72 ? `${val.slice(0, 69)}…` : val;
    page.drawText(texte, { x: M + 190, y, size: 9.5, font: normal, color: ENCRE });
    y -= 17;
  }

  const pied = `Pièce archivée — ${iso(dateDoc)} — document de démonstration`;
  page.drawText(pied, { x: M, y: M - 14, size: 7, font: normal, color: GRIS });

  const texte = [
    'AGEF — AGENCE DE GESTION FONCIÈRE — RÉPUBLIQUE DE CÔTE D’IVOIRE',
    cote, typeLabel, titre,
    ...lignes.map(([k, v]) => `${k} : ${v}`),
    pied,
  ].join('\n');

  return { bytes: await pdf.save(), texte };
}

/* -------------------------------------------------------------------------- */
/* Seed                                                                        */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  const types = await prisma.documentType.findMany({
    where: { isActive: true },
    include: {
      setting: true,
      lifeCycle: true,
      metaDatas: { include: { metaData: { include: { listItems: true } } } },
    },
  });
  if (!types.length) throw new Error('Aucun type de document actif — lancer d’abord db:seed:agef.');
  const sansRegle = types.filter((t) => !t.lifeCycle || !t.setting);
  if (sansRegle.length) throw new Error(`Types sans paramétrage ou cycle de vie : ${sansRegle.map((t) => t.code).join(', ')}`);

  // Racine du dossier de chaque type : détermine la famille documentaire et donc les libellés.
  const dossiers = await prisma.dossier.findMany({ select: { dossierId: true, code: true, path: true, depth: true } });
  const parId = new Map(dossiers.map((d) => [d.dossierId, d]));
  const racineCode = (dossierId: number | null): string => {
    if (dossierId == null) return '';
    const d = parId.get(dossierId);
    if (!d) return '';
    const premier = Number(d.path.split('/').filter(Boolean)[0]);
    return parId.get(premier)?.code ?? d.code ?? '';
  };

  const locations = await prisma.location.findMany({ where: { depth: { gte: 2 } }, select: { locationId: true, label: true } });

  /**
   * Agents « numériseurs » : le fonds est réparti entre plusieurs comptes plutôt que tout attribué
   * à l'administrateur. Un fonds entièrement créé par le même compte n'est pas seulement irréaliste,
   * il fausse la démonstration : `created_by` vaut passe-droit, sur la confidentialité comme sur les
   * droits explicites (cf. `SearchService.permissionCondition`).
   */
  const auteurs = await prisma.appUserGroup.findMany({
    where: { isDefault: true, user: { isDisabled: false } },
    orderBy: { userGroupId: 'asc' },
    take: 6,
    select: { userGroupId: true, user: { select: { username: true } } },
  });
  if (!auteurs.length) throw new Error('Aucun app_user_group : lancer le seed de base.');
  const auteur = auteurs[0]!;

  const fileType = await prisma.fileType.upsert({
    where: { extension: '.pdf' },
    update: {},
    create: { extension: '.pdf', friendlyName: 'PDF' },
    select: { fileTypeId: true },
  });

  // Valeurs de listes réellement semées, pour que le contexte reste cohérent avec le référentiel.
  const listeDe = async (label: string): Promise<string[]> => {
    const m = await prisma.metaData.findFirst({ where: { label, isActive: true }, include: { listItems: true } });
    return m?.listItems.map((i) => i.label) ?? [];
  };
  const operations = (await listeDe("Opération d'aménagement")).filter((o) => !/^Hors |^Opération à identifier/.test(o));
  const communes = await listeDe('Commune');
  const districts = await listeDe('District ou région');

  /* --- purge du fonds précédent ----------------------------------------- */
  const avant = await prisma.document.count();
  if (avant > 0) {
    await prisma.mailDocument.deleteMany({});
    await prisma.mailScannedDocument.updateMany({ data: { documentId: null } });
    await prisma.lendingDocumentDetail.deleteMany({});
    await prisma.documentAccessInquiry.deleteMany({});
    await prisma.document.deleteMany({});
    await prisma.acquisitionBatch.deleteMany({});
    console.log(`  ${avant} document(s) précédent(s) purgé(s).`);
  }
  await mkdir(ARCHIVES, { recursive: true });

  /* --- génération -------------------------------------------------------- */
  const aujourdhui = new Date();
  const cotesVues = new Set<string>();
  /** Quelques pièces réservées nominativement, pour que l'onglet « Accès par utilisateur » ait de quoi montrer. */
  const restreints: string[] = [];
  let expires = 0;
  let nonIndexes = 0;
  let valeurs = 0;
  let octets = 0;

  for (let i = 0; i < NB_LOTS; i++) {
    const type = types[i % types.length]!;
    // Créateur tournant : le fonds se répartit entre les comptes, comme une vraie équipe de numérisation.
    const createur = auteurs[i % auteurs.length]!;
    const dua = Math.round(type.lifeCycle!.usefulnessLifespan / 12);

    // Date métier. Une DUA de 99 ans ne peut pas expirer sur un fonds plausible : on ne force
    // l'ancienneté que là où elle produit une échéance réellement atteinte.
    // Le plafond suit les DUA réellement paramétrées (jusqu'à 30 ans depuis que la DUA ne peut plus
    // descendre sous la durée de conformité). Une pièce à DUA de 30 ans doit donc remonter aux
    // années 1990 pour être échue — ce qui tombe bien : c'est précisément l'âge du fonds hérité
    // de la SETU, liquidée en 1987.
    const forcerExpiration = dua <= 40 && alea() < PART_EXPIREE;
    const dateDoc = new Date(aujourdhui);
    if (forcerExpiration) {
      dateDoc.setUTCFullYear(dateDoc.getUTCFullYear() - dua - entre(1, 7));
    } else {
      dateDoc.setUTCFullYear(dateDoc.getUTCFullYear() - entre(0, 5));
    }
    dateDoc.setUTCMonth(entre(0, 11), entre(1, 28));
    const dateCivile = new Date(Date.UTC(dateDoc.getUTCFullYear(), dateDoc.getUTCMonth(), dateDoc.getUTCDate()));
    const annee = dateCivile.getUTCFullYear();

    // Échéance réelle, calculée comme le fait l'écran, pour un comptage honnête du rapport.
    const echeance = new Date(dateCivile);
    echeance.setUTCMonth(echeance.getUTCMonth() + type.lifeCycle!.usefulnessLifespan);
    const estExpire = echeance.getTime() <= aujourdhui.getTime();
    if (estExpire) expires += 1;

    const c = contexte(operations, communes, districts, annee);
    const label = intituler(type.label, famille(racineCode(type.setting!.dossierId)), c);

    let cote = `AGEF-${annee}-${String(i + 1).padStart(5, '0')}`;
    while (cotesVues.has(cote)) cote = `AGEF-${annee}-${String(entre(10000, 99999))}`;
    cotesVues.add(cote);

    // 12 % du fonds reste en attente d'indexation : un tableau de bord où tout est validé ne
    // montre pas la file de travail de l'agent.
    const indexe = alea() > 0.12;
    if (!indexe) nonIndexes += 1;

    const lot = await prisma.acquisitionBatch.create({
      data: {
        documentTypeId: type.documentTypeId,
        dossierId: type.setting!.dossierId,
        planId: type.setting!.planId,
        confidentialiteId: type.setting!.confidentialiteId,
        scannedBy: createur.userGroupId,
        scanDate: dateCivile,
        sourceLabel: `Numérisation ${type.code ?? type.label} — ${c.operation}`,
        fileCount: 1,
        documentCount: 1,
        processedFiles: 1,
        useIntercalaires: false,
        status: 1, // terminé
        createdAt: dateCivile,
      },
    });

    const document = await prisma.document.create({
      data: {
        label,
        documentTypeId: type.documentTypeId,
        planId: type.setting!.planId,
        dossierId: type.setting!.dossierId,
        confidentialiteId: type.setting!.confidentialiteId,
        locationId: locations.length ? piocher(locations).locationId : null,
        batchId: lot.batchId,
        cote,
        documentDate: dateCivile,
        archiveYear: annee,
        isArchived: indexe,
        documentState: indexe ? ETAT_ARCHIVE : ETAT_NON_ARCHIVE,
        overview: `${type.label} — ${c.operation}, îlot ${c.ilot}, lot ${c.lot}. Dossier ${c.numeroDossier}.`,
        createdBy: createur.userGroupId,
        createdAt: dateCivile,
        validatedBy: indexe ? createur.userGroupId : null,
        validatedAt: indexe ? dateCivile : null,
        versions: { create: { versionNumber: 1, isCurrent: true, createdBy: createur.userGroupId } },
      },
      include: { versions: true },
    });

    /* --- valeurs de métadonnées ----------------------------------------- */
    const lignesPdf: Array<[string, string]> = [['Date du document', iso(dateCivile)]];
    if (indexe) {
      for (const lien of type.metaDatas) {
        const champ: ChampDef = {
          metaDataId: lien.metaDataId,
          label: lien.metaData.label,
          dataType: lien.metaData.dataType,
          items: lien.metaData.listItems.map((it) => ({ id: it.metaDataListItemId, label: it.label })),
        };
        const v = valeurChamp(champ, c, dateCivile);
        if (!v) continue;
        await prisma.documentMetadataValue.create({
          data: {
            documentId: document.documentId,
            metaDataId: champ.metaDataId,
            value: v.value,
            metaDataListItemId: v.metaDataListItemId,
          },
        });
        valeurs += 1;
        const affiche = v.metaDataListItemId
          ? champ.items.find((it) => it.id === v.metaDataListItemId)!.label
          : v.value!;
        lignesPdf.push([champ.label, affiche]);
      }
    }

    /* --- fichier ---------------------------------------------------------- */
    const { bytes, texte } = await fabriquerPdf(label, cote, type.label, dateCivile, lignesPdf);
    const fichier = await prisma.documentFile.create({
      data: {
        documentVersionId: document.versions[0]!.documentVersionId,
        fileTypeId: fileType.fileTypeId,
        originalName: `${cote}.pdf`,
        fileExtension: '.pdf',
        byteLength: BigInt(bytes.length),
        pageCount: 1,
        ocrText: texte,
        sortOrder: 0,
        hash: createHash('sha256').update(bytes).digest('hex'),
        hashComputedAt: new Date(),
        createdAt: dateCivile,
      },
    });
    await writeFile(join(ARCHIVES, `${fichier.fileId}.pdf`), Buffer.from(bytes));
    octets += bytes.length;

    /**
     * AUCUN droit nominatif sur l'immense majorité du fonds — et c'est délibéré.
     *
     * Dans ce produit, `document_permission` RESTREINT : un document que ni lui ni son type ne
     * grève d'un droit en vigueur reste ouvert à tous (sous réserve de confidentialité), tandis
     * qu'une seule ligne de droit le réserve à ses bénéficiaires. Poser un droit « de confort »
     * sur chaque document au nom de son créateur revient donc à verrouiller tout le fonds sur un
     * compte : la recherche se vide pour tous les autres utilisateurs.
     *
     * Le filtrage que la démonstration doit montrer est celui de la CONFIDENTIALITÉ, qui compare
     * le rang de l'habilitation à celui du document. Il opère ici pleinement.
     */
    if (restreints.length < NB_RESTREINTS && indexe && alea() < 0.08) {
      const beneficiaire = piocher(auteurs.filter((a) => a.userGroupId !== createur.userGroupId));
      if (beneficiaire) {
        await prisma.documentPermission.create({
          data: {
            documentId: document.documentId,
            userGroupId: beneficiaire.userGroupId,
            permissionLevelId: CONSULTATION,
            grantedBy: auteur.userGroupId,
          },
        });
        restreints.push(`${cote} → ${beneficiaire.user?.username ?? beneficiaire.userGroupId}`);
      }
    }

    if ((i + 1) % 20 === 0) console.log(`    ${i + 1}/${NB_LOTS} lots…`);
  }

  /* --- rapport ------------------------------------------------------------ */
  const [nbDocs, nbLots, nbFichiers, nbValeurs] = await Promise.all([
    prisma.document.count(),
    prisma.acquisitionBatch.count(),
    prisma.documentFile.count(),
    prisma.documentMetadataValue.count(),
  ]);
  console.log('\n  FONDS DE DÉMONSTRATION AGEF :');
  console.log(`    ${nbLots} lots d’acquisition`);
  console.log(`    ${nbDocs} documents (${nbDocs - nonIndexes} indexés, ${nonIndexes} en attente)`);
  console.log(`    ${nbFichiers} PDF écrits sous ${ARCHIVES} (${(octets / 1024 / 1024).toFixed(1)} Mo)`);
  console.log(`    ${nbValeurs} valeurs de métadonnées saisies (${valeurs} posées ici)`);
  console.log(`    ${expires} document(s) à DUA échue — visibles sur /archives/dua-expirees`);
  console.log(`    réparti entre ${auteurs.length} compte(s) : ${auteurs.map((a) => a.user?.username ?? a.userGroupId).join(', ')}`);
  console.log(
    `    ${restreints.length} pièce(s) réservée(s) nominativement — le reste du fonds n’est grevé` +
      ` d’aucun droit explicite, donc visible de tous sous réserve de confidentialité :`,
  );
  restreints.forEach((r) => console.log(`      ${r}`));
  console.log();
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
