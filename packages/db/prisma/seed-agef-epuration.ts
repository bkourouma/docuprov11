/**
 * Seed AGEF — CAMPAGNE D'ÉPURATION : `pnpm --filter @archivage/db db:seed:agef:epuration`.
 *
 * Alimente l'écran « Documents épurés » en rejouant ce qu'un archiviste aurait fait à l'écran
 * « DUA expirés » : sélectionner des pièces dont la durée d'utilité administrative est atteinte,
 * et les passer à l'état « Épuré ». Rien d'autre n'est écrit — `document_state` est la seule
 * colonne que l'épuration touche (cf. `ArchivesComplianceService.purge`).
 *
 * Les DEUX écrans se partagent le même fonds : `listExpired` exclut l'état « Épuré », `listPurged`
 * ne montre que lui. Épurer, c'est donc déplacer une ligne de l'un vers l'autre — d'où le quota
 * ci-dessous, qui laisse de quoi remplir les deux.
 *
 * Deux règles du domaine sont respectées, parce que les enfreindre produirait un fonds que
 * l'application elle-même aurait refusé de créer :
 *  1. on n'épure QUE des documents dont la DUA est réellement échue — l'écran ne propose rien
 *     d'autre ;
 *  2. on n'épure PAS un document encore prêté : `purge()` le refuse et le renvoie à l'écran comme
 *     bloqué, précisément pour ne pas faire disparaître une communication en cours.
 *
 * L'épuration NE SUPPRIME RIEN : le binaire reste sur le coffre et le document reste consultable.
 * La destruction physique est une opération distincte, guidée par le mode de destruction.
 *
 * À lancer APRÈS `db:seed:agef:acquisition` et `db:seed:agef:prets`.
 * Idempotent par remplacement : relancer ramène d'abord tout le fonds à son état non épuré.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/** document_state : 0 NonArchivé, 1 Archivé, 2 Restreint, 3 Épuré, 4 Vidéo-codage. */
const ETAT_ARCHIVE = 1;
const ETAT_EPURE = 3;

/** Part des documents à DUA échue passés à l'état « Épuré ». */
const PART_EPUREE = Number(process.env.PART_EPUREE ?? 0.4);

/** Graine fixe : la même campagne d'un lancement à l'autre. */
let graine = 20260917;
function alea(): number {
  graine = (graine * 1664525 + 1013904223) % 4294967296;
  return graine / 4294967296;
}

interface Candidat {
  document_id: number;
  label: string;
  cote: string | null;
  final_fate: string | null;
  prete: boolean;
}

async function main(): Promise<void> {
  /* --- remise à zéro ------------------------------------------------------ */
  const dejaEpures = await prisma.document.count({ where: { documentState: ETAT_EPURE } });
  if (dejaEpures > 0) {
    await prisma.document.updateMany({
      where: { documentState: ETAT_EPURE },
      data: { documentState: ETAT_ARCHIVE },
    });
    console.log(`  ${dejaEpures} document(s) précédemment épuré(s) remis à l’état « Archivé ».`);
  }

  /**
   * Candidats : exactement ce que l'écran « DUA expirés » proposerait aujourd'hui. L'échéance est
   * recalculée EN SQL avec `make_interval`, comme le fait `ArchivesComplianceService`, plutôt que
   * réimplémentée ici — deux arithmétiques divergeraient tôt ou tard.
   */
  const candidats = await prisma.$queryRawUnsafe<Candidat[]>(`
    SELECT d.document_id, d.label, d.cote, ff.label AS final_fate,
           EXISTS (
             SELECT 1 FROM lending_document_detail ldd
             WHERE ldd.document_id = d.document_id AND ldd.returned_date IS NULL
           ) AS prete
    FROM document d
    JOIN document_type_life_cycle l ON l.document_type_id = d.document_type_id
    LEFT JOIN final_fate ff ON ff.final_fate_id = l.final_fate_id
    WHERE d.document_state <> ${ETAT_EPURE}
      AND (COALESCE(d.document_date, d.created_at::date)
           + make_interval(months => l.usefulness_lifespan))::date <= CURRENT_DATE
    ORDER BY d.document_id
  `);

  if (!candidats.length) {
    throw new Error(
      'Aucun document à DUA échue — lancer d’abord db:seed:agef:acquisition, qui en produit.',
    );
  }

  const bloques = candidats.filter((c) => c.prete);
  const eligibles = candidats.filter((c) => !c.prete);
  const cible = Math.max(1, Math.round(eligibles.length * PART_EPUREE));

  // Tirage déterministe sur les seuls éligibles, en gardant un mélange de sorts finaux : une liste
  // où tout part en « Conservation définitive » ne montrerait pas à quoi sert le sort final.
  const choisis = eligibles
    .map((c) => ({ c, r: alea() }))
    .sort((a, b) => a.r - b.r)
    .slice(0, cible)
    .map((x) => x.c);

  const { count } = await prisma.document.updateMany({
    where: { documentId: { in: choisis.map((c) => c.document_id) } },
    data: { documentState: ETAT_EPURE },
  });

  /* --- rapport ------------------------------------------------------------ */
  const parSort = new Map<string, number>();
  choisis.forEach((c) => {
    const k = c.final_fate ?? 'sans sort final';
    parSort.set(k, (parSort.get(k) ?? 0) + 1);
  });

  const restants = await prisma.$queryRawUnsafe<{ n: number }[]>(`
    SELECT count(*)::int AS n FROM document d
    JOIN document_type_life_cycle l ON l.document_type_id = d.document_type_id
    WHERE d.document_state <> ${ETAT_EPURE}
      AND (COALESCE(d.document_date, d.created_at::date)
           + make_interval(months => l.usefulness_lifespan))::date <= CURRENT_DATE
  `);

  console.log('\n  CAMPAGNE D’ÉPURATION AGEF :');
  console.log(`    ${candidats.length} document(s) à DUA échue au départ`);
  console.log(`    ${count} épuré(s) → « Documents épurés »`);
  [...parSort.entries()]
    .sort((a, b) => b[1] - a[1])
    .forEach(([sort, n]) => console.log(`        ${String(n).padStart(3)} — ${sort}`));
  console.log(`    ${restants[0]!.n} restant(s) → « DUA expirés »`);
  if (bloques.length) {
    console.log(`    ${bloques.length} écarté(s) car encore prêté(s) — ce que purge() refuserait :`);
    bloques.slice(0, 5).forEach((b) => console.log(`        ${b.cote ?? b.document_id} — ${b.label.slice(0, 64)}`));
  }
  console.log(
    '\n    Rappel : l’épuration ne supprime rien. Les binaires restent sur le coffre et les' +
      '\n    documents restent consultables ; la destruction physique est une opération distincte.\n',
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
