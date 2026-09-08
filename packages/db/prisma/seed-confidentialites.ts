/**
 * Seed des NIVEAUX DE CONFIDENTIALITÉ — `pnpm --filter @archivage/db db:seed:confidentialites`.
 *
 * Le référentiel est ORDONNÉ : c'est le `rank` qui porte la règle d'accès (l'habilitation d'un
 * utilisateur doit être de rang supérieur ou égal au niveau du document). Les libellés retenus
 * suivent l'échelle administrative courante, du plus ouvert au plus restreint.
 *
 * Les rangs sont espacés de 10 À DESSEIN : intercaler un niveau plus tard (« Diffusion restreinte »
 * entre Interne et Confidentiel) ne demandera alors aucune renumérotation, donc aucune migration
 * de données — alors qu'une suite 0,1,2,3 aurait obligé à décaler tout ce qui suit, et avec elle
 * chaque document et chaque habilitation déjà classés.
 *
 * Idempotent : chaque niveau est recherché par libellé parmi les ACTIFS avant création — même
 * garde que `seed-document-types.ts`, exigée par l'index unique partiel sur le libellé.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const NIVEAUX: Array<{ label: string; rank: number }> = [
  { label: 'Public', rank: 0 },
  { label: 'Interne', rank: 10 },
  { label: 'Confidentiel', rank: 20 },
  { label: 'Secret', rank: 30 },
];

async function main(): Promise<void> {
  let created = 0;
  for (const niveau of NIVEAUX) {
    const existing = await prisma.confidentialite.findFirst({
      where: { label: niveau.label, isActive: true },
      select: { confidentialiteId: true },
    });
    if (existing) continue;
    await prisma.confidentialite.create({ data: niveau });
    created += 1;
  }

  const total = await prisma.confidentialite.count({ where: { isActive: true } });
  console.log(
    created > 0
      ? `${created} niveau(x) de confidentialité créé(s) — ${total} actif(s) au total.`
      : `Rien à créer : les ${total} niveaux sont déjà en place.`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
