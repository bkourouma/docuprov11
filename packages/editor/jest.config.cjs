/**
 * Certaines dépendances sont publiées en ESM pur (sanitize-html 2.18 -> htmlparser2 12, et
 * happy-dom, requis par @tiptap/html/server). Jest (CommonJS) ne sait pas les charger tel quel :
 * on les fait transpiler en CJS par ts-jest. Aucun effet sur le build (tsc) ni sur le runtime.
 */
const ESM_ONLY = [
  'htmlparser2',
  'domhandler',
  'domutils',
  'dom-serializer',
  'domelementtype',
  'entities',
  'happy-dom',
  'whatwg-mimetype',
  'uuid',
].join('|');

/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testRegex: '.*\\.(test|spec)\\.ts$',
  moduleFileExtensions: ['ts', 'js', 'mjs', 'cjs', 'json'],
  transform: {
    '^.+\\.(ts|js|mjs)$': ['ts-jest', { tsconfig: { allowJs: true, esModuleInterop: true } }],
  },
  transformIgnorePatterns: [`/node_modules/(?!(?:\\.pnpm/)?(?:${ESM_ONLY})(?:/|@))`],
  testTimeout: 30000,
};
