import { prisma } from '../db';

/** permission_level 1 = Consultation (seed). */
const CONSULTATION = 1;

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
