import {
  COMMENTS_KEY,
  EDITOR_FRAGMENT,
  MENTION_NODE_NAME,
  extractMentionIds,
} from '@archivage/editor';
import * as Y from 'yjs';

/**
 * Attribution côté serveur dans une salle collaborative :
 *  - MENTIONS : chaque transaction est comparée avant/après ; les ids de mention qu'elle INTRODUIT
 *    sont attribués à l'auteur authentifié de cette transaction (jamais à un autre) ;
 *  - COMMENTAIRES : l'identité de l'auteur (`authorUserGroupId`, `authorName`) d'un nouveau
 *    commentaire ou d'une nouvelle réponse, et `resolvedByName` à la résolution, sont réécrits avec
 *    l'identité authentifiée de la connexion ; l'identité d'un commentaire existant est immuable.
 *
 * Fonctions pures sur un `Y.Doc` (aucune dépendance Nest) : le service les branche sur la salle.
 */

/** Identité authentifiée imposée aux commentaires. */
export interface CollabIdentity {
  /** `user_group_id` de l'auteur ; 0 si l'utilisateur n'en a pas (lu comme « auteur invalide »). */
  userGroupId: number;
  name: string;
}

/**
 * Origine des corrections écrites par le serveur. Forme d'une origine Hocuspocus « locale »
 * (diffusée aux clients, persistée) sans utilisateur : ni version, ni attribution, ni boucle.
 */
export const SERVER_FIX_ORIGIN = Object.freeze({
  source: 'local' as const,
  context: Object.freeze({}),
});

const AUTHOR_KEYS = ['authorUserGroupId', 'authorName'] as const;

// ------------------------------------------------------------------------------------ mentions

function isElement(value: unknown): value is Y.XmlElement {
  return value instanceof Y.XmlElement;
}

/** Une structure qui peut ajouter/retirer une mention : nouvel élément, ou attribut d'une mention. */
function touchesMention(struct: Y.Item | Y.GC): boolean {
  if (!(struct instanceof Y.Item)) return false;
  if (struct.content instanceof Y.ContentType && isElement(struct.content.type)) return true;
  const parent = struct.parent;
  return isElement(parent) && parent.nodeName === MENTION_NODE_NAME;
}

/**
 * Suivi des mentions d'une salle. Le coût est borné : la liste complète (`extractMentionIds`,
 * proportionnelle au document) n'est recalculée que si la transaction touche les commentaires ou
 * insère/supprime un ÉLÉMENT du texte (paragraphe, mention…) ou un attribut de mention — pas à
 * chaque caractère tapé.
 *
 * Retirer une mention supprime toujours un élément (ou un attribut de mention, ou touche les
 * commentaires) : l'ensemble connu reste exact, et un id retiré puis réintroduit par un autre
 * auteur est attribué à ce dernier. En cas de doute, une mention peut ne pas être renotifiée ;
 * elle n'est jamais attribuée à tort.
 */
export class MentionTracker {
  private known: Set<number>;
  /** Nombre de recalculs complets depuis la création (mesure du coût, testée). */
  fullScans = 0;

  constructor(private readonly doc: Y.Doc) {
    this.known = new Set(extractMentionIds(doc));
  }

  /** Ids de mention introduits par cette transaction (à attribuer à son auteur). */
  added(transaction: Y.Transaction): number[] {
    if (!this.isRelevant(transaction)) return [];
    this.fullScans += 1;
    const now = extractMentionIds(this.doc);
    const added = now.filter((id) => !this.known.has(id));
    this.known = new Set(now);
    return added;
  }

  private isRelevant(tr: Y.Transaction): boolean {
    // Types modifiés par la transaction ET leurs ancêtres (racines comprises).
    const changed: ReadonlyMap<unknown, unknown> = tr.changedParentTypes;
    if (changed.has(this.doc.getMap(COMMENTS_KEY))) return true;
    if (!changed.has(this.doc.getXmlFragment(EDITOR_FRAGMENT))) return false;
    // Structures créées par la transaction : [beforeState, afterState) pour chaque client.
    for (const [client, after] of tr.afterState) {
      const before = tr.beforeState.get(client) ?? 0;
      if (after <= before) continue;
      const structs = this.doc.store.clients.get(client);
      if (!structs || structs.length === 0) continue;
      for (let i = Y.findIndexSS(structs, before); i < structs.length; i += 1) {
        const struct = structs[i];
        if (struct.id.clock >= after) break;
        if (touchesMention(struct)) return true;
      }
    }
    let removed = false;
    Y.iterateDeletedStructs(tr, tr.deleteSet, (struct) => {
      if (!removed && touchesMention(struct as Y.Item | Y.GC)) removed = true;
    });
    return removed;
  }
}

// -------------------------------------------------------------------------------- commentaires

function setIfDifferent(map: Y.Map<unknown>, key: string, value: unknown): void {
  if (map.get(key) !== value) map.set(key, value);
}

function stampAuthor(map: Y.Map<unknown>, identity: CollabIdentity): void {
  setIfDifferent(map, 'authorUserGroupId', identity.userGroupId);
  setIfDifferent(map, 'authorName', identity.name);
}

function stampResolution(comment: Y.Map<unknown>, identity: CollabIdentity): void {
  setIfDifferent(comment, 'resolvedByName', comment.get('resolved') === true ? identity.name : null);
}

/** Rétablit la valeur d'avant la transaction (clé absente avant : supprimée). */
function revert(map: Y.Map<unknown>, key: string, oldValue: unknown): void {
  if (oldValue === undefined) {
    if (map.has(key)) map.delete(key);
  } else {
    setIfDifferent(map, key, oldValue);
  }
}

function stampReplies(replies: unknown, identity: CollabIdentity): void {
  if (!(replies instanceof Y.Array)) return;
  for (const reply of replies.toArray()) {
    if (reply instanceof Y.Map) stampAuthor(reply as Y.Map<unknown>, identity);
  }
}

/**
 * Branche la garde d'identité des commentaires sur `doc`. `identityOf(origin)` renvoie l'identité
 * authentifiée d'une transaction CLIENT, ou `null` (écriture serveur : laissée telle quelle).
 * Les corrections sont écrites dans une transaction distincte d'origine `SERVER_FIX_ORIGIN` :
 * la modification fautive est déjà diffusée, la correction la suit aussitôt et c'est elle qui
 * est persistée.
 *
 * Limites (documentées) : un écrivain peut toujours SUPPRIMER un commentaire ou en modifier le
 * corps (droit d'écriture sur le document) ; seule l'identité est garantie. Un utilisateur sans
 * `user_group_id` est enregistré avec l'id 0 (lu comme auteur invalide), son nom restant exact.
 */
export function installCommentIdentityGuard(
  doc: Y.Doc,
  identityOf: (origin: unknown) => CollabIdentity | null,
  onError: (error: unknown) => void = () => undefined,
): () => void {
  const comments = doc.getMap<unknown>(COMMENTS_KEY);
  const isComment = (t: unknown): t is Y.Map<unknown> => t instanceof Y.Map && t.parent === comments;
  const isReplies = (t: unknown): t is Y.Array<unknown> => t instanceof Y.Array && isComment(t.parent);
  const isReply = (t: unknown): t is Y.Map<unknown> => t instanceof Y.Map && isReplies(t.parent);

  const handler = (events: Array<Y.YEvent<Y.AbstractType<unknown>>>, tr: Y.Transaction): void => {
    // Une exception d'observateur remonterait dans la transaction Yjs (et fermerait la connexion).
    try {
      enforce(events, tr);
    } catch (error) {
      onError(error);
    }
  };

  const enforce = (events: Array<Y.YEvent<Y.AbstractType<unknown>>>, tr: Y.Transaction): void => {
    if (tr.origin === SERVER_FIX_ORIGIN) return;
    const identity = identityOf(tr.origin);
    if (!identity) return;
    const fixes: Array<() => void> = [];
    for (const event of events) {
      const target: unknown = event.target;
      if (target === comments) {
        // Nouveau commentaire (ou remplacement d'une entrée) : il appartient à cette connexion.
        event.changes.keys.forEach((change, key) => {
          if (change.action === 'delete') return;
          const comment = comments.get(key);
          if (!(comment instanceof Y.Map)) return;
          const map = comment as Y.Map<unknown>;
          fixes.push(() => {
            stampAuthor(map, identity);
            stampResolution(map, identity);
            stampReplies(map.get('replies'), identity);
          });
        });
      } else if (isComment(target)) {
        const keys = event.changes.keys;
        for (const key of AUTHOR_KEYS) {
          const change = keys.get(key);
          if (change) fixes.push(() => revert(target, key, change.oldValue));
        }
        const byName = keys.get('resolvedByName');
        if (keys.has('resolved')) fixes.push(() => stampResolution(target, identity));
        else if (byName) fixes.push(() => revert(target, 'resolvedByName', byName.oldValue));
        const replies = keys.get('replies');
        if (replies && replies.action !== 'delete') {
          fixes.push(() => stampReplies(target.get('replies'), identity));
        }
      } else if (isReplies(target)) {
        for (const item of event.changes.added) {
          for (const reply of item.content.getContent()) {
            if (reply instanceof Y.Map) fixes.push(() => stampAuthor(reply as Y.Map<unknown>, identity));
          }
        }
      } else if (isReply(target)) {
        for (const key of AUTHOR_KEYS) {
          const change = event.changes.keys.get(key);
          if (change) fixes.push(() => revert(target, key, change.oldValue));
        }
      }
    }
    if (fixes.length > 0) doc.transact(() => fixes.forEach((fix) => fix()), SERVER_FIX_ORIGIN);
  };
  comments.observeDeep(handler);
  return () => comments.unobserveDeep(handler);
}
