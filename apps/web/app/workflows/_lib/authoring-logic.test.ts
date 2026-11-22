// Tests de la logique pure de création en langage naturel (W5).
// Lancer : cd apps/web && npx tsx --test app/workflows/_lib/authoring-logic.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WfAuthoringGenerateResponse, WfGraph } from '@archivage/types';
import { WorkflowApiError } from '../../lib/workflows-api';
import {
  AUTHORING_AI_DISABLED_MESSAGE,
  AUTHORING_EXAMPLE,
  BANNER_LIMITS,
  authoringEditorPath,
  authoringErrorMessage,
  bannerStorageKey,
  buildBannerModel,
  buildBannerState,
  clearBannerState,
  countChars,
  counterLabel,
  describeProblems,
  editorPath,
  filterTemplates,
  loadBannerState,
  markersToComplete,
  normalizeExplanation,
  saveBannerState,
  templateTagsLabel,
  usableTemplates,
  validateDescription,
  type BannerState,
  type BannerStorageLike,
} from './authoring-logic';

function memoryStorage(initial: Record<string, string> = {}): BannerStorageLike & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (k in data ? (data[k] as string) : null),
    setItem: (k, v) => {
      data[k] = v;
    },
    removeItem: (k) => {
      delete data[k];
    },
  };
}

const throwingStorage: BannerStorageLike = {
  getItem: () => {
    throw new Error('bloqué');
  },
  setItem: () => {
    throw new Error('plein');
  },
  removeItem: () => {
    throw new Error('bloqué');
  },
};

const graph = (steps: Array<Record<string, unknown>>): WfGraph =>
  ({ schemaVersion: 1, start: 'a', steps: steps.map((s) => ({ next: [], ...s })) }) as unknown as WfGraph;

const response = (over: Partial<WfAuthoringGenerateResponse> = {}): WfAuthoringGenerateResponse => ({
  definitionId: 12,
  name: 'Facture fournisseur',
  graph: graph([{ key: 'a', name: 'A', type: 'form' }]),
  issues: [],
  assumptions: ['Seuil de 5 000 000 FCFA'],
  toComplete: [{ stepKey: 'a', stepName: 'Validation DAF', what: 'assignee', hint: 'DAF' }],
  triggerSuggestion: { eventType: 'document.created', label: 'Facture fournisseur reçue', conditions: {}, reason: '', incomplete: [] },
  ...over,
});

// ----- description -----

test('validateDescription : vide, trop courte, trop longue, valide', () => {
  assert.match(validateDescription('') ?? '', /Décrivez le besoin/);
  assert.match(validateDescription('   \n ') ?? '', /Décrivez le besoin/);
  assert.match(validateDescription('court') ?? '', /trop courte/);
  assert.equal(validateDescription('1234567890'), null);
  assert.equal(validateDescription(AUTHORING_EXAMPLE), null);
  assert.equal(validateDescription('a'.repeat(4000)), null);
  assert.match(validateDescription('a'.repeat(4001)) ?? '', /trop longue.*4000/);
  // Les espaces de tête et de queue ne comptent pas.
  assert.match(validateDescription(`   ${'a'.repeat(5)}   `) ?? '', /trop courte/);
});

test('countChars : points de code (un emoji vaut 1) ; compteur « n / 4000 »', () => {
  assert.equal(countChars('abc'), 3);
  assert.equal(countChars('😀'), 1);
  assert.equal(countChars('a😀é'), 3);
  assert.equal(countChars(''), 0);
  assert.equal(counterLabel('a😀'), '2 / 4000');
  // 4000 emojis restent dans la limite (8000 unités UTF-16).
  assert.equal(validateDescription('😀'.repeat(4000)), null);
  assert.match(validateDescription('😀'.repeat(4001)) ?? '', /trop longue/);
});

test('authoringEditorPath / editorPath : identifiant entier positif seulement', () => {
  assert.equal(authoringEditorPath(12), '/workflows/conception/12?origine=langage-naturel');
  assert.equal(editorPath(12), '/workflows/conception/12');
  for (const bad of [0, -1, 1.5, '12', null, undefined, NaN, Number.MAX_SAFE_INTEGER + 2]) {
    assert.equal(authoringEditorPath(bad), null);
    assert.equal(editorPath(bad), null);
  }
});

// ----- messages d'erreur -----

test('authoringErrorMessage : 409 IA désactivée, message français de l’API, repli', () => {
  assert.equal(authoringErrorMessage(new WorkflowApiError(409, 'IA désactivée pour ce client')), AUTHORING_AI_DISABLED_MESSAGE);
  assert.equal(authoringErrorMessage(new WorkflowApiError(409, 'HTTP 409')), AUTHORING_AI_DISABLED_MESSAGE);
  assert.equal(authoringErrorMessage(new WorkflowApiError(409, 'Conflict')), AUTHORING_AI_DISABLED_MESSAGE);
  assert.equal(
    authoringErrorMessage(new WorkflowApiError(409, 'Arrêt d’urgence actif : la génération est suspendue.')),
    'Arrêt d’urgence actif : la génération est suspendue.',
  );
  assert.match(AUTHORING_AI_DISABLED_MESSAGE, /L’IA est désactivée pour ce client : décrivez le besoin dans l’éditeur ou créez le workflow à la main\./);
});

test('authoringErrorMessage : 429 avec et sans Retry-After', () => {
  assert.equal(
    authoringErrorMessage(new WorkflowApiError(429, 'Too Many Requests', undefined, undefined, undefined, 30)),
    'Trop de demandes de génération. Réessayez dans 30 s.',
  );
  assert.equal(authoringErrorMessage(new WorkflowApiError(429, 'Too Many Requests')), 'Trop de demandes de génération. Réessayez dans quelques instants.');
  assert.equal(
    authoringErrorMessage(new WorkflowApiError(429, 'Le budget IA du mois est épuisé.')),
    'Le budget IA du mois est épuisé.',
  );
});

test('authoringErrorMessage : 422 brouillon inutilisable + problèmes, 403, 5xx, réseau, inconnu', () => {
  const m422 = authoringErrorMessage(
    new WorkflowApiError(422, 'x', 'AUTHORING_INVALID', [
      { code: 'UNREACHABLE_STEP', message: 'L’étape « b » est inaccessible.' },
      { code: 'NO_TERMINAL_STEP', message: 'Aucune étape finale.' },
    ]),
  );
  assert.match(m422, /^Le brouillon généré n’est pas utilisable : reformulez le besoin avec plus de détails\./);
  assert.match(m422, /inaccessible.*;.*Aucune étape finale/);
  assert.equal(
    authoringErrorMessage(new WorkflowApiError(422, 'x', 'AUTHORING_INVALID')),
    'Le brouillon généré n’est pas utilisable : reformulez le besoin avec plus de détails.',
  );
  // Plus de 5 problèmes : seuls les 5 premiers sont cités.
  const many = Array.from({ length: 9 }, (_, i) => ({ code: 'X', message: `p${i}` }));
  assert.ok(!authoringErrorMessage(new WorkflowApiError(422, 'x', 'AUTHORING_INVALID', many as never)).includes('p5'));
  assert.match(authoringErrorMessage(new WorkflowApiError(403, 'Forbidden')), /droit de conception/);
  assert.equal(authoringErrorMessage(new WorkflowApiError(502, 'Bad gateway: secret')), 'Le service est momentanément indisponible. Réessayez dans un instant.');
  assert.match(authoringErrorMessage(new WorkflowApiError(0, 'x')), /injoignable/);
  assert.equal(authoringErrorMessage(new Error('boom')), 'Une erreur est survenue. Réessayez.');
});

// ----- problèmes -----

test('describeProblems : regroupe problèmes et éléments à compléter en lignes lisibles', () => {
  const lines = describeProblems(
    response({ issues: [{ code: 'X', message: 'Étape isolée.', stepKey: 'b' }] }),
  );
  assert.deepEqual(lines, [
    { kind: 'issue', text: 'Étape isolée.', stepKey: 'b' },
    { kind: 'todo', text: 'Étape « Validation DAF » : renseigner le responsable (« DAF » lu dans la description).', stepKey: 'a' },
  ]);
  assert.deepEqual(describeProblems({ issues: [], toComplete: [] }), []);
  assert.match(
    describeProblems({ issues: [], toComplete: [{ stepKey: 'a', stepName: 'N', what: 'assignee', hint: null }] })[0]?.text ?? '',
    /^Étape « N » : renseigner le responsable\.$/,
  );
});

// ----- bandeau et stockage -----

test('buildBannerState / buildBannerModel : titre, hypothèses, problèmes, à compléter, déclencheur, compte', () => {
  const r = response({ issues: [{ code: 'X', message: 'Problème A' }] });
  const state = buildBannerState(r);
  const model = buildBannerModel({ state, graph: r.graph });
  assert.ok(model);
  assert.match(model.title, /Brouillon généré à partir de votre description — à relire avant toute publication/);
  assert.deepEqual(model.assumptions, ['Seuil de 5 000 000 FCFA']);
  assert.equal(model.problems.length, 1);
  assert.equal(model.toComplete.length, 1);
  assert.equal(model.count, 3);
  assert.equal(model.countLabel, '3 points à relire');
  assert.equal(
    model.triggerText,
    'Déclencheur suggéré : Facture fournisseur reçue — à créer dans le panneau Déclencheurs ; rien n’a été créé.',
  );
});

test('buildBannerModel : rien à montrer sans état ni marqueur ; l’élément disparaît quand le responsable est renseigné', () => {
  assert.equal(buildBannerModel({ state: null, graph: graph([{ key: 'a', name: 'A', type: 'form' }]) }), null);
  const withAssignee = graph([{ key: 'a', name: 'A', type: 'form', assignee: { kind: 'user', id: 3 } }]);
  const model = buildBannerModel({ state: buildBannerState(response()), graph: withAssignee });
  assert.ok(model);
  assert.equal(model.toComplete.length, 0);
  // Étape supprimée : l'élément n'a plus d'objet.
  const gone = buildBannerModel({ state: buildBannerState(response()), graph: graph([{ key: 'z', name: 'Z', type: 'form' }]) });
  assert.equal(gone?.toComplete.length, 0);
});

test('markersToComplete : marqueurs config.authoring.toComplete, étapes sans marqueur ignorées', () => {
  const g = graph([
    { key: 'a', name: 'Validation', type: 'validation', config: { authoring: { toComplete: ['assignee'], hint: 'DAF' } } },
    { key: 'b', name: 'Autre', type: 'form', config: { authoring: { note: 1 } } },
    { key: 'c', name: 'Libre', type: 'form', config: { authoring: 'texte' } },
    { key: 'd', name: 'Vide', type: 'form', config: { authoring: { toComplete: [] } } },
    { key: 'e', name: 'Réel', type: 'validation', config: { authoring: { toComplete: ['assignee'], assigneeHint: 'Chef de service', hint: 'ignoré' } } },
    { key: 'f', name: 'Sans libellé', type: 'validation', config: { authoring: { toComplete: ['assignee'], assigneeHint: null } } },
  ]);
  const items = markersToComplete(g);
  assert.deepEqual(items, [
    { stepKey: 'a', stepName: 'Validation', what: 'assignee', hint: 'DAF' },
    { stepKey: 'e', stepName: 'Réel', what: 'assignee', hint: 'Chef de service' },
    { stepKey: 'f', stepName: 'Sans libellé', what: 'assignee', hint: null },
  ]);
  // Le bandeau s'affiche grâce au marqueur seul, sans état enregistré.
  const model = buildBannerModel({ state: null, graph: g });
  assert.equal(model?.toComplete.length, 3);
  assert.equal(model?.countLabel, '3 points à relire');
  assert.deepEqual(markersToComplete(null), []);
});

test('stockage du bandeau : aller-retour, clé wf-authoring:<id>, nettoyage', () => {
  const st = memoryStorage();
  const state = buildBannerState(response());
  assert.equal(saveBannerState(st, 12, state), true);
  assert.ok('wf-authoring:12' in st.data);
  assert.equal(bannerStorageKey(12), 'wf-authoring:12');
  assert.deepEqual(loadBannerState(st, 12), state);
  assert.equal(loadBannerState(st, 13), null);
  clearBannerState(st, 12);
  assert.equal(loadBannerState(st, 12), null);
  assert.deepEqual(st.data, {});
});

test('stockage du bandeau : absent, qui lève, corrompu, forme inattendue => null sans exception', () => {
  const state = buildBannerState(response());
  assert.equal(saveBannerState(null, 1, state), false);
  assert.equal(saveBannerState(undefined, 1, state), false);
  assert.equal(saveBannerState(throwingStorage, 1, state), false);
  assert.equal(loadBannerState(null, 1), null);
  assert.equal(loadBannerState(throwingStorage, 1), null);
  assert.doesNotThrow(() => clearBannerState(throwingStorage, 1));
  assert.doesNotThrow(() => clearBannerState(null, 1));
  for (const raw of ['{pas du json', 'null', '[]', '"x"', '{"v":2,"assumptions":[],"issues":[],"toComplete":[]}', '{"v":1,"assumptions":"x","issues":[],"toComplete":[]}']) {
    assert.equal(loadBannerState(memoryStorage({ 'wf-authoring:1': raw }), 1), null, raw);
  }
});

test('stockage du bandeau : taille bornée (écriture et relecture)', () => {
  const huge = response({
    assumptions: Array.from({ length: 80 }, (_, i) => `H${i} ${'x'.repeat(900)}`),
    issues: Array.from({ length: 120 }, (_, i) => ({ code: 'X', message: `P${i} ${'y'.repeat(900)}`, stepKey: 'a' })),
    toComplete: Array.from({ length: 120 }, (_, i) => ({ stepKey: `s${i}`, stepName: 'n'.repeat(900), what: 'assignee' as const, hint: 'h'.repeat(900) })),
  });
  const bounded = buildBannerState(huge);
  assert.equal(bounded.assumptions.length, BANNER_LIMITS.assumptions);
  assert.equal(bounded.issues.length, BANNER_LIMITS.problems);
  assert.equal(bounded.toComplete.length, BANNER_LIMITS.problems);
  assert.ok(bounded.assumptions.every((a) => countChars(a) <= BANNER_LIMITS.assumptionChars));
  assert.ok(bounded.issues.every((i) => countChars(i.message) <= BANNER_LIMITS.textChars));
  const st = memoryStorage();
  assert.equal(saveBannerState(st, 5, bounded), true);
  assert.ok((st.data['wf-authoring:5'] as string).length <= BANNER_LIMITS.rawChars);

  // Valeur déjà trop grosse dans le stockage : ignorée sans analyse.
  const tooBig = JSON.stringify({ v: 1, assumptions: ['x'.repeat(BANNER_LIMITS.rawChars)], issues: [], toComplete: [] });
  assert.equal(loadBannerState(memoryStorage({ 'wf-authoring:6': tooBig }), 6), null);

  // Une valeur « bien formée » mais non bornée est bornée à la relecture.
  const loose = JSON.stringify({ v: 1, assumptions: Array.from({ length: 40 }, (_, i) => `a${i}`), issues: [], toComplete: [] });
  assert.equal(loadBannerState(memoryStorage({ 'wf-authoring:7': loose }), 7)?.assumptions.length, 20);
});

test('relecture du bandeau : éléments invalides écartés, texte conservé tel quel (jamais interprété)', () => {
  const raw = JSON.stringify({
    v: 1,
    assumptions: ['<img src=x onerror=alert(1)>', 42, '', null],
    issues: [{ code: 'X', message: '<script>alert(1)</script>' }, { code: 'Y' }, 'texte', null],
    toComplete: [{ stepKey: 'a', stepName: '<b>Nom</b>', what: 'assignee', hint: 3 }, { stepName: 'sans clé' }, 7],
    trigger: { label: '<i>Libellé</i>', eventType: 5 },
  });
  const s = loadBannerState(memoryStorage({ 'wf-authoring:9': raw }), 9);
  assert.ok(s);
  assert.deepEqual(s.assumptions, ['<img src=x onerror=alert(1)>']);
  assert.equal(s.issues.length, 1);
  assert.equal(s.issues[0]?.message, '<script>alert(1)</script>');
  assert.deepEqual(s.toComplete, [{ stepKey: 'a', stepName: '<b>Nom</b>', what: 'assignee', hint: null }]);
  assert.deepEqual(s.trigger, { label: '<i>Libellé</i>', eventType: '' });
});

test('saveBannerState refuse un état invalide', () => {
  assert.equal(saveBannerState(memoryStorage(), 1, { v: 2 } as unknown as BannerState), false);
});

// ----- explication -----

test('normalizeExplanation : forme vérifiée, textes bornés, champs inconnus ignorés', () => {
  assert.equal(normalizeExplanation(null), null);
  assert.equal(normalizeExplanation({ summary: 3 }), null);
  const v = normalizeExplanation({
    definitionId: 1,
    versionNumber: 2,
    summary: 'Résumé',
    steps: [{ key: 'a', name: 'A', text: 'Texte' }, { key: 'b' }, 'x'],
    toComplete: [{ stepKey: 'a', stepName: 'A', what: 'assignee', hint: 'DAF' }, 4],
  });
  assert.equal(v?.versionNumber, 2);
  assert.equal(v?.steps.length, 1);
  assert.equal(v?.toComplete.length, 1);
  assert.equal(normalizeExplanation({ summary: 'x'.repeat(9000), steps: [] })?.summary.length, 4000);
});

// ----- modèles -----

test('templateTagsLabel, usableTemplates, filterTemplates', () => {
  assert.equal(templateTagsLabel(['compta', ' facture ', '', 3 as unknown as string]), 'compta, facture');
  assert.equal(templateTagsLabel([]), '');
  assert.equal(templateTagsLabel(undefined), '');
  const list = usableTemplates([
    { key: 'facture_fournisseur', name: 'Facture fournisseur', description: 'Validation en deux niveaux', agentKey: 'extracteur', tags: ['compta', 7] },
    { key: 'MAUVAISE CLE', name: 'x', description: '', agentKey: null, tags: [] },
    { key: 'sans_nom', name: '  ', description: '', agentKey: null, tags: [] },
    { key: 'conge', name: 'Demande de congé', description: 5, agentKey: '', tags: 'rh' },
    null,
  ]);
  assert.deepEqual(
    list.map((t) => t.key),
    ['facture_fournisseur', 'conge'],
  );
  assert.deepEqual(list[0]?.tags, ['compta']);
  assert.equal(list[1]?.agentKey, null);
  assert.equal(list[1]?.description, '');
  assert.deepEqual(usableTemplates('pas une liste'), []);
  assert.deepEqual(filterTemplates(list, 'COMPTA').map((t) => t.key), ['facture_fournisseur']);
  assert.deepEqual(filterTemplates(list, 'congé').map((t) => t.key), ['conge']);
  assert.equal(filterTemplates(list, '  ').length, 2);
  assert.equal(filterTemplates(list, 'zzz').length, 0);
});
