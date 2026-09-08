// Charge le .env AVANT tout accès à process.env. Doit être le tout premier import de l'entrée.
// L'agent tourne sur le POSTE DE SCAN, pas sur le serveur : son .env est celui posé à côté de
// l'exécutable (cwd), avec repli sur le .env du monorepo quand on le lance depuis les sources.
// dotenv n'écrase pas les variables déjà définies : un wrapper qui les exporte reste prioritaire.
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';

loadDotenv({
  path: [
    resolve(process.cwd(), '.env'),
    resolve(__dirname, '../../.env'),
    resolve(process.cwd(), '../../.env'),
  ],
});
