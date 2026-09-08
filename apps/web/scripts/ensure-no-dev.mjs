// Garde-fou du script "build" : refuse `next build` pendant qu'un serveur de dev
// écoute. Build et dev partagent apps/web/.next (build-manifest, server/, static/) ;
// un build concurrent casse le serveur de dev (ChunkLoadError) et le dev peut
// empoisonner le build produit.
import net from 'node:net';

const PORT = 5000;

const probe = net.connect({ port: PORT, host: '127.0.0.1' });

const timer = setTimeout(() => probe.destroy(), 2000);

probe.on('connect', () => {
  clearTimeout(timer);
  probe.destroy();
  process.stderr.write(
    `\n[ensure-no-dev] Un serveur de dev écoute sur le port ${PORT} — build refusé.\n` +
      `[ensure-no-dev] Build et dev partagent apps/web/.next et s'écrasent mutuellement.\n` +
      `[ensure-no-dev] Arrêtez le serveur de dev (Ctrl+C sur pnpm dev) puis relancez le build.\n\n`,
  );
  process.exitCode = 1;
});

// Rien n'écoute → build autorisé.
probe.on('error', () => {
  clearTimeout(timer);
  probe.destroy();
});
