/**
 * Seed de DÉMONSTRATION du TABLEAU DE BORD Docu-Courriers (lot D2).
 *   Peupler   : `pnpm --filter @archivage/db db:seed:dashboard`
 *   Nettoyer  : `pnpm --filter @archivage/db db:seed:dashboard -- --clean`
 *
 * POURQUOI. La base ne contient qu'une poignée de courriers : à ce volume, ni le rendu des
 * widgets, ni la pertinence des seuils, ni les performances ne sont jugeables, et les arbitrages
 * du plan restent théoriques. Ce seed produit un jeu de ~200 courriers dont la **distribution est
 * construite pour exercer chaque KPI**, y compris les cas limites que des données aléatoires
 * rateraient (courriers sans échéance, imputations en retard jamais relancées, correspondants en
 * doublon, objets sans durée de suivi).
 *
 * PÉRIMÈTRE. Ce seed ne crée QUE des courriers et leurs dépendances directes. Il s'appuie sur les
 * acteurs, rôles, organigrammes et référentiels déjà posés par `seed-demo.ts`, et sur les
 * correspondants de `seed-correspondants.ts` — il ne les recrée pas.
 *
 * SÛRETÉ. Tout ce qu'il insère est marqué et réversible :
 *   - courriers          → `reference` préfixée `DEMO-`
 *   - entités externes   → `email` = l'adresse marqueur ci-dessous (TLD `.invalid`, réservé)
 *   - objets de courrier → libellé suffixé « (démo tdb) »
 * Idempotent : les références existantes sont relues et ignorées, un second passage n'insère rien.
 * Il ne modifie JAMAIS une ligne préexistante (aucun update sur les rôles, référentiels ou
 * courriers réels) et ne supprime que ce qu'il a lui-même créé.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Constantes recopiées de @archivage/types (packages/db n'en dépend pas — même parti pris que
// seed.ts et seed-demo.ts). Identifiants du source, à ne pas renuméroter.
const MailType = { Arrivee: 0, Depart: 1, Interne: 2 } as const;
const MailStatus = { Redaction: 0, Redige: 1, Decharge: 2, Traite: 3 } as const;
const MailInputationTypeId = {
  ValidationDG: 5,
  PourSuivi: 10,
  ValidationDirection: 14,
  EnCopie: 17,
} as const;

/** Marqueurs de réversibilité. Ne pas les changer sans adapter `nettoyer()`. */
const REF_PREFIX = 'DEMO-';
const EMAIL_MARQUEUR = 'demo-dashboard@example.invalid';
const SUFFIXE_OBJET = '(démo tdb)';

const TOTAL_COURRIERS = 200;
const ETALEMENT_JOURS = 180;

// ---------------------------------------------------------------------------
// Générateur pseudo-aléatoire déterministe (mulberry32).
// Un `Math.random()` rendrait chaque exécution différente : impossible de reproduire un rendu ou
// de comparer deux passages. Graine fixe = jeu de données stable.
// ---------------------------------------------------------------------------
function prng(graine: number): () => number {
  let a = graine;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = prng(20260721);
const piocher = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
const entre = (min: number, max: number): number => min + Math.floor(rnd() * (max - min + 1));

const JOUR_MS = 86_400_000;
const jours = (d: Date, n: number): Date => new Date(d.getTime() + n * JOUR_MS);
/** Ramène à minuit UTC — `mail.date` est une colonne `date`, sans heure. */
const jourCivil = (d: Date): Date =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
/**
 * Empêche une date d'événement de tomber dans le futur. Un courrier enregistré il y a deux jours
 * et « archivé » dans trois semaines produirait un délai de traitement négatif et des KPI absurdes.
 */
const plafonner = (d: Date, maximum: Date): Date => (d > maximum ? jours(maximum, -1) : d);

// ---------------------------------------------------------------------------
// Matière rédactionnelle — libellés plausibles d'une administration ivoirienne.
// ---------------------------------------------------------------------------
const OBJETS_ARRIVEE = [
  "Demande d'agrément",
  'Réclamation sur facturation',
  'Transmission de dossier',
  "Demande d'audience",
  'Notification de contrôle',
  'Convocation à réunion interministérielle',
  'Demande de subvention',
  'Appel à manifestation d’intérêt',
  'Signalement de non-conformité',
  'Demande de renseignements',
  'Transmission de rapport annuel',
  'Requête de régularisation',
];
const OBJETS_DEPART = [
  'Réponse à demande d’agrément',
  'Accusé de réception',
  'Transmission de décision',
  'Notification de rejet',
  'Convocation',
  'Note de service',
  'Bordereau de transmission',
  'Lettre de relance',
];
const OBJETS_INTERNE = [
  'Note interne — organisation du service',
  'Compte rendu de réunion',
  'Circulaire interne',
  'Demande de congé',
  'Note de cadrage budgétaire',
];
const INSTRUCTIONS = [
  'Pour attribution et suite à donner',
  'Pour avis motivé sous huitaine',
  'Pour information',
  'À traiter en urgence',
  'Préparer un projet de réponse',
  'Pour instruction et compte rendu',
];

/**
 * Profils de courrier. Chaque profil isole une **situation métier** que le tableau de bord doit
 * savoir montrer ; les quotas garantissent que les cas rares (sans échéance, retard silencieux)
 * sont présents, ce qu'un tirage purement aléatoire ne garantirait pas.
 */
interface Profil {
  cle: string;
  quota: number;
  type: number;
  /** Courrier archivé (Traité pour Arrivée/Interne, Déchargé pour Départ). */
  archive: boolean;
  /** false → reste dans la file Contrôle (B1). */
  valider: boolean;
  echeance: 'passee' | 'proche' | 'lointaine' | 'aucune';
}

const PROFILS: readonly Profil[] = [
  // --- Archivés : alimentent A5, C1/C3, C4 (SLA), et le débit par agent -------------------
  {
    cle: 'arrivee-traitee',
    quota: 62,
    type: MailType.Arrivee,
    archive: true,
    valider: true,
    echeance: 'lointaine',
  },
  {
    cle: 'depart-decharge',
    quota: 34,
    type: MailType.Depart,
    archive: true,
    valider: true,
    echeance: 'lointaine',
  },
  {
    cle: 'interne-traite',
    quota: 12,
    type: MailType.Interne,
    archive: true,
    valider: true,
    echeance: 'lointaine',
  },

  // --- En cours, à contrôler : file B1 -----------------------------------------------------
  {
    cle: 'arrivee-a-controler',
    quota: 16,
    type: MailType.Arrivee,
    archive: false,
    valider: false,
    echeance: 'proche',
  },

  // --- En cours, validés : files B3/B7, charge, délais ------------------------------------
  {
    cle: 'arrivee-en-cours',
    quota: 26,
    type: MailType.Arrivee,
    archive: false,
    valider: true,
    echeance: 'proche',
  },
  {
    cle: 'depart-en-cours',
    quota: 14,
    type: MailType.Depart,
    archive: false,
    valider: true,
    echeance: 'lointaine',
  },

  // --- EN RETARD : le cœur de valeur du tableau de bord (D1/D6) ---------------------------
  // Ces courriers ne déclenchent plus aucune relance dès que le retard dépasse 3 jours (§3.6).
  {
    cle: 'arrivee-en-retard',
    quota: 18,
    type: MailType.Arrivee,
    archive: false,
    valider: true,
    echeance: 'passee',
  },
  {
    cle: 'depart-en-retard',
    quota: 6,
    type: MailType.Depart,
    archive: false,
    valider: true,
    echeance: 'passee',
  },

  // --- SANS ÉCHÉANCE : invisibles de D1, rattrapés seulement par D5 et G1 ------------------
  {
    cle: 'arrivee-sans-echeance',
    quota: 12,
    type: MailType.Arrivee,
    archive: false,
    valider: true,
    echeance: 'aucune',
  },
];

interface Referentiels {
  roles: number[];
  acteurs: number[];
  organigrammes: number[];
  natures: number[];
  objets: number[];
  objetsSansDuree: number[];
  confidentialites: number[];
  departTypes: number[];
  entites: number[];
  documents: number[];
  typesImputation: number[];
  /** Types portant `suivi = true` : leurs imputations sont auto-traitées à la lecture (§3.5). */
  typesAutoTraites: number[];
}

async function chargerReferentiels(): Promise<Referentiels> {
  const [
    roles,
    acteurs,
    organigrammes,
    natures,
    objets,
    confidentialites,
    departTypes,
    entites,
    documents,
    typesImputation,
  ] = await Promise.all([
    prisma.role.findMany({ where: { isActive: true }, select: { roleId: true } }),
    prisma.appUserGroup.findMany({
      where: { user: { isDisabled: false } },
      select: { userGroupId: true },
    }),
    prisma.organigramme.findMany({ where: { isActive: true }, select: { organigrammeId: true } }),
    prisma.mailNature.findMany({ where: { isActive: true }, select: { mailNatureId: true } }),
    prisma.mailObjet.findMany({
      where: { isActive: true },
      select: { mailObjetId: true, dureeSuiviExterne: true, dureeSuiviInterne: true },
    }),
    prisma.mailConfidentialite.findMany({
      where: { isActive: true },
      select: { mailConfidentialiteId: true },
    }),
    prisma.mailDepartType.findMany({
      where: { isActive: true },
      select: { mailDepartTypeId: true },
    }),
    prisma.externalEntity.findMany({
      where: { isActive: true },
      select: { externalEntityId: true },
    }),
    prisma.document.findMany({ select: { documentId: true }, take: 12 }),
    prisma.mailInputationType.findMany({
      where: { isActive: true },
      select: { mailInputationTypeId: true, suivi: true },
    }),
  ]);

  return {
    roles: roles.map((r) => r.roleId),
    acteurs: acteurs.map((a) => a.userGroupId),
    organigrammes: organigrammes.map((o) => o.organigrammeId),
    natures: natures.map((n) => n.mailNatureId),
    objets: objets
      .filter((o) => o.dureeSuiviExterne > 0 || o.dureeSuiviInterne > 0)
      .map((o) => o.mailObjetId),
    objetsSansDuree: objets
      .filter((o) => o.dureeSuiviExterne === 0 && o.dureeSuiviInterne === 0)
      .map((o) => o.mailObjetId),
    confidentialites: confidentialites.map((c) => c.mailConfidentialiteId),
    departTypes: departTypes.map((d) => d.mailDepartTypeId),
    entites: entites.map((e) => e.externalEntityId),
    documents: documents.map((d) => d.documentId),
    typesImputation: typesImputation.map((t) => t.mailInputationTypeId),
    typesAutoTraites: typesImputation.filter((t) => t.suivi).map((t) => t.mailInputationTypeId),
  };
}

/**
 * Prérequis propres au tableau de bord, absents des autres seeds :
 *  - deux objets SANS durée de suivi → alimentent G4 et prouvent que le widget SLA sait dire
 *    « non configuré » au lieu de compter ces courriers en échec ;
 *  - deux paires de correspondants en doublon de casse/espacement → alimentent G8 et fractionnent
 *    volontairement le Top correspondants (F1), pour que le défaut soit visible à l'écran.
 */
async function creerPrerequis(): Promise<void> {
  const objetsSansDuree = [
    `Note de transmission ${SUFFIXE_OBJET}`,
    `Pli non qualifié ${SUFFIXE_OBJET}`,
  ];
  for (const label of objetsSansDuree) {
    const existant = await prisma.mailObjet.findFirst({ where: { label } });
    if (!existant) {
      await prisma.mailObjet.create({
        data: { label, dureeSuiviExterne: 0, dureeSuiviInterne: 0, isActive: true },
      });
    }
  }

  // Type d'imputation à AUTO-TRAITEMENT (`suivi = true`) : aucun type de cette base n'en porte,
  // si bien que le quirk §3.5 (imputation traitée à la simple lecture du courrier) reste dormant
  // et que la moitié « auto » du KPI C5 serait vide en permanence — indiscernable d'un bug.
  const typeAuto = `Pour information ${SUFFIXE_OBJET}`;
  if (!(await prisma.mailInputationType.findFirst({ where: { label: typeAuto } }))) {
    await prisma.mailInputationType.create({
      data: { label: typeAuto, suivi: true, isActive: true },
    });
  }

  // Le référentiel des correspondants n'a délibérément PAS d'unique sur le libellé (cf. migration) :
  // ces doublons sont donc un cas réel du produit, pas une entorse au modèle.
  const doublons = [
    'Groupement Alpha Services',
    'GROUPEMENT ALPHA SERVICES',
    'Coopérative Bâtir Ensemble',
    'Cooperative Batir  Ensemble',
  ];
  for (const label of doublons) {
    const existant = await prisma.externalEntity.findFirst({
      where: { label, email: EMAIL_MARQUEUR },
    });
    if (!existant) {
      await prisma.externalEntity.create({
        data: { label, email: EMAIL_MARQUEUR, isActive: true },
      });
    }
  }
}

interface Plan {
  profil: Profil;
  index: number;
}

/** Déroule les quotas en une liste de courriers à créer, mélangée pour que l'ordre chronologique
 *  ne corresponde pas à l'ordre des profils (sinon les graphes de flux montrent des paliers nets). */
function planifier(): Plan[] {
  const plans: Plan[] = [];
  let i = 0;
  for (const profil of PROFILS) {
    for (let k = 0; k < profil.quota; k += 1) {
      plans.push({ profil, index: i });
      i += 1;
    }
  }
  for (let j = plans.length - 1; j > 0; j -= 1) {
    const k = Math.floor(rnd() * (j + 1));
    [plans[j], plans[k]] = [plans[k], plans[j]];
  }
  return plans.slice(0, TOTAL_COURRIERS);
}

async function peupler(): Promise<void> {
  const ref = await chargerReferentiels();

  if (ref.acteurs.length === 0 || ref.roles.length === 0) {
    throw new Error(
      'Aucun acteur ou rôle actif : lancez d’abord `db:seed` puis `db:seed:demo` (le tableau de bord a besoin de destinataires réels).',
    );
  }
  if (ref.entites.length === 0) {
    throw new Error('Aucun correspondant actif : lancez d’abord `db:seed:correspondants`.');
  }

  await creerPrerequis();
  // Rechargé : les prérequis viennent d'ajouter objets sans durée et correspondants en doublon.
  const refs = await chargerReferentiels();

  const dejaPresentes = new Set(
    (
      await prisma.mail.findMany({
        where: { reference: { startsWith: REF_PREFIX } },
        select: { reference: true },
      })
    ).map((m) => m.reference as string),
  );

  const maintenant = new Date();
  const plans = planifier();
  // Compteurs de numérotation par type de départ : l'unique partiel porte sur
  // (mail_depart_type_id, n_reference). L'espace « D9xxxx » est réservé à la démo pour ne jamais
  // entrer en collision avec la numérotation réelle produite par l'application.
  const compteursDepart = new Map<number, number>();
  let crees = 0;
  let ignores = 0;

  for (const { profil, index } of plans) {
    const reference = `${REF_PREFIX}${String(index + 1).padStart(4, '0')}`;
    if (dejaPresentes.has(reference)) {
      ignores += 1;
      continue;
    }

    const estDepart = profil.type === MailType.Depart;
    const estInterne = profil.type === MailType.Interne;

    // --- Chronologie : mail_date <= date_enregistrement <= archivage, jamais dans le futur ----
    const age = entre(1, ETALEMENT_JOURS);
    const dateCourrier = jourCivil(jours(maintenant, -age));
    // Plafonné : un courrier daté d'hier avec 3 jours de délai de prise en charge tomberait sinon
    // dans le futur, et tout ce qui en dérive (décharge, traitement) avec lui.
    const dateEnregistrement = plafonner(jours(dateCourrier, entre(0, 3)), maintenant);

    // --- Échéance ----------------------------------------------------------------------------
    // Pour un courrier ENCORE EN COURS, l'échéance doit être ancrée sur « maintenant » : la caler
    // sur la date d'enregistrement (jusqu'à 180 jours en arrière) la placerait mécaniquement dans
    // le passé et gonflerait le KPI D1 de courriers censés être dans les temps.
    let dateButoire: Date | null;
    switch (profil.echeance) {
      case 'aucune':
        dateButoire = null;
        break;
      case 'passee':
        // Majoritairement au-delà de -3 jours : ce sont les courriers devenus SILENCIEUX, que
        // plus aucune relance ne signale (§3.6).
        dateButoire = jours(maintenant, -entre(1, 45));
        break;
      case 'proche':
        // Couvre les paliers J0 / J1-J3 / J4-J7 / au-delà, y compris les jours (2, 4, 5, 6) que
        // les relances ignorent.
        dateButoire = jours(maintenant, entre(0, 12));
        break;
      default:
        dateButoire = profil.archive
          ? jours(dateEnregistrement, entre(20, 60)) // historique : échéance d'époque
          : jours(maintenant, entre(13, 60)); // en cours : échéance encore devant nous
    }

    // --- Archivage : la date retenue DIFFÈRE selon le type (§3.7) ----------------------------
    let status: number = MailStatus.Redaction;
    let dateTraited: Date | null = null;
    let dateDecharge: Date | null = null;

    if (estDepart) {
      // Quirk §3.1 : tout Départ porte une date de décharge dès son passage à « Rédigé ».
      // C'est ce qui sert de date d'archivage au Départ — reproduit fidèlement ici.
      dateDecharge = plafonner(jours(dateEnregistrement, entre(0, 2)), maintenant);
      status = profil.archive ? MailStatus.Decharge : MailStatus.Redige;
      if (profil.archive) {
        // §13 : l'intégration de la décharge signée enchaîne `markDecharge` PUIS `ArchiverCourrier`
        // — le Départ reçoit donc AUSSI un `dateTraited`. L'omettre le laisserait éternellement
        // dans les files « en cours » et le ferait compter en retard (D1).
        dateDecharge = plafonner(jours(dateEnregistrement, entre(3, 35)), maintenant);
        dateTraited = dateDecharge;
      }
    } else if (profil.archive) {
      status = MailStatus.Traite;
      dateTraited = plafonner(jours(dateEnregistrement, entre(1, 40)), maintenant);
    } else {
      status = profil.valider ? MailStatus.Redige : MailStatus.Redaction;
    }

    // --- Destinataire : XOR imposé par ck_mail_destinataire ----------------------------------
    // Une Arrivée est adressée à une FONCTION (rôle) ; un Départ / Interne à un agent nommé.
    const destinataireRoleId = profil.type === MailType.Arrivee ? piocher(refs.roles) : null;
    const destinataireExpediteur = destinataireRoleId === null ? piocher(refs.acteurs) : null;

    // --- Organigramme : Arrivées uniquement (§2.2) -------------------------------------------
    // En production la valeur est dérivée du rôle du destinataire ; aucun rôle n'étant rattaché
    // dans cette base, on la pose directement. ~1 Arrivée sur 6 reste NULL pour alimenter G9.
    const organigrammeId =
      profil.type === MailType.Arrivee && refs.organigrammes.length > 0 && rnd() > 0.17
        ? piocher(refs.organigrammes)
        : null;

    // --- Objet : 1 sur 4 sans durée de suivi → le SLA doit l'écarter, pas le compter en échec --
    const objetId =
      rnd() > 0.25 && refs.objets.length > 0
        ? piocher(refs.objets)
        : refs.objetsSansDuree.length > 0
          ? piocher(refs.objetsSansDuree)
          : null;

    let nReference: string | null = null;
    let mailDepartTypeId: number | null = null;
    if (estDepart && refs.departTypes.length > 0) {
      mailDepartTypeId = piocher(refs.departTypes);
      const suivant = (compteursDepart.get(mailDepartTypeId) ?? 0) + 1;
      compteursDepart.set(mailDepartTypeId, suivant);
      nReference = `D9${String(suivant).padStart(4, '0')}`;
    }

    const titre = estDepart
      ? piocher(OBJETS_DEPART)
      : estInterne
        ? piocher(OBJETS_INTERNE)
        : piocher(OBJETS_ARRIVEE);

    const courrier = await prisma.mail.create({
      data: {
        title: `${titre} — ${reference}`,
        date: dateCourrier,
        description: `Courrier de démonstration du tableau de bord (${profil.cle}).`,
        reference,
        nReference,
        mailType: profil.type,
        status,
        dateEnregistrementCourrier: dateEnregistrement,
        dateButoire,
        dateTraited,
        dateDecharge,
        valider: profil.valider,
        // Une partie des courriers validés n'est pas encore passée en Direction : c'est ce qui
        // alimente la file B3.
        validationDirection: profil.valider && profil.archive && rnd() > 0.4,
        validationDG: profil.archive && rnd() > 0.8,
        enregistrementReponse: profil.archive && rnd() > 0.7,
        decharge: estDepart && profil.archive,
        destinataireExpediteur,
        destinataireRoleId,
        organigrammeId,
        mailObjetId: objetId,
        mailNatureId: refs.natures.length > 0 ? piocher(refs.natures) : null,
        confidentialiteId: refs.confidentialites.length > 0 ? piocher(refs.confidentialites) : null,
        // Un Interne n'a pas nécessairement de correspondant externe (FK nullable, §02.1.2).
        externalEntityId: estInterne && rnd() > 0.5 ? null : piocher(refs.entites),
        mailDepartTypeId,
        isDeleted: false,
        createdBy: piocher(refs.acteurs),
        createdAt: dateEnregistrement,
      },
      select: { mailId: true },
    });

    await creerImputations(courrier.mailId, profil, refs, dateEnregistrement, maintenant);

    // Décharge réellement intégrée : un document rattaché avec `decharge = true` (§3.1). Sans lui,
    // TOUS les Départs apparaîtraient en attente dans la file B5, ce qui serait irréaliste.
    if (estDepart && profil.archive && refs.documents.length > 0 && rnd() > 0.45) {
      await prisma.mailDocument.create({
        data: {
          mailId: courrier.mailId,
          documentId: piocher(refs.documents),
          decharge: true,
          createdBy: piocher(refs.acteurs),
          createdAt: dateDecharge ?? dateEnregistrement,
        },
      });
    }

    crees += 1;
  }

  await resumer(crees, ignores);
}

/**
 * Imputations du courrier. Trois situations sont garanties :
 *  - traitées (alimentent C5 et le débit par agent) ;
 *  - ouvertes dans les temps (charge courante, E1) ;
 *  - **en retard** (`deadline` passée, jamais relancée) → KPI D3, l'angle mort que le worker
 *    cesse de signaler dès l'échéance franchie.
 */
async function creerImputations(
  mailId: number,
  profil: Profil,
  refs: Referentiels,
  dateEnregistrement: Date,
  maintenant: Date,
): Promise<void> {
  if (profil.valider === false && rnd() > 0.3) return; // un courrier non contrôlé est rarement imputé

  const nombre = entre(1, 3);
  for (let i = 0; i < nombre; i += 1) {
    const creeLe = jours(dateEnregistrement, entre(0, 2));
    // ~1 imputation sur 5 porte un type AUTO-TRAITÉ : sans elles, la moitié « auto » du KPI C5
    // resterait vide et l'on ne saurait pas distinguer « aucune donnée » de « calcul cassé ».
    const typeId =
      refs.typesAutoTraites.length > 0 && rnd() > 0.8
        ? piocher(refs.typesAutoTraites)
        : refs.typesImputation.includes(MailInputationTypeId.EnCopie) && i > 0 && rnd() > 0.6
          ? MailInputationTypeId.EnCopie
          : piocher(refs.typesImputation);

    let deadline: Date | null = null;
    let dateTreated: Date | null = null;
    let lastReminderSent: Date | null = null;

    const autoTraitee = refs.typesAutoTraites.includes(typeId);

    if (profil.archive) {
      // Imputation historique : échéance et traitement d'époque, calés sur la création.
      deadline = jours(creeLe, entre(2, 30));
      // Une imputation auto-traitée est soldée à la simple LECTURE du courrier : son délai frôle
      // zéro sans qu'aucun travail n'ait eu lieu. C'est exactement l'artefact que la ségrégation
      // du KPI C5 sert à démasquer — encore faut-il que les données le montrent.
      dateTreated = jours(creeLe, autoTraitee ? entre(0, 1) : entre(1, 25));
      if (dateTreated > maintenant) dateTreated = jours(maintenant, -1);
    } else if (profil.echeance === 'passee') {
      // Échéance dépassée + jamais relancée : `shouldRemindInputation` renvoie false dès que
      // `deadline < now`, ces imputations sont donc devenues muettes.
      deadline = jours(maintenant, -entre(1, 30));
    } else if (rnd() > 0.75) {
      deadline = null; // alimente G2 (imputations sans échéance, jamais relancées non plus)
    } else {
      // Imputation ouverte et dans les temps : ancrée sur « maintenant », sinon elle naîtrait
      // en retard du seul fait de l'ancienneté du courrier.
      deadline = jours(maintenant, entre(1, 25));
      if (rnd() > 0.6) lastReminderSent = jours(maintenant, -entre(1, 3));
    }

    await prisma.mailInputation.create({
      data: {
        mailId,
        userId: piocher(refs.acteurs),
        mailInputationTypeId: typeId,
        instructions: piocher(INSTRUCTIONS),
        deadline,
        dateTreated,
        lastReminderSent,
        createdBy: piocher(refs.acteurs),
        createdAt: creeLe,
      },
    });
  }
}

async function resumer(crees: number, ignores: number): Promise<void> {
  const [total, enRetard, sansEcheance, imputRetard, doublons] = await Promise.all([
    prisma.mail.count({ where: { reference: { startsWith: REF_PREFIX } } }),
    prisma.mail.count({
      where: {
        reference: { startsWith: REF_PREFIX },
        dateTraited: null,
        dateButoire: { lt: new Date() },
      },
    }),
    prisma.mail.count({
      where: { reference: { startsWith: REF_PREFIX }, dateTraited: null, dateButoire: null },
    }),
    prisma.mailInputation.count({
      where: {
        dateTreated: null,
        deadline: { lt: new Date() },
        mail: { reference: { startsWith: REF_PREFIX } },
      },
    }),
    prisma.externalEntity.count({ where: { email: EMAIL_MARQUEUR } }),
  ]);

  console.log(
    `\n  Seed tableau de bord — ${crees} courrier(s) créé(s), ${ignores} déjà présent(s).`,
  );
  console.log(`  Total marqué « ${REF_PREFIX} »      : ${total}`);
  console.log(`  Courriers en retard (D1)      : ${enRetard}`);
  console.log(`  Courriers sans échéance (G1)  : ${sansEcheance}`);
  console.log(`  Imputations en retard (D3)    : ${imputRetard}  ← plus aucune relance envoyée`);
  console.log(`  Correspondants en doublon (G8): ${doublons}`);
  console.log(`\n  Nettoyage : pnpm --filter @archivage/db db:seed:dashboard -- --clean\n`);
}

/**
 * Retrait complet. `mail_inputation` et `mail_document` disparaissent par cascade (onDelete:
 * Cascade côté schéma) ; `mail_action_log` et `mail_scanned_document` passeraient en SET NULL mais
 * ce seed n'en crée pas. Les objets de démo ne sont retirés que s'ils ne sont plus référencés,
 * pour ne jamais casser un courrier réel qui les aurait adoptés entre-temps.
 */
async function nettoyer(): Promise<void> {
  const { count: mails } = await prisma.mail.deleteMany({
    where: { reference: { startsWith: REF_PREFIX } },
  });
  const { count: entites } = await prisma.externalEntity.deleteMany({
    where: { email: EMAIL_MARQUEUR },
  });

  let objets = 0;
  const candidats = await prisma.mailObjet.findMany({
    where: { label: { endsWith: SUFFIXE_OBJET } },
    select: { mailObjetId: true, label: true, _count: { select: { mails: true } } },
  });
  for (const o of candidats) {
    if (o._count.mails === 0) {
      await prisma.mailObjet.delete({ where: { mailObjetId: o.mailObjetId } });
      objets += 1;
    } else {
      console.log(
        `  · objet « ${o.label} » conservé : ${o._count.mails} courrier(s) le référencent.`,
      );
    }
  }

  // Type d'imputation auto-traité : retiré une fois ses imputations parties par cascade.
  let types = 0;
  const typesDemo = await prisma.mailInputationType.findMany({
    where: { label: { endsWith: SUFFIXE_OBJET } },
    select: { mailInputationTypeId: true, label: true, _count: { select: { inputations: true } } },
  });
  for (const t of typesDemo) {
    if (t._count.inputations === 0) {
      await prisma.mailInputationType.delete({
        where: { mailInputationTypeId: t.mailInputationTypeId },
      });
      types += 1;
    } else {
      console.log(
        `  · type « ${t.label} » conservé : ${t._count.inputations} imputation(s) le référencent.`,
      );
    }
  }

  console.log(
    `\n  Nettoyage terminé — ${mails} courrier(s), ${entites} correspondant(s), ${objets} objet(s), ${types} type(s) d'imputation supprimé(s).\n`,
  );
}

async function main(): Promise<void> {
  const clean = process.argv.includes('--clean');
  if (clean) await nettoyer();
  else await peupler();
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
