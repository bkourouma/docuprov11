/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  moduleFileExtensions: ['ts', 'js', 'json'],
  // htmlparser2 (via sanitize-html) et ses dépendances sont publiés en ESM pur : à transformer.
  transform: {
    '^.+\\.ts$': 'ts-jest',
    '^.+\\.m?js$': ['ts-jest', { tsconfig: { allowJs: true, module: 'commonjs', target: 'ES2022' }, diagnostics: false }],
  },
  transformIgnorePatterns: [
    '/node_modules/(?!(?:\\.pnpm/[^/]+/node_modules/)?(?:htmlparser2|domhandler|domutils|dom-serializer|domelementtype|entities)/)',
  ],
};
