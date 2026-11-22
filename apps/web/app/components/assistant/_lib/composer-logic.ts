// Logique pure de la zone de saisie de l'assistant.
import { ASST_MESSAGE_MAX_CHARS } from '@archivage/types';

export const ASSISTANT_SHORTCUT_LABEL = 'Alt+Maj+A';

export type ComposerState = {
  trimmed: string;
  length: number;
  remaining: number;
  tooLong: boolean;
  empty: boolean;
  canSend: boolean;
  counterLabel: string;
};

/** État de la saisie ; la longueur contractuelle s'apprécie après trim (comme le schéma zod). */
export function composerState(text: string): ComposerState {
  const trimmed = text.trim();
  const length = trimmed.length;
  const tooLong = length > ASST_MESSAGE_MAX_CHARS;
  const empty = length === 0;
  return {
    trimmed,
    length,
    remaining: ASST_MESSAGE_MAX_CHARS - length,
    tooLong,
    empty,
    canSend: !empty && !tooLong,
    counterLabel: `${length} / ${ASST_MESSAGE_MAX_CHARS}`,
  };
}

export type ComposerKeyEvent = {
  key: string;
  shiftKey: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  isComposing?: boolean;
  nativeEvent?: { isComposing?: boolean };
};

/** Entrée (ou Ctrl/Cmd+Entrée) envoie ; Maj+Entrée = saut de ligne ; jamais pendant une composition IME. */
export function shouldSendOnKey(e: ComposerKeyEvent): boolean {
  if (e.key !== 'Enter') return false;
  if (e.isComposing || e.nativeEvent?.isComposing) return false;
  if (e.ctrlKey || e.metaKey) return true;
  return !e.shiftKey;
}

export type ShortcutEvent = {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
};

/**
 * Raccourci d'ouverture du panneau : Alt+Maj+A. On se fonde sur `key` (la lettre produite, donc la disposition
 * réelle du clavier : AZERTY envoie code 'KeyQ' pour la lettre A). `code === 'KeyA'` n'est retenu que lorsque
 * `key` n'est pas une lettre ASCII (Alt+lettre produit un caractère spécial sur Mac).
 */
export function isAssistantShortcut(e: ShortcutEvent): boolean {
  if (!e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey) return false;
  if (/^[a-z]$/i.test(e.key)) return e.key.toLowerCase() === 'a';
  return e.code === 'KeyA';
}
