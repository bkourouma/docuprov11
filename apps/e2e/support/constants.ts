/**
 * Identifiants de l'administrateur de la pile E2E.
 *
 * Le seed de base crée `admin` / `admin1234` avec changement de mot de passe forcé ; le global
 * setup change ce mot de passe pour ADMIN_PASSWORD par l'API (ce qui lève l'obligation), si bien
 * que l'administrateur est directement utilisable par les tests. Valeur de test, pas un secret.
 */
export const ADMIN_USER = 'admin';
export const ADMIN_PASSWORD = 'E2e-Admin-2026';
/** Mot de passe posé par packages/db/prisma/seed.ts (avant le changement fait par le setup). */
export const SEED_ADMIN_PASSWORD = 'admin1234';
