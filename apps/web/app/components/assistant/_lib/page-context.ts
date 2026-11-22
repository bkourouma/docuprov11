// Contexte de page de l'assistant : déduit du chemin courant (logique pure, sans React ni DOM).
// Le contexte est une DONNÉE envoyée au serveur, qui revérifie les droits ; on n'y met jamais de query string.
import type { AsstPageContext } from '@archivage/types';

const ROUTE_MAX = 200;
const ID_RE = /^\d{1,18}$/;
const MAIL_SECTIONS = new Set(['controle', 'parapheur', 'recherche', 'suivi']);

/** Normalise un chemin : sans query/hash/slash final, commence par '/', tronqué ; null si inexploitable. */
function normalizePath(pathname: string): string | null {
  if (typeof pathname !== 'string') return null;
  let p = pathname.trim();
  const cut = p.search(/[?#]/);
  if (cut >= 0) p = p.slice(0, cut);
  if (!p.startsWith('/')) return null;
  p = p.replace(/\/+$/, '');
  if (p === '') p = '/';
  return p.slice(0, ROUTE_MAX);
}

/** Contexte de la page courante, ou null (chaîne vide, chemin invalide, /login). */
export function pageContextFromPath(pathname: string): AsstPageContext | null {
  const path = normalizePath(pathname);
  if (path === null) return null;
  if (path === '/login' || path.startsWith('/login/')) return null;

  const seg = path.split('/').slice(1);
  // Identifiant invalide : route seule, jamais un sujet invalide.
  const withSubject = (route: string, subjectType: string, id: string): AsstPageContext =>
    ID_RE.test(id) ? { route, subjectType, subjectId: id } : { route };

  if (seg.length === 3 && seg[0] === 'courriers' && MAIL_SECTIONS.has(seg[1]!)) {
    return withSubject(`/courriers/${seg[1]}`, 'mail', seg[2]!);
  }
  if (seg.length === 2 && seg[0] === 'documents') return withSubject('/documents', 'document', seg[1]!);
  if (seg.length === 2 && seg[0] === 'editeur' && seg[1] !== 'nouveau') {
    return withSubject('/editeur', 'document', seg[1]!);
  }
  if (seg.length === 2 && seg[0] === 'espaces') return withSubject('/espaces', 'space', seg[1]!);
  return { route: path };
}

/** Libellé court affiché (« courrier n° 4321 ») ; null sans sujet. */
export function describePageContext(ctx: AsstPageContext | null): string | null {
  if (!ctx || !ctx.subjectId) return null;
  switch (ctx.subjectType) {
    case 'mail':
      return `courrier n° ${ctx.subjectId}`;
    case 'document':
      return `document n° ${ctx.subjectId}`;
    case 'space':
      return `espace n° ${ctx.subjectId}`;
    default:
      return null;
  }
}
