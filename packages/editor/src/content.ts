import * as Y from 'yjs';
import type { Node as PMNode } from '@tiptap/pm/model';
import { EDITOR_FRAGMENT, MENTION_NODE_NAME } from './constants';
import { listComments } from './comments';
import { DEFAULT_STRUCTURE_LIMITS, projectFragment } from './structure';

const INLINE_NODES = new Set([MENTION_NODE_NAME, 'hardBreak']);

const parseMentionId = (raw: unknown): number | null => {
  const text = typeof raw === 'number' ? String(raw) : raw;
  if (typeof text !== 'string' || !/^[0-9]{1,15}$/.test(text)) return null;
  const n = Number(text);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

/**
 * Collecte les mentions du fragment, SANS récursion (pile explicite) et avec des bornes de
 * profondeur et de nœuds : un état Yjs empoisonné ne peut ni dépasser la pile ni bloquer.
 */
const collectMentions = (root: Y.XmlFragment, out: Set<number>): void => {
  const { maxDepth, maxNodes } = DEFAULT_STRUCTURE_LIMITS;
  const stack: Array<{ node: Y.XmlFragment | Y.XmlElement; depth: number }> = [{ node: root, depth: 0 }];
  let count = 0;
  while (stack.length > 0) {
    const { node, depth } = stack.pop() as { node: Y.XmlFragment | Y.XmlElement; depth: number };
    if (node.length > maxNodes - count) return;
    for (const child of node.toArray()) {
      if (++count > maxNodes) return;
      if (!(child instanceof Y.XmlElement)) continue;
      if (child.nodeName === MENTION_NODE_NAME) {
        const id = parseMentionId(child.getAttribute('id'));
        if (id !== null) out.add(id);
      } else if (depth + 1 <= maxDepth) {
        stack.push({ node: child, depth: depth + 1 });
      }
    }
  }
};

/** Union des user_group_id mentionnés : nœuds `mention` du texte + commentaires + réponses. */
export const extractMentionIds = (ydoc: Y.Doc): number[] => {
  const ids = new Set<number>();
  collectMentions(ydoc.getXmlFragment(EDITOR_FRAGMENT), ids);
  for (const c of listComments(ydoc)) {
    c.mentions.forEach((m) => ids.add(m));
    c.replies.forEach((r) => r.mentions.forEach((m) => ids.add(m)));
  }
  return Array.from(ids).sort((a, b) => a - b);
};

/** Texte d'un nœud ProseMirror (profondeur déjà bornée à 64 par la projection tolérante). */
const nodeText = (node: PMNode): string => {
  if (node.isText) return node.text ?? '';
  if (node.type.name === MENTION_NODE_NAME) {
    const label = node.attrs.label;
    return `@${typeof label === 'string' ? label : String(node.attrs.id ?? '')}`;
  }
  if (node.type.name === 'hardBreak') return '\n';
  const children: PMNode[] = [];
  node.forEach((c) => children.push(c));
  const allInline = children.every((c) => c.isText || INLINE_NODES.has(c.type.name));
  const sep = allInline ? '' : node.type.name === 'tableRow' ? ' ' : '\n';
  return children.map(nodeText).join(sep);
};

/**
 * Texte brut du document (indexation / aperçu / détection de contenu vide).
 * TOLÉRANT : nœuds invalides ignorés, bornes de profondeur/nœuds, jamais d'exception.
 */
export const yDocToPlainText = (ydoc: Y.Doc): string => {
  try {
    const result = projectFragment(ydoc.getXmlFragment(EDITOR_FRAGMENT), 'tolerant');
    if (!result.ok) return '';
    const blocks: string[] = [];
    result.root.forEach((c) => blocks.push(nodeText(c)));
    return blocks.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  } catch {
    return '';
  }
};
