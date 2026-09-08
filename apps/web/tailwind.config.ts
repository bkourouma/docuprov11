import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    '../../packages/ui/src/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {},
  },
  // Disable Preflight so Tailwind's CSS reset does not clash with Ant Design's.
  corePlugins: {
    preflight: false,
  },
  plugins: [],
};

export default config;
