import { performance } from 'node:perf_hooks';
import { EDITOR_FRAGMENT } from '@archivage/editor';
import { validateYDocStructure } from '@archivage/editor/server';
import * as Y from 'yjs';
import { purgePendingUpdates } from './collab-update-guard';

/**
 * Garde de STRUCTURE du contenu (fragment ProseMirror `EDITOR_FRAGMENT`).
 *
 * Une mise à jour Yjs peut être bien formée et sans dépendance manquante, mais produire un fragment
 * que ProseMirror ne sait pas lire (Y.XmlText à la racine, 3000 blockquote imbriqués, type ou
 * attribut inconnu…). Persistée, elle casserait la conversion HTML/DOCX, les versions, la
 * restauration et l'import pour tous. Le serveur la valide donc AVANT application et diffusion.
 *
 * Coût : la validation (`validateYDocStructure`) parcourt tout le fragment. Elle n'est lancée que
 * pour une mise à jour STRUCTURELLE (règle de `classifyUpdate`) ; la frappe de texte simple — le cas
 * de loin le plus fréquent — n'en déclenche aucune. Elle s'exécute sur une copie miroir de la salle
 * (`RoomStructureGuard`), une à la fois par salle, avec un budget de temps de calcul par salle.
 */

export type StructureVerdict = { ok: true } | { ok: false; reason: string };
export type StructureValidator = (doc: Y.Doc, limits: StructureLimits) => StructureVerdict;

export interface StructureLimits {
  maxDepth: number;
  maxNodes: number;
}

/** Validation de référence (paquet éditeur) ; ne lève jamais (filet ajouté par précaution). */
export const defaultStructureValidator: StructureValidator = (doc, limits) => {
  try {
    return validateYDocStructure(doc, limits);
  } catch {
    return { ok: false, reason: 'Document illisible.' };
  }
};

// ------------------------------------------------------------------------------ classification

/** Empreinte d'une mise à jour : structurelle ou non, et ce qu'elle apporte (contrôle d'intégration). */
export interface UpdateFootprint {
  structural: boolean;
  /** Motif (journalisable, sans contenu) quand `structural`. */
  why: string | null;
  /** Par client : horloge de fin des structures apportées. */
  ends: Map<number, number>;
  /** Suppressions apportées : [client, horloge, longueur]. */
  deletes: Array<[number, number, number]>;
}

/** Emplacement d'un élément : dans le fragment de contenu ? dans un Y.XmlText ? entrée de map ? */
interface Slot {
  inFragment: boolean;
  xmlText: boolean;
  keyed: boolean;
}

/** Au-delà, on ne détaille pas : la mise à jour est traitée comme structurelle (validée). */
const MAX_CLASSIFIED_STRUCTS = 20_000;
const MAX_SCANNED_DELETIONS = 20_000;

type Struct = Y.Item | Y.GC | Y.Skip;

/**
 * Classe une mise à jour (format v1) appliquée à `doc`. RÈGLE : elle est NEUTRE (aucune validation)
 * si et seulement si chacun de ses éléments est
 *  - du contenu supprimé (`ContentDeleted`, invisible), ou
 *  - placé HORS du fragment de contenu (texte de test, commentaires, méta…), ou
 *  - du texte brut (`ContentString`) dans un `Y.XmlText` du fragment (pas d'attribut, pas de marque) ;
 * et si chacune de ses suppressions ne porte que sur du contenu hors fragment, déjà supprimé, ou
 * contenu dans un `Y.XmlText` (texte, marques). Tout le reste est STRUCTUREL : nouvel élément ou
 * texte placé dans le fragment ou un élément, attribut, marque (format), suppression d'un nœud…
 * L'emplacement d'un élément sans parent explicite est déduit de son origine (gauche, sinon
 * droite), comme le fait Yjs à l'intégration. Ne lève jamais : un doute => structurel.
 */
export function classifyUpdate(update: Uint8Array, doc: Y.Doc): UpdateFootprint {
  const footprint: UpdateFootprint = { structural: false, why: null, ends: new Map(), deletes: [] };
  const structural = (why: string): UpdateFootprint => {
    footprint.structural = true;
    footprint.why = footprint.why ?? why;
    return footprint;
  };
  let decoded: ReturnType<typeof Y.decodeUpdate>;
  try {
    decoded = Y.decodeUpdate(update);
  } catch {
    return structural('mise à jour illisible');
  }
  const structs = decoded.structs as Struct[];
  for (const s of structs) {
    const end = s.id.clock + s.length;
    if (end > (footprint.ends.get(s.id.client) ?? 0)) footprint.ends.set(s.id.client, end);
  }
  for (const [client, items] of decoded.ds.clients) {
    for (const item of items) footprint.deletes.push([client, item.clock, item.len]);
  }
  if (structs.length > MAX_CLASSIFIED_STRUCTS) return structural('mise à jour volumineuse');

  try {
    const resolver = new SlotResolver(doc, structs);
    for (const s of structs) {
      if (!(s instanceof Y.Item) || s.content instanceof Y.ContentDeleted) continue;
      const slot = resolver.slotOf(s);
      if (!slot) return structural('emplacement indéterminé');
      if (!slot.inFragment) continue;
      if (slot.xmlText && !slot.keyed && s.content instanceof Y.ContentString) continue;
      return structural('élément, attribut ou marque dans le contenu');
    }
    let scanned = 0;
    for (const [client, clock, len] of footprint.deletes) {
      const live = doc.store.clients.get(client);
      if (!live || live.length === 0) continue; // contenu apporté par la mise à jour elle-même
      const last = live[live.length - 1] as Struct;
      const liveEnd = last.id.clock + last.length;
      if (clock >= liveEnd) continue;
      let index = clock < (live[0] as Struct).id.clock ? 0 : Y.findIndexSS(live, clock);
      for (; index < live.length; index += 1) {
        const target = live[index] as Struct;
        if (target.id.clock >= clock + len) break;
        if ((scanned += 1) > MAX_SCANNED_DELETIONS) return structural('suppression volumineuse');
        if (!(target instanceof Y.Item) || target.deleted) continue;
        const slot = resolver.liveSlot(target);
        if (!slot) return structural('suppression indéterminée');
        if (!slot.inFragment || (slot.xmlText && !slot.keyed)) continue;
        return structural('suppression d’un nœud ou d’un attribut du contenu');
      }
    }
  } catch {
    return structural('classification impossible');
  }
  return footprint;
}

/** Résolution itérative (aucune récursion : profondeur quelconque) de l'emplacement des éléments. */
class SlotResolver {
  private readonly fragmentRoot: unknown;
  private readonly local = new Map<number, Struct[]>();
  private readonly typeMemo = new Map<Y.AbstractType<unknown>, boolean>();
  private readonly slotMemo = new Map<Y.Item, Slot | null>();

  constructor(
    private readonly doc: Y.Doc,
    structs: Struct[],
  ) {
    this.fragmentRoot = doc.share.get(EDITOR_FRAGMENT) ?? null;
    for (const s of structs) {
      let list = this.local.get(s.id.client);
      if (!list) {
        list = [];
        this.local.set(s.id.client, list);
      }
      list.push(s);
    }
    for (const list of this.local.values()) list.sort((a, b) => a.id.clock - b.id.clock);
  }

  /** Le type vivant appartient-il à l'arbre du fragment de contenu ? */
  private typeInFragment(type: Y.AbstractType<unknown>): boolean {
    const chain: Y.AbstractType<unknown>[] = [];
    let current: Y.AbstractType<unknown> | null = type;
    let result = false;
    while (current) {
      const known = this.typeMemo.get(current);
      if (known !== undefined) {
        result = known;
        break;
      }
      chain.push(current);
      const item: Y.Item | null = current._item;
      if (!item) {
        result = current === this.fragmentRoot;
        break;
      }
      current = item.parent instanceof Y.AbstractType ? (item.parent as Y.AbstractType<unknown>) : null;
    }
    for (const t of chain) this.typeMemo.set(t, result);
    return result;
  }

  /** Emplacement d'un élément déjà intégré dans la salle. */
  liveSlot(item: Y.Item): Slot | null {
    const parent = item.parent;
    if (!(parent instanceof Y.AbstractType)) return null;
    return {
      inFragment: this.typeInFragment(parent as Y.AbstractType<unknown>),
      xmlText: parent instanceof Y.XmlText,
      keyed: item.parentSub !== null,
    };
  }

  private findLocal(id: Y.ID): Struct | null {
    const list = this.local.get(id.client);
    if (!list) return null;
    let lo = 0;
    let hi = list.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const s = list[mid] as Struct;
      if (id.clock < s.id.clock) hi = mid - 1;
      else if (id.clock >= s.id.clock + s.length) lo = mid + 1;
      else return s;
    }
    return null;
  }

  private findLive(id: Y.ID): Struct | null {
    const list = this.doc.store.clients.get(id.client);
    if (!list || list.length === 0) return null;
    const last = list[list.length - 1] as Struct;
    if (id.clock >= last.id.clock + last.length) return null;
    try {
      return Y.getItem(this.doc.store, id) as Struct;
    } catch {
      return null;
    }
  }

  /**
   * Emplacement d'un élément de la mise à jour : parent explicite (racine nommée ou type porté par
   * un élément), sinon celui de son origine. `null` si indéterminable.
   */
  slotOf(start: Y.Item): Slot | null {
    type Step = { item: Y.Item; kind: 'type-of' | 'sibling'; via: Y.Item };
    const pending: Step[] = [];
    const visiting = new Set<Y.Item>();
    let current: Y.Item = start;
    let base: Slot | null;
    for (;;) {
      if (this.slotMemo.has(current)) {
        base = this.slotMemo.get(current) ?? null;
        break;
      }
      if (visiting.has(current)) {
        // Références circulaires forgées : indéterminable (=> structurel, donc validé).
        base = null;
        break;
      }
      visiting.add(current);
      const keyed = current.parentSub !== null;
      const parent: unknown = current.parent;
      if (typeof parent === 'string' || (parent instanceof Y.AbstractType && !parent._item)) {
        const name = typeof parent === 'string' ? parent : Y.findRootTypeKey(parent as Y.AbstractType<unknown>);
        base = { inFragment: name === EDITOR_FRAGMENT, xmlText: false, keyed };
        break;
      }
      if (parent instanceof Y.ID) {
        const local = this.findLocal(parent);
        if (local) {
          if (!(local instanceof Y.Item) || !(local.content instanceof Y.ContentType)) {
            base = null;
            break;
          }
          pending.push({ item: current, kind: 'type-of', via: local });
          current = local;
          continue;
        }
        const live = this.findLive(parent);
        if (!(live instanceof Y.Item) || !(live.content instanceof Y.ContentType)) {
          base = null;
          break;
        }
        const type = live.content.type as Y.AbstractType<unknown>;
        base = { inFragment: this.typeInFragment(type), xmlText: type instanceof Y.XmlText, keyed };
        break;
      }
      // Parent implicite : celui de l'origine gauche, sinon droite (comme `Item.getMissing`).
      const ref = current.origin ?? current.rightOrigin;
      if (!ref) {
        base = null;
        break;
      }
      const local = this.findLocal(ref);
      if (local) {
        if (!(local instanceof Y.Item)) {
          // Voisin effacé (GC) : Yjs efface aussi l'élément, sans effet sur le contenu.
          base = { inFragment: false, xmlText: false, keyed };
          break;
        }
        pending.push({ item: current, kind: 'sibling', via: local });
        current = local;
        continue;
      }
      const live = this.findLive(ref);
      if (live instanceof Y.GC) {
        base = { inFragment: false, xmlText: false, keyed };
        break;
      }
      base = live instanceof Y.Item ? this.liveSlot(live) : null;
      break;
    }
    this.slotMemo.set(current, base);
    for (let i = pending.length - 1; i >= 0; i -= 1) {
      const step = pending[i] as Step;
      const via = this.slotMemo.get(step.via) ?? null;
      let slot: Slot | null = null;
      if (via) {
        slot =
          step.kind === 'sibling'
            ? via
            : {
                inFragment: via.inFragment,
                xmlText: (step.via.content as Y.ContentType).type instanceof Y.XmlText,
                keyed: step.item.parentSub !== null,
              };
      }
      this.slotMemo.set(step.item, slot);
    }
    return this.slotMemo.get(start) ?? null;
  }
}

/** La salle contient-elle tout ce qu'apporte la mise à jour (structures ET suppressions) ? */
export function isIntegrated(doc: Y.Doc, footprint: UpdateFootprint): boolean {
  const sv = Y.decodeStateVector(Y.encodeStateVector(doc));
  for (const [client, end] of footprint.ends) {
    if ((sv.get(client) ?? 0) < end) return false;
  }
  for (const [client, clock, len] of footprint.deletes) {
    const live = doc.store.clients.get(client);
    if (!live || live.length === 0) return false;
    let index = clock < (live[0] as Struct).id.clock ? 0 : Y.findIndexSS(live, clock);
    for (; index < live.length; index += 1) {
      const s = live[index] as Struct;
      if (s.id.clock >= clock + len) break;
      if (s instanceof Y.Item && !s.deleted) return false;
    }
  }
  return true;
}

// --------------------------------------------------------------------------- garde par salle

export interface RoomStructureGuardOptions extends StructureLimits {
  /** Budget de calcul de validation : rafale (ms). */
  burstMs: number;
  /** Recharge du budget (ms de calcul autorisés par seconde). */
  msPerSecond: number;
  /** Copie miroir libérée après cette durée sans validation. */
  shadowIdleMs: number;
  /** Verrou rendu au plus tard après ce délai si l'application n'est jamais signalée. */
  lockTimeoutMs: number;
}

export interface StructureCounters {
  /** Validations AVANT application d'une mise à jour cliente. */
  updateChecks: number;
  /** Mises à jour refusées pour structure invalide. */
  rejected: number;
  /** Validations de l'état vivant (autosave, déchargement, lecture, mutation serveur). */
  liveChecks: number;
  /** Reconstructions de la copie miroir. */
  shadowBuilds: number;
}

export function emptyStructureCounters(): StructureCounters {
  return { updateChecks: 0, rejected: 0, liveChecks: 0, shadowBuilds: 0 };
}

export type AdmitResult = { ok: true } | { ok: false; invalid: boolean; reason: string };
const CLOSED: AdmitResult = { ok: false, invalid: false, reason: 'salle ou connexion fermée' };

interface Held {
  owner: unknown;
  footprint: UpdateFootprint;
  release: () => void;
  timer: NodeJS.Timeout;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });

/**
 * Validation structurelle d'une salle. Choix : valider la mise à jour sur une COPIE MIROIR avant
 * de l'appliquer à la salle vivante (rien d'invalide n'est jamais appliqué, donc ni diffusé ni
 * persisté ; aucun retour arrière à faire chez les autres clients). La copie suit la salle à
 * chaque mise à jour (coût proportionnel à la mise à jour, pas au document) ; elle n'est
 * reconstruite depuis la salle qu'au premier besoin, après un refus (elle a reçu la mise à jour
 * fautive) ou si elle a divergé. Libérée après inactivité pour ne pas doubler la mémoire.
 *
 * Une seule validation à la fois par salle : le verrou est tenu de la validation jusqu'à
 * l'application effective (`settle`, appelé après traitement du message), de sorte que la mise à
 * jour suivante est validée sur un état qui contient la précédente. Le budget de calcul par salle
 * (rafale + recharge) retarde les validations d'une salle trop sollicitée (contre-pression sur la
 * connexion) au lieu de saturer le processus.
 */
export class RoomStructureGuard {
  private shadow: Y.Doc | null = null;
  private shadowUsedAt = 0;
  private tokens: number;
  private refilledAt: number;
  private queue: Promise<void> = Promise.resolve();
  private held: Held | null = null;
  private attached = false;
  private disposed = false;
  /** Nombre de mises à jour de la salle, et valeur lors de la dernière validation réussie de l'état vivant. */
  private changes = 0;
  private liveValidAt = -1;
  private readonly mirror = (update: Uint8Array): void => {
    this.changes += 1;
    if (!this.shadow) return;
    try {
      Y.applyUpdate(this.shadow, update);
    } catch {
      this.dropShadow();
    }
  };

  constructor(
    private readonly live: Y.Doc,
    private readonly options: RoomStructureGuardOptions,
    private readonly counters: StructureCounters,
    private readonly validator: StructureValidator = defaultStructureValidator,
    private readonly now: () => number = () => performance.now(),
    private readonly sleep: (ms: number) => Promise<void> = defaultSleep,
  ) {
    this.tokens = options.burstMs;
    this.refilledAt = now();
  }

  attach(): void {
    if (this.attached || this.disposed) return;
    this.attached = true;
    this.live.on('update', this.mirror);
  }

  /** Débranche la garde ; un verrou tenu est rendu (les attentes en cours échouent proprement). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.attached) this.live.off('update', this.mirror);
    this.attached = false;
    this.dropShadow();
    if (this.held) {
      clearTimeout(this.held.timer);
      this.held.release();
      this.held = null;
    }
  }

  hasShadow(): boolean {
    return this.shadow !== null;
  }

  /**
   * Validation de l'état VIVANT de la salle (avant toute écriture ou remise de l'état). Un résultat
   * conforme reste valable tant que la salle ne change pas (aucune revalidation inutile).
   */
  checkLive(): StructureVerdict {
    if (this.attached && this.liveValidAt === this.changes) return { ok: true };
    this.counters.liveChecks += 1;
    const verdict = this.validator(this.live, this.options);
    if (verdict.ok) this.liveValidAt = this.changes;
    return verdict;
  }

  /**
   * Admet (ou non) une mise à jour structurelle d'un écrivain. `ok` : le verrou de la salle reste
   * tenu jusqu'à `settle(owner)` (ou le délai de garde). Sinon la mise à jour ne doit PAS être
   * appliquée : `invalid` = structure non conforme, sinon salle/connexion fermée entre-temps.
   * `alive()` est réévalué après l'attente.
   */
  async admit(
    update: Uint8Array,
    owner: unknown,
    footprint: UpdateFootprint,
    alive: () => boolean,
  ): Promise<AdmitResult> {
    if (this.disposed) return CLOSED;
    const previous = this.queue;
    let release!: () => void;
    const turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.queue = previous.then(() => turn);
    let kept = false;
    try {
      await previous;
      await this.throttle();
      if (this.disposed || !alive()) return CLOSED;
      const started = this.now();
      const verdict = this.validateOnShadow(update);
      this.spend(this.now() - started);
      if (!verdict.ok) {
        this.counters.rejected += 1;
        return { ok: false, invalid: true, reason: verdict.reason };
      }
      const timer = setTimeout(() => this.settle(owner), this.options.lockTimeoutMs);
      timer.unref();
      this.held = { owner, footprint, release, timer };
      kept = true;
      return { ok: true };
    } finally {
      if (!kept) release();
    }
  }

  /**
   * Fin du traitement du message admis de `owner` : si la salle ne contient pas entièrement la
   * mise à jour (connexion passée en lecture seule entre-temps, erreur), la copie miroir — qui,
   * elle, l'a reçue — est écartée et sera reconstruite. Puis le verrou est rendu.
   */
  settle(owner: unknown): void {
    const held = this.held;
    if (!held || held.owner !== owner) return;
    this.held = null;
    clearTimeout(held.timer);
    try {
      if (this.shadow && !isIntegrated(this.live, held.footprint)) this.dropShadow();
    } catch {
      this.dropShadow();
    } finally {
      held.release();
    }
  }

  /** Libère la copie miroir inutilisée depuis `shadowIdleMs` (appelé au balayage). */
  releaseIfIdle(): void {
    if (this.shadow && !this.held && this.now() - this.shadowUsedAt >= this.options.shadowIdleMs) {
      this.dropShadow();
    }
  }

  private validateOnShadow(update: Uint8Array): StructureVerdict {
    this.counters.updateChecks += 1;
    let shadow = this.shadow;
    if (shadow && !sameStateVector(shadow, this.live)) {
      this.dropShadow();
      shadow = null;
    }
    if (!shadow) {
      shadow = new Y.Doc({ gc: this.live.gc });
      purgePendingUpdates(this.live);
      Y.applyUpdate(shadow, Y.encodeStateAsUpdate(this.live));
      this.shadow = shadow;
      this.counters.shadowBuilds += 1;
    }
    this.shadowUsedAt = this.now();
    try {
      Y.applyUpdate(shadow, update);
    } catch {
      this.dropShadow();
      return { ok: false, reason: 'mise à jour inapplicable' };
    }
    if (shadow.store.pendingStructs !== null || shadow.store.pendingDs !== null) {
      this.dropShadow();
      return { ok: false, reason: 'dépendances manquantes' };
    }
    const verdict = this.validator(shadow, this.options);
    // Copie empoisonnée : jamais réutilisée (reconstruite depuis la salle, restée saine).
    if (!verdict.ok) this.dropShadow();
    return verdict;
  }

  private refill(): void {
    const t = this.now();
    const elapsed = Math.max(0, t - this.refilledAt);
    this.refilledAt = t;
    this.tokens = Math.min(this.options.burstMs, this.tokens + (elapsed * this.options.msPerSecond) / 1000);
  }

  private spend(ms: number): void {
    this.refill();
    this.tokens -= Math.max(0, ms);
  }

  /** Attend que le budget de calcul de la salle soit de nouveau positif. */
  private async throttle(): Promise<void> {
    this.refill();
    while (this.tokens <= 0 && !this.disposed) {
      const wait = Math.ceil(((-this.tokens + 1) * 1000) / Math.max(1, this.options.msPerSecond));
      await this.sleep(wait);
      this.refill();
    }
  }

  private dropShadow(): void {
    const shadow = this.shadow;
    this.shadow = null;
    if (shadow) {
      try {
        shadow.destroy();
      } catch {
        /* sans effet */
      }
    }
  }
}

function sameStateVector(a: Y.Doc, b: Y.Doc): boolean {
  const x = Y.encodeStateVector(a);
  const y = Y.encodeStateVector(b);
  if (x.byteLength !== y.byteLength) return false;
  for (let i = 0; i < x.byteLength; i += 1) if (x[i] !== y[i]) return false;
  return true;
}
