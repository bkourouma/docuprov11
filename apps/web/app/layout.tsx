import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { AntdRegistry } from '@ant-design/nextjs-registry';
import { GeistMono } from 'geist/font/mono';
import { Archivo } from 'next/font/google';
import { Providers } from './components/Providers';
import { AuthShell } from './components/AuthShell';
import './globals.css';
import { CLIENT_BRAND } from './theme/client-brand';

// Archivo — famille unique du design « Registre », en fonte VARIABLE : graisse et largeur.
// L'axe de largeur (`wdth`) est ce qui fait la voix du registre : étroite pour les titres
// d'écran et les en-têtes de colonne en capitales, normale pour le texte. Sous-ensemble latin
// étendu pour les diacritiques français ; swap pour éviter le FOUT.
// `--font-display` et `--font-geist-sans` sont des alias posés dans globals.css.
const archivo = Archivo({
  subsets: ['latin', 'latin-ext'],
  display: 'swap',
  variable: '--font-sans',
  axes: ['wdth'],
});

export const metadata: Metadata = {
  // Onglet co-brandé quand l'instance est dédiée à une organisation : c'est le
  // premier repère visible en vidéoprojection, avant même le contenu de la page.
  title: CLIENT_BRAND ? `DocuPro — ${CLIENT_BRAND.shortName}` : 'DocuPro',
  description: "Génération d'intercalaires, acquisition par lot, recherche & export",
};

/**
 * Fenêtre d'affichage. Sans cet export, la balise `viewport` injectée par défaut suffit à
 * l'échelle mais rien ne garantit le contrat : on le déclare explicitement.
 *
 * `maximumScale` et `userScalable` sont VOLONTAIREMENT absents. Les poser (pour empêcher le
 * zoom iOS au focus d'un champ) interdirait à l'utilisateur d'agrandir la page — une
 * régression d'accessibilité. Le zoom au focus est traité à la source, en portant la police
 * des champs à 16 px sous 768 px (`globals.css`, couche mobile §h).
 */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="fr" data-theme="light" className={`${archivo.variable} ${GeistMono.variable}`}>
      <body>
        {/*
          Filet de sécurité (surtout en dev) : automatise le rechargement forcé que
          l'utilisateur faisait à la main (Ctrl+F5). Une ChunkLoadError résiduelle —
          onglet resté ouvert après un redémarrage du serveur (le client HMR périmé
          référence des chunks d'un build disparu), ou chunk tronqué — laisse la page
          bloquée. Ce script, exécuté avant l'hydratation, l'intercepte et recharge la
          page UNE fois (garde anti-boucle de 15 s via sessionStorage), au lieu de
          rester coincé. En prod, ne se déclenche que sur des chunks périmés après un
          déploiement — cas où un rechargement unique est également la bonne réponse.

          `dangerouslySetInnerHTML` est le seul moyen d'injecter un script INLINE devant
          s'exécuter avant l'hydratation : le contenu est une constante littérale écrite ici,
          aucune donnée extérieure n'y entre.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){var K="__chunkReloadAt";function isChunk(e){var r=e&&(e.reason||e);var m=((r&&(r.message||r))||"")+"";var n=((r&&r.name)||"")+"";return n==="ChunkLoadError"||/ChunkLoadError|Loading (chunk|CSS chunk)/i.test(m);}function go(e){if(!isChunk(e))return;var t=Date.now(),l=0;try{l=+sessionStorage.getItem(K)||0;}catch(_){}if(t-l<15000)return;try{sessionStorage.setItem(K,String(t));}catch(_){}location.reload();}addEventListener("error",go,true);addEventListener("unhandledrejection",go);})();`,
          }}
        />
        <AntdRegistry>
          <Providers>
            <AuthShell>{children}</AuthShell>
          </Providers>
        </AntdRegistry>
      </body>
    </html>
  );
}
