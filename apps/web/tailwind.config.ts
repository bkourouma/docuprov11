import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    '../../packages/ui/src/**/*.{ts,tsx}',
  ],
  theme: {
    // Paliers volontairement NON personnalisés — arbitrage du chantier mobile-first
    // (2026-09-08, docs/MOBILE-CORRECTIONS.md).
    //
    // Ceux de Tailwind (640/768/1024/1280/1536) et ceux d'Ant Design
    // (576/768/992/1200/1600) ne coïncident que sur 768. Plutôt que d'aligner l'un sur
    // l'autre, la règle retenue est : **aucun préfixe responsive Tailwind dans les .tsx**
    // (il n'y en avait aucun dans les 121 fichiers au moment de l'arbitrage). Le responsive
    // transverse vit dans `app/globals.css` (couche `@media (max-width: 767px)`), le
    // responsive de composant passe par `Grid.useBreakpoint()` ou les props `xs/sm/md/lg`
    // des `Col` AntD. Un seul système de paliers, donc aucune contradiction possible.
    //
    // Si un préfixe `md:`/`lg:` devait un jour être introduit, il faudrait d'abord recopier
    // ici les paliers AntD — sans quoi `lg:` (1024) et `screens.lg` (992) divergeraient.
    extend: {},
  },
  // Disable Preflight so Tailwind's CSS reset does not clash with Ant Design's.
  corePlugins: {
    preflight: false,
  },
  plugins: [],
};

export default config;
