import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

// Échelle enforcée depuis le 2026-08-04 (cf. `migrate-permission-levels.ts`) : 1 Denied n'est
// JAMAIS accordable (exclu des écrans d'octroi, cf. `ReferentialsService.listPermissionLevels`),
// il sert seulement à distinguer explicitement « aucun droit » de « Consultation ».
const PERMISSION_LEVELS = [
  { permissionLevelId: 1, name: 'Denied' },
  { permissionLevelId: 2, name: 'Consultation' },
  { permissionLevelId: 3, name: 'Modification' },
  { permissionLevelId: 4, name: 'Administration' },
  { permissionLevelId: 5, name: 'Archivistique' },
];

const SYSTEM_ROLE_NAME = 'Admin système';

// Toutes les permissions de menu (miroir de apps/api/src/modules/roles/menu-catalog.ts,
// hors l'accueil « / » toujours visible). À garder synchronisé avec la sidebar (nav.ts).
const ALL_MENU_KEYS = [
  '/intercalaires',
  '/acquisition',
  '/search',
  '/dashboards',
  // '/admin/geolocalisation' : écran masqué, non assignable (cf. HIDDEN_MENU_KEYS dans
  // apps/api/src/modules/roles/menu-catalog.ts). '/admin/dossier-categories' a purement disparu,
  // avec la table `dossier_category` (migration 20260731160000).
  '/admin/classification-plans',
  '/admin/dossiers',
  '/admin/document-types',
  '/admin/users',
  '/admin/roles',
  // Docu-Archives : cycle de vie, métadonnées, prêts — miroir de ARCHIVES_MENUS
  // (apps/api/src/modules/archives/archives.menus.ts).
  '/admin/archives/parametrage-types',
  '/admin/archives/cycles-de-vie',
  '/admin/archives/modes-destruction',
  '/admin/archives/sorts-finaux',
  '/admin/archives/motifs-pret',
  '/admin/archives/metadonnees',
  '/admin/archives/metadonnees-types',
  '/admin/archives/elements-listes',
  '/archives/dua-expirees',
  '/archives/documents-epures',
  '/archives/communiquer',
  '/archives/documents-communiques',
  '/archives/mes-documents-communiques',
  '/archives/historique-communications',
  // Docu-Courriers (opérationnel + paramétrage) — miroir de menu-catalog.ts §04.
  '/courriers/tableau-de-bord',
  '/courriers/enregistrement',
  '/courriers/controle',
  '/courriers/documents-scannes',
  '/courriers/parapheur',
  '/courriers/suivi',
  '/courriers/validation',
  '/courriers/recherche',
  '/courriers/depart',
  '/courriers/integration-decharge',
  '/admin/courriers/organigrammes',
  '/admin/courriers/role-organigramme',
  '/admin/courriers/entites-externes',
  '/admin/courriers/types-imputation',
  '/admin/courriers/types-depart',
  // '/admin/courriers/natures', '/admin/courriers/objets' et '/admin/courriers/confidentialites' :
  // écrans masqués, non assignables (cf. HIDDEN_MENU_KEYS dans
  // apps/api/src/modules/roles/menu-catalog.ts).
];

const INTERCALAIRE_CATEGORIES = [
  {
    categoryCode: 'TYPE_DOCUMENT',
    targetTable: 'document_type',
    targetColumn: 'document_type_id',
    isBlank: false,
    label: 'Type de document',
  },
  {
    categoryCode: 'PLAN',
    targetTable: 'classification_plan',
    targetColumn: 'plan_id',
    isBlank: false,
    label: 'Plan de classement',
  },
  {
    categoryCode: 'LOCALISATION',
    targetTable: 'location',
    targetColumn: 'location_id',
    isBlank: false,
    label: 'Localisation',
  },
  {
    categoryCode: 'DOSSIER',
    targetTable: 'dossier',
    targetColumn: 'dossier_id',
    isBlank: false,
    label: 'Dossier',
  },
  {
    categoryCode: 'BLANK',
    targetTable: null,
    targetColumn: null,
    isBlank: true,
    label: 'Séparateur vierge',
  },
];

const FILE_TYPES = [
  { extension: '.pdf', friendlyName: 'PDF', isMedia: false },
  { extension: '.jpg', friendlyName: 'Image JPEG', isMedia: true },
  { extension: '.png', friendlyName: 'Image PNG', isMedia: true },
  { extension: '.tiff', friendlyName: 'Image TIFF', isMedia: true },
];

async function main(): Promise<void> {
  // Permission levels (domain values)
  for (const lvl of PERMISSION_LEVELS) {
    await prisma.permissionLevel.upsert({
      where: { permissionLevelId: lvl.permissionLevelId },
      update: { name: lvl.name },
      create: lvl,
    });
  }

  // Intercalaire categories (QR contract)
  for (const cat of INTERCALAIRE_CATEGORIES) {
    await prisma.intercalaireCategory.upsert({
      where: { categoryCode: cat.categoryCode },
      update: {
        targetTable: cat.targetTable,
        targetColumn: cat.targetColumn,
        isBlank: cat.isBlank,
        label: cat.label,
      },
      create: { ...cat, isIngestHandled: true },
    });
  }

  // File types (unique extension)
  for (const ft of FILE_TYPES) {
    await prisma.fileType.upsert({
      where: { extension: ft.extension },
      update: { friendlyName: ft.friendlyName, isMedia: ft.isMedia },
      create: ft,
    });
  }

  // Admin group + user + effective identity
  let adminGroup = await prisma.appGroup.findFirst({ where: { name: 'Administrateurs' } });
  if (!adminGroup) {
    adminGroup = await prisma.appGroup.create({ data: { name: 'Administrateurs' } });
  }

  const passwordHash = await bcrypt.hash('admin1234', 12);
  const admin = await prisma.appUser.upsert({
    where: { username: 'admin' },
    update: { isAdmin: true, isDisabled: false },
    create: {
      username: 'admin',
      firstName: 'Admin',
      lastName: 'Système',
      fullName: 'Admin Système',
      email: 'admin@example.local',
      passwordHash,
      mustChangePwd: true,
      isAdmin: true,
    },
  });

  await prisma.appUserGroup.upsert({
    where: { userId_groupId: { userId: admin.userId, groupId: adminGroup.groupId } },
    update: {},
    create: { userId: admin.userId, groupId: adminGroup.groupId, isDefault: true },
  });

  // Rôle système par défaut : toutes les permissions de menu, non supprimable, attribué à l'admin.
  const existingSystemRole = await prisma.role.findFirst({ where: { isSystem: true } });
  const systemRole =
    existingSystemRole ??
    (await prisma.role.create({
      data: {
        name: SYSTEM_ROLE_NAME,
        description: 'Rôle système par défaut — accès à tous les menus. Non supprimable.',
        isSystem: true,
      },
    }));
  // (Ré)affirme l'état du rôle système et l'intégralité de ses permissions de menu.
  await prisma.role.update({
    where: { roleId: systemRole.roleId },
    data: { name: SYSTEM_ROLE_NAME, isActive: true, isSystem: true },
  });
  await prisma.roleMenuPermission.deleteMany({ where: { roleId: systemRole.roleId } });
  await prisma.roleMenuPermission.createMany({
    data: ALL_MENU_KEYS.map((menuKey) => ({ roleId: systemRole.roleId, menuKey })),
  });
  // Attribue le rôle système au compte admin.
  await prisma.appUser.update({
    where: { username: 'admin' },
    data: { roleId: systemRole.roleId },
  });

  // Demo referentials
  for (const label of ['Facture', 'Contrat', 'Courrier']) {
    const exists = await prisma.documentType.findFirst({ where: { label, isActive: true } });
    if (!exists) await prisma.documentType.create({ data: { label } });
  }

  await ensureRoot(
    () => prisma.classificationPlan.findFirst({ where: { label: 'Racine plan', parentId: null } }),
    (path) => prisma.classificationPlan.create({ data: { label: 'Racine plan', depth: 0, path } }),
    (id, path) => prisma.classificationPlan.update({ where: { planId: id }, data: { path } }),
    (e) => e.planId,
  );
  await ensureRoot(
    () => prisma.location.findFirst({ where: { label: 'Magasin central', parentId: null } }),
    (path) => prisma.location.create({ data: { label: 'Magasin central', depth: 0, path } }),
    (id, path) => prisma.location.update({ where: { locationId: id }, data: { path } }),
    (e) => e.locationId,
  );
  await ensureRoot(
    () =>
      prisma.dossier.findFirst({ where: { label: 'Dossier de démonstration', parentId: null } }),
    (path) =>
      prisma.dossier.create({ data: { label: 'Dossier de démonstration', depth: 0, path } }),
    (id, path) => prisma.dossier.update({ where: { dossierId: id }, data: { path } }),
    (e) => e.dossierId,
  );

  // --- Docu-Courriers ---
  // Types d'imputation « système » aux identifiants figés (référencés par le domaine, §08/§10).
  // Ids source préservés : 5 Validation DG, 10 Pour Suivi, 14 Validation Direction, 17 En Copie.
  // `suivi` = déclenche l'auto-« traité » à la lecture ; connu seulement pour « Pour Suivi » (à
  // ajuster si la donnée source précise d'autres cas).
  const MAIL_INPUTATION_TYPES = [
    { mailInputationTypeId: 5, label: 'Validation DG', suivi: false },
    { mailInputationTypeId: 10, label: 'Pour Suivi', suivi: true },
    { mailInputationTypeId: 14, label: 'Validation Direction', suivi: false },
    { mailInputationTypeId: 17, label: 'En Copie', suivi: false },
  ];
  for (const t of MAIL_INPUTATION_TYPES) {
    await prisma.mailInputationType.upsert({
      where: { mailInputationTypeId: t.mailInputationTypeId },
      update: { label: t.label, suivi: t.suivi },
      create: t,
    });
  }
  // Réserve les ids < 100 aux types système ; les types créés via l'UI (§18) démarrent à 100.
  await prisma.$executeRawUnsafe(
    `SELECT setval(pg_get_serial_sequence('mail_inputation_type', 'mail_inputation_type_id'), 100, false)`,
  );

  // Type d'entité externe par défaut (§16/§17).
  const defaultExtType = await prisma.externalEntityType.findFirst({
    where: { label: 'Non défini', isActive: true },
  });
  if (!defaultExtType) await prisma.externalEntityType.create({ data: { label: 'Non défini' } });

  // --- Docu-Archives ---
  // Amorces des trois référentiels du cycle de vie. Sans elles, l'écran « Cycles de vie » ne
  // propose ni sort final ni mode de destruction, et « Communiquer un document » exige un motif
  // qu'aucune liste ne contient : le module serait inutilisable au premier démarrage.
  // Idempotent : on ne crée que ce qui manque, et un libellé renommé par l'utilisateur n'est pas
  // recréé à l'identique tant qu'il reste actif sous une forme équivalente.
  const seedRefLabels = async (
    labels: string[],
    find: (label: string) => Promise<unknown | null>,
    create: (label: string) => Promise<unknown>,
  ) => {
    for (const label of labels) {
      if (!(await find(label))) await create(label);
    }
  };

  await seedRefLabels(
    ['Broyage', 'Incinération', 'Effacement numérique'],
    (label) => prisma.destructionMode.findFirst({ where: { label, isActive: true } }),
    (label) => prisma.destructionMode.create({ data: { label } }),
  );
  await seedRefLabels(
    ['Conservation définitive', 'Destruction', 'Versement aux archives'],
    (label) => prisma.finalFate.findFirst({ where: { label, isActive: true } }),
    (label) => prisma.finalFate.create({ data: { label } }),
  );
  await seedRefLabels(
    ['Consultation', 'Contrôle', 'Litige'],
    (label) => prisma.lendingMotive.findFirst({ where: { label, isActive: true } }),
    (label) => prisma.lendingMotive.create({ data: { label } }),
  );

  // eslint-disable-next-line no-console
  console.log(
    "Seed complete: admin/admin1234 (must change pwd), rôle système (toutes permissions) attribué à admin, 5 permission levels, 5 intercalaire categories, demo referentials, 4 types d'imputation Docu-Courriers, type d'entité externe par défaut, référentiels Docu-Archives (modes de destruction, sorts finaux, motifs de prêt).",
  );
}

/** Create a hierarchy root with a materialized path of /{id}/, idempotently. */
async function ensureRoot<T>(
  find: () => Promise<T | null>,
  create: (path: string) => Promise<T>,
  setPath: (id: number, path: string) => Promise<T>,
  idOf: (e: T) => number,
): Promise<void> {
  const existing = await find();
  if (existing) return;
  const created = await create('/');
  const id = idOf(created);
  await setPath(id, `/${id}/`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
