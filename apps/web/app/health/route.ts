export const dynamic = 'force-dynamic';

/** Liveness du front — indépendant de l'API (le rewrite /api est sondé à part). */
export function GET(): Response {
  return Response.json({ status: 'ok' });
}
