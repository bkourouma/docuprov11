// Lanceur unique du serveur de dev web (script "dev").
// 1) Refuse de démarrer si un serveur écoute déjà sur le port : deux `next dev`
//    partageraient .next (cache webpack + manifests, mono-écrivain) et corrompraient
//    le build → ChunkLoadError sur tous les chunks de pages.
// 2) Sinon lance `next dev -p <PORT>` en posant le marqueur ARCHIVAGE_WEB_DEV_GUARD,
//    exigé par next.config.mjs en phase de dev : un `next dev` lancé par un autre
//    chemin (exec/npx, tâche IDE…) échoue au chargement de la config, avant tout
//    accès à .next.
// NB : le `-p` explicite est porteur. Avec un port explicite, Next 15 ne fait aucun
// retry EADDRINUSE (allowRetry=false) : le perdant d'un double démarrage simultané
// s'arrête net au lieu de basculer silencieusement sur 3001+ et d'écrire dans .next.
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const PORT = 5000;
const require = createRequire(import.meta.url);

const probe = net.connect({ port: PORT, host: '127.0.0.1' });

// Filet de sécurité : ne jamais bloquer le démarrage plus de 2 s (fail-open).
const timer = setTimeout(() => {
  probe.destroy();
  startNext();
}, 2000);

probe.on('connect', () => {
  clearTimeout(timer);
  probe.destroy();
  process.stderr.write(
    `\n[ensure-single-dev] Le port ${PORT} est déjà occupé — démarrage refusé.\n` +
      `[ensure-single-dev] Deux "next dev" simultanés corrompent apps/web/.next (ChunkLoadError).\n` +
      `[ensure-single-dev] Identifiez d'abord le propriétaire du port :\n` +
      `[ensure-single-dev]   Get-Process -Id (Get-NetTCPConnection -LocalPort ${PORT} -State Listen).OwningProcess | Select Id,ProcessName,Path\n` +
      `[ensure-single-dev] Puis, si c'est bien un node/next orphelin, libérez le port et relancez :\n` +
      `[ensure-single-dev]   Get-NetTCPConnection -LocalPort ${PORT} -State Listen | % { Stop-Process -Id $_.OwningProcess -Force }\n\n`,
  );
  process.exitCode = 1;
});

// Rien n'écoute (ECONNREFUSED) → la voie est libre.
probe.on('error', () => {
  clearTimeout(timer);
  probe.destroy();
  startNext();
});

function startNext() {
  const child = spawn(
    process.execPath,
    // --turbopack : compile la route lourde (dashboards, ~6400 modules) en ~13 s au
    // lieu de ~37 s sous webpack. Cette rapidité est ce qui supprime la course
    // compile/navigation à l'origine du ChunkLoadError puis du spinner bloqué au 1er
    // lancement. Le `next build` (prod) reste sur webpack.
    [require.resolve('next/dist/bin/next'), 'dev', '--turbopack', '-p', String(PORT)],
    { stdio: 'inherit', env: { ...process.env, ARCHIVAGE_WEB_DEV_GUARD: '1' } },
  );
  child.on('exit', (code, signal) => {
    process.exitCode = signal ? 1 : (code ?? 1);
  });
  prewarm(child);
}

// Pré-chauffage : Next compile chaque page à la demande, donc sans cette étape la
// toute première visite du navigateur déclenche la compilation du layout racine
// (antd + plots + pdfjs), longue au point de frôler le timeout de chunk côté
// navigateur. Dès que le serveur écoute, on demande "/" nous-mêmes pour que la
// compilation démarre au lancement du serveur, pas à l'arrivée de l'utilisateur.
// "/login" puis "/dashboards" sont chauffées à la suite : AuthShell redirige toute
// première visite vers /login, et la connexion redirige vers /dashboards — sans ces
// warms, chaque redirection attendrait une compilation à la demande (et une
// navigation client lancée pendant une compilation peut être avalée par le rebuild
// HMR, cf. replaceWithFallback dans AuthShell).
function prewarm(child) {
  let attempts = 0;
  const timer = setInterval(() => {
    if (child.exitCode !== null || ++attempts > 120) {
      clearInterval(timer);
      return;
    }
    const probe = net.connect({ port: PORT, host: '127.0.0.1' });
    probe.on('connect', () => {
      probe.destroy();
      clearInterval(timer);
      warm('/', () => warm('/login', () => warm('/dashboards')));
    });
    probe.on('error', () => probe.destroy());
  }, 1000);
  timer.unref();
}

function warm(path, done) {
  const req = http.get(`http://127.0.0.1:${PORT}${path}`, (res) => {
    res.resume();
    res.on('end', () => done?.());
  });
  req.setTimeout(600_000, () => req.destroy());
  req.on('error', () => done?.());
}
