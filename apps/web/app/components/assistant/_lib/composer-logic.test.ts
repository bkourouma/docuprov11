// Tests de la logique de saisie de l'assistant.
// Lancer : cd apps/web && npx tsx --test app/components/assistant/_lib/composer-logic.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { postMessageBody } from '@archivage/types';
import {
  ASSISTANT_SHORTCUT_LABEL,
  composerState,
  isAssistantShortcut,
  shouldSendOnKey,
} from './composer-logic';

test('composerState : vide et espaces seuls', () => {
  for (const t of ['', '   ', '\n\t ']) {
    const s = composerState(t);
    assert.equal(s.empty, true);
    assert.equal(s.canSend, false);
    assert.equal(s.length, 0);
  }
});

test('composerState : limite apprécie après trim', () => {
  const ok = composerState('a'.repeat(4000));
  assert.equal(ok.tooLong, false);
  assert.equal(ok.canSend, true);
  assert.equal(ok.remaining, 0);
  assert.equal(ok.counterLabel, '4000 / 4000');

  const long = composerState('a'.repeat(4001));
  assert.equal(long.tooLong, true);
  assert.equal(long.canSend, false);
  assert.equal(long.remaining, -1);

  // 4000 espaces + 'a' : une fois trimé, 1 caractère -> envoyable
  const spaces = composerState(' '.repeat(4000) + 'a');
  assert.equal(spaces.length, 1);
  assert.equal(spaces.canSend, true);
  assert.equal(spaces.trimmed, 'a');
});

test('composerState : cohérent avec le schéma du contrat', () => {
  for (const t of ['', ' a ', 'a'.repeat(4000), 'a'.repeat(4001), ' '.repeat(4000) + 'a']) {
    assert.equal(composerState(t).canSend, postMessageBody.safeParse({ content: t }).success);
  }
  assert.equal(composerState(' bonjour ').counterLabel, '7 / 4000');
});

test('shouldSendOnKey', () => {
  assert.equal(shouldSendOnKey({ key: 'Enter', shiftKey: false }), true);
  assert.equal(shouldSendOnKey({ key: 'Enter', shiftKey: true }), false);
  assert.equal(shouldSendOnKey({ key: 'Enter', shiftKey: false, isComposing: true }), false);
  assert.equal(shouldSendOnKey({ key: 'Enter', shiftKey: false, nativeEvent: { isComposing: true } }), false);
  assert.equal(shouldSendOnKey({ key: 'Enter', shiftKey: false, ctrlKey: true }), true);
  assert.equal(shouldSendOnKey({ key: 'Enter', shiftKey: false, metaKey: true }), true);
  assert.equal(shouldSendOnKey({ key: 'a', shiftKey: false }), false);
  assert.equal(shouldSendOnKey({ key: 'Enter', shiftKey: false, ctrlKey: true, isComposing: true }), false);
});

test('isAssistantShortcut', () => {
  const base = { key: 'A', code: 'KeyA', ctrlKey: false, metaKey: false, altKey: true, shiftKey: true };
  assert.equal(ASSISTANT_SHORTCUT_LABEL, 'Alt+Maj+A');
  assert.equal(isAssistantShortcut(base), true);
  assert.equal(isAssistantShortcut({ ...base, code: undefined, key: 'a' }), true);
  assert.equal(isAssistantShortcut({ ...base, code: 'KeyQ', key: 'q' }), false);
  // AZERTY : la touche physique du A envoie code 'KeyQ' pour la lettre q ; la touche Q physique (code 'KeyA') produit 'q'.
  assert.equal(isAssistantShortcut({ ...base, code: 'KeyA', key: 'Q' }), false);
  assert.equal(isAssistantShortcut({ ...base, code: 'KeyQ', key: 'A' }), true);
  // Mac : Alt+Maj+A produit un caractère spécial ; le code physique décide alors.
  assert.equal(isAssistantShortcut({ ...base, code: 'KeyA', key: 'Â' }), true);
  assert.equal(isAssistantShortcut({ ...base, code: 'KeyB', key: 'Â' }), false);
  assert.equal(isAssistantShortcut({ ...base, altKey: false }), false);
  assert.equal(isAssistantShortcut({ ...base, shiftKey: false }), false);
  assert.equal(isAssistantShortcut({ ...base, ctrlKey: true }), false);
  assert.equal(isAssistantShortcut({ ...base, metaKey: true }), false);
});

