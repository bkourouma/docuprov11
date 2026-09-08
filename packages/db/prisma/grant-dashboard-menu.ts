/**
 * Attribution de la permission « Tableau de bord courrier » aux rôles existants.
 *   Attribuer : `pnpm --filter @archivage/db db:grant:dashboard`
 *   Retirer   : `pnpm --filter @archivage/db db:grant:dashboard -- --revoke`
 *   Simuler   : `pnpm --filter @archivage/db db:grant:dashboard -- --dry-run`
 *
 * POURQUOI. La clé `/courriers/tableau-de-bord` a été ajoutée au catalogue et au seed, mais un
 * seed ne rétro-attribue rien : les rôles déjà en base ne la portent pas, et l'écran reste
 * invisible pour tout le monde sauf l'administrateur (qui contourne la garde).
 *
 * CRITÈRE. Seuls les rôles disposant déjà d'une permission de SUIVI (`/courriers/suivi` ou
 * `/courriers/suivi-dc`) sont servis. Ce n'est pas arbitraire : le contenu du tableau de bord est
 * entièrement gouverné par ce périmètre (`MailScope`). L'accorder à un rôle qui n'a ni l'une ni
 * l'autre lui ouvrirait un écran structurellement VIDE — une fausse promesse, pas un droit.
 *
 * Les rôles système sont ignorés : ils reçoivent toutes les clés implicitement.
 *
 * SÛRETÉ. Idempotent (unique sur `[roleId, menuKey]`), réversible, et il n'écrit QUE cette clé :
 * aucune autre permission n'est touchée.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const CLE_TABLEAU_DE_BORD = '/courriers/tableau-de-bord';
const CLES_SUIVI = ['/courriers/suivi', '/courriers/suivi-dc'];

async function principal(): Promise<void> {
  const revoke = process.argv.includes('--revoke');
  const dryRun = process.argv.includes('--dry-run');

  if (revoke) {
    const { count } = await prisma.roleMenuPermission.deleteMany({
      where: { menuKey: CLE_TABLEAU_DE_BORD },
    });
    console.log(`\n  Permission retirée de ${count} rôle(s).\n`);
    return;
  }

  const roles = await prisma.role.findMany({
    where: { isActive: true, isSystem: false },
    select: { roleId: true, name: true, menus: { select: { menuKey: true } } },
    orderBy: { name: 'asc' },
  });

  const servis: string[] = [];
  const ignores: string[] = [];

  for (const role of roles) {
    const cles = role.menus.map((m) => m.menuKey);
    if (cles.includes(CLE_TABLEAU_DE_BORD)) {
      servis.push(`${role.name} (déjà accordée)`);
      continue;
    }
    if (!CLES_SUIVI.some((k) => cles.includes(k))) {
      ignores.push(role.name);
      continue;
    }
    if (!dryRun) {
      await prisma.roleMenuPermission.create({
        data: { roleId: role.roleId, menuKey: CLE_TABLEAU_DE_BORD },
      });
    }
    servis.push(role.name);
  }

  console.log(`\n  ${dryRun ? '[SIMULATION] ' : ''}Permission « Tableau de bord courrier »`);
  for (const nom of servis) console.log(`   ✓ ${nom}`);
  for (const nom of ignores) {
    console.log(`   · ${nom} — ignoré : aucune permission de suivi, l'écran serait vide`);
  }
  console.log(`\n  Retrait : db:grant:dashboard -- --revoke\n`);
}

principal()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
