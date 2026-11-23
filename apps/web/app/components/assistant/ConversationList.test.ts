// Rendu statique de la liste des échanges.
// Lancer : cd apps/web && npx tsx --test app/components/assistant/ConversationList.test.ts
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AsstConversationDto } from '@archivage/types';
import type { UiError } from './_lib/ui-error';

type List = typeof import('./ConversationList').ConversationList;
let ConversationList: List;
before(async () => {
  (globalThis as { React?: unknown }).React = React;
  ({ ConversationList } = await import('./ConversationList'));
});

const NOW = Date.parse('2026-11-22T10:00:00.000Z');
const TRAP = '<img src=x onerror=alert(1)>';

function conv(id: string, title: string | null, count = 2): AsstConversationDto {
  return {
    conversationId: id,
    title,
    pageContext: null,
    createdAt: '2026-11-20T09:00:00.000Z',
    updatedAt: '2026-11-21T09:00:00.000Z',
    lastMessageAt: '2026-11-21T09:00:00.000Z',
    purgeAt: new Date(NOW + 10 * 86_400_000).toISOString(),
    messageCount: count,
  };
}

interface Opts {
  items?: AsstConversationDto[];
  total?: number;
  status?: 'idle' | 'loading' | 'ready' | 'error';
  error?: UiError | null;
  selectedId?: string | null;
  deleteError?: UiError | null;
}
function render(o: Opts = {}): string {
  const items = o.items ?? [];
  return renderToStaticMarkup(
    createElement(ConversationList, {
      items,
      total: o.total ?? items.length,
      status: o.status ?? 'ready',
      error: o.error ?? null,
      selectedId: o.selectedId ?? null,
      nowMs: NOW,
      onOpen: () => {},
      onDelete: () => {},
      onNew: () => {},
      onRetry: () => {},
      deleteError: o.deleteError ?? null,
      onDismissDeleteError: () => {},
    }),
  );
}

test('chargement : squelette et aria-busy', () => {
  const html = render({ status: 'loading' });
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /ant-skeleton/);
  assert.match(html, /Vos échanges/);
  assert.match(html, /Nouvel échange/);
});

test('vide : message d’invitation et bouton', () => {
  const html = render({ status: 'ready' });
  assert.match(html, /Aucun échange pour l’instant\./);
  assert.match(html, /impute ce courrier/);
  assert.equal((html.match(/Nouvel échange/g) ?? []).length, 2);
  assert.doesNotMatch(html, /<ul/);
});

test('échec de suppression : erreur visible dans la liste', () => {
  const deleteError: UiError = { kind: 'generic', message: 'Une erreur est survenue.', retryAfterSeconds: null, retryable: false };
  const html = render({ items: [conv('1', 'A', 1)], deleteError });
  assert.match(html, /role="alert"/);
  assert.match(html, /Suppression impossible. Une erreur est survenue./);
  assert.match(html, /Masquer ce message/);
  assert.doesNotMatch(render({ items: [conv('1', 'A', 1)] }), /Suppression impossible/);
});

test('erreur : bandeau et Réessayer', () => {
  const error: UiError = { kind: 'network', message: 'Serveur injoignable.', retryAfterSeconds: null, retryable: true };
  const html = render({ status: 'error', error });
  assert.match(html, /role="alert"/);
  assert.match(html, /Serveur injoignable\./);
  assert.match(html, /Réessayer/);
});

test('liste de 3 échanges dont un titre piégé : échappé, aucun lien ni image', () => {
  const html = render({ items: [conv('1', 'Imputation DAF'), conv('2', TRAP), conv('3', null, 1)] });
  assert.equal((html.match(/<li/g) ?? []).length, 3);
  assert.match(html, /Imputation DAF/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(html, /<a[ >]/);
  assert.match(html, /Échange du 20\/11\/2026/);
  assert.match(html, /2 messages/);
  assert.match(html, /1 message</);
  assert.match(html, /Supprimé automatiquement dans 10 jours/);
});

test('sélection : aria-current sur la bonne entrée seulement', () => {
  const html = render({ items: [conv('1', 'A'), conv('2', 'B')], selectedId: '2' });
  assert.equal((html.match(/aria-current="true"/g) ?? []).length, 1);
  assert.match(html, /aria-current="true"[^>]*>(?:<[^>]+>)*B/);
});

test('total > items : mention du total', () => {
  assert.match(render({ items: [conv('1', 'A')], total: 42 }), /42 échanges au total/);
  assert.doesNotMatch(render({ items: [conv('1', 'A')], total: 1 }), /au total/);
});

test('bouton supprimer avec aria-label explicite (titre échappé)', () => {
  const html = render({ items: [conv('1', 'Imputation DAF'), conv('2', TRAP)] });
  assert.match(html, /aria-label="Supprimer l’échange Imputation DAF"/);
  assert.match(html, /aria-label="Supprimer l’échange &lt;img src=x onerror=alert\(1\)&gt;"/);
});
