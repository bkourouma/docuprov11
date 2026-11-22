// Rendu statique du fil de conversation.
// Lancer : cd apps/web && npx tsx --test app/components/assistant/MessageThread.test.ts
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AsstMessageDto, AsstPageContext, AsstProposalDto } from '@archivage/types';
import type { Busy, CardNotice } from './_lib/proposal-logic';

type Thread = typeof import('./MessageThread').MessageThread;
let MessageThread: Thread;
before(async () => {
  (globalThis as { React?: unknown }).React = React;
  ({ MessageThread } = await import('./MessageThread'));
});

const EXP = Date.parse('2026-11-22T09:29:02.000Z');
const NOW = EXP - 14 * 60_000;

function prop(id: string, over: Partial<AsstProposalDto> = {}): AsstProposalDto {
  return {
    proposalId: id,
    conversationId: '1',
    messageId: 'm2',
    status: 0,
    actions: [
      {
        tool: 'proposer_imputation_courrier',
        args: { mailId: 4321, recipients: [{ userGroupId: 17, mailInputationTypeId: 2, delayDays: 3 }], rationale: 'Délai.' },
      },
    ],
    summary: 'Imputer le courrier 4321.',
    argsHash: 'a'.repeat(64),
    expiresAt: new Date(EXP).toISOString(),
    createdAt: new Date(EXP - 15 * 60_000).toISOString(),
    confirmedAt: null,
    finishedAt: null,
    result: null,
    errorCode: null,
    errorMessage: null,
    rowVersion: 1,
    ...over,
  };
}

function msg(id: string, role: 0 | 1, content: string, position: number, proposals: AsstProposalDto[] = []): AsstMessageDto {
  return { messageId: id, conversationId: '1', role, content, position, createdAt: '2026-11-22T09:15:00.000Z', proposals };
}

interface Opts {
  messages?: AsstMessageDto[];
  pageContext?: AsstPageContext | null;
  pendingText?: string | null;
  sending?: boolean;
  blocked?: boolean;
  proposals?: Record<string, { busy: Busy; notice: CardNotice | null }>;
  announce?: string;
}
function render(o: Opts = {}): string {
  return renderToStaticMarkup(
    createElement(MessageThread, {
      messages: o.messages ?? [],
      pageContext: o.pageContext ?? null,
      pendingText: o.pendingText ?? null,
      sending: o.sending ?? false,
      blocked: o.blocked ?? false,
      nowMs: NOW,
      proposals: o.proposals ?? {},
      announce: o.announce ?? '',
      onConfirm: () => {},
      onRefuse: () => {},
      onReload: () => {},
      onChoose: () => {},
    }),
  );
}

const withClar = (m: AsstMessageDto): AsstMessageDto =>
  ({ ...m, clarification: { question: 'Quel service ?', choices: ['DAF', 'DRH'] } }) as AsstMessageDto;

test('fil vide : 3 exemples, groupe nommé accessible (pas de role=log)', () => {
  const html = render();
  // Pas de role="log" (live implicite) : la zone `announce` et la carte portent les annonces, sans doublon.
  assert.match(html, /role="group"/);
  assert.doesNotMatch(html, /role="log"/);
  assert.match(html, /aria-label="Fil de la conversation"/);
  assert.match(html, /tabindex="0"/);
  assert.match(html, /Impute ce courrier à la DAF sous 3 jours/);
  assert.match(html, /Relance le service concerné pour ce courrier en retard/);
  assert.match(html, /Prépare un brouillon de réponse à ce courrier/);
  assert.doesNotMatch(html, /role="status"/);
});

test('contexte de page affiché en tête', () => {
  const html = render({ pageContext: { route: '/courriers/controle', subjectType: 'mail', subjectId: '4321' } });
  assert.match(html, /Contexte : (<!-- -->)?courrier n° (<!-- -->)?4321/);
  assert.doesNotMatch(render({ pageContext: { route: '/x' } }), /Contexte/);
});

test('fil user + assistant : libellés, heures, texte brut', () => {
  const html = render({ messages: [msg('m1', 0, 'Bonjour\nligne 2', 1), msg('m2', 1, 'Réponse', 2)] });
  assert.equal((html.match(/<article/g) ?? []).length, 2);
  assert.match(html, /aria-label="Vous"/);
  assert.match(html, /aria-label="Assistant"/);
  assert.match(html, /<p class="asst-msg-text">Bonjour\nligne 2<\/p>/);
  assert.match(html, /asst-msg-time/);
  assert.doesNotMatch(html, /Que souhaitez-vous faire/);
});

test('contenu piégé : échappé, aucun lien, script ni image', () => {
  const html = render({
    messages: [
      msg('m1', 0, '<script>alert(1)</script>', 1),
      msg('m2', 1, '<img src=x onerror=alert(1)> [clic](javascript:alert(1)) https://exemple.test/x <a href="javascript:alert(1)">z</a>', 2),
    ],
  });
  assert.doesNotMatch(html, /<a[ >]/);
  assert.doesNotMatch(html, /<script/);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /https:\/\/exemple\.test\/x/);
  assert.match(html, /javascript:alert\(1\)/);
});

test('proposition rendue via ConfirmationCard (région et boutons)', () => {
  const html = render({ messages: [msg('m1', 0, 'Impute', 1), msg('m2', 1, 'Voici', 2, [prop('p1')])] });
  assert.match(html, /role="region"/);
  assert.match(html, /Action proposée/);
  assert.match(html, /Confirmer/);
  assert.match(html, /Refuser/);
});

test('plusieurs propositions : une carte chacune', () => {
  const html = render({ messages: [msg('m2', 1, 'Voici', 2, [prop('p1'), prop('p2')])] });
  assert.equal((html.match(/role="region"/g) ?? []).length, 2);
});

test('état d’une proposition lu dans `proposals` (busy)', () => {
  const html = render({
    messages: [msg('m2', 1, 'Voici', 2, [prop('p1')])],
    proposals: { p1: { busy: 'confirm', notice: { kind: 'info', message: 'Patientez' } } },
  });
  assert.match(html, /Application en cours/);
  assert.match(html, /Patientez/);
});

test('pending + sending : bulle « Vous » en envoi et indicateur de réflexion', () => {
  const html = render({ messages: [msg('m1', 0, 'Avant', 1)], pendingText: 'Ma question', sending: true });
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /Envoi…/);
  assert.match(html, /Ma question/);
  assert.match(html, /role="status"[^>]*>L’assistant réfléchit…/);
});

test('sans sending : ni indicateur ni bulle en attente', () => {
  const html = render({ pendingText: 'Ma question', sending: false });
  assert.doesNotMatch(html, /Envoi…/);
  assert.doesNotMatch(html, /réfléchit/);
});

test('clarification : seulement sur le dernier message', () => {
  const last = render({ messages: [msg('m1', 0, 'Impute', 1), withClar(msg('m2', 1, 'Précisez', 2))] });
  assert.match(last, /Quel service \?/);
  assert.match(last, /DAF/);
  assert.match(last, /DRH/);
  const notLast = render({ messages: [withClar(msg('m2', 1, 'Précisez', 2)), msg('m3', 0, 'DAF', 3)] });
  assert.doesNotMatch(notLast, /Quel service/);
});

test('clarification désactivée pendant l’envoi ou si bloqué', () => {
  const msgs = [withClar(msg('m2', 1, 'Précisez', 2))];
  assert.match(render({ messages: msgs, sending: true }).match(/<button[^>]*class="asst-choice"[^>]*>/)?.[0] ?? '', /disabled/);
  assert.match(render({ messages: msgs, blocked: true }).match(/<button[^>]*class="asst-choice"[^>]*>/)?.[0] ?? '', /disabled/);
});

test('annonce : texte du parent dans la zone polie', () => {
  const html = render({ announce: 'Nouvelle réponse de l’assistant.' });
  assert.match(html, /aria-live="polite"[^>]*>Nouvelle réponse de l’assistant\./);
  assert.doesNotMatch(render({ announce: '' }), /Nouvelle réponse/);
});
