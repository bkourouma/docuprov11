// NOTE — le script `test` n'appelle pas `jest` directement mais
// `node --experimental-vm-modules ../../node_modules/jest/bin/jest.js`.
//
// POURQUOI. `@archivage/pdf` charge pdfjs-dist (ESM pur) par un vrai `import()` dynamique
// construit via `new Function` (packages/pdf/src/rasterize.ts), seul moyen de survivre à la
// transpilation CJS. Dans la VM de Jest, ce rappel d'import échoue sans le drapeau :
// « A dynamic import callback was invoked without --experimental-vm-modules ». Toute la chaîne
// QR + OCR (test/acquisition-live.spec.ts) est donc intestable sans lui.
//
// Le chemin est relatif à la racine du dépôt parce que jest y est remonté
// (`node-linker=hoisted` dans .npmrc) et que son champ `exports` interdit
// `require.resolve('jest/bin/jest.js')`. Si le chemin devenait faux, l'échec serait bruyant
// (« Cannot find module »), pas silencieux.

/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/test'],
  testRegex: '.*\\.spec\\.ts$',
  moduleFileExtensions: ['ts', 'js', 'json'],
};
