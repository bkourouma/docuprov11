/**
 * Substitut de `@archivage/editor/server` POUR LES TESTS JEST du serveur collaboratif
 * (`jest.mock('@archivage/editor/server', () => jest.requireActual('./editor-structure.fake'))`).
 *
 * Le vrai point d'entrée charge `sanitize-html` (htmlparser2, ESM pur) que la configuration jest
 * de l'API ne transforme pas. Ici, la validation de structure est la VRAIE (`validateYDocStructure`
 * compilée du paquet éditeur, chargée par son fichier : elle ne dépend que de Yjs et du schéma
 * Tiptap) ; seuls les exports isomorphes l'accompagnent. Exclu de la compilation (`*.fake.ts`),
 * aucun code de production n'importe ce fichier.
 */
import * as path from 'node:path';

export * from '@archivage/editor';

type Validate = (
  ydoc: unknown,
  limits?: { maxDepth?: number; maxNodes?: number },
) => { ok: true } | { ok: false; reason: string };

// eslint-disable-next-line @typescript-eslint/no-require-imports
const structure = require(
  path.join(path.dirname(require.resolve('@archivage/editor')), 'structure.js'),
) as { validateYDocStructure: Validate };

export const validateYDocStructure: Validate = structure.validateYDocStructure;
