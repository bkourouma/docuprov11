import * as Y from 'yjs';
import { Fragment } from '@tiptap/pm/model';
import type { Mark, MarkType, Node as PMNode, NodeType } from '@tiptap/pm/model';
import { EDITOR_FRAGMENT } from './constants';
import { getEditorSchema } from './schema';

/** Bornes par défaut de l'analyse d'un fragment Yjs (profondeur d'éléments, nombre total de nœuds). */
export const DEFAULT_STRUCTURE_LIMITS = { maxDepth: 64, maxNodes: 100_000 } as const;

export interface StructureLimits {
  maxDepth?: number;
  maxNodes?: number;
}

/** Longueur max d'une valeur d'attribut texte et taille max d'un attribut tableau. */
const MAX_ATTR_STRING = 100_000;
const MAX_ATTR_ARRAY = 1_000;

const hasOwn = (obj: object, key: string): boolean => Object.prototype.hasOwnProperty.call(obj, key);

const isPrimitive = (v: unknown): boolean =>
  v === null ||
  typeof v === 'boolean' ||
  (typeof v === 'number' && Number.isFinite(v)) ||
  (typeof v === 'string' && v.length <= MAX_ATTR_STRING);

/** Valeur d'attribut « sûre » : primitive, ou tableau plat de primitives (ex. `colwidth`). */
const isSafeAttrValue = (v: unknown): boolean => {
  if (isPrimitive(v)) return true;
  return Array.isArray(v) && v.length <= MAX_ATTR_ARRAY && v.every(isPrimitive);
};

/**
 * Extrait uniquement les attributs déclarés par le schéma (jamais de clé arbitraire).
 * Renvoie `null` si une valeur est dangereuse en mode strict ; l'ignore en mode tolérant.
 */
const pickAttrs = (
  read: (name: string) => unknown,
  declared: Record<string, unknown>,
  strict: boolean,
): Record<string, unknown> | null => {
  const attrs: Record<string, unknown> = {};
  for (const name of Object.keys(declared)) {
    const value = read(name);
    if (value === undefined) continue;
    if (isSafeAttrValue(value)) attrs[name] = value;
    else if (strict) return null;
  }
  return attrs;
};

/** Attributs déclarés par le schéma (propriété runtime `attrs`, absente des typings publics). */
const declaredAttrs = (t: NodeType | MarkType): Record<string, unknown> =>
  (t as unknown as { attrs: Record<string, unknown> }).attrs;

/** Les marques Yjs peuvent porter un suffixe de hachage (`bold--AbC12345`). */
const markName = (attrName: string): string => /(.*)(--[a-zA-Z0-9+/=]{8})$/.exec(attrName)?.[1] ?? attrName;

/** Texte Yjs -> nœuds texte ProseMirror ; `null` si invalide en mode strict. */
const textNodes = (text: Y.XmlText, strict: boolean): PMNode[] | null => {
  const schema = getEditorSchema();
  const out: PMNode[] = [];
  for (const op of text.toDelta() as Array<{ insert?: unknown; attributes?: Record<string, unknown> }>) {
    if (typeof op.insert !== 'string') {
      if (strict) return null;
      continue;
    }
    if (op.insert.length === 0) continue;
    const marks: Mark[] = [];
    for (const key of Object.keys(op.attributes ?? {})) {
      const name = markName(key);
      const markType: MarkType | undefined = hasOwn(schema.marks, name) ? schema.marks[name] : undefined;
      const raw = op.attributes?.[key];
      const plain = typeof raw === 'object' && raw !== null && !Array.isArray(raw);
      if (!markType || (!plain && strict)) {
        if (strict) return null;
        continue;
      }
      const attrs = pickAttrs(
        (n) => (plain ? (raw as Record<string, unknown>)[n] : undefined),
        declaredAttrs(markType),
        strict,
      );
      if (attrs === null) return null;
      try {
        marks.push(markType.create(attrs));
      } catch {
        if (strict) return null;
      }
    }
    try {
      out.push(schema.text(op.insert, marks));
    } catch {
      if (strict) return null;
    }
  }
  return out;
};

interface Frame {
  type: NodeType;
  attrs: Record<string, unknown> | null;
  items: unknown[];
  i: number;
  out: PMNode[];
  depth: number;
}

/** Assemble un nœud en ne gardant que les enfants conformes à son modèle de contenu (mode tolérant). */
const buildTolerant = (frame: Frame, isRoot: boolean): PMNode | null => {
  const { type } = frame;
  try {
    if (isRoot && frame.out.length === 0) return type.create(null, Fragment.empty);
    let match = type.contentMatch;
    const kept: PMNode[] = [];
    for (const child of frame.out) {
      const next = match.matchType(child.type);
      if (!next) continue;
      match = next;
      kept.push(child.marks.length > 0 && !type.allowsMarks(child.marks) ? child.mark(type.allowedMarks(child.marks)) : child);
    }
    if (!match.validEnd) {
      const fill = match.fillBefore(Fragment.empty, true);
      if (!fill) return null;
      fill.forEach((n) => kept.push(n));
    }
    return type.create(frame.attrs, Fragment.fromArray(kept));
  } catch {
    return null;
  }
};

export type Projection = { ok: true; root: PMNode } | { ok: false; reason: string };

/**
 * Projette un fragment Yjs en nœud racine ProseMirror, de façon ITÉRATIVE (pile explicite) :
 * aucun dépassement de pile possible, quelle que soit la profondeur du document.
 *
 * - mode `strict` : échoue au premier défaut (type, nom, texte hors contexte, attribut, borne, schéma) ;
 * - mode `tolerant` : ignore les nœuds invalides et ne lève jamais ; renvoie le contenu valide restant.
 * Ne modifie jamais le Y.Doc (contrairement aux utilitaires de y-tiptap qui suppriment les nœuds illisibles).
 */
export const projectFragment = (
  fragment: Y.XmlFragment,
  mode: 'strict' | 'tolerant',
  limits?: StructureLimits,
): Projection => {
  const strict = mode === 'strict';
  const maxDepth = limits?.maxDepth ?? DEFAULT_STRUCTURE_LIMITS.maxDepth;
  const maxNodes = limits?.maxNodes ?? DEFAULT_STRUCTURE_LIMITS.maxNodes;
  const schema = getEditorSchema();
  const topType = schema.topNodeType;
  const emptyRoot = (): Projection => ({ ok: true, root: topType.create(null, Fragment.empty) });
  const fail = (reason: string): Projection => ({ ok: false, reason });

  try {
    if (fragment.length > maxNodes) {
      if (strict) return fail('Document trop volumineux (nombre de nœuds).');
      return emptyRoot();
    }
    const stack: Frame[] = [{ type: topType, attrs: null, items: fragment.toArray(), i: 0, out: [], depth: 0 }];
    let count = 0;
    let overflow = false;
    let root: PMNode | null = null;

    while (stack.length > 0) {
      const frame = stack[stack.length - 1] as Frame;
      if (frame.i < frame.items.length && !overflow) {
        const item = frame.items[frame.i++];
        if (++count > maxNodes) {
          if (strict) return fail('Document trop volumineux (nombre de nœuds).');
          overflow = true;
          continue;
        }
        if (item instanceof Y.XmlElement) {
          const name = item.nodeName;
          const type: NodeType | undefined =
            typeof name === 'string' && name !== 'text' && hasOwn(schema.nodes, name) ? schema.nodes[name] : undefined;
          if (!type || type === topType) {
            if (strict) return fail('Nœud inconnu dans le document.');
            continue;
          }
          if (frame.depth + 1 > maxDepth) {
            if (strict) return fail('Document trop profond.');
            continue;
          }
          if (count + item.length > maxNodes) {
            if (strict) return fail('Document trop volumineux (nombre de nœuds).');
            overflow = true;
            continue;
          }
          const attrs = pickAttrs((n) => item.getAttribute(n), declaredAttrs(type), strict);
          if (attrs === null) return fail('Attribut de nœud invalide.');
          stack.push({ type, attrs, items: item.toArray(), i: 0, out: [], depth: frame.depth + 1 });
        } else if (item instanceof Y.XmlText) {
          if (!frame.type.inlineContent) {
            if (strict) return fail('Texte à un emplacement non autorisé.');
            continue;
          }
          const nodes = textNodes(item, strict);
          if (nodes === null) return fail('Texte ou marque invalide.');
          for (const n of nodes) frame.out.push(n);
        } else if (strict) {
          return fail('Type de nœud non autorisé dans le document.');
        }
        continue;
      }

      // Enfants traités : on assemble ce nœud puis on le rend à son parent.
      stack.pop();
      const isRoot = stack.length === 0;
      let node: PMNode | null;
      if (strict) {
        try {
          node = frame.type.create(frame.attrs, Fragment.fromArray(frame.out));
        } catch {
          return fail('Nœud invalide pour le schéma.');
        }
      } else {
        node = buildTolerant(frame, isRoot);
      }
      if (isRoot) root = node;
      else if (node) (stack[stack.length - 1] as Frame).out.push(node);
    }

    if (!root) return strict ? fail('Document invalide.') : emptyRoot();
    if (root.childCount > 0) {
      try {
        root.check();
      } catch {
        return strict ? fail('Contenu non conforme au schéma.') : emptyRoot();
      }
    }
    return { ok: true, root };
  } catch {
    return strict ? fail('Document illisible.') : emptyRoot();
  }
};

/**
 * Vérifie qu'un Y.Doc est un document ProseMirror valide pour le schéma de l'éditeur (fragment
 * `EDITOR_FRAGMENT`) : bornes de profondeur et de nœuds, types et noms de nœuds connus, texte
 * uniquement là où le schéma l'accepte, attributs sûrs, contenu conforme au schéma.
 * Non récursive, ne lève jamais ; la raison renvoyée est générique (aucun contenu utilisateur).
 */
export const validateYDocStructure = (
  ydoc: Y.Doc,
  limits?: StructureLimits,
): { ok: true } | { ok: false; reason: string } => {
  try {
    const result = projectFragment(ydoc.getXmlFragment(EDITOR_FRAGMENT), 'strict', limits);
    return result.ok ? { ok: true } : { ok: false, reason: result.reason };
  } catch {
    return { ok: false, reason: 'Document illisible.' };
  }
};
