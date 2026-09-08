// Valeur de PHASE_DEVELOPMENT_SERVER (next/constants n'est pas résolvable en ESM).
const PHASE_DEVELOPMENT_SERVER = 'phase-development-server';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@archivage/ui', '@archivage/types'],
  eslint: { ignoreDuringBuilds: true },
  // Proxy même-origine : le navigateur appelle /api sur l'adresse par laquelle il est arrivé
  // (LAN, Tailscale, …) et Next route en interne vers l'API locale sur le port 3001.
  // → l'app est joignable depuis n'importe quelle IP sans rebuild, et seul le port 5000 doit être exposé.
  async rewrites() {
    return [
      { source: '/api/:path*', destination: 'http://127.0.0.1:3001/api/:path*' },
    ];
  },
};

// Le dev tourne sous Turbopack (compile ~3× plus vite → la fenêtre de course qui
// causait le ChunkLoadError/spinner au 1er lancement est quasi supprimée). La config
// webpack ci-dessous ne sert donc qu'au `next build` (prod) ou à un éventuel dev
// webpack de secours : sous Turbopack, la définir déclenche l'avertissement
// "Webpack is configured while Turbopack is not" → on ne l'ajoute qu'hors Turbopack.
if (!process.env.TURBOPACK) {
  nextConfig.webpack = (config, { dev }) => {
    if (dev) {
      // Garde-fou si l'on repasse en dev webpack : la 1re compilation à la demande
      // (layout racine : antd + plots + pdfjs) peut dépasser les 120 s du timeout
      // de chunk par défaut → le navigateur abandonne le chunk en plein
      // téléchargement (ChunkLoadError "(timeout)" + fichier tronqué).
      config.output.chunkLoadTimeout = 600_000;
    }
    return config;
  };
}

// Verrou anti-doublon : tout `next dev` doit passer par scripts/ensure-single-dev.mjs
// (le script "dev"), qui pose ce marqueur après avoir vérifié qu'aucun autre serveur
// n'écoute. Un `next dev` lancé directement (exec/npx) basculerait sur un port libre
// tout en écrivant dans le même .next que l'instance légitime → build corrompu,
// ChunkLoadError sur tous les chunks de pages.
export default function config(phase) {
  if (phase === PHASE_DEVELOPMENT_SERVER && process.env.ARCHIVAGE_WEB_DEV_GUARD !== '1') {
    throw new Error(
      '[apps/web] `next dev` direct refusé : lancez "pnpm dev" (racine) ou "pnpm --filter @archivage/web dev".',
    );
  }
  return nextConfig;
}
