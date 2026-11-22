import type { AuthUser } from '../../auth/auth.types';
import type { WfTool, WfToolContext } from '../../workflow-agents/agent.contracts';
import { WfToolRegistry } from '../../workflow-agents/tools/tool-registry';
import {
  CATALOG_TOOL_KEYS,
  DRAFT_HTML_MAX_CHARS,
  IMPUTATION_DELAY_DAYS_MAX,
  RELANCE_MAX_PER_INSTANCE_PER_DAY,
  RELANCE_MAX_PER_TARGET_PER_DAY,
  type DeclaredDelegates,
} from '../catalog.contracts';
import type {
  CatalogDataPort,
  CatalogMailRef,
  DraftGenerationRequest,
  DraftGenerationResult,
  InputationView,
  PieceFields,
  PieceTarget,
  PieceView,
  RelanceCounts,
  SimilarMail,
} from './catalog-data.port';
import { createCatalogTools, registerCatalogTools } from './catalog-tools';

const alice: AuthUser = { userId: 1, username: 'alice', isAdmin: false, userGroupId: 10 };
const bob: AuthUser = { userId: 2, username: 'bob', isAdmin: false, userGroupId: 20 };
const NOW = new Date('2026-11-21T12:00:00Z');

/** Faux port : droits PAR utilisateur (userId), aucune base. */
class FakeData implements CatalogDataPort {
  readonly seenUsers: AuthUser[] = [];
  mails = new Map<number, { readers: number[]; ref: CatalogMailRef; similar: SimilarMail[] }>();
  imputables = new Map<number, string>([
    [7, 'Awa Diallo'],
    [8, 'Moussa Traoré'],
  ]);
  types = new Map<number, { label: string; suivi: boolean }>([
    [10, { label: 'Pour Suivi', suivi: true }],
    [17, { label: 'En Copie', suivi: false }],
  ]);
  openImputations = new Set<string>();
  pieces = new Map<number, { readers: number[]; view: PieceView; fields: PieceFields['values'] }>();
  inputations = new Map<number, InputationView & { readers: number[] }>();
  counts: RelanceCounts = { target: 0, instance: 0 };
  delegates: DeclaredDelegates = [];
  readDelegatesCalls = 0;
  generateCalls: DraftGenerationRequest[] = [];
  generation: DraftGenerationResult = { status: 'ok', draftHtml: '<p>Brouillon généré</p>', decisionId: '55', contextDocumentCount: 0 };

  async readMail(user: AuthUser, id: number) {
    this.seenUsers.push(user);
    const m = this.mails.get(id);
    return m && m.readers.includes(user.userId) ? m.ref : null;
  }
  async findSimilarMails(user: AuthUser, id: number) {
    const m = this.mails.get(id);
    return m && m.readers.includes(user.userId) ? m.similar : null;
  }
  async readImputables(user: AuthUser, opts: { search?: string; limit: number }) {
    this.seenUsers.push(user);
    return {
      actors: [...this.imputables].slice(0, opts.limit).map(([userGroupId, label]) => ({
        userGroupId, label, roleName: 'Chef de service', organigrammeLabel: 'Direction',
      })),
      types: [...this.types].map(([id, t]) => ({ id, label: t.label, suivi: t.suivi })),
    };
  }
  canImputeFlag = true;
  async canImpute() {
    return this.canImputeFlag;
  }
  async resolveImputableActor(_user: AuthUser, id: number) {
    const label = this.imputables.get(id);
    return label ? { userGroupId: id, label } : null;
  }
  async resolveActiveActor(id: number) {
    const label = this.imputables.get(id);
    return label ? { userGroupId: id, label } : null;
  }
  async getActiveInputationType(id: number) {
    const t = this.types.get(id);
    return t ? { id, label: t.label, suivi: t.suivi } : null;
  }
  async hasOpenImputation(mailId: number, userGroupId: number, typeId: number) {
    return this.openImputations.has(`${mailId}:${userGroupId}:${typeId}`);
  }
  async listPieces(user: AuthUser, target: PieceTarget) {
    this.seenUsers.push(user);
    if ('documentId' in target) {
      const p = this.pieces.get(target.documentId);
      if (!p || !p.readers.includes(user.userId)) return null;
    }
    return [...this.pieces.values()].filter((p) => p.readers.includes(user.userId)).map((p) => p.view);
  }
  async readPieceFields(user: AuthUser, ids: number[]) {
    this.seenUsers.push(user);
    return ids.flatMap((id) => {
      const p = this.pieces.get(id);
      return p && p.readers.includes(user.userId) ? [{ documentId: id, label: p.view.label, values: p.fields }] : [];
    });
  }
  async readInputation(user: AuthUser, mailId: number, inputationId: number) {
    const i = this.inputations.get(inputationId);
    return i && i.mailId === mailId && i.readers.includes(user.userId) ? i : null;
  }
  async countRelances() {
    return this.counts;
  }
  async readDeclaredDelegates() {
    this.readDelegatesCalls += 1;
    return this.delegates;
  }
  async getDraftTemplate(id: string) {
    return id === 'lettre-reponse' || id === 'vide'
      ? { id, label: 'Lettre de réponse', skeletonHtml: '<h1>Objet</h1><p>[à compléter]</p>' }
      : null;
  }
  async generateDraft(_user: AuthUser, request: DraftGenerationRequest) {
    this.generateCalls.push(request);
    return this.generation;
  }
}

type CtxOver = Partial<WfToolContext> & { evalContext?: Readonly<Record<string, unknown>> };

function ctx(user: AuthUser, over: CtxOver = {}): WfToolContext {
  return {
    identity: { user, principal: { userGroupId: user.userGroupId as number, userId: user.userId, groupIds: [], roleId: null } },
    instanceId: '9',
    taskId: 't1',
    stepKey: 's1',
    subject: { type: null, id: null },
    dryRun: false,
    ...over,
  };
}

function inputation(over: Partial<InputationView & { readers: number[] }> = {}): InputationView & { readers: number[] } {
  return {
    mailInputationId: 300,
    mailId: 200,
    mailReference: 'ARR-2026-001',
    mailTitle: 'Demande',
    userGroupId: 7,
    actorLabel: 'Awa Diallo',
    actorActive: true,
    typeLabel: 'Pour Suivi',
    deadline: new Date('2026-11-10T00:00:00Z'),
    dateTreated: null,
    createdBy: 10,
    readers: [1],
    ...over,
  };
}

function setup() {
  const data = new FakeData();
  data.mails.set(200, { readers: [1], ref: { mailId: 200, reference: 'ARR-2026-001', title: 'Demande' }, similar: [] });
  data.inputations.set(300, inputation());
  const tools = new Map(createCatalogTools(data, { now: () => NOW }).map((t) => [t.key, t]));
  return { data, tool: (k: string): WfTool => tools.get(k) as WfTool };
}

const run = (tool: WfTool, user: AuthUser, args: unknown, over: CtxOver = {}) => {
  const parsed = tool.inputSchema.parse(args);
  return tool.execute(ctx(user, over), parsed);
};
const out = (r: { output: unknown }) => r.output as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe('catalogue d’outils : forme et enregistrement', () => {
  it('huit outils, clés valides, effets et validations attendus', () => {
    const { data } = setup();
    const all = createCatalogTools(data);
    expect(all.map((t) => t.key)).toEqual(Object.values(CATALOG_TOOL_KEYS));
    for (const t of all) expect(t.key).toMatch(/^[a-z0-9_.]+$/);
    const reads = all.filter((t) => t.sideEffect === 0);
    const writes = all.filter((t) => t.sideEffect === 1);
    expect(reads).toHaveLength(4);
    expect(writes.map((t) => t.key)).toEqual([
      'proposer_imputation_courrier', 'preparer_brouillon_reponse', 'proposer_relance', 'proposer_delegation',
    ]);
    for (const t of writes) expect(t.requiresValidation).toBe(true);
    for (const t of reads) expect(t.requiresValidation).toBe(false);
    for (const t of all) {
      expect(t.jsonSchema.type).toBe('object');
      expect(t.jsonSchema.additionalProperties).toBe(false);
    }
  });

  it('s’enregistre dans un registre réel sans lever, et de façon idempotente', () => {
    const registry = new WfToolRegistry();
    const data = new FakeData();
    expect(registerCatalogTools(registry, data)).toBe(8);
    expect(registry.list()).toHaveLength(8);
    expect(registerCatalogTools(registry, data)).toBe(0); // déjà présents : ignorés
    expect(registry.list()).toHaveLength(8);
  });

  it('un outil déjà enregistré sous la même clé est ignoré, les autres sont ajoutés', () => {
    const registry = new WfToolRegistry();
    const data = new FakeData();
    const first = createCatalogTools(data)[0];
    registry.register(first);
    expect(registerCatalogTools(registry, data)).toBe(7);
    expect(registry.get(first.key)).toBe(first);
  });

  it('refuse toute clé inconnue dans les arguments (schéma strict) pour les huit outils', () => {
    const { tool } = setup();
    const valid: Record<string, unknown> = {
      lister_courriers_similaires: { mailId: 200 },
      lire_organigramme_imputable: {},
      lister_pieces: { mailId: 200 },
      comparer_champs: { documentIds: [1, 2], fields: ['montant'] },
      proposer_imputation_courrier: { mailId: 200, recipients: [{ userGroupId: 7, mailInputationTypeId: 10 }], rationale: 'x' },
      preparer_brouillon_reponse: { templateId: 'vide', instruction: 'Rédige', label: 'L' },
      proposer_relance: { mailId: 200, mailInputationId: 300, message: 'm' },
      proposer_delegation: { mailId: 200, mailInputationId: 300, delegateUserGroupId: 8, rationale: 'r' },
    };
    for (const key of Object.values(CATALOG_TOOL_KEYS)) {
      expect(tool(key).inputSchema.safeParse(valid[key]).success).toBe(true);
      expect(tool(key).inputSchema.safeParse({ ...(valid[key] as object), extra: 1 }).success).toBe(false);
    }
  });
});

describe('lister_courriers_similaires', () => {
  const similar: SimilarMail = {
    mailId: 201, reference: 'ARR-2025-040', title: 'Demande de subvention', natureLabel: 'Demande', date: '2025-05-01',
    imputations: [
      { mailInputationId: 1, actorUserGroupId: 7, actorLabel: 'Awa Diallo', typeId: 10, typeLabel: 'Pour Suivi', delayDays: 5, treated: true },
    ],
  };

  it('borne limit à 10 et refuse 0', () => {
    const { tool } = setup();
    expect(tool('lister_courriers_similaires').inputSchema.safeParse({ mailId: 200, limit: 11 }).success).toBe(false);
    expect(tool('lister_courriers_similaires').inputSchema.safeParse({ mailId: 200, limit: 0 }).success).toBe(false);
  });

  it('renvoie imputations (sans instructions) et une source mail par courrier', async () => {
    const { data, tool } = setup();
    (data.mails.get(200) as { similar: SimilarMail[] }).similar = [similar];
    const r = await run(tool('lister_courriers_similaires'), alice, { mailId: 200 });
    const o = out(r);
    expect(o.found).toBe(true);
    expect(o.mails[0].imputations[0]).toEqual({
      acteurId: 7, acteur: 'Awa Diallo', typeImputation: { id: 10, libelle: 'Pour Suivi' }, delaiJours: 5, traitee: true,
    });
    expect(JSON.stringify(o)).not.toContain('instructions');
    expect(r.sources.map((s) => s.id)).toEqual([200, 201]);
    expect(r.sources.every((s) => s.kind === 'mail')).toBe(true);
  });

  it('borne le nombre de résultats au limit demandé', async () => {
    const { data, tool } = setup();
    (data.mails.get(200) as { similar: SimilarMail[] }).similar = Array.from({ length: 10 }, (_, i) => ({ ...similar, mailId: 300 + i }));
    const r = await run(tool('lister_courriers_similaires'), alice, { mailId: 200, limit: 3 });
    expect(out(r).mails).toHaveLength(3);
  });

  it('refus et inexistant : même réponse found:false, sans source', async () => {
    const { tool } = setup();
    const refused = await run(tool('lister_courriers_similaires'), bob, { mailId: 200 });
    const missing = await run(tool('lister_courriers_similaires'), alice, { mailId: 999 });
    expect(refused).toEqual(missing);
    expect(out(refused).found).toBe(false);
    expect(refused.sources).toEqual([]);
  });
});

describe('lire_organigramme_imputable', () => {
  it('renvoie acteurs, types actifs et borne de délai, sans e-mail ni identifiant de connexion', async () => {
    const { tool, data } = setup();
    const r = await run(tool('lire_organigramme_imputable'), alice, {});
    const o = out(r);
    expect(o.acteurs[0]).toEqual({ userGroupId: 7, libelle: 'Awa Diallo', role: 'Chef de service', noeudOrganigramme: 'Direction' });
    expect(o.typesImputation).toEqual([
      { id: 10, libelle: 'Pour Suivi', suivi: true },
      { id: 17, libelle: 'En Copie', suivi: false },
    ]);
    expect(o.delaiMaxJours).toBe(IMPUTATION_DELAY_DAYS_MAX);
    expect(JSON.stringify(o)).not.toMatch(/email|username/i);
    expect(data.seenUsers[0]).toBe(alice);
  });

  it('borne limit à 50', () => {
    const { tool } = setup();
    expect(tool('lire_organigramme_imputable').inputSchema.safeParse({ limit: 51 }).success).toBe(false);
    expect(tool('lire_organigramme_imputable').inputSchema.safeParse({ limit: 50 }).success).toBe(true);
  });
});

describe('lister_pieces', () => {
  const piece = (id: number, readers: number[]) => ({
    readers,
    view: {
      documentId: id, label: `Facture ${id}`, documentTypeLabel: 'Facture', documentDate: '2026-03-01', cote: 'F-1',
      pageCount: 2, metadataExcerpt: 'montant : 100 '.repeat(60),
    },
    fields: {},
  });

  it('exige exactement un identifiant', () => {
    const { tool } = setup();
    const s = tool('lister_pieces').inputSchema;
    expect(s.safeParse({}).success).toBe(false);
    expect(s.safeParse({ mailId: 1, documentId: 2 }).success).toBe(false);
    expect(s.safeParse({ dossierId: 3 }).success).toBe(true);
  });

  it('ne liste que les pièces accessibles, extrait borné, une source par pièce', async () => {
    const { data, tool } = setup();
    data.pieces.set(1, piece(1, [1]));
    data.pieces.set(2, piece(2, [2]));
    const r = await run(tool('lister_pieces'), alice, { mailId: 200 });
    const o = out(r);
    expect(o.pieces).toHaveLength(1);
    expect(o.pieces[0].documentId).toBe(1);
    expect(Array.from(o.pieces[0].extrait as string).length).toBeLessThanOrEqual(300);
    expect(r.sources).toHaveLength(1);
    expect(r.sources[0]).toMatchObject({ kind: 'document', id: 1 });
    expect(Array.from(r.sources[0].excerpt as string).length).toBeLessThanOrEqual(300);
  });

  it('borne à 30 pièces', async () => {
    const { data, tool } = setup();
    for (let i = 1; i <= 40; i += 1) data.pieces.set(i, piece(i, [1]));
    const r = await run(tool('lister_pieces'), alice, { dossierId: 5 });
    expect(out(r).pieces).toHaveLength(30);
  });

  it('refus et inexistant : même réponse', async () => {
    const { data, tool } = setup();
    data.pieces.set(1, piece(1, [1]));
    const refused = await run(tool('lister_pieces'), bob, { documentId: 1 });
    const missing = await run(tool('lister_pieces'), alice, { documentId: 404 });
    expect(refused).toEqual(missing);
    expect(out(refused).found).toBe(false);
  });
});

describe('comparer_champs', () => {
  const p = (id: number, readers: number[], values: PieceFields['values']) => ({
    readers,
    view: { documentId: id, label: `Pièce ${id}`, documentTypeLabel: null, documentDate: null, cote: null, pageCount: null, metadataExcerpt: null },
    fields: values,
  });

  it('borne 2..6 documents, champs fermés, sans doublon', () => {
    const { tool } = setup();
    const s = tool('comparer_champs').inputSchema;
    expect(s.safeParse({ documentIds: [1], fields: ['montant'] }).success).toBe(false);
    expect(s.safeParse({ documentIds: [1, 2, 3, 4, 5, 6, 7], fields: ['montant'] }).success).toBe(false);
    expect(s.safeParse({ documentIds: [1, 1], fields: ['montant'] }).success).toBe(false);
    expect(s.safeParse({ documentIds: [1, 2], fields: ['iban'] }).success).toBe(false);
    expect(s.safeParse({ documentIds: [1, 2], fields: ['montant', 'montant'] }).success).toBe(false);
    expect(s.safeParse({ documentIds: [1, 2], fields: [] }).success).toBe(false);
  });

  it('montants équivalents (formats différents) : concordant ; calcul en code', async () => {
    const { data, tool } = setup();
    data.pieces.set(1, p(1, [1], { montant: { raw: '1 250,50 FCFA', evidence: 'Montant : 1 250,50 FCFA' } }));
    data.pieces.set(2, p(2, [1], { montant: { raw: '1250.5', evidence: 'Montant TTC : 1250.5' } }));
    const r = await run(tool('comparer_champs'), alice, { documentIds: [1, 2], fields: ['montant'] });
    const c = out(r).comparaisons[0];
    expect(c.statut).toBe('concordant');
    expect(c.discordant).toBe(false);
    expect(c.valeurs.map((v: { normalisee: string }) => v.normalisee)).toEqual(['1250.50', '1250.50']);
    expect(c.valeurs[0]).toMatchObject({ documentId: 1, preuve: 'Montant : 1 250,50 FCFA' });
  });

  it('montants différents : discordant ; dates normalisées en ISO', async () => {
    const { data, tool } = setup();
    data.pieces.set(1, p(1, [1], {
      montant: { raw: '1000', evidence: 'a' }, date: { raw: '12/03/2026', evidence: 'b' },
    }));
    data.pieces.set(2, p(2, [1], {
      montant: { raw: '1 100,00', evidence: 'c' }, date: { raw: '12 mars 2026', evidence: 'd' },
    }));
    const r = await run(tool('comparer_champs'), alice, { documentIds: [1, 2], fields: ['montant', 'date'] });
    const [montant, date] = out(r).comparaisons;
    expect(montant.discordant).toBe(true);
    expect(date.discordant).toBe(false);
    expect(date.valeurs[0].normalisee).toBe('2026-03-12');
  });

  it('moins de deux valeurs : insuffisant, jamais discordant', async () => {
    const { data, tool } = setup();
    data.pieces.set(1, p(1, [1], { reference: { raw: 'FAC-001', evidence: 'x' } }));
    data.pieces.set(2, p(2, [1], {}));
    const r = await run(tool('comparer_champs'), alice, { documentIds: [1, 2], fields: ['reference'] });
    const c = out(r).comparaisons[0];
    expect(c.statut).toBe('insuffisant');
    expect(c.discordant).toBe(false);
    expect(c.sansValeur).toEqual([2]);
  });

  it('une pièce inaccessible est omise sans la distinguer d’une inexistante', async () => {
    const { data, tool } = setup();
    data.pieces.set(1, p(1, [1], { objet: { raw: 'Achat', evidence: 'e' } }));
    data.pieces.set(2, p(2, [2], { objet: { raw: 'Achat', evidence: 'e' } })); // interdite à alice
    const withForbidden = await run(tool('comparer_champs'), alice, { documentIds: [1, 2], fields: ['objet'] });
    const withMissing = await run(tool('comparer_champs'), alice, { documentIds: [1, 999], fields: ['objet'] });
    expect(out(withForbidden)).toEqual(out(withMissing));
    expect(out(withForbidden).pieces).toEqual([1]);
    expect(withForbidden.sources.map((s) => s.id)).toEqual([1]);
  });

  it('aucune pièce accessible : found:false', async () => {
    const { tool } = setup();
    const r = await run(tool('comparer_champs'), alice, { documentIds: [8, 9], fields: ['tiers'] });
    expect(out(r).found).toBe(false);
  });
});

describe('proposer_imputation_courrier', () => {
  const args = (over: Record<string, unknown> = {}) => ({
    mailId: 200,
    recipients: [{ userGroupId: 7, mailInputationTypeId: 10, delayDays: 5, instructions: 'Traiter' }],
    rationale: 'Relève de ce service',
    ...over,
  });

  it('prépare sans rien écrire : effet 1, validation, aperçu lisible', async () => {
    const { tool } = setup();
    const r = await run(tool('proposer_imputation_courrier'), alice, args());
    expect(out(r)).toEqual({ prepared: true, destinataires: 1 });
    expect(r.prepared).toMatchObject({
      tool: 'proposer_imputation_courrier', sideEffect: 1, requiresValidation: true,
      arguments: args(),
    });
    expect(r.prepared?.preview).toBe(
      'Imputer le courrier n° 200 à Awa Diallo (Pour Suivi, délai 5 jours). Motif : Relève de ce service',
    );
    expect(r.sources[0]).toMatchObject({ kind: 'mail', id: 200 });
  });

  it('identifiant inventé ou non imputable : rejeté, aucune action préparée, identifiant cité', async () => {
    const { tool } = setup();
    const r = await run(tool('proposer_imputation_courrier'), alice, args({ recipients: [
      { userGroupId: 7, mailInputationTypeId: 10 }, { userGroupId: 4242, mailInputationTypeId: 10 },
    ] }));
    expect(out(r).prepared).toBe(false);
    expect(out(r).message).toContain('4242');
    expect(r.prepared).toBeUndefined();
  });

  it('type d’imputation inactif ou inventé : rejeté', async () => {
    const { tool } = setup();
    const r = await run(tool('proposer_imputation_courrier'), alice, args({ recipients: [{ userGroupId: 7, mailInputationTypeId: 99 }] }));
    expect(out(r).message).toContain('99');
    expect(r.prepared).toBeUndefined();
  });

  it('doublon d’acteur dans la demande, ou imputation ouverte existante : rejeté', async () => {
    const { data, tool } = setup();
    const dup = await run(tool('proposer_imputation_courrier'), alice, args({ recipients: [
      { userGroupId: 7, mailInputationTypeId: 10 }, { userGroupId: 7, mailInputationTypeId: 17 },
    ] }));
    expect(dup.prepared).toBeUndefined();
    data.openImputations.add('200:7:10');
    const open = await run(tool('proposer_imputation_courrier'), alice, args());
    expect(open.prepared).toBeUndefined();
    expect(out(open).message).toContain('7');
  });

  it('courrier illisible ou inexistant : même réponse', async () => {
    const { tool } = setup();
    const a = await run(tool('proposer_imputation_courrier'), bob, args());
    const b = await run(tool('proposer_imputation_courrier'), alice, args({ mailId: 999 }));
    expect(a).toEqual(b);
    expect(a.prepared).toBeUndefined();
  });

  it('bornes du contrat : 5 destinataires, délai <= 90, instructions <= 1000', () => {
    const { tool } = setup();
    const s = tool('proposer_imputation_courrier').inputSchema;
    const rec = (i: number) => ({ userGroupId: i + 1, mailInputationTypeId: 10 });
    expect(s.safeParse(args({ recipients: Array.from({ length: 6 }, (_, i) => rec(i)) })).success).toBe(false);
    expect(s.safeParse(args({ recipients: [{ ...rec(1), delayDays: IMPUTATION_DELAY_DAYS_MAX + 1 }] })).success).toBe(false);
    expect(s.safeParse(args({ recipients: [{ ...rec(1), instructions: 'x'.repeat(1001) }] })).success).toBe(false);
  });
});

describe('preparer_brouillon_reponse', () => {
  const args = (over: Record<string, unknown> = {}) => ({
    templateId: 'lettre-reponse', instruction: 'Rédige une réponse polie', label: 'Réponse ARR-001', mailId: 200, spaceId: 3, ...over,
  });

  it('génère avec les droits du lanceur, prépare, extrait <= 600 caractères', async () => {
    const { data, tool } = setup();
    data.generation = { status: 'ok', draftHtml: `<p>${'Mot '.repeat(500)}</p>`, decisionId: '55', contextDocumentCount: 0 };
    const r = await run(tool('preparer_brouillon_reponse'), alice, args({ contextDocumentIds: [1, 2] }));
    expect(data.generateCalls).toEqual([{ templateId: 'lettre-reponse', instruction: 'Rédige une réponse polie', contextDocumentIds: [1, 2] }]);
    expect(out(r).prepared).toBe(true);
    expect(Array.from(out(r).extrait as string).length).toBeLessThanOrEqual(600);
    expect(r.prepared).toMatchObject({
      tool: 'preparer_brouillon_reponse', sideEffect: 1, requiresValidation: true,
      arguments: { templateId: 'lettre-reponse', label: 'Réponse ARR-001', mailId: 200, spaceId: 3, decisionId: '55' },
    });
    expect(typeof (r.prepared?.arguments as { draftHtml: string }).draftHtml).toBe('string');
    expect(r.prepared?.preview).toContain('Réponse ARR-001');
    expect(r.sources.map((s) => s.kind)).toEqual(['mail', 'document', 'document']);
  });

  it('dryRun : aucun appel IA, squelette statique du modèle', async () => {
    const { data, tool } = setup();
    const r = await run(tool('preparer_brouillon_reponse'), alice, args(), { dryRun: true, instanceId: null });
    expect(data.generateCalls).toEqual([]);
    expect(out(r).prepared).toBe(true);
    expect((r.prepared?.arguments as { draftHtml: string }).draftHtml).toBe('<h1>Objet</h1><p>[à compléter]</p>');
    expect(r.prepared?.arguments).not.toHaveProperty('decisionId');
  });

  it('modèle inconnu : refusé sans générer', async () => {
    const { data, tool } = setup();
    const r = await run(tool('preparer_brouillon_reponse'), alice, args({ templateId: 'inconnu' }));
    expect(out(r).prepared).toBe(false);
    expect(data.generateCalls).toEqual([]);
    expect(r.prepared).toBeUndefined();
  });

  it('IA désactivée : prepared:false avec message, aucune action', async () => {
    const { data, tool } = setup();
    data.generation = { status: 'disabled', message: 'IA désactivée.' };
    const r = await run(tool('preparer_brouillon_reponse'), alice, args());
    expect(out(r)).toEqual({ prepared: false, message: 'IA désactivée.' });
    expect(r.prepared).toBeUndefined();
  });

  it('budget ou refus de génération : prepared:false', async () => {
    const { data, tool } = setup();
    data.generation = { status: 'refused', message: 'Plafond de budget atteint.' };
    const r = await run(tool('preparer_brouillon_reponse'), alice, args());
    expect(out(r).message).toBe('Plafond de budget atteint.');
    expect(r.prepared).toBeUndefined();
  });

  it('brouillon trop long : refusé', async () => {
    const { data, tool } = setup();
    data.generation = { status: 'ok', draftHtml: 'x'.repeat(DRAFT_HTML_MAX_CHARS + 1), decisionId: null, contextDocumentCount: 0 };
    const r = await run(tool('preparer_brouillon_reponse'), alice, args());
    expect(out(r).prepared).toBe(false);
    expect(r.prepared).toBeUndefined();
  });

  it('courrier illisible : refus uniforme, aucune génération', async () => {
    const { data, tool } = setup();
    const r = await run(tool('preparer_brouillon_reponse'), bob, args());
    expect(out(r).prepared).toBe(false);
    expect(data.generateCalls).toEqual([]);
  });

  it('bornes : instruction <= 2000, 5 documents de contexte au plus', () => {
    const { tool } = setup();
    const s = tool('preparer_brouillon_reponse').inputSchema;
    expect(s.safeParse(args({ instruction: 'x'.repeat(2001) })).success).toBe(false);
    expect(s.safeParse(args({ contextDocumentIds: [1, 2, 3, 4, 5, 6] })).success).toBe(false);
  });
});

describe('proposer_relance', () => {
  const args = (over: Record<string, unknown> = {}) => ({ mailId: 200, mailInputationId: 300, message: 'Merci de traiter ce courrier.', ...over });

  it('prépare une relance interne pour une imputation en retard, sans préfixe dans les arguments', async () => {
    const { tool } = setup();
    const r = await run(tool('proposer_relance'), alice, args());
    expect(out(r).prepared).toBe(true);
    expect(r.prepared).toMatchObject({
      tool: 'proposer_relance', sideEffect: 1, requiresValidation: true,
      arguments: { mailId: 200, mailInputationId: 300, recipientUserGroupId: 7, message: 'Merci de traiter ce courrier.' },
    });
    expect((r.prepared?.arguments as { message: string }).message).not.toMatch(/^Relance :/);
  });

  it('pas en retard, traitée ou sans échéance : refus', async () => {
    const { data, tool } = setup();
    data.inputations.set(300, inputation({ deadline: new Date('2026-12-01T00:00:00Z') }));
    expect(out(await run(tool('proposer_relance'), alice, args())).message).toContain('pas en retard');
    data.inputations.set(300, inputation({ dateTreated: new Date('2026-11-05T00:00:00Z') }));
    expect(out(await run(tool('proposer_relance'), alice, args())).message).toContain('traitée');
    data.inputations.set(300, inputation({ deadline: null }));
    expect(out(await run(tool('proposer_relance'), alice, args())).message).toContain('pas en retard');
  });

  it('imputé inactif : refus', async () => {
    const { data, tool } = setup();
    data.inputations.set(300, inputation({ actorActive: false }));
    expect((await run(tool('proposer_relance'), alice, args())).prepared).toBeUndefined();
  });

  it('imputation d’un autre courrier, illisible ou inexistante : même réponse', async () => {
    const { tool } = setup();
    const a = await run(tool('proposer_relance'), alice, args({ mailId: 201 }));
    const b = await run(tool('proposer_relance'), bob, args());
    const c = await run(tool('proposer_relance'), alice, args({ mailInputationId: 999 }));
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });

  it('escalade : seulement vers l’auteur de l’imputation', async () => {
    const { tool } = setup();
    const ok = await run(tool('proposer_relance'), alice, args({ escalateToUserGroupId: 10 }));
    expect(ok.prepared?.arguments).toMatchObject({ escalateToUserGroupId: 10 });
    const ko = await run(tool('proposer_relance'), alice, args({ escalateToUserGroupId: 99 }));
    expect(ko.prepared).toBeUndefined();
    expect(out(ko).message).toContain('99');
  });

  it('droit de relancer : menu d’imputation (ou administrateur), OU auteur de l’imputation, jamais plus', async () => {
    const { data, tool } = setup();
    // 1. Menu d'imputation, sans être l'auteur (auteur = acteur 99, lanceur = acteur 10).
    data.inputations.set(300, inputation({ createdBy: 99 }));
    data.canImputeFlag = true;
    expect((await run(tool('proposer_relance'), alice, args(), { taskId: 't1' })).prepared).toBeDefined();
    // 2. Auteur de l'imputation, sans aucun menu.
    data.inputations.set(300, inputation({ createdBy: 10 }));
    data.canImputeFlag = false;
    expect((await run(tool('proposer_relance'), alice, args(), { taskId: 't2' })).prepared).toBeDefined();
    // 3. Ni l'un ni l'autre : refus en français, rien de préparé.
    data.inputations.set(300, inputation({ createdBy: 99 }));
    const r = await run(tool('proposer_relance'), alice, args(), { taskId: 't3' });
    expect(r.prepared).toBeUndefined();
    expect(out(r).message).toContain('droit d’imputer');
    // Auteur inconnu (null) et sans menu : refus.
    data.inputations.set(300, inputation({ createdBy: null }));
    expect((await run(tool('proposer_relance'), alice, args(), { taskId: 't4' })).prepared).toBeUndefined();
  });

  it('plafond par destinataire atteint : refus (hors dryRun seulement)', async () => {
    const { data, tool } = setup();
    data.counts = { target: RELANCE_MAX_PER_TARGET_PER_DAY, instance: 0 };
    expect((await run(tool('proposer_relance'), alice, args())).prepared).toBeUndefined();
    const dry = await run(tool('proposer_relance'), alice, args(), { dryRun: true, instanceId: null });
    expect(dry.prepared).toBeDefined();
  });

  it('plafond d’instance : relances déjà appliquées + préparées dans ce run', async () => {
    const { data, tool } = setup();
    data.counts = { target: 0, instance: RELANCE_MAX_PER_INSTANCE_PER_DAY };
    expect((await run(tool('proposer_relance'), alice, args())).prepared).toBeUndefined();

    data.counts = { target: 0, instance: RELANCE_MAX_PER_INSTANCE_PER_DAY - 1 };
    expect((await run(tool('proposer_relance'), alice, args())).prepared).toBeDefined();
    // Une seconde relance dans le même run (autre imputation) dépasse le plafond d'instance.
    data.inputations.set(301, inputation({ mailInputationId: 301 }));
    const second = await run(tool('proposer_relance'), alice, args({ mailInputationId: 301 }));
    expect(second.prepared).toBeUndefined();
    expect(out(second).message).toContain('Plafond');
  });

  it('même imputation relancée deux fois dans un run : refus', async () => {
    const { tool } = setup();
    expect((await run(tool('proposer_relance'), alice, args())).prepared).toBeDefined();
    const again = await run(tool('proposer_relance'), alice, args());
    expect(again.prepared).toBeUndefined();
  });

  it('borne le message à 500 caractères', () => {
    const { tool } = setup();
    expect(tool('proposer_relance').inputSchema.safeParse(args({ message: 'x'.repeat(501) })).success).toBe(false);
  });
});

describe('proposer_delegation', () => {
  const args = (over: Record<string, unknown> = {}) => ({
    mailId: 200, mailInputationId: 300, delegateUserGroupId: 8, rationale: 'Absence de l’imputé', ...over,
  });

  it('prépare vers un délégataire déclaré et imputable', async () => {
    const { data, tool } = setup();
    data.delegates = [{ userGroupId: 8, forUserGroupId: 7, label: 'Suppléant' }];
    const r = await run(tool('proposer_delegation'), alice, args());
    expect(out(r).prepared).toBe(true);
    expect(r.prepared).toMatchObject({
      tool: 'proposer_delegation', sideEffect: 1, requiresValidation: true,
      arguments: { mailId: 200, mailInputationId: 300, delegateUserGroupId: 8, rationale: 'Absence de l’imputé' },
    });
    expect(r.prepared?.preview).toContain('Moussa Traoré');
  });

  it('aucun délégataire déclaré : prepared:false', async () => {
    const { tool } = setup();
    const r = await run(tool('proposer_delegation'), alice, args());
    expect(out(r)).toMatchObject({ prepared: false });
    expect(out(r).message).toContain('Aucun délégataire déclaré');
    expect(r.prepared).toBeUndefined();
  });

  it('délégataire non déclaré, déclaré pour un autre imputé, inactif : refus', async () => {
    const { data, tool } = setup();
    data.delegates = [{ userGroupId: 9 }];
    expect((await run(tool('proposer_delegation'), alice, args())).prepared).toBeUndefined();
    data.delegates = [{ userGroupId: 8, forUserGroupId: 55 }];
    expect((await run(tool('proposer_delegation'), alice, args())).prepared).toBeUndefined();
    data.delegates = [{ userGroupId: 8 }];
    data.imputables.delete(8);
    expect((await run(tool('proposer_delegation'), alice, args())).prepared).toBeUndefined();
  });

  it('imputation déjà traitée : refus', async () => {
    const { data, tool } = setup();
    data.delegates = [{ userGroupId: 8 }];
    data.inputations.set(300, inputation({ dateTreated: new Date('2026-11-05T00:00:00Z') }));
    expect((await run(tool('proposer_delegation'), alice, args())).prepared).toBeUndefined();
  });

  it('dryRun sans contexte d’évaluation : aucun délégataire, jamais de lecture du graphe', async () => {
    const { data, tool } = setup();
    data.delegates = [{ userGroupId: 8 }]; // ignoré en évaluation
    const r = await run(tool('proposer_delegation'), alice, args(), { dryRun: true, instanceId: null });
    expect(out(r).prepared).toBe(false);
    expect(out(r).message).toContain('Aucun délégataire déclaré');
    expect(data.readDelegatesCalls).toBe(0);
    expect(r.prepared).toBeUndefined();
  });

  describe('dryRun avec contexte du cas d’évaluation', () => {
    const evalCtx = (over: Record<string, unknown> = {}) => ({
      delegates: [{ userGroupId: 8, forUserGroupId: 7 }],
      imputation: { recipientUserGroupId: 7 },
      ...over,
    });
    const dry = (evalContext: Record<string, unknown> | undefined) => ({ dryRun: true, instanceId: null, evalContext });

    it('délégataire déclaré : prepared simulé, sans lecture de base ni du port', async () => {
      const { data, tool } = setup();
      data.inputations.clear(); // aucune lecture : l'imputation n'a pas besoin d'exister
      const r = await run(tool('proposer_delegation'), alice, args(), dry(evalCtx()));
      expect(out(r)).toEqual({ prepared: true, simulated: true });
      expect(r.prepared).toMatchObject({
        tool: 'proposer_delegation', sideEffect: 1, requiresValidation: true,
        arguments: { mailId: 200, mailInputationId: 300, delegateUserGroupId: 8 },
      });
      expect(data.readDelegatesCalls).toBe(0);
    });

    it('délégataire non déclaré, déclaré pour un autre imputé, ou contexte invalide : refus', async () => {
      const { tool } = setup();
      const a = await run(tool('proposer_delegation'), alice, args({ delegateUserGroupId: 777 }), dry(evalCtx()));
      expect(out(a).prepared).toBe(false);
      expect(out(a).message).toContain('777');
      const b = await run(tool('proposer_delegation'), alice, args(), dry(evalCtx({ imputation: { recipientUserGroupId: 99 } })));
      expect(b.prepared).toBeUndefined();
      const c = await run(tool('proposer_delegation'), alice, args(), dry(evalCtx({ delegates: [{ userGroupId: 8, autre: 1 }] })));
      expect(c.prepared).toBeUndefined();
      const d = await run(tool('proposer_delegation'), alice, args(), dry({ delegates: [] }));
      expect(d.prepared).toBeUndefined();
    });

    it('imputé inconnu du contexte : seule la liste déclarée compte ; délégataire = imputé refusé', async () => {
      const { tool } = setup();
      const ok = await run(tool('proposer_delegation'), alice, args(), dry({ delegates: [{ userGroupId: 8, forUserGroupId: 7 }] }));
      expect(out(ok).simulated).toBe(true);
      const self = await run(tool('proposer_delegation'), alice, args({ delegateUserGroupId: 7 }), dry({
        delegates: [{ userGroupId: 7 }], imputation: { recipientUserGroupId: 7 },
      }));
      expect(self.prepared).toBeUndefined();
    });
  });

  it('hors évaluation, le contexte d’évaluation est ignoré (jamais de confiance)', async () => {
    const { tool } = setup();
    const r = await run(tool('proposer_delegation'), alice, args(), {
      dryRun: false,
      evalContext: { delegates: [{ userGroupId: 8 }] },
    });
    expect(r.prepared).toBeUndefined(); // lecture réelle : aucun délégataire déclaré
  });

  it('instance nulle hors évaluation : refus', async () => {
    const { tool } = setup();
    const r = await run(tool('proposer_delegation'), alice, args(), { dryRun: false, instanceId: null });
    expect(r.prepared).toBeUndefined();
  });

  it('imputation illisible ou inexistante : même réponse', async () => {
    const { data, tool } = setup();
    data.delegates = [{ userGroupId: 8 }];
    const a = await run(tool('proposer_delegation'), bob, args());
    const b = await run(tool('proposer_delegation'), alice, args({ mailInputationId: 999 }));
    expect(a).toEqual(b);
  });
});

describe('droits du lanceur', () => {
  it('chaque outil de lecture transmet l’utilisateur lanceur au port, jamais un autre', async () => {
    const { data, tool } = setup();
    data.pieces.set(1, { readers: [1], view: { documentId: 1, label: 'P', documentTypeLabel: null, documentDate: null, cote: null, pageCount: null, metadataExcerpt: null }, fields: {} });
    await run(tool('lister_courriers_similaires'), alice, { mailId: 200 });
    await run(tool('lire_organigramme_imputable'), alice, {});
    await run(tool('lister_pieces'), alice, { mailId: 200 });
    await run(tool('comparer_champs'), alice, { documentIds: [1, 2], fields: ['date'] });
    expect(data.seenUsers.length).toBeGreaterThanOrEqual(4);
    expect(data.seenUsers.every((u) => u === alice)).toBe(true);
  });
});
