import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Renumérote `permission_level` pour distinguer explicitement l'ABSENCE de droit (Denied) de la
 * Consultation — jusqu'ici le niveau 1 portait « Consultation », ce qui ne permettait pas de dire
 * « aucun accès ». Nouvelle échelle (2026-08-04, cf. mémo `docupro-v6-permission-levels-enforcement`) :
 *   1 Denied (jamais accordable — exclu des écrans d'octroi), 2 Consultation, 3 Modification,
 *   4 Administration, 5 Archivistique.
 *
 * Remap AVANT rename : les droits déjà accordés au niveau 1 (Consultation — seul niveau utilisé
 * jusqu'ici, cf. audit du 2026-08-04 : 0 ligne à 2/4/5) doivent glisser au niveau 2 pour conserver
 * leur sens, sinon le seul effet du renommage les ferait basculer à « Denied ». Idempotent :
 * rejouable sans effet une fois les données déjà migrées (les `updateMany` ne trouvent alors plus
 * rien au niveau 1, et les renames sont déjà en place).
 */
async function main() {
  const movedPermissions = await prisma.documentPermission.updateMany({
    where: { permissionLevelId: 1 },
    data: { permissionLevelId: 2 },
  });
  const movedTypePermissions = await prisma.documentTypePermission.updateMany({
    where: { permissionLevelId: 1 },
    data: { permissionLevelId: 2 },
  });
  const movedInquiries = await prisma.documentAccessInquiry.updateMany({
    where: { permissionLevelId: 1 },
    data: { permissionLevelId: 2 },
  });

  const names: Record<number, string> = {
    1: 'Denied',
    2: 'Consultation',
    3: 'Modification',
    4: 'Administration',
    5: 'Archivistique',
  };
  for (const [id, name] of Object.entries(names)) {
    await prisma.permissionLevel.update({
      where: { permissionLevelId: Number(id) },
      data: { name },
    });
  }

  console.log(`document_permission remappés (1→2) : ${movedPermissions.count}`);
  console.log(`document_type_permission remappés (1→2) : ${movedTypePermissions.count}`);
  console.log(`document_access_inquiry remappés (1→2) : ${movedInquiries.count}`);
  console.log('Niveaux renommés :', names);
}

main().finally(() => prisma.$disconnect());
