import type { AuthUser } from '../../auth/auth.types';
import { createPlannerToolbox } from './planner-toolbox';
import {
  PLANNER_MAIL_TEXT_MAX_CHARS,
  PLANNER_READ_TOOLS,
  PLANNER_SEARCH_DEFAULT_LIMIT,
  PLANNER_SEARCH_MAX_LIMIT,
  type AsstPlannerDataPort,
  type PlannerInputationView,
  type PlannerMailView,
  type PlannerToolboxContext,
} from './planner.types';

const USER: AuthUser = { userId: 1, username: 'u1', isAdmin: false, userGroupId: 10 };
const NOW = new Date('2026-11-22T10:00:00Z');
const UNREADABLE = 'Courrier introuvable ou inaccessible.';

const MAIL: PlannerMailView = {
  mailId: 5,
  reference: 'REF-5',
  title: 'Demande de subvention',
  date: '2026-11-01',
  senderLabel: 'Mairie',
  natureLabel: 'Lettre',
  objetLabel: 'Finances',
  confidentialiteLabel: null,
  text: 'Texte du courrier',
};

const INPUTATION: PlannerInputationView = {
  mailInputationId: 7,
  mailId: 5,
  actorUserGroupId: 22,
  actorLabel: 'Awa Diallo — DAF',
  actorActive: true,
  typeId: 3,
  typeLabel: 'Pour traitement',
  deadline: new Date('2026-11-10T00:00:00Z'),
  treated: false,
  late: true,
  createdBy: 10,
};

/** Faux port en mémoire : enregistre chaque appel ; aucune méthode d'écriture n'existe dans le contrat. */
function fakePort(over: Partial<AsstPlannerDataPort> = {}): AsstPlannerDataPort & { calls: string[] } {
  const calls: string[] = [];
  const track = <T>(name: string, value: T) =>
    jest.fn((..._a: unknown[]): Promise<T> => {
      calls.push(name);
      return Promise.resolve(value);
    });
  const port: AsstPlannerDataPort = {
    readMail: track('readMail', MAIL as PlannerMailView | null),
    searchMails: track('searchMails', [
      { mailId: 5, reference: 'REF-5', title: 'Demande de subvention', date: '2026-11-01', senderLabel: 'Mairie' },
    ]),
    listActors: track('listActors', [
      { userGroupId: 22, label: 'Awa Diallo — DAF', roleName: 'Directrice', organigrammeLabel: 'Finances' },
    ]),
    listInputationTypes: track('listInputationTypes', [{ id: 3, label: 'Pour traitement', suivi: true }]),
    listInputations: track('listInputations', [INPUTATION] as PlannerInputationView[] | null),
    canImpute: track('canImpute', true),
    resolveImputableActor: track('resolveImputableActor', null),
    getActiveInputationType: track('getActiveInputationType', null),
    hasOpenImputation: track('hasOpenImputation', false),
    readInputation: track('readInputation', null),
    countTargetRelancesToday: track('countTargetRelancesToday', 0),
    listDraftTemplates: () => {
      calls.push('listDraftTemplates');
      return [{ id: 'note', label: 'Note' }];
    },
    listWritableSpaces: track('listWritableSpaces', [{ spaceId: 4, label: 'Espace DAF' }]),
    generateDraft: track('generateDraft', { status: 'disabled' as const, message: 'x' }),
    ...over,
  };
  return Object.assign(port, { calls });
}

function ctx(pageContext: PlannerToolboxContext['pageContext'] = null): PlannerToolboxContext {
  return { user: USER, pageContext, now: NOW };
}

describe('AsstPlannerToolbox', () => {
  it('décrit les sept outils de lecture, avec schéma JSON', () => {
    const tb = createPlannerToolbox(fakePort(), ctx());
    const d = tb.describe();
    expect(d.map((x) => x.key)).toEqual([...PLANNER_READ_TOOLS]);
    expect(d).toHaveLength(7);
    for (const x of d) {
      expect(x.jsonSchema['type']).toBe('object');
      expect(x.jsonSchema['additionalProperties']).toBe(false);
    }
  });

  it('lire_courrier : lit le courrier demandé, borne le texte et enregistre les preuves', async () => {
    const port = fakePort({ readMail: jest.fn().mockResolvedValue({ ...MAIL, text: 'é'.repeat(PLANNER_MAIL_TEXT_MAX_CHARS + 50) }) });
    const tb = createPlannerToolbox(port, ctx());
    const r = await tb.call('lire_courrier', { mailId: 5 });
    expect(r.ok).toBe(true);
    const out = r.output as { texte: string; objet: string; mailId: number };
    expect(out.mailId).toBe(5);
    expect(Array.from(out.texte)).toHaveLength(PLANNER_MAIL_TEXT_MAX_CHARS);
    expect(port.readMail).toHaveBeenCalledWith(USER, 5, PLANNER_MAIL_TEXT_MAX_CHARS);
    expect(tb.evidence.mails.get(5)).toEqual({ mailId: 5, reference: 'REF-5', title: 'Demande de subvention' });
    expect(tb.evidence.untrustedTexts).toEqual(expect.arrayContaining(['Demande de subvention', 'Mairie', 'Finances']));
  });

  it('lire_courrier : sans mailId, utilise le courrier de la page', async () => {
    const port = fakePort();
    const tb = createPlannerToolbox(port, ctx({ route: '/courriers/5', subjectType: 'mail', subjectId: '5' }));
    const r = await tb.call('lire_courrier', {});
    expect(r.ok).toBe(true);
    expect(port.readMail).toHaveBeenCalledWith(USER, 5, PLANNER_MAIL_TEXT_MAX_CHARS);
  });

  it('lire_courrier : sans mailId ni courrier de page, échoue avec « aucun courrier ouvert »', async () => {
    for (const page of [null, { route: '/x' }, { route: '/x', subjectType: 'document', subjectId: '5' }]) {
      const tb = createPlannerToolbox(fakePort(), ctx(page));
      const r = await tb.call('lire_courrier', undefined);
      expect(r.ok).toBe(false);
      expect(String(r.output)).toContain('Aucun courrier ouvert');
    }
  });

  it('courrier illisible et courrier inexistant donnent le MÊME message', async () => {
    const tb = createPlannerToolbox(fakePort({ readMail: jest.fn().mockResolvedValue(null) }), ctx());
    const a = await tb.call('lire_courrier', { mailId: 5 });
    const b = await tb.call('lire_courrier', { mailId: 999 });
    const c = await createPlannerToolbox(fakePort({ listInputations: jest.fn().mockResolvedValue(null) }), ctx()).call(
      'imputations_courrier',
      { mailId: 5 },
    );
    expect(a).toEqual({ ok: false, output: UNREADABLE });
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(tb.evidence.mails.size).toBe(0);
  });

  it('rechercher_courriers : limite par défaut, plafonnée, preuves recueillies', async () => {
    const port = fakePort();
    const tb = createPlannerToolbox(port, ctx());
    await tb.call('rechercher_courriers', { query: ' subvention ' });
    expect(port.searchMails).toHaveBeenLastCalledWith(USER, 'subvention', PLANNER_SEARCH_DEFAULT_LIMIT);
    await tb.call('rechercher_courriers', { query: 'x', limit: 500 });
    expect(port.searchMails).toHaveBeenLastCalledWith(USER, 'x', PLANNER_SEARCH_MAX_LIMIT);
    expect(tb.evidence.mailSearches[0]).toEqual({ query: 'subvention', mailIds: [5] });
    expect(tb.evidence.mails.has(5)).toBe(true);
    expect(tb.evidence.untrustedTexts).toContain('Mairie');
  });

  it('rechercher_courriers : tronque une réponse trop longue du port', async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ mailId: i + 1, reference: null, title: `t${i}`, date: null, senderLabel: null }));
    const tb = createPlannerToolbox(fakePort({ searchMails: jest.fn().mockResolvedValue(many) }), ctx());
    const r = await tb.call('rechercher_courriers', { query: 'x', limit: 3 });
    expect((r.output as { courriers: unknown[] }).courriers).toHaveLength(3);
    expect(tb.evidence.mailSearches[0]?.mailIds).toEqual([1, 2, 3]);
  });

  it.each([
    ['rechercher_courriers', { query: '' }],
    ['rechercher_courriers', { query: 'a'.repeat(201) }],
    ['rechercher_courriers', { query: 'a', limit: 0 }],
    ['rechercher_courriers', { query: 'a', extra: 1 }],
    ['rechercher_courriers', {}],
    ['acteurs_imputables', { search: 'a'.repeat(101) }],
    ['acteurs_imputables', { search: '' }],
    ['lire_courrier', { mailId: 'abc' }],
    ['lire_courrier', { mailId: -1 }],
    ['lire_courrier', 'texte'],
    ['imputations_courrier', {}],
    ['imputations_courrier', { mailId: 1.5 }],
    ['types_imputation', { x: 1 }],
    ['modeles_brouillon', { x: 1 }],
    ['espaces_ecriture', [1]],
  ])('arguments invalides refusés sans lever : %s %j', async (tool, args) => {
    const port = fakePort();
    const r = await createPlannerToolbox(port, ctx()).call(tool, args);
    expect(r).toEqual({ ok: false, output: 'Arguments invalides pour cet outil.' });
    expect(port.calls).toHaveLength(0);
  });

  it('outil inconnu (y compris une écriture) : ok false, aucun appel au port', async () => {
    const port = fakePort();
    const tb = createPlannerToolbox(port, ctx());
    for (const name of ['proposer_imputation', 'constructor', '__proto__', '', 'toString']) {
      const r = await tb.call(name, {});
      expect(r.ok).toBe(false);
    }
    expect(port.calls).toHaveLength(0);
  });

  it('acteurs_imputables : filtre texte, bornes, preuves et textes de tiers', async () => {
    const port = fakePort();
    const tb = createPlannerToolbox(port, ctx());
    const r = await tb.call('acteurs_imputables', { search: 'DAF' });
    expect(port.listActors).toHaveBeenCalledWith(USER, { search: 'DAF', limit: PLANNER_SEARCH_DEFAULT_LIMIT });
    expect(r.output).toEqual({
      acteurs: [{ userGroupId: 22, libelle: 'Awa Diallo — DAF', role: 'Directrice', organigramme: 'Finances' }],
    });
    await tb.call('acteurs_imputables', { limit: 99 });
    expect(port.listActors).toHaveBeenLastCalledWith(USER, { search: undefined, limit: PLANNER_SEARCH_MAX_LIMIT });
    expect(tb.evidence.actorSearches.map((s) => s.search)).toEqual(['DAF', null]);
    expect(tb.evidence.actorSearches[0]?.actors[0]?.userGroupId).toBe(22);
    expect(tb.evidence.untrustedTexts).toEqual(expect.arrayContaining(['Awa Diallo — DAF', 'Directrice']));
  });

  it('types_imputation, modeles_brouillon et espaces_ecriture : sorties en français', async () => {
    const tb = createPlannerToolbox(fakePort(), ctx());
    expect((await tb.call('types_imputation', {})).output).toEqual({ types: [{ id: 3, libelle: 'Pour traitement', suivi: true }] });
    expect((await tb.call('modeles_brouillon', {})).output).toEqual({ modeles: [{ id: 'note', libelle: 'Note' }] });
    expect((await tb.call('espaces_ecriture', undefined)).output).toEqual({ espaces: [{ spaceId: 4, libelle: 'Espace DAF' }] });
  });

  it('imputations_courrier : retard, créateur, preuves ; jamais d’e-mail ni de connexion', async () => {
    const tb = createPlannerToolbox(fakePort(), ctx());
    const r = await tb.call('imputations_courrier', { mailId: 5 });
    expect(r.ok).toBe(true);
    const out = r.output as { imputations: Array<Record<string, unknown>> };
    expect(out.imputations[0]).toMatchObject({
      mailInputationId: 7,
      acteurId: 22,
      acteur: 'Awa Diallo — DAF',
      acteurActif: true,
      echeance: '2026-11-10',
      traitee: false,
      enRetard: true,
      creeParVous: true,
    });
    expect(tb.evidence.inputations.get(7)).toEqual(INPUTATION);
    expect(tb.evidence.untrustedTexts).toContain('Awa Diallo — DAF');
    expect(JSON.stringify(r.output)).not.toMatch(/@|username/i);
  });

  it('une exception du port devient ok false sans fuite de détail', async () => {
    const port = fakePort({ readMail: jest.fn().mockRejectedValue(new Error('secret SQL')) });
    const r = await createPlannerToolbox(port, ctx()).call('lire_courrier', { mailId: 5 });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain('secret');
  });

  it('n’appelle que des méthodes de lecture du port (aucune génération, aucune résolution d’écriture)', async () => {
    const port = fakePort();
    const tb = createPlannerToolbox(port, ctx({ route: '/c', subjectType: 'mail', subjectId: '5' }));
    await tb.call('lire_courrier', {});
    await tb.call('rechercher_courriers', { query: 'a' });
    await tb.call('acteurs_imputables', {});
    await tb.call('types_imputation', {});
    await tb.call('imputations_courrier', { mailId: 5 });
    await tb.call('modeles_brouillon', {});
    await tb.call('espaces_ecriture', {});
    expect(port.calls).not.toContain('generateDraft');
    expect(new Set(port.calls)).toEqual(
      new Set(['readMail', 'searchMails', 'listActors', 'listInputationTypes', 'listInputations', 'listDraftTemplates', 'listWritableSpaces']),
    );
  });
});
