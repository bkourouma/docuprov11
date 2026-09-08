/**
 * Seed de DÉMO / RECETTE Docu-Courriers — `pnpm --filter @archivage/db db:seed:demo`.
 *
 * SÉPARÉ du seed de production (`seed.ts`), qui ne crée que le socle (admin, types d'imputation
 * aux ids source 5/10/14/17, types de fichier). Ici on peuple de quoi ÉPROUVER le module :
 * référentiels d'indexation, organigramme, propriétés personnalisées, et surtout **plusieurs
 * acteurs** — sans eux tout le module se joue « admin → admin » et l'imputation, le parapheur,
 * la validation ou les badges par destinataire ne veulent rien dire.
 *
 * Idempotent : relançable sans dupliquer (tout est recherché avant création). Ne touche jamais aux
 * données de production existantes ; les libellés portent le suffixe « (démo) » pour être
 * identifiables et supprimables.
 */
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

// Valeurs recopiées de @archivage/types (que `packages/db` n'a pas en dépendance — le seed de prod
// fait de même). Ce sont les identifiants du source, à ne pas renuméroter.
const MailType = { Arrivee: 0, Depart: 1, Interne: 2 } as const;
const MailStatus = { Redaction: 0, Redige: 1, Decharge: 2, Traite: 3, Supprime: 4 } as const;
const MailInputationTypeId = { ValidationDG: 5, PourSuivi: 10, ValidationDirection: 14, EnCopie: 17 } as const;

/** Mot de passe commun aux comptes de démo — jamais destiné à la production. */
const DEMO_PASSWORD = 'demo1234';

/** Menus du bureau d'ordre : enregistre, contrôle, dépose les scans, cherche. */
const MENUS_BUREAU_ORDRE = [
  '/dashboards',
  '/courriers/enregistrement',
  '/courriers/controle',
  '/courriers/documents-scannes',
  '/courriers/recherche',
  '/courriers/depart',
  '/courriers/integration-decharge',
];
/** Menus d'un agent traitant : son parapheur et le suivi. */
const MENUS_AGENT = ['/dashboards', '/courriers/parapheur', '/courriers/suivi', '/courriers/recherche'];
/** Menus d'un valideur : parapheur + validation. */
const MENUS_VALIDEUR = [
  '/dashboards',
  '/courriers/parapheur',
  '/courriers/validation',
  '/courriers/suivi',
  '/courriers/recherche',
];

async function findOrCreate<T>(find: () => Promise<T | null>, create: () => Promise<T>): Promise<T> {
  return (await find()) ?? (await create());
}

/** Nœud d'organigramme (le `path` matérialise l'arbre : « dg », « dg/achats »…). */
async function node(label: string, path: string, parentId: number | null) {
  return findOrCreate(
    () => prisma.organigramme.findFirst({ where: { path } }),
    () => prisma.organigramme.create({ data: { label, path, parentId } }),
  );
}

/** Rôle + ses menus + son nœud d'organigramme (§15 « Rôle ↔ organigramme »). */
async function role(name: string, menus: string[], organigrammeId: number | null) {
  const r = await findOrCreate(
    () => prisma.role.findFirst({ where: { name } }),
    () => prisma.role.create({ data: { name, description: 'Rôle de démo (recette)' } }),
  );
  await prisma.role.update({ where: { roleId: r.roleId }, data: { organigrammeId, isActive: true } });
  // Réaffirme les menus (relançable sans doublon : la table a un unique (roleId, menuKey)).
  await prisma.roleMenuPermission.deleteMany({ where: { roleId: r.roleId } });
  await prisma.roleMenuPermission.createMany({
    data: menus.map((menuKey) => ({ roleId: r.roleId, menuKey })),
  });
  return r;
}

/**
 * Acteur = utilisateur + groupe + `app_user_group` (l'identité effective V6 : c'est ELLE que
 * portent tous les `*_by`, les imputations et les destinataires).
 */
async function actor(opts: {
  username: string;
  fullName: string;
  groupName: string;
  roleId: number;
}): Promise<number> {
  const [firstName = '', ...rest] = opts.fullName.split(' ');
  const group = await findOrCreate(
    () => prisma.appGroup.findFirst({ where: { name: opts.groupName } }),
    () => prisma.appGroup.create({ data: { name: opts.groupName } }),
  );
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 12);
  const user = await prisma.appUser.upsert({
    where: { username: opts.username },
    update: { roleId: opts.roleId, isDisabled: false, fullName: opts.fullName },
    create: {
      username: opts.username,
      firstName,
      lastName: rest.join(' '),
      fullName: opts.fullName,
      email: `${opts.username}@demo.local`,
      passwordHash,
      mustChangePwd: false,
      isAdmin: false,
      roleId: opts.roleId,
    },
  });
  const ug = await prisma.appUserGroup.upsert({
    where: { userId_groupId: { userId: user.userId, groupId: group.groupId } },
    update: {},
    create: { userId: user.userId, groupId: group.groupId, isDefault: true },
  });
  return ug.userGroupId;
}

async function ref<T>(
  model: { findFirst: (a: unknown) => Promise<T | null>; create: (a: unknown) => Promise<T> },
  label: string,
  extra: Record<string, unknown> = {},
): Promise<T> {
  return findOrCreate(
    () => model.findFirst({ where: { label } }),
    () => model.create({ data: { label, ...extra } }),
  );
}

async function main(): Promise<void> {
  // ---- Organigramme (3 niveaux) ------------------------------------------
  const dg = await node('Direction Générale (démo)', 'dg', null);
  const achats = await node('Direction des Achats (démo)', 'dg/achats', dg.organigrammeId);
  const bo = await node("Bureau d'Ordre (démo)", 'dg/bo', dg.organigrammeId);

  // ---- Rôles (menus distincts : c'est ce qui rend le menu-RBAC observable) --
  const roleBO = await role("Bureau d'ordre (démo)", MENUS_BUREAU_ORDRE, bo.organigrammeId);
  const roleAgent = await role('Agent traitant (démo)', MENUS_AGENT, achats.organigrammeId);
  const roleDirecteur = await role('Directeur (démo)', MENUS_VALIDEUR, achats.organigrammeId);
  const roleDG = await role('Directeur Général (démo)', MENUS_VALIDEUR, dg.organigrammeId);

  // ---- Acteurs -------------------------------------------------------------
  const uBO = await actor({
    username: 'bo.courrier',
    fullName: 'Awa Bureau-Ordre',
    groupName: "Bureau d'Ordre",
    roleId: roleBO.roleId,
  });
  const uAgent = await actor({
    username: 'agent.achats',
    fullName: 'Kouassi Agent',
    groupName: 'Direction des Achats',
    roleId: roleAgent.roleId,
  });
  const uDirecteur = await actor({
    username: 'directeur.achats',
    fullName: 'Fatou Directrice',
    groupName: 'Direction des Achats',
    roleId: roleDirecteur.roleId,
  });
  const uDG = await actor({
    username: 'dg',
    fullName: 'Ibrahim Directeur-Général',
    groupName: 'Direction Générale',
    roleId: roleDG.roleId,
  });

  // ---- Référentiels d'indexation ------------------------------------------
  const tMinistere = await ref(prisma.externalEntityType, 'Ministère (démo)');
  const tEntreprise = await ref(prisma.externalEntityType, 'Entreprise (démo)');
  const eFinances = await ref(prisma.externalEntity, 'Ministère des Finances (démo)', {
    externalEntityTypeId: tMinistere.externalEntityTypeId,
  });
  const eSante = await ref(prisma.externalEntity, 'Ministère de la Santé (démo)', {
    externalEntityTypeId: tMinistere.externalEntityTypeId,
  });
  await ref(prisma.externalEntity, 'SODECI (démo)', {
    externalEntityTypeId: tEntreprise.externalEntityTypeId,
  });

  const nOfficiel = await ref(prisma.mailNature, 'Officiel (démo)');
  await ref(prisma.mailNature, 'Confidentiel (démo)');
  const oDemande = await ref(prisma.mailObjet, 'Demande (démo)', {
    dureeSuiviExterne: 15,
    dureeSuiviInterne: 7,
  });
  await ref(prisma.mailObjet, 'Réclamation (démo)', { dureeSuiviExterne: 30, dureeSuiviInterne: 10 });
  const cRestreint = await ref(prisma.mailConfidentialite, 'Restreint (démo)');
  await ref(prisma.mailConfidentialite, 'Public (démo)');

  // ---- Propriétés personnalisées (panneau Métadonnées du MailViewer) -------
  await ref(prisma.externalEntityCustomProperty, 'N° marché (démo)');
  await ref(prisma.externalEntityCustomProperty, 'Service émetteur (démo)');

  // ---- Courriers dans des états VARIÉS ------------------------------------
  // On couvre chaque file : Contrôle (non validé), Parapheur (imputé), Validation (en attente
  // Direction), et un courrier avec échéance proche pour voir les rappels §03.5 se déclencher.
  const now = new Date();
  const inDays = (d: number) => new Date(now.getTime() + d * 86_400_000);

  const mk = async (data: Record<string, unknown>) =>
    findOrCreate(
      () => prisma.mail.findFirst({ where: { nReference: data.nReference as string } }),
      () => prisma.mail.create({ data: data as never }),
    );

  // 1. À contrôler (file Contrôle, badge « controle »)
  await mk({
    title: 'Demande de subvention 2026 (démo)',
    nReference: 'D0001',
    reference: 'MIN/FIN/2026/118',
    mailType: MailType.Arrivee,
    status: MailStatus.Redaction,
    valider: false,
    date: inDays(-6),
    dateEnregistrementCourrier: inDays(-5),
    dateButoire: inDays(7), // J-7 => palier PREMIÈRE_ALERTE du rappel §03.5
    description: 'Demande de subvention pour le programme de modernisation.',
    destinataireExpediteur: uDirecteur,
    createdBy: uBO,
    externalEntityId: eFinances.externalEntityId,
    mailNatureId: nOfficiel.mailNatureId,
    mailObjetId: oDemande.mailObjetId,
    confidentialiteId: cRestreint.mailConfidentialiteId,
    organigrammeId: achats.organigrammeId,
  });

  // 2. Validé + imputé => parapheur de l'agent, et file Validation (ValidationDirection=false)
  const m2 = await mk({
    title: 'Réclamation fournisseur (démo)',
    nReference: 'D0002',
    reference: 'SANTE/2026/042',
    mailType: MailType.Arrivee,
    status: MailStatus.Redaction,
    valider: true,
    date: inDays(-3),
    dateEnregistrementCourrier: inDays(-2),
    dateButoire: inDays(3), // J-3 => palier RAPPEL
    description: 'Réclamation sur le marché de fournitures.',
    destinataireExpediteur: uDirecteur,
    createdBy: uBO,
    externalEntityId: eSante.externalEntityId,
    mailNatureId: nOfficiel.mailNatureId,
    organigrammeId: achats.organigrammeId,
  });
  const hasImp = await prisma.mailInputation.findFirst({ where: { mailId: m2.mailId } });
  if (!hasImp) {
    await prisma.mailInputation.createMany({
      data: [
        {
          mailId: m2.mailId,
          userId: uAgent,
          mailInputationTypeId: MailInputationTypeId.PourSuivi,
          instructions: 'Traiter et proposer une réponse sous 48 h.',
          deadline: new Date(now.getTime() + 36 * 3_600_000), // dans la fenêtre 48 h => rappel §03.5
          createdBy: uDirecteur,
        },
        {
          mailId: m2.mailId,
          userId: uDG,
          mailInputationTypeId: MailInputationTypeId.EnCopie,
          createdBy: uDirecteur,
        },
      ],
    });
    await prisma.mailActionLog.create({
      data: {
        mailId: m2.mailId,
        actionCode: 1019,
        userGroupId: uBO,
        details: 'Contrôle du courrier effectué',
      },
    });
  }

  // 3. Traité (sort des files « en cours », visible en recherche)
  await mk({
    title: 'Accusé de réception (démo)',
    nReference: 'D0003',
    mailType: MailType.Arrivee,
    status: MailStatus.Traite,
    valider: true,
    validationDirection: true,
    date: inDays(-20),
    dateEnregistrementCourrier: inDays(-19),
    dateTraited: inDays(-15),
    description: 'Accusé de réception classé.',
    destinataireExpediteur: uAgent,
    createdBy: uBO,
    externalEntityId: eFinances.externalEntityId,
    organigrammeId: achats.organigrammeId,
  });

  const counts = {
    acteurs: await prisma.appUserGroup.count(),
    roles: await prisma.role.count(),
    organigramme: await prisma.organigramme.count(),
    correspondants: await prisma.externalEntity.count(),
    natures: await prisma.mailNature.count(),
    objets: await prisma.mailObjet.count(),
    confidentialites: await prisma.mailConfidentialite.count(),
    proprietes: await prisma.externalEntityCustomProperty.count(),
    courriers: await prisma.mail.count(),
    imputations: await prisma.mailInputation.count(),
  };
  console.log('Seed de démo appliqué :', JSON.stringify(counts, null, 1));
  console.log('\nComptes de démo :');
  console.log("  bo.courrier        Awa Bureau-Ordre          — Bureau d'ordre (enregistre, contrôle)");
  console.log('  agent.achats       Kouassi Agent             — Agent traitant (parapheur)');
  console.log('  directeur.achats   Fatou Directrice          — Directeur (validation)');
  console.log('  dg                 Ibrahim Directeur-Général — DG (validation)');
  console.log(`  mot de passe commun : ${DEMO_PASSWORD}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
