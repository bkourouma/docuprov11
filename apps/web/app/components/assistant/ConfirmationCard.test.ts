// Rendu statique de la carte de confirmation, tous les états.
// Lancer : cd apps/web && npx tsx --test app/components/assistant/ConfirmationCard.test.ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { before, test } from 'node:test';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AsstProposalDto, AsstProposedAction } from '@archivage/types';
import type { CardNotice } from './_lib/proposal-logic';

// `React` global requis avant l'import du composant (jsx: preserve + tsx => React.createElement).
type CardComponent = typeof import('./ConfirmationCard').ConfirmationCard;
let ConfirmationCard: CardComponent;
before(async () => {
  (globalThis as { React?: unknown }).React = React;
  ({ ConfirmationCard } = await import('./ConfirmationCard'));
});

const EXP = Date.parse('2026-11-22T09:29:02.000Z');
const NOW = EXP - 14 * 60_000 - 32_000; // 14 min 32 s restantes

const imputation: AsstProposedAction = {
  tool: 'proposer_imputation_courrier',
  args: { mailId: 4321, recipients: [{ userGroupId: 17, mailInputationTypeId: 2, delayDays: 3 }], rationale: 'Délai demandé.' },
};
const relance: AsstProposedAction = {
  tool: 'proposer_relance',
  args: { mailId: 10, mailInputationId: 20, recipientUserGroupId: 30, message: 'Merci de répondre' },
};
const brouillon: AsstProposedAction = {
  tool: 'preparer_brouillon_reponse',
  args: { templateId: 'tpl-1', label: 'Réponse', draftHtml: '<p>Bonjour <b>Madame</b></p>', mailId: 5 },
};

function prop(over: Partial<AsstProposalDto> = {}): AsstProposalDto {
  return {
    proposalId: '5001',
    conversationId: '1203',
    messageId: '8843',
    status: 0,
    actions: [imputation],
    summary: 'Imputer le courrier 4321 à la DAF.',
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

interface Opts {
  nowMs?: number;
  busy?: null | 'confirm' | 'refuse';
  notice?: CardNotice | null;
  onConfirm?: () => void;
  onRefuse?: (r?: string) => void;
  onReload?: () => void;
}
const render = (proposal: AsstProposalDto, o: Opts = {}) =>
  renderToStaticMarkup(
    createElement(ConfirmationCard, {
      proposal,
      nowMs: o.nowMs ?? NOW,
      busy: o.busy ?? null,
      notice: o.notice,
      onConfirm: o.onConfirm ?? (() => {}),
      onRefuse: o.onRefuse ?? (() => {}),
      onReload: o.onReload,
    }),
  );

/** Balises <button> avec leur contenu. */
const buttons = (html: string) => html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? [];
const liveZones = (html: string) => (html.match(/aria-live=/g) ?? []).length;

test('proposée : boutons actifs, compte à rebours, bandeau, ordre Confirmer puis Refuser', () => {
  const html = render(prop());
  assert.match(html, /<section tabindex="-1" class="asst-card asst-card--proposed" role="region" aria-labelledby="/);
  assert.match(html, /Action proposée/);
  assert.match(html, /Proposée/);
  assert.match(html, /Cette proposition n’a aucun effet tant que vous ne l’avez pas confirmée\./);
  assert.match(html, /Imputer le courrier 4321 à la DAF\./);
  assert.match(html, /Valable jusqu’à \d{2}:\d{2}/);
  assert.match(html, /<span role="timer"[^>]*>14 min 32 s<\/span>/);
  const b = buttons(html);
  assert.equal(b.length, 2);
  assert.match(b[0], /Confirmer/);
  assert.match(b[1]!, /Refuser/);
  assert.ok(!/disabled/.test(b[0]!) && !/disabled/.test(b[1]!));
  assert.match(b[0], /ant-btn-primary/);
  assert.match(html, /Imputation de courrier/);
  assert.match(html, /<dt>Courrier<\/dt><dd>n° 4321<\/dd>/);
  assert.match(html, /Destinataire 1/);
  assert.match(html, /3 jours/);
  assert.match(html, /role="note"/);
  assert.match(html, /ne peut pas être annulée automatiquement/);
});

test('proposée avec échéance < 1 min : avertissement', () => {
  const html = render(prop(), { nowMs: EXP - 45_000 });
  assert.match(html, /Cette proposition expire dans moins d’une minute\./);
  assert.match(html, /45 s/);
});

test('proposée mais nowMs >= expiresAt : « Expirée », AUCUN bouton, pas de timer', () => {
  const html = render(prop(), { nowMs: EXP });
  assert.match(html, /asst-card--expired/);
  assert.match(html, /Expirée — reformulez votre demande\./);
  assert.equal(buttons(html).length, 0);
  assert.ok(!/role="timer"/.test(html));
});

test('pendant un envoi, le badge ne dit jamais « Expirée », même si l’échéance est passée', () => {
  const html = render(prop(), { nowMs: EXP + 5000, busy: 'confirm' });
  assert.match(html, /asst-card-pill--confirming">Confirmée</);
  assert.ok(!/asst-card-pill--expired/.test(html));
  assert.ok(!/>Expirée</.test(html));
});

test('reload-needed : Confirmer désactivé (contenu peut-être périmé) et bouton Recharger', () => {
  const html = render(prop(), { notice: { kind: 'reload-needed', message: 'Rechargez.' }, onReload: () => {} });
  const b = buttons(html);
  const confirm = b.find((x) => /Confirmer/.test(x))!;
  assert.match(confirm, /disabled/);
  assert.match(html, /Recharger la proposition/);
});

test('busy confirm / refuse : deux boutons disabled, un seul en loading', () => {
  for (const busy of ['confirm', 'refuse'] as const) {
    const html = render(prop(), { busy });
    const b = buttons(html);
    assert.equal(b.length, 2);
    assert.match(b[0], /disabled/);
    assert.match(b[1]!, /disabled/);
    const loading = b.filter((x) => /ant-btn-loading/.test(x));
    assert.equal(loading.length, 1);
    assert.match(loading[0]!, busy === 'confirm' ? /Confirmer/ : /Refuser/);
    assert.match(html, /Application en cours…/);
    assert.ok(!/role="timer"/.test(html));
  }
});

test('statut 1 Confirmée : application en cours, boutons disabled', () => {
  const html = render(prop({ status: 1 }));
  assert.match(html, /asst-card--confirming/);
  assert.match(html, /Application en cours…/);
  assert.match(html, />Application en cours\.</);
  for (const b of buttons(html)) assert.match(b, /disabled/);
});

test('appliquée : effets listés, aucun bouton', () => {
  const html = render(
    prop({
      status: 2,
      result: { effects: [{ tool: 'proposer_imputation_courrier', summary: { mailId: 4321, inputationsCreees: 1, autre: 'x' } }] },
    }),
  );
  assert.match(html, /asst-card--applied/);
  assert.match(html, /Appliquée/);
  assert.match(html, /<ul class="asst-card-effects">/);
  assert.match(html, /Imputations créées<\/dt><dd>1<\/dd>/);
  assert.match(html, /<dt>autre<\/dt><dd>x<\/dd>/);
  assert.match(html, />Proposition appliquée\.</);
  assert.equal(buttons(html).length, 0);
  assert.ok(!/Cette proposition n’a aucun effet/.test(html));
});

test('refusée', () => {
  const html = render(prop({ status: 3 }));
  assert.match(html, /Refusée — aucune action n’a été appliquée\./);
  assert.match(html, />Proposition refusée\.</);
  assert.equal(buttons(html).length, 0);
});

test('expirée statut 4', () => {
  const html = render(prop({ status: 4 }), { nowMs: EXP + 1000 });
  assert.match(html, /Expirée — reformulez votre demande\./);
  assert.match(html, /Reformulez votre demande pour obtenir une nouvelle proposition\./);
  assert.match(html, />Proposition expirée\.</);
  assert.equal(buttons(html).length, 0);
});

test('échec statut 5 avec et sans errorMessage', () => {
  const withMsg = render(prop({ status: 5, errorCode: 'effect_failed', errorMessage: 'Le courrier est déjà imputé.' }));
  assert.match(withMsg, /asst-card--failed/);
  assert.match(withMsg, />Échec</);
  assert.match(withMsg, /Le courrier est déjà imputé\./);
  assert.match(withMsg, />Échec de l’application\.</);
  assert.equal(buttons(withMsg).length, 0);

  const noMsg = render(prop({ status: 5, errorCode: 'effect_failed', errorMessage: null }));
  assert.match(noMsg, /L’application n’a pas pu appliquer cette action/);
  const forb = render(prop({ status: 5, errorCode: 'effect_forbidden', errorMessage: '  ' }));
  assert.match(forb, /droits nécessaires/);
  assert.ok(!/>effect_failed</.test(noMsg));
});

test('notices : conflit avec Recharger, reload-needed, erreur en role=alert, info en status', () => {
  const conflict = render(prop(), { notice: { kind: 'conflict', message: 'La proposition a changé.' }, onReload: () => {} });
  assert.match(conflict, /role="status"/);
  assert.match(conflict, /La proposition a changé\./);
  // Le conflit est déjà relu par le hook : pas de bouton de rechargement (réservé à reload-needed).
  assert.ok(!/Recharger la proposition/.test(conflict));

  const reload = render(prop(), { notice: { kind: 'reload-needed', message: 'Rechargez.' }, onReload: () => {} });
  assert.match(reload, /Recharger la proposition/);

  const err = render(prop(), { notice: { kind: 'error', message: 'Accès refusé.' }, onReload: () => {} });
  assert.match(err, /<div class="asst-card-notice asst-card-notice--error" role="alert">/);
  assert.ok(!/Recharger la proposition/.test(err));

  const info = render(prop({ status: 4 }), { notice: { kind: 'info', message: 'Expirée.' } });
  assert.match(info, /role="status"/);
  assert.ok(!/Recharger la proposition/.test(info));
  assert.ok(!/Recharger/.test(render(prop(), { notice: { kind: 'conflict', message: 'x' } })));
});

test('plusieurs actions (3 outils), relance, brouillon aperçu texte', () => {
  const html = render(prop({ actions: [imputation, relance, brouillon] }));
  assert.match(html, /<ol class="asst-card-actions">/);
  assert.equal((html.match(/class="asst-card-action"/g) ?? []).length, 3);
  assert.match(html, /Plusieurs actions seront appliquées en une seule confirmation \(3\)\./);
  assert.match(html, /Notification interne : aucun e-mail n’est envoyé\./);
  assert.match(html, /Escalade|Imputation visée/);
  assert.match(html, /Brouillon de réponse/);
  assert.match(html, /Bonjour Madame/);
  assert.ok(!/<b>/.test(html));
  assert.match(html, /Un document brouillon sera créé\./);
  assert.match(html, /Message<\/dt><dd>Merci de répondre/);
});

test('outil inconnu : « Action non reconnue »', () => {
  const html = render(prop({ actions: [{ tool: 'x', args: {} } as unknown as AsstProposedAction] }));
  assert.match(html, /Action non reconnue/);
});

test('INJECTION : tout est du texte échappé, aucune balise dangereuse', () => {
  const evil = [
    '<img src=x onerror=alert(1)>',
    '<script>alert(1)</script>',
    'javascript:alert(1)',
    '<iframe src="javascript:alert(1)"></iframe>',
  ];
  const html = render(
    prop({
      status: 2,
      summary: evil[0],
      errorMessage: evil[1],
      actions: [
        {
          tool: 'proposer_imputation_courrier',
          args: { mailId: 1, recipients: [{ userGroupId: 1, mailInputationTypeId: 1, instructions: evil[0]! }], rationale: evil[3]! },
        },
        { tool: 'proposer_relance', args: { mailId: 1, mailInputationId: 1, recipientUserGroupId: 1, message: evil[2]! } },
        {
          tool: 'preparer_brouillon_reponse',
          args: { templateId: 't', label: evil[1]!, draftHtml: `<p>Salut</p>${evil[1]!}${evil[3]!}<img src=x onerror=alert(2)>` },
        },
      ],
      result: { effects: [{ tool: 'x', summary: { [evil[0]!]: evil[1]!, v: evil[3]! } }] },
    }),
    { notice: { kind: 'error', message: evil[1]! } },
  );
  assert.ok(!/<img/i.test(html), 'pas de <img');
  assert.ok(!/<script/i.test(html), 'pas de <script');
  assert.ok(!/<iframe/i.test(html), 'pas de <iframe');
  assert.ok(!/<a[\s>]/i.test(html), 'pas de <a');
  assert.ok(!/<[a-z][^>]*\son\w+=/i.test(html), 'aucun attribut on*= dans une balise');
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /javascript:alert\(1\)/);
  // le HTML du brouillon n'apparaît que sous forme de texte brut
  assert.match(html, /Salut/);
});

test('accessibilité : région nommée, une seule zone live, timer seulement en phase proposée', () => {
  const html = render(prop());
  const labelled = /aria-labelledby="([^"]+)"/.exec(html);
  assert.ok(labelled);
  assert.match(html, new RegExp(`<h4 id="${labelled![1]!.replace(/[:]/g, '\\$&')}"`));
  assert.equal(liveZones(html), 1);
  assert.match(html, /<div class="asst-card-live" aria-live="polite" aria-atomic="true"><\/div>/);
  assert.ok(!/<div class="asst-card-live"[^>]*>[^<]*14 min/.test(html), 'compte à rebours absent de la zone live');
  for (const s of [0, 1, 2, 3, 4, 5] as const) {
    const h = render(prop({ status: s }));
    assert.equal(liveZones(h), 1);
    assert.equal(/role="timer"/.test(h), s === 0);
  }
  const h3 = renderToStaticMarkup(
    createElement(ConfirmationCard, { proposal: prop(), nowMs: NOW, busy: null, onConfirm() {}, onRefuse() {}, headingLevel: 3 }),
  );
  assert.match(h3, /<h3 id=/);
});

test('aucun callback déclenché au rendu ; jamais de dangerouslySetInnerHTML dans les sources', () => {
  let calls = 0;
  const bump = () => {
    calls += 1;
  };
  render(prop(), { onConfirm: bump, onRefuse: bump, onReload: bump });
  render(prop(), { onConfirm: bump, onRefuse: bump, onReload: bump, busy: 'confirm' });
  assert.equal(calls, 0);
  const dir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  for (const f of ['ConfirmationCard.tsx', 'ClarificationChoices.tsx', path.join('_lib', 'proposal-logic.ts')]) {
    const src = fs.readFileSync(path.join(decodeURIComponent(dir), f), 'utf8');
    assert.ok(!src.includes('dangerouslySetInnerHTML'), `${f} contient dangerouslySetInnerHTML`);
    assert.ok(!/\binnerHTML\b/.test(src.replace(/\/\/.*$/gm, '')), `${f} utilise innerHTML`);
  }
});
