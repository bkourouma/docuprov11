import * as Y from 'yjs';

/**
 * Garde des mises à jour Yjs entrantes : une mise à jour BIEN FORMÉE mais dont les dépendances
 * manquent (2e modification d'un client envoyée sans la 1re, référence à un élément inconnu,
 * suppression de contenu inconnu) n'est pas rejetée par Yjs : elle reste « en attente »
 * (`doc.store.pendingStructs` / `pendingDs`) et `Y.encodeStateAsUpdate` la RECOPIE dans l'état
 * encodé. L'état de travail, les versions et la synchronisation des autres clients hériteraient
 * alors d'un état jamais intégrable : c'est pourquoi la mise à jour est écartée AVANT application.
 *
 * Un client légitime ne produit jamais une telle mise à jour : il ne connaît que ce que le serveur
 * lui a transmis et sa sync step 2 contient tout ce qui manque au serveur.
 */

export type StateVector = Map<number, number>;

/** Vecteur d'état (client -> prochaine horloge attendue) du document. */
export function stateVectorOf(doc: Y.Doc): StateVector {
  return Y.decodeStateVector(Y.encodeStateVector(doc));
}

/**
 * Vérifie qu'une mise à jour (format v1) s'intégrera ENTIÈREMENT dans un document de vecteur
 * d'état `sv`. Renvoie `null` si c'est le cas, sinon le motif (journalisable, sans contenu).
 * Ne jette jamais (une mise à jour illisible renvoie un motif).
 */
export function findMissingDependency(update: Uint8Array, sv: StateVector): string | null {
  let decoded: ReturnType<typeof Y.decodeUpdate>;
  try {
    decoded = Y.decodeUpdate(update);
  } catch {
    return 'mise à jour Yjs malformée';
  }
  // 1. Par client : première horloge et fin des structures, qui doivent être contiguës.
  const first = new Map<number, number>();
  const end = new Map<number, number>();
  for (const struct of decoded.structs) {
    if (struct instanceof Y.Skip) return 'mise à jour lacunaire (structures sautées)';
    const { client, clock } = struct.id;
    const previousEnd = end.get(client);
    if (previousEnd === undefined) first.set(client, clock);
    else if (clock !== previousEnd) return `structures non contiguës (client ${client})`;
    end.set(client, clock + struct.length);
  }
  // 2. Aucun trou entre ce que le serveur connaît et le début de la mise à jour.
  for (const [client, clock] of first) {
    if (clock > (sv.get(client) ?? 0)) return `dépendances manquantes (client ${client})`;
  }
  const known = (client: number): number => Math.max(sv.get(client) ?? 0, end.get(client) ?? 0);
  // 3. Références (origines gauche/droite, parent) vers des éléments connus ou apportés.
  for (const struct of decoded.structs) {
    if (!(struct instanceof Y.Item)) continue;
    const parent = struct.parent instanceof Y.ID ? struct.parent : null;
    for (const ref of [struct.origin, struct.rightOrigin, parent]) {
      if (ref && ref.clock >= known(ref.client)) return `référence à un élément inconnu (client ${ref.client})`;
    }
  }
  // 4. Suppressions : uniquement de contenu connu ou apporté par la mise à jour.
  for (const [client, items] of decoded.ds.clients) {
    for (const item of items) {
      if (item.clock + item.len > known(client)) return `suppression de contenu inconnu (client ${client})`;
    }
  }
  return null;
}

/** Le document porte-t-il des structures ou suppressions en attente (jamais intégrées) ? */
export function hasPendingUpdates(doc: Y.Doc): boolean {
  return doc.store.pendingStructs !== null || doc.store.pendingDs !== null;
}

/**
 * Écarte les structures et suppressions en attente. Sans effet sur le contenu visible : elles n'ont
 * jamais été intégrées (ni diffusées par l'événement `update`). Renvoie `true` s'il y en avait.
 */
export function purgePendingUpdates(doc: Y.Doc): boolean {
  if (!hasPendingUpdates(doc)) return false;
  doc.store.pendingStructs = null;
  doc.store.pendingDs = null;
  return true;
}
