import { prisma } from '../db';

/**
 * permission_level 2 = Consultation.
 *
 * Valait 1 jusqu'à la renumérotation du référentiel (migration des niveaux de permission) : le
 * niveau 1 est désormais `Denied`, le seul qui RETIRE un accès. Le worker posait donc un refus
 * explicite sur chaque document qu'il ingérait, au nom de son propre groupe créateur — l'inverse
 * exact de ce que cette fonction annonce. Ne pas revenir à 1 : `canAccess` et la recherche
 * traitent ce niveau comme un refus opposable, qui l'emporte même sur le passe-droit du créateur.
 */
const CONSULTATION = 2;

/** Auto-grant Consultation on a freshly-created document to its creating group (FR-029). */
export async function grantConsultation(documentId: number, userGroupId: number): Promise<void> {
  await prisma.documentPermission.upsert({
    where: {
      documentId_userGroupId_permissionLevelId: {
        documentId,
        userGroupId,
        permissionLevelId: CONSULTATION,
      },
    },
    update: {},
    create: { documentId, userGroupId, permissionLevelId: CONSULTATION, grantedBy: userGroupId },
  });
}
