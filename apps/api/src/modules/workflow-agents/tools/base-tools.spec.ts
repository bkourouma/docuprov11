import type { AuthUser } from '../../auth/auth.types';
import type { WfTool, WfToolContext } from '../agent.contracts';
import type {
  AgentDocumentHit,
  AgentDocumentView,
  AgentMailView,
  WfAgentDataPort,
} from './agent-data.port';
import {
  DOCUMENT_NOT_FOUND_MESSAGE,
  MAIL_NOT_FOUND_MESSAGE,
  createBaseTools,
} from './base-tools';
import { WfToolRegistry } from './tool-registry';

const alice: AuthUser = { userId: 1, username: 'alice', isAdmin: false, userGroupId: 10 };
const bob: AuthUser = { userId: 2, username: 'bob', isAdmin: false, userGroupId: 20 };

/** Faux port : droits PAR utilisateur (documents et courriers lisibles), null pour tout refus. */
class FakeData implements WfAgentDataPort {
  readonly seenUsers: AuthUser[] = [];
  docs = new Map<number, { readers: number[]; view: AgentDocumentView }>();
  mails = new Map<number, { readers: number[]; view: AgentMailView }>();
  targets = { user: new Set([7]), role: new Set([3]) };

  async searchDocuments(user: AuthUser, query: string, limit: number): Promise<AgentDocumentHit[]> {
    this.seenUsers.push(user);
    return [...this.docs.values()]
      .filter((d) => d.readers.includes(user.userId) && d.view.label.includes(query))
      .slice(0, limit)
      .map((d) => ({ documentId: d.view.documentId, label: d.view.label, excerpt: 'extrait '.repeat(80) }));
  }
  async readDocument(user: AuthUser, id: number): Promise<AgentDocumentView | null> {
    this.seenUsers.push(user);
    const d = this.docs.get(id);
    return d && d.readers.includes(user.userId) ? d.view : null;
  }
  async readMail(user: AuthUser, id: number): Promise<AgentMailView | null> {
    this.seenUsers.push(user);
    const m = this.mails.get(id);
    return m && m.readers.includes(user.userId) ? m.view : null;
  }
  async targetExists(kind: 'user' | 'role', id: number): Promise<boolean> {
    return this.targets[kind].has(id);
  }
}

function docView(id: number, label = 'Contrat'): AgentDocumentView {
  return { documentId: id, label, documentTypeLabel: 'Contrat', documentDate: '2026-01-02', cote: 'C-1', overview: 'Résumé', excerpts: ['a', 'b'] };
}
function mailView(id: number): AgentMailView {
  return {
    mailId: id, reference: 'ARR-2026-001', title: 'Demande', date: '2026-03-04', senderLabel: 'Société X',
    natureLabel: null, objetLabel: null, confidentialiteLabel: null, documents: [{ documentId: 1, label: 'PJ' }], text: 'Bonjour',
  };
}

function ctx(user: AuthUser, dryRun = false): WfToolContext {
  return {
    identity: { user, principal: { userGroupId: user.userGroupId as number, userId: user.userId, groupIds: [], roleId: null } },
    instanceId: dryRun ? null : '1',
    taskId: null,
    stepKey: 's1',
    subject: { type: null, id: null },
    dryRun,
  };
}

function setup() {
  const data = new FakeData();
  data.docs.set(100, { readers: [1], view: docView(100) });
  data.mails.set(200, { readers: [1], view: mailView(200) });
  const tools = new Map(createBaseTools(data).map((t) => [t.key, t]));
  return { data, tool: (k: string): WfTool => tools.get(k) as WfTool };
}

describe('outils de base : catalogue', () => {
  it('cinq outils, enregistrables, effets et validations attendus', () => {
    const { tool } = setup();
    const registry = new WfToolRegistry();
    const all = createBaseTools(new FakeData());
    all.forEach((t) => registry.register(t));
    expect(all.map((t) => t.key)).toEqual([
      'rechercher_documents', 'lire_document', 'lire_courrier', 'proposer_imputation', 'proposer_reponse',
    ]);
    for (const k of ['rechercher_documents', 'lire_document', 'lire_courrier']) {
      expect(tool(k).sideEffect).toBe(0);
      expect(tool(k).requiresValidation).toBe(false);
    }
    for (const k of ['proposer_imputation', 'proposer_reponse']) {
      expect(tool(k).sideEffect).toBe(1);
      expect(tool(k).requiresValidation).toBe(true);
    }
  });
});

describe('validation des arguments (strict)', () => {
  const cases: Array<[string, unknown[], unknown[]]> = [
    ['rechercher_documents', [{ query: 'x' }, { query: 'x', limit: 10 }], [{}, { query: '' }, { query: 'a'.repeat(301) }, { query: 'x', limit: 0 }, { query: 'x', limit: 11 }, { query: 'x', limit: 1.5 }, { query: 'x', extra: 1 }]],
    ['lire_document', [{ documentId: 1 }], [{}, { documentId: 0 }, { documentId: -1 }, { documentId: 1.2 }, { documentId: '1' }, { documentId: 1, extra: true }]],
    ['lire_courrier', [{ mailId: 1 }], [{}, { mailId: 0 }, { mailId: 'a' }, { mailId: 1, extra: 1 }]],
    ['proposer_imputation',
      [{ mailId: 1, target: { kind: 'user', id: 7 }, rationale: 'ok' }, { mailId: 1, target: { kind: 'role', id: 3 }, imputationType: 'Pour action', rationale: 'ok' }],
      [{ mailId: 1, target: { kind: 'user', id: 7 } }, { mailId: 1, target: { kind: 'group', id: 7 }, rationale: 'x' }, { mailId: 1, target: { kind: 'user', id: 7, extra: 1 }, rationale: 'x' },
        { mailId: 1, target: { kind: 'user', id: 7 }, rationale: '' }, { mailId: 1, target: { kind: 'user', id: 7 }, rationale: 'a'.repeat(501) },
        { mailId: 1, target: { kind: 'user', id: 7 }, rationale: 'x', imputationType: 'a'.repeat(101) }, { mailId: 1, target: { kind: 'user', id: 7 }, rationale: 'x', extra: 1 }]],
    ['proposer_reponse',
      [{ subject: 's', bodyText: 'b' }, { mailId: 3, subject: 's', bodyText: 'b' }],
      [{ subject: 's' }, { bodyText: 'b' }, { subject: '', bodyText: 'b' }, { subject: 'a'.repeat(201), bodyText: 'b' }, { subject: 's', bodyText: 'a'.repeat(4001) }, { mailId: 0, subject: 's', bodyText: 'b' }, { subject: 's', bodyText: 'b', extra: 1 }]],
  ];
  it.each(cases)('%s', (key, valid, invalid) => {
    const { tool } = setup();
    for (const v of valid) expect(tool(key).inputSchema.safeParse(v).success).toBe(true);
    for (const i of invalid) expect(tool(key).inputSchema.safeParse(i).success).toBe(false);
  });

  it('chaque jsonSchema interdit les propriétés en trop', () => {
    const { tool } = setup();
    for (const k of ['rechercher_documents', 'lire_document', 'lire_courrier', 'proposer_imputation', 'proposer_reponse']) {
      expect(tool(k).jsonSchema.additionalProperties).toBe(false);
    }
  });
});

describe('rechercher_documents', () => {
  it('renvoie hits + sources document, bornés, avec l’utilisateur lanceur', async () => {
    const { data, tool } = setup();
    const res = await tool('rechercher_documents').execute(ctx(alice), { query: 'Contrat' });
    expect(res.output).toMatchObject({ hits: [{ documentId: 100, label: 'Contrat' }] });
    const hit = (res.output as { hits: Array<{ excerpt: string }> }).hits[0];
    expect(Array.from(hit.excerpt).length).toBeLessThanOrEqual(300);
    expect(res.sources).toHaveLength(1);
    expect(res.sources[0]).toMatchObject({ kind: 'document', id: 100 });
    expect(Array.from(res.sources[0].excerpt ?? '').length).toBeLessThanOrEqual(300);
    expect(data.seenUsers).toEqual([alice]);
  });

  it('un lanceur sans droit ne voit rien (aucun hit, aucune source)', async () => {
    const { tool } = setup();
    const res = await tool('rechercher_documents').execute(ctx(bob), { query: 'Contrat' });
    expect(res).toEqual({ output: { hits: [] }, sources: [] });
  });
});

describe('lire_document : droits', () => {
  it('lisible : document borné + source', async () => {
    const { tool } = setup();
    const res = await tool('lire_document').execute(ctx(alice), { documentId: 100 });
    expect(res.output).toMatchObject({ found: true, documentId: 100, excerpts: ['a', 'b'] });
    expect(res.sources).toEqual([{ kind: 'document', id: 100, label: 'Contrat', excerpt: 'Résumé' }]);
  });

  it('interdit et inexistant : réponse STRICTEMENT identique, aucune source', async () => {
    const { tool } = setup();
    const forbidden = await tool('lire_document').execute(ctx(bob), { documentId: 100 });
    const missing = await tool('lire_document').execute(ctx(bob), { documentId: 999 });
    expect(forbidden).toEqual(missing);
    expect(forbidden).toEqual({ output: { found: false, message: DOCUMENT_NOT_FOUND_MESSAGE }, sources: [] });
  });
});

describe('lire_courrier : droits', () => {
  it('lisible : champs + source mail', async () => {
    const { tool } = setup();
    const res = await tool('lire_courrier').execute(ctx(alice), { mailId: 200 });
    expect(res.output).toMatchObject({ found: true, mailId: 200, reference: 'ARR-2026-001', text: 'Bonjour' });
    expect(res.sources).toEqual([{ kind: 'mail', id: 200, label: 'ARR-2026-001' }]);
  });

  it('interdit et inexistant : identiques, aucune source', async () => {
    const { tool } = setup();
    const forbidden = await tool('lire_courrier').execute(ctx(bob), { mailId: 200 });
    const missing = await tool('lire_courrier').execute(ctx(bob), { mailId: 999 });
    expect(forbidden).toEqual(missing);
    expect(forbidden).toEqual({ output: { found: false, message: MAIL_NOT_FOUND_MESSAGE }, sources: [] });
  });
});

describe('proposer_imputation', () => {
  const input = { mailId: 200, target: { kind: 'user' as const, id: 7 }, imputationType: 'Pour action', rationale: 'Relève de ce service' };

  it('prépare sans rien écrire (prepared + preview en français)', async () => {
    const { tool } = setup();
    const res = await tool('proposer_imputation').execute(ctx(alice), input);
    expect(res.output).toEqual({ prepared: true });
    expect(res.prepared).toEqual({
      tool: 'proposer_imputation',
      arguments: { mailId: 200, target: { kind: 'user', id: 7 }, rationale: 'Relève de ce service', imputationType: 'Pour action' },
      sideEffect: 1,
      requiresValidation: true,
      preview: expect.stringContaining('Imputer le courrier n° 200'),
    });
    expect(res.sources).toEqual([{ kind: 'mail', id: 200, label: 'ARR-2026-001' }]);
  });

  it('refuse un courrier illisible par le lanceur : rien de préparé, message identique à l’inexistant', async () => {
    const { tool } = setup();
    const forbidden = await tool('proposer_imputation').execute(ctx(bob), input);
    const missing = await tool('proposer_imputation').execute(ctx(alice), { ...input, mailId: 999 });
    expect(forbidden.prepared).toBeUndefined();
    expect(forbidden).toEqual(missing);
    expect(forbidden.output).toEqual({ prepared: false, message: MAIL_NOT_FOUND_MESSAGE });
    expect(forbidden.sources).toEqual([]);
  });

  it('refuse une cible inexistante', async () => {
    const { tool } = setup();
    const res = await tool('proposer_imputation').execute(ctx(alice), { ...input, target: { kind: 'role' as const, id: 99 } });
    expect(res.prepared).toBeUndefined();
    expect(res.output).toMatchObject({ prepared: false });
  });

  it('dryRun : même résultat, aucune écriture (le port n’en expose pas)', async () => {
    const { tool } = setup();
    const live = await tool('proposer_imputation').execute(ctx(alice), input);
    const dry = await tool('proposer_imputation').execute(ctx(alice, true), input);
    expect(dry).toEqual(live);
  });
});

describe('proposer_reponse', () => {
  it('prépare sans mailId', async () => {
    const { tool } = setup();
    const res = await tool('proposer_reponse').execute(ctx(alice), { subject: 'Objet', bodyText: 'Texte' });
    expect(res.prepared).toMatchObject({
      tool: 'proposer_reponse',
      arguments: { subject: 'Objet', bodyText: 'Texte' },
      sideEffect: 1,
      requiresValidation: true,
    });
    expect(res.sources).toEqual([]);
  });

  it('avec mailId lisible : source mail et lien dans l’aperçu', async () => {
    const { tool } = setup();
    const res = await tool('proposer_reponse').execute(ctx(alice), { mailId: 200, subject: 'Objet', bodyText: 'Texte' });
    expect(res.prepared?.arguments).toMatchObject({ mailId: 200 });
    expect(res.prepared?.preview).toContain('courrier n° 200');
    expect(res.sources).toHaveLength(1);
  });

  it('refuse un courrier illisible par le lanceur', async () => {
    const { tool } = setup();
    const res = await tool('proposer_reponse').execute(ctx(bob), { mailId: 200, subject: 'Objet', bodyText: 'Texte' });
    expect(res.prepared).toBeUndefined();
    expect(res).toEqual({ output: { prepared: false, message: MAIL_NOT_FOUND_MESSAGE }, sources: [] });
  });
});
