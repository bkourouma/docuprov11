/**
 * Garde de page du smoke : relève les réponses 5xx, les exceptions non rattrapées et les erreurs
 * console pendant qu'une page se charge, pour les vérifier en une assertion.
 *
 * Une erreur console n'est tolérée que si elle figure dans IGNORED_CONSOLE avec sa raison : toute
 * autre est une anomalie à corriger (ou à documenter ici, justification à l'appui).
 */
import type { Page } from '@playwright/test';

const IGNORED_CONSOLE: Array<{ pattern: RegExp; reason: string }> = [
  // Navigateur : une ressource absente (favicon de déploiement, image décorative) n'empêche rien.
  // Les 4xx/5xx des appels /api, eux, sont relevés par l'écoute des réponses, pas ici.
  { pattern: /^Failed to load resource: the server responded with a status of 404/, reason: 'ressource statique absente (4xx relevés à part)' },
];

export interface PageProblems {
  serverErrors: string[];
  pageErrors: string[];
  consoleErrors: string[];
}

export function watchPage(page: Page): PageProblems {
  const problems: PageProblems = { serverErrors: [], pageErrors: [], consoleErrors: [] };
  page.on('response', (res) => {
    if (res.status() >= 500) problems.serverErrors.push(`${res.status()} ${res.request().method()} ${res.url()}`);
  });
  page.on('pageerror', (err) => problems.pageErrors.push(err.stack ?? err.message));
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (IGNORED_CONSOLE.some((i) => i.pattern.test(text))) return;
    problems.consoleErrors.push(`${text} (${msg.location().url})`);
  });
  return problems;
}
