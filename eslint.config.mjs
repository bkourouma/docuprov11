import base from '@archivage/config/eslint';

/** Root ESLint flat config — delegates to the shared base in packages/config. */
export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/coverage/**',
      'packages/db/generated/**',
      'storage/**',
    ],
  },
  ...base,
];
