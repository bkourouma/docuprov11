/**
 * Pilotage manuel de la pile E2E :
 *   tsx support/cli.ts up                      monte (ou réutilise) la pile et rend la main
 *   tsx support/cli.ts up --fresh              remonte de zéro (base neuve, processus relancés)
 *   tsx support/cli.ts build                   builds seuls (API, worker, web de la pile), sans démarrer
 *   tsx support/cli.ts down                    arrête la pile
 *   tsx support/cli.ts status                  état des services
 *   tsx support/cli.ts restart api|worker|web|all   rebuild ciblé + redémarrage, base conservée
 *   tsx support/cli.ts procs                   processus de cette copie de travail (diagnostic)
 * Les ports viennent de E2E_API_PORT / E2E_WEB_PORT / E2E_PG_PORT / E2E_REDIS_URL.
 */
import { prepareAdmin } from './admin';
import { listRepoProcesses } from './stack/proc';
import { buildApiAndWorker, buildWebIfNeeded, ensurePrismaClient } from './stack/services';
import { restartService, stackDown, stackStatus, stackUp, type ServiceName } from './stack';

async function main(): Promise<void> {
  const [cmd, arg] = process.argv.slice(2);
  switch (cmd) {
    case 'up': {
      await stackUp({ forceFresh: arg === '--fresh' });
      await prepareAdmin();
      console.log(await stackStatus());
      break;
    }
    case 'build': {
      // Builds seuls (API, worker, web de cette pile), sans base ni démarrage : préchauffe.
      await ensurePrismaClient();
      await buildApiAndWorker();
      console.log((await buildWebIfNeeded()) ? '[e2e] build web fait' : '[e2e] build web déjà à jour');
      break;
    }
    case 'down':
      await stackDown();
      break;
    case 'status':
      console.log(await stackStatus());
      break;
    case 'restart': {
      const target = (arg ?? 'all') as ServiceName | 'all';
      if (!['api', 'worker', 'web', 'all'].includes(target)) throw new Error(`cible inconnue : ${target}`);
      await restartService(target);
      console.log(await stackStatus());
      break;
    }
    case 'procs': {
      const procs = listRepoProcesses();
      console.log(procs.length ? procs.map((p) => `${p.pid}\t${p.cmd}`).join('\n') : '(aucun processus de cette copie de travail)');
      break;
    }
    default:
      console.log('usage : tsx support/cli.ts up [--fresh] | build | down | status | restart <api|worker|web|all> | procs');
      process.exitCode = 2;
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
