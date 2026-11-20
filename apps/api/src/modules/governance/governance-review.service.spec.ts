import {
  ConflictException,
  ForbiddenException,
  HttpException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  DocumentState,
  GED_GOVERNANCE_PROMPT_VERSION,
  GedAiDecisionStatus,
  GedAiTask,
  GovernanceKind,
  parseGovernanceOutput,
} from '@archivage/types';
import type { AuthUser } from '../auth/auth.types';
import {
  GOVERNANCE_LOWERING_CONFIRMATION_REQUIRED,
  GovernanceReviewService,
} from './governance-review.service';

// Faux Prisma EN MÉMOIRE. Les transactions sont SÉRIALISÉES (comme le ferait le verrou de ligne
// PostgreSQL sur la décision et `FOR UPDATE` sur le document) et l'état est RESTAURÉ si le callback
// lève (rollback). Ces tests prouvent l'enchaînement des règles et des écritures, pas le
// comportement réel des verrous et de l'isolation PostgreSQL (test d'intégration requis).

// --- Données ------------------------------------------------------------------------------------

interface DecisionRow {
  gedAiDecisionId: bigint;
  documentId: number | null;
  task: number;
  promptVersion: string | null;
  output: unknown;
  status: number;
  validatedBy: number | null;
  validatedAt: Date | null;
}

interface DocRow {
  documentId: number;
  confidentialiteId: number | null;
  isFrozen: boolean;
  documentState: number;
  modifiedBy: number | null;
  modifiedAt: Date | null;
}

interface ConfRow {
  confidentialiteId: number;
  rank: number;
  label: string;
  isActive: boolean;
}

interface State {
  decisions: Map<bigint, DecisionRow>;
  documents: Map<number, DocRow>;
  confidentialites: Map<number, ConfRow>;
  /** Rang de confidentialité propre de chaque utilisateur (`null` = aucune habilitation). */
  userRanks: Map<number, number | null>;
}

const clone = (s: State): State => ({
  decisions: new Map([...s.decisions].map(([k, v]) => [k, { ...v }])),
  documents: new Map([...s.documents].map(([k, v]) => [k, { ...v }])),
  confidentialites: new Map([...s.confidentialites].map(([k, v]) => [k, { ...v }])),
  userRanks: new Map(s.userRanks),
});

const ORDINARY: AuthUser = { userId: 42, username: 'gestion', fullName: 'Agent Gestion', isAdmin: false, userGroupId: 7 };
const ADMIN: AuthUser = { userId: 1, username: 'admin', fullName: 'Admin', isAdmin: true, userGroupId: 5 };
const SCAN_AGENT: AuthUser = { userId: -1, username: 'scan', isAdmin: false, userGroupId: null, isScanAgent: true };

const DOC = 10;
const ORIGINAL = 20;
const PUBLIC = 1; // rang 0
const INTERNE = 2; // rang 1
const SECRET = 3; // rang 3
const ARCHIVE_LEVEL = 4; // rang 2, désactivé

const duplicateOutput = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  kind: GovernanceKind.DoublonExact,
  method: 'file_hash',
  similarity: 1,
  groupKey: `dup:${ORIGINAL}`,
  originalDocumentId: ORIGINAL,
  duplicateDocumentId: DOC,
  proposedAction: 'archive_duplicate',
  ...over,
});

const PII_CONTEXT = 'jean.dupont@example.org 06 12 34 56 78';

const piiOutput = () => ({
  schemaVersion: 1,
  kind: GovernanceKind.DonneesPersonnelles,
  findings: [{ entity: 'email', count: 2, confidence: 1, contexts: [PII_CONTEXT] }],
  overallConfidence: 1,
  detection: { deterministic: true, ai: false },
});

const sensitivityOutput = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  kind: GovernanceKind.Sensibilite,
  score: 2,
  currentConfidentialiteId: null,
  currentRank: null,
  proposedConfidentialiteId: SECRET,
  proposedRank: 3,
  direction: 'raise',
  reasons: ['pii_email'],
  detection: { deterministic: true, ai: false },
  ...over,
});

function decision(output: unknown, over: Partial<DecisionRow> = {}): DecisionRow {
  const kind = (output as { kind?: string } | null)?.kind;
  return {
    gedAiDecisionId: 99n,
    documentId: DOC,
    task:
      kind === GovernanceKind.DoublonExact || kind === GovernanceKind.QuasiDoublon
        ? GedAiTask.Similarite
        : GedAiTask.Autre,
    promptVersion: GED_GOVERNANCE_PROMPT_VERSION,
    output,
    status: GedAiDecisionStatus.Proposee,
    validatedBy: null,
    validatedAt: null,
    ...over,
  };
}

const doc = (documentId: number, over: Partial<DocRow> = {}): DocRow => ({
  documentId,
  confidentialiteId: null,
  isFrozen: false,
  documentState: DocumentState.Archive,
  modifiedBy: null,
  modifiedAt: null,
  ...over,
});

interface Setup {
  decisions?: DecisionRow[];
  documents?: DocRow[];
  /** Documents que l'utilisateur ORDINAIRE peut ouvrir (l'administrateur ouvre tout). */
  access?: number[];
  /** Niveau effectif de l'utilisateur ORDINAIRE par document (défaut 2). */
  levels?: Record<number, number>;
  userRank?: number | null;
  auditFails?: boolean;
  /** Fait échouer l'écriture de `output.applied` (pour vérifier l'annulation). */
  failOutputWrite?: boolean;
}

function setup(opts: Setup = {}) {
  let state: State = {
    decisions: new Map((opts.decisions ?? []).map((d) => [d.gedAiDecisionId, d])),
    documents: new Map((opts.documents ?? [doc(DOC), doc(ORIGINAL)]).map((d) => [d.documentId, d])),
    confidentialites: new Map(
      [
        { confidentialiteId: PUBLIC, rank: 0, label: 'Public', isActive: true },
        { confidentialiteId: INTERNE, rank: 1, label: 'Interne', isActive: true },
        { confidentialiteId: SECRET, rank: 3, label: 'Secret', isActive: true },
        { confidentialiteId: ARCHIVE_LEVEL, rank: 2, label: 'Restreint', isActive: false },
      ].map((c) => [c.confidentialiteId, c]),
    ),
    userRanks: new Map([[ORDINARY.userId, opts.userRank === undefined ? 3 : opts.userRank]]),
  };
  const access = new Set(opts.access ?? [DOC, ORIGINAL]);

  const matches = (row: Record<string, unknown>, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) =>
      v !== null && typeof v === 'object' && 'not' in (v as object)
        ? row[k] !== (v as { not: unknown }).not
        : row[k] === v,
    );

  const prisma = {
    gedAiDecision: {
      findUnique: jest.fn(async ({ where }: { where: { gedAiDecisionId: bigint } }) => {
        const d = state.decisions.get(where.gedAiDecisionId);
        return d ? { ...d } : null;
      }),
      updateMany: jest.fn(
        async ({ where, data }: { where: Record<string, unknown>; data: Partial<DecisionRow> }) => {
          const d = state.decisions.get(where.gedAiDecisionId as bigint);
          if (!d || !matches(d as never, where)) return { count: 0 };
          Object.assign(d, data);
          return { count: 1 };
        },
      ),
      update: jest.fn(
        async ({ where, data }: { where: { gedAiDecisionId: bigint }; data: Partial<DecisionRow> }) => {
          if (opts.failOutputWrite) throw new Error('écriture impossible');
          const d = state.decisions.get(where.gedAiDecisionId);
          if (!d) throw new Error('introuvable');
          Object.assign(d, data);
          return d;
        },
      ),
    },
    document: {
      findUnique: jest.fn(async ({ where }: { where: { documentId: number } }) => {
        const d = state.documents.get(where.documentId);
        return d ? { documentId: d.documentId } : null;
      }),
      updateMany: jest.fn(
        async ({ where, data }: { where: Record<string, unknown>; data: Partial<DocRow> }) => {
          const d = state.documents.get(where.documentId as number);
          if (!d || !matches(d as never, where)) return { count: 0 };
          Object.assign(d, data);
          return { count: 1 };
        },
      ),
    },
    confidentialite: {
      findFirst: jest.fn(async ({ where }: { where: { confidentialiteId: number; isActive: boolean } }) => {
        const c = state.confidentialites.get(where.confidentialiteId);
        return c && c.isActive === where.isActive ? { ...c } : null;
      }),
      findUnique: jest.fn(async ({ where }: { where: { confidentialiteId: number } }) => {
        const c = state.confidentialites.get(where.confidentialiteId);
        return c ? { rank: c.rank, label: c.label } : null;
      }),
    },
    appUser: {
      findUnique: jest.fn(async ({ where }: { where: { userId: number } }) => {
        if (!state.userRanks.has(where.userId)) return null;
        const rank = state.userRanks.get(where.userId);
        return { confidentialite: rank == null ? null : { rank } };
      }),
    },
    $queryRaw: jest.fn(async (q: Prisma.Sql) => {
      expect(q.sql).toMatch(/FOR UPDATE\s*$/);
      return (q.values as number[])
        .filter((id) => state.documents.has(id))
        .sort((x, y) => x - y)
        .map((id) => {
          const d = state.documents.get(id) as DocRow;
          return {
            document_id: d.documentId,
            confidentialite_id: d.confidentialiteId,
            is_frozen: d.isFrozen,
            document_state: d.documentState,
          };
        });
    }),
    $transaction: jest.fn(),
  };

  // Transactions sérialisées + rollback sur erreur.
  let queue: Promise<unknown> = Promise.resolve();
  prisma.$transaction.mockImplementation((cb: (tx: unknown) => Promise<unknown>) => {
    const run = queue.then(async () => {
      const snapshot = clone(state);
      try {
        return await cb(prisma);
      } catch (e) {
        state = snapshot;
        throw e;
      }
    });
    queue = run.catch(() => undefined);
    return run;
  });

  const isPrivileged = (u: AuthUser) => u.isAdmin === true || u.isScanAgent === true;
  const documents = {
    canAccess: jest.fn(async (id: number, u: AuthUser) => isPrivileged(u) || access.has(id)),
    getEffectivePermissionLevel: jest.fn(async (id: number, u: AuthUser) => {
      if (isPrivileged(u)) return 5;
      if (!state.documents.has(id)) return null;
      return opts.levels?.[id] ?? 2;
    }),
  };
  const audit = {
    dataChange: jest.fn(async (_entry: Record<string, unknown>) => {
      if (opts.auditFails) throw new Error(`échec audit ${PII_CONTEXT}`);
    }),
  };
  const service = new GovernanceReviewService(prisma as never, documents as never, audit as never);
  return {
    service,
    prisma,
    documents,
    audit,
    doc: (id: number) => state.documents.get(id) as DocRow,
    decision: (id: bigint = 99n) => state.decisions.get(id) as DecisionRow,
  };
}

/** Capture l'erreur d'une promesse (échoue si elle est résolue). */
async function errorOf(p: Promise<unknown>): Promise<HttpException> {
  try {
    await p;
  } catch (e) {
    return e as HttpException;
  }
  throw new Error('la promesse aurait dû échouer');
}

/** Le message de toute erreur ne contient ni valeur brute ni contexte de données personnelles. */
function expectNoRawValue(e: unknown) {
  const text = JSON.stringify((e as HttpException).getResponse?.() ?? String(e));
  expect(text).not.toContain('jean.dupont');
  expect(text).not.toContain('06 12 34');
  expect(text).not.toContain('example.org');
}

let warnSpy: jest.SpyInstance;
beforeEach(() => {
  warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => warnSpy.mockRestore());

// =================================================================================================
// Visibilité : 404 identique
// =================================================================================================

describe('GovernanceReviewService — visibilité (404 identique, jamais 403)', () => {
  it('utilisateur sans droit sur le document : 404, pour valider comme pour rejeter', async () => {
    const t = setup({ decisions: [decision(sensitivityOutput())], access: [ORIGINAL] });
    const v = await errorOf(t.service.validate(99, ORDINARY, {}));
    const r = await errorOf(t.service.reject(99, ORDINARY));
    for (const e of [v, r]) {
      expect(e).toBeInstanceOf(NotFoundException);
      expect(e.message).toBe('Proposition de gouvernance introuvable.');
    }
    expect(t.decision().status).toBe(GedAiDecisionStatus.Proposee);
    expect(t.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('doublon dont l’ORIGINAL est interdit : 404 aussi (on n’apprend pas son existence)', async () => {
    const t = setup({ decisions: [decision(duplicateOutput())], access: [DOC], levels: { [DOC]: 5 } });
    const e = await errorOf(t.service.validate(99, ORDINARY, {}));
    expect(e).toBeInstanceOf(NotFoundException);
    expect(e.message).toBe('Proposition de gouvernance introuvable.');
    expect((await errorOf(t.service.reject(99, ORDINARY))).message).toBe(e.message);
    expect(t.doc(DOC).isFrozen).toBe(false);
  });

  it('même réponse 404 pour une proposition inexistante', async () => {
    const t = setup({ decisions: [] });
    const e = await errorOf(t.service.validate(12345, ORDINARY, {}));
    expect(e).toBeInstanceOf(NotFoundException);
    expect(e.message).toBe('Proposition de gouvernance introuvable.');
  });

  it.each([
    ['prompt_version étrangère', decision(sensitivityOutput(), { promptVersion: 'ged-ai-v1' })],
    ['prompt_version absente', decision(sensitivityOutput(), { promptVersion: null })],
    ['tâche incohérente avec la nature', decision(sensitivityOutput(), { task: GedAiTask.Similarite })],
    ['tâche hors gouvernance', decision(piiOutput(), { task: GedAiTask.Classement })],
    ['nature inconnue', decision({ ...piiOutput(), kind: 'autre' })],
    ['output non conforme (clé en trop)', decision({ ...piiOutput(), extra: 1 })],
    ['output nul', decision(null as unknown as object, { task: GedAiTask.Autre })],
    ['doublon incohérent', decision(duplicateOutput({ duplicateDocumentId: 77 }))],
  ])('hors périmètre (%s) : 404, administrateur compris', async (_l, row) => {
    const t = setup({ decisions: [row] });
    for (const u of [ORDINARY, ADMIN]) {
      const e = await errorOf(t.service.validate(99, u, {}));
      expect(e).toBeInstanceOf(NotFoundException);
      expect((await errorOf(t.service.reject(99, u))).message).toBe('Proposition de gouvernance introuvable.');
    }
    expect(t.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('administrateur : document ou original inexistant => 404 (existence exigée, comme la SQL)', async () => {
    const t = setup({ decisions: [decision(duplicateOutput())], documents: [doc(DOC)] });
    expect(await errorOf(t.service.validate(99, ADMIN, {}))).toBeInstanceOf(NotFoundException);
    const t2 = setup({ decisions: [decision(piiOutput())], documents: [doc(ORIGINAL)] });
    expect(await errorOf(t2.service.validate(99, ADMIN, {}))).toBeInstanceOf(NotFoundException);
    // Le REJET d'un orphelin par un administrateur est couvert par la section dediee plus bas.
  });

  it.each([0, -1, 1.5, Number.NaN])('identifiant invalide (%s) : 404 sans requête', async (id) => {
    const t = setup({ decisions: [decision(piiOutput())] });
    expect(await errorOf(t.service.validate(id, ORDINARY, {}))).toBeInstanceOf(NotFoundException);
    expect(t.prisma.gedAiDecision.findUnique).not.toHaveBeenCalled();
  });

  it.each([
    ['agent de numérisation (aucune voie automatique)', SCAN_AGENT],
    ['identifiant corrompu', { ...ORDINARY, userId: Number.NaN }],
    ['identifiant non positif', { ...ORDINARY, userId: 0 }],
    ['utilisateur absent', undefined as unknown as AuthUser],
  ])('%s : 403 AVANT toute lecture (ne révèle rien)', async (_l, u) => {
    const t = setup({ decisions: [decision(piiOutput())] });
    expect(await errorOf(t.service.validate(99, u as AuthUser, {}))).toBeInstanceOf(ForbiddenException);
    expect(await errorOf(t.service.reject(99, u as AuthUser))).toBeInstanceOf(ForbiddenException);
    expect(t.prisma.gedAiDecision.findUnique).not.toHaveBeenCalled();
  });
});

// =================================================================================================
// Sensibilité
// =================================================================================================

describe('GovernanceReviewService — sensibilité', () => {
  it('élévation en un clic (niveau 3) : niveau posé, trace écrite, audit', async () => {
    const t = setup({ decisions: [decision(sensitivityOutput())], levels: { [DOC]: 3 } });
    const { applied } = await t.service.validate(99, ORDINARY, {});

    expect(applied).toMatchObject({
      action: 'confidentiality_set',
      by: 7,
      previousConfidentialiteId: null,
      loweredWithConfirmation: false,
    });
    expect(new Date(applied!.at).toISOString()).toBe(applied!.at);
    expect(t.doc(DOC)).toMatchObject({ confidentialiteId: SECRET, modifiedBy: 7 });
    expect(t.doc(DOC).modifiedAt).toBeInstanceOf(Date);

    const d = t.decision();
    expect(d.status).toBe(GedAiDecisionStatus.Validee);
    expect(d.validatedBy).toBe(7);
    expect(d.validatedAt).toBeInstanceOf(Date);
    // Le reste de output est conservé, la trace est conforme au schéma strict.
    expect(d.output).toEqual({ ...sensitivityOutput(), applied });
    expect(parseGovernanceOutput(d.output)).not.toBeNull();

    expect(t.audit.dataChange).toHaveBeenCalledTimes(1);
    expect(t.audit.dataChange).toHaveBeenCalledWith({
      userGroupId: 7,
      actorFullName: 'Agent Gestion',
      objectRef: `document:${DOC}`,
      oldValue: 'Confidentialité : aucune',
      newValue: `Confidentialité : Secret (#${SECRET}) (proposition de gouvernance #99 validée)`,
    });
  });

  it('élévation refusée au niveau 2 (consultation) : 403, rien ne change', async () => {
    const t = setup({ decisions: [decision(sensitivityOutput())], levels: { [DOC]: 2 } });
    expect(await errorOf(t.service.validate(99, ORDINARY, {}))).toBeInstanceOf(ForbiddenException);
    expect(t.doc(DOC).confidentialiteId).toBeNull();
    expect(t.decision().status).toBe(GedAiDecisionStatus.Proposee);
    expect(t.audit.dataChange).not.toHaveBeenCalled();
  });

  const lowering = () =>
    setup({
      decisions: [
        decision(
          sensitivityOutput({
            currentConfidentialiteId: SECRET,
            currentRank: 3,
            proposedConfidentialiteId: INTERNE,
            proposedRank: 1,
            direction: 'lower',
            score: 1,
          }),
        ),
      ],
      documents: [doc(DOC, { confidentialiteId: SECRET })],
      levels: { [DOC]: 5 },
    });

  it('abaissement SANS confirmation : refusé avec le code explicite, même pour un administrateur', async () => {
    for (const u of [ADMIN, ORDINARY]) {
      const t = lowering();
      const e = await errorOf(t.service.validate(99, u, {}));
      expect(e).toBeInstanceOf(ConflictException);
      expect(e.message).toContain(GOVERNANCE_LOWERING_CONFIRMATION_REQUIRED);
      expect(t.doc(DOC).confidentialiteId).toBe(SECRET);
      expect(t.decision().status).toBe(GedAiDecisionStatus.Proposee);
    }
  });

  it('`confirmLowering` non booléen (« true ») ne vaut pas confirmation', async () => {
    const t = lowering();
    const e = await errorOf(
      t.service.validate(99, ADMIN, { confirmLowering: 'true' as unknown as boolean }),
    );
    expect(e.message).toContain(GOVERNANCE_LOWERING_CONFIRMATION_REQUIRED);
  });

  it('abaissement confirmé mais niveau 4 : 403', async () => {
    const t = setup({
      decisions: [decision(sensitivityOutput({ proposedConfidentialiteId: INTERNE, proposedRank: 1 }))],
      documents: [doc(DOC, { confidentialiteId: SECRET })],
      levels: { [DOC]: 4 },
    });
    expect(await errorOf(t.service.validate(99, ORDINARY, { confirmLowering: true }))).toBeInstanceOf(
      ForbiddenException,
    );
    expect(t.doc(DOC).confidentialiteId).toBe(SECRET);
    expect(t.decision().status).toBe(GedAiDecisionStatus.Proposee);
  });

  it.each([
    ['rang propre trop bas', 1],
    ['aucune habilitation', null],
  ])('abaissement confirmé, niveau 5 mais %s : 403', async (_l, rank) => {
    const t = setup({
      decisions: [decision(sensitivityOutput({ proposedConfidentialiteId: INTERNE, proposedRank: 1 }))],
      documents: [doc(DOC, { confidentialiteId: SECRET })],
      levels: { [DOC]: 5 },
      userRank: rank,
    });
    expect(await errorOf(t.service.validate(99, ORDINARY, { confirmLowering: true }))).toBeInstanceOf(
      ForbiddenException,
    );
    expect(t.doc(DOC).confidentialiteId).toBe(SECRET);
  });

  it('abaissement confirmé par un administrateur : appliqué, tracé comme confirmé', async () => {
    const t = lowering();
    const { applied } = await t.service.validate(99, ADMIN, { confirmLowering: true });
    expect(applied).toMatchObject({
      action: 'confidentiality_set',
      by: 5,
      previousConfidentialiteId: SECRET,
      loweredWithConfirmation: true,
    });
    expect(t.doc(DOC).confidentialiteId).toBe(INTERNE);
    expect(t.decision().status).toBe(GedAiDecisionStatus.Validee);
    const entry = t.audit.dataChange.mock.calls[0][0] as Record<string, string>;
    expect(entry.oldValue).toBe(`Confidentialité : Secret (#${SECRET})`);
    expect(entry.newValue).toContain('abaissement confirmé');
  });

  it('abaissement confirmé, niveau 5 et rang propre suffisant (= rang courant) : appliqué', async () => {
    const t = setup({
      decisions: [decision(sensitivityOutput({ proposedConfidentialiteId: INTERNE, proposedRank: 1 }))],
      documents: [doc(DOC, { confidentialiteId: SECRET })],
      levels: { [DOC]: 5 },
      userRank: 3,
    });
    const { applied } = await t.service.validate(99, ORDINARY, { confirmLowering: true });
    expect(applied?.loweredWithConfirmation).toBe(true);
    expect(t.doc(DOC).confidentialiteId).toBe(INTERNE);
  });

  it('proposition périmée : output dit « élévation » mais l’état VIVANT impose un abaissement', async () => {
    // Proposée quand le document n'avait aucun niveau ; il est passé à Secret entre-temps.
    const t = setup({
      decisions: [decision(sensitivityOutput({ proposedConfidentialiteId: INTERNE, proposedRank: 9 }))],
      documents: [doc(DOC, { confidentialiteId: SECRET })],
      levels: { [DOC]: 3 },
    });
    const e = await errorOf(t.service.validate(99, ORDINARY, {}));
    // Recalcul : abaissement => droits d'abaissement exigés (niveau 3 insuffisant).
    expect(e).toBeInstanceOf(ForbiddenException);
    expect(t.doc(DOC).confidentialiteId).toBe(SECRET);
  });

  it('proposition périmée inverse : output dit « abaissement » mais l’état vivant est une élévation (un clic)', async () => {
    const t = setup({
      decisions: [
        decision(
          sensitivityOutput({ direction: 'lower', currentConfidentialiteId: SECRET, currentRank: 3, proposedRank: 0 }),
        ),
      ],
      documents: [doc(DOC, { confidentialiteId: PUBLIC })],
      levels: { [DOC]: 3 },
    });
    const { applied } = await t.service.validate(99, ORDINARY, {});
    expect(applied).toMatchObject({ previousConfidentialiteId: PUBLIC, loweredWithConfirmation: false });
    expect(t.doc(DOC).confidentialiteId).toBe(SECRET);
  });

  it('niveau proposé désactivé : 409 (périmée), rien ne change', async () => {
    const t = setup({
      decisions: [decision(sensitivityOutput({ proposedConfidentialiteId: ARCHIVE_LEVEL, proposedRank: 2 }))],
      levels: { [DOC]: 5 },
    });
    const e = await errorOf(t.service.validate(99, ADMIN, { confirmLowering: true }));
    expect(e).toBeInstanceOf(ConflictException);
    expect(e.message).toMatch(/périmée/);
    expect(t.doc(DOC).confidentialiteId).toBeNull();
    expect(t.decision().status).toBe(GedAiDecisionStatus.Proposee);
    expect(t.audit.dataChange).not.toHaveBeenCalled();
  });

  it('niveau proposé disparu : 409', async () => {
    const t = setup({ decisions: [decision(sensitivityOutput({ proposedConfidentialiteId: 999 }))], levels: { [DOC]: 3 } });
    expect(await errorOf(t.service.validate(99, ORDINARY, {}))).toBeInstanceOf(ConflictException);
  });

  it('pas de nouvelle élévation inutile : niveau déjà en place => validée, aucun effet, applied null', async () => {
    const t = setup({
      decisions: [decision(sensitivityOutput())],
      documents: [doc(DOC, { confidentialiteId: SECRET })],
      levels: { [DOC]: 3 },
    });
    const { applied } = await t.service.validate(99, ORDINARY, {});
    expect(applied).toBeNull();
    expect(t.prisma.document.updateMany).not.toHaveBeenCalled();
    expect(t.prisma.gedAiDecision.update).not.toHaveBeenCalled();
    expect(t.doc(DOC).modifiedAt).toBeNull();
    expect(t.decision().status).toBe(GedAiDecisionStatus.Validee);
    expect(t.decision().output).toEqual(sensitivityOutput());
    expect(t.audit.dataChange).toHaveBeenCalledWith(
      expect.objectContaining({ objectRef: 'governance:99', oldValue: 'proposée' }),
    );
  });

  it('le rang proposé est RELU en base : output.proposedRank n’est jamais cru', async () => {
    // output prétend un rang 0 (abaissement) ; en base Secret est de rang 3 : c'est une élévation.
    const t = setup({
      decisions: [decision(sensitivityOutput({ proposedRank: 0, direction: 'lower' }))],
      documents: [doc(DOC, { confidentialiteId: INTERNE })],
      levels: { [DOC]: 3 },
    });
    await t.service.validate(99, ORDINARY, {});
    expect(t.doc(DOC).confidentialiteId).toBe(SECRET);
  });

  it('le document est lu VERROUILLÉ (FOR UPDATE) dans la transaction, avant l’écriture', async () => {
    const t = setup({ decisions: [decision(sensitivityOutput())], levels: { [DOC]: 3 } });
    await t.service.validate(99, ORDINARY, {});
    expect(t.prisma.$queryRaw).toHaveBeenCalledTimes(1);
    const order = (m: jest.Mock) => m.mock.invocationCallOrder[0];
    expect(order(t.prisma.$queryRaw)).toBeLessThan(order(t.prisma.document.updateMany));
    expect(order(t.prisma.$transaction)).toBeLessThan(order(t.prisma.$queryRaw));
  });

  it('échec de l’écriture de la trace : TOUT est annulé (statut et niveau inchangés)', async () => {
    const t = setup({ decisions: [decision(sensitivityOutput())], levels: { [DOC]: 3 }, failOutputWrite: true });
    await expect(t.service.validate(99, ORDINARY, {})).rejects.toThrow();
    expect(t.doc(DOC).confidentialiteId).toBeNull();
    expect(t.decision().status).toBe(GedAiDecisionStatus.Proposee);
    expect(t.audit.dataChange).not.toHaveBeenCalled();
  });
});

// =================================================================================================
// Concurrence et statut
// =================================================================================================

describe('GovernanceReviewService — statut et concurrence', () => {
  it('double validation concurrente : une seule réussit, l’autre obtient 409', async () => {
    const t = setup({ decisions: [decision(sensitivityOutput())], levels: { [DOC]: 3 } });
    const results = await Promise.allSettled([
      t.service.validate(99, ORDINARY, {}),
      t.service.validate(99, ADMIN, {}),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const ko = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(ok).toHaveLength(1);
    expect(ko).toHaveLength(1);
    expect(ko[0].reason).toBeInstanceOf(ConflictException);
    expect(t.prisma.document.updateMany).toHaveBeenCalledTimes(1);
    expect(t.audit.dataChange).toHaveBeenCalledTimes(1);
    expect(t.decision().status).toBe(GedAiDecisionStatus.Validee);
  });

  it('validation et rejet concurrents : un seul gagne', async () => {
    const t = setup({ decisions: [decision(duplicateOutput())], levels: { [DOC]: 3 } });
    const results = await Promise.allSettled([t.service.reject(99, ORDINARY), t.service.validate(99, ORDINARY, {})]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const status = t.decision().status;
    expect(status === GedAiDecisionStatus.Rejetee ? t.doc(DOC).isFrozen : !t.doc(DOC).isFrozen).toBe(false);
  });

  it.each([
    ['validée', GedAiDecisionStatus.Validee],
    ['rejetée', GedAiDecisionStatus.Rejetee],
    ['en erreur', GedAiDecisionStatus.Erreur],
  ])('proposition déjà %s : 409, pour valider comme pour rejeter', async (_l, status) => {
    const t = setup({ decisions: [decision(piiOutput(), { status })] });
    expect(await errorOf(t.service.validate(99, ORDINARY, {}))).toBeInstanceOf(ConflictException);
    expect(await errorOf(t.service.reject(99, ORDINARY))).toBeInstanceOf(ConflictException);
    expect(t.audit.dataChange).not.toHaveBeenCalled();
  });
});

// =================================================================================================
// Doublons
// =================================================================================================

describe('GovernanceReviewService — doublons', () => {
  it('validation : archivage LOGIQUE du doublon (gel), l’original intact, jamais de suppression', async () => {
    const t = setup({ decisions: [decision(duplicateOutput())], levels: { [DOC]: 3 } });
    const { applied } = await t.service.validate(99, ORDINARY, {});
    expect(applied).toMatchObject({ action: 'duplicate_archived', by: 7 });
    expect(t.doc(DOC).isFrozen).toBe(true);
    expect(t.doc(ORIGINAL).isFrozen).toBe(false);
    expect(t.doc(DOC).documentState).toBe(DocumentState.Archive);
    expect(t.decision().output).toEqual({ ...duplicateOutput(), applied });
    expect(parseGovernanceOutput(t.decision().output)).not.toBeNull();
    expect(t.documents.canAccess).toHaveBeenCalledWith(ORIGINAL, ORDINARY);
    expect(t.audit.dataChange).toHaveBeenCalledWith(
      expect.objectContaining({
        objectRef: `document:${DOC}`,
        oldValue: 'non gelé',
        newValue: expect.stringContaining(`gelé (doublon du document #${ORIGINAL}`),
      }),
    );
    // Verrous pris dans l'ordre croissant des identifiants (pas d'interblocage).
    expect((t.prisma.$queryRaw.mock.calls[0][0] as Prisma.Sql).values).toEqual([DOC, ORIGINAL]);
  });

  it('idempotent : doublon déjà gelé => validée sans nouvelle écriture sur le document', async () => {
    const t = setup({
      decisions: [decision(duplicateOutput())],
      documents: [doc(DOC, { isFrozen: true }), doc(ORIGINAL)],
      levels: { [DOC]: 3 },
    });
    const { applied } = await t.service.validate(99, ORDINARY, {});
    expect(applied?.action).toBe('duplicate_archived');
    expect(t.prisma.document.updateMany).not.toHaveBeenCalled();
    expect(t.doc(DOC).isFrozen).toBe(true);
    expect(t.audit.dataChange).toHaveBeenCalledWith(expect.objectContaining({ oldValue: 'gelé' }));
  });

  it('niveau 2 sur le doublon : 403, rien n’est gelé', async () => {
    const t = setup({ decisions: [decision(duplicateOutput())], levels: { [DOC]: 2, [ORIGINAL]: 5 } });
    expect(await errorOf(t.service.validate(99, ORDINARY, {}))).toBeInstanceOf(ForbiddenException);
    expect(t.doc(DOC).isFrozen).toBe(false);
    // Le rejet n'exige que l'accès.
    await t.service.reject(99, ORDINARY);
    expect(t.decision().status).toBe(GedAiDecisionStatus.Rejetee);
  });

  it('original == doublon : 409 à la validation', async () => {
    const t = setup({
      decisions: [decision(duplicateOutput({ originalDocumentId: DOC, groupKey: `dup:${DOC}` }))],
      levels: { [DOC]: 3 },
    });
    expect(await errorOf(t.service.validate(99, ORDINARY, {}))).toBeInstanceOf(ConflictException);
    expect(t.doc(DOC).isFrozen).toBe(false);
    expect(t.decision().status).toBe(GedAiDecisionStatus.Proposee);
  });

  it.each([
    ['doublon épuré', [doc(DOC, { documentState: DocumentState.Epure }), doc(ORIGINAL)]],
    ['original épuré', [doc(DOC), doc(ORIGINAL, { documentState: DocumentState.Epure })]],
    ['original lui-même gelé (paire croisée)', [doc(DOC), doc(ORIGINAL, { isFrozen: true })]],
  ])('%s : 409, rien n’est gelé', async (_l, documents) => {
    const t = setup({ decisions: [decision(duplicateOutput())], documents, levels: { [DOC]: 3 } });
    expect(await errorOf(t.service.validate(99, ADMIN, {}))).toBeInstanceOf(ConflictException);
    expect(t.doc(DOC).isFrozen).toBe(documents[0].isFrozen);
    expect(t.decision().status).toBe(GedAiDecisionStatus.Proposee);
  });

  it('original supprimé ENTRE la vérification et la transaction : 409, statut inchangé', async () => {
    const t = setup({ decisions: [decision(duplicateOutput())], levels: { [DOC]: 3 } });
    // La vérification de visibilité voit l'original ; le verrou ne le trouve plus.
    t.prisma.$queryRaw.mockImplementationOnce(async () => [
      { document_id: DOC, confidentialite_id: null, is_frozen: false, document_state: DocumentState.Archive },
    ]);
    expect(await errorOf(t.service.validate(99, ORDINARY, {}))).toBeInstanceOf(ConflictException);
    expect(t.decision().status).toBe(GedAiDecisionStatus.Proposee);
  });

  it('échec de l’écriture de la trace : le gel est annulé avec le statut', async () => {
    const t = setup({ decisions: [decision(duplicateOutput())], levels: { [DOC]: 3 }, failOutputWrite: true });
    await expect(t.service.validate(99, ORDINARY, {})).rejects.toThrow();
    expect(t.doc(DOC).isFrozen).toBe(false);
    expect(t.decision().status).toBe(GedAiDecisionStatus.Proposee);
  });
});

// =================================================================================================
// Données personnelles, rejet, audit
// =================================================================================================

describe('GovernanceReviewService — données personnelles, rejet, audit', () => {
  it('pii : validée = prise d’acte, aucun changement de document, applied null', async () => {
    const t = setup({ decisions: [decision(piiOutput())] });
    const { applied } = await t.service.validate(99, ORDINARY, {});
    expect(applied).toBeNull();
    expect(t.prisma.document.updateMany).not.toHaveBeenCalled();
    expect(t.prisma.$queryRaw).not.toHaveBeenCalled();
    expect(t.prisma.gedAiDecision.update).not.toHaveBeenCalled();
    expect(t.decision().status).toBe(GedAiDecisionStatus.Validee);
    expect(t.doc(DOC)).toEqual(doc(DOC));
  });

  it.each([
    ['doublon', duplicateOutput()],
    ['pii', piiOutput()],
    ['sensibilité', sensitivityOutput()],
  ])('rejet (%s) : aucun effet document, statut Rejetée, audit écrit', async (_l, output) => {
    const t = setup({ decisions: [decision(output)] });
    await t.service.reject(99, ORDINARY);
    expect(t.prisma.document.updateMany).not.toHaveBeenCalled();
    expect(t.prisma.gedAiDecision.update).not.toHaveBeenCalled();
    expect(t.doc(DOC)).toEqual(doc(DOC));
    expect(t.decision()).toMatchObject({ status: GedAiDecisionStatus.Rejetee, validatedBy: 7 });
    expect(t.decision().output).toEqual(output);
    expect(t.audit.dataChange).toHaveBeenCalledTimes(1);
    expect(t.audit.dataChange).toHaveBeenCalledWith({
      userGroupId: 7,
      actorFullName: 'Agent Gestion',
      objectRef: 'governance:99',
      oldValue: 'proposée',
      newValue: expect.stringMatching(/^rejet \(.+, document #10\)$/),
    });
  });

  it('aucune donnée personnelle brute dans l’audit (pii validée puis rejetée)', async () => {
    const t1 = setup({ decisions: [decision(piiOutput())] });
    await t1.service.validate(99, ORDINARY, {});
    const t2 = setup({ decisions: [decision(piiOutput())] });
    await t2.service.reject(99, ORDINARY);
    for (const t of [t1, t2]) {
      const written = JSON.stringify(t.audit.dataChange.mock.calls);
      expect(written).not.toContain('jean.dupont');
      expect(written).not.toContain('06 12 34');
      expect(written).not.toContain('contexts');
    }
  });

  it('aucune valeur brute dans les messages d’erreur', async () => {
    const cases: Array<() => Promise<unknown>> = [
      () => setup({ decisions: [decision(piiOutput())], access: [] }).service.validate(99, ORDINARY, {}),
      () =>
        setup({ decisions: [decision(piiOutput(), { status: GedAiDecisionStatus.Validee })] }).service.reject(
          99,
          ORDINARY,
        ),
      () => setup({ decisions: [decision({ ...piiOutput(), extra: PII_CONTEXT })] }).service.validate(99, ADMIN, {}),
    ];
    for (const run of cases) expectNoRawValue(await errorOf(run()));
  });

  it('échec de l’audit APRÈS validation : l’action reste acquise, avertissement sans contenu', async () => {
    const t = setup({ decisions: [decision(sensitivityOutput())], levels: { [DOC]: 3 }, auditFails: true });
    const { applied } = await t.service.validate(99, ORDINARY, {});
    expect(applied?.action).toBe('confidentiality_set');
    expect(t.doc(DOC).confidentialiteId).toBe(SECRET);
    expect(t.decision().status).toBe(GedAiDecisionStatus.Validee);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(warnSpy.mock.calls);
    expect(logged).toContain('#99');
    expect(logged).not.toContain('jean.dupont');
    expect(logged).not.toContain('échec audit');
  });

  it('échec de l’audit après un rejet : le rejet reste acquis', async () => {
    const t = setup({ decisions: [decision(piiOutput())], auditFails: true });
    await expect(t.service.reject(99, ORDINARY)).resolves.toBeUndefined();
    expect(t.decision().status).toBe(GedAiDecisionStatus.Rejetee);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('administrateur sans compte-groupe : validatedBy null, nom d’acteur conservé dans l’audit', async () => {
    const admin = { ...ADMIN, userGroupId: null, fullName: null };
    const t = setup({ decisions: [decision(piiOutput())] });
    await t.service.validate(99, admin, {});
    expect(t.decision().validatedBy).toBeNull();
    expect(t.audit.dataChange).toHaveBeenCalledWith(expect.objectContaining({ actorFullName: 'admin' }));
  });
});

// =================================================================================================
// Propositions orphelines : rejet par un administrateur uniquement
// =================================================================================================

describe('GovernanceReviewService — propositions orphelines (rejet administrateur)', () => {
  const orphanCases: Array<[string, () => ReturnType<typeof setup>]> = [
    [
      'document supprimé (document_id NULL)',
      () => setup({ decisions: [decision(sensitivityOutput(), { documentId: null })] }),
    ],
    [
      'document inexistant (ligne absente)',
      () => setup({ decisions: [decision(piiOutput())], documents: [doc(ORIGINAL)] }),
    ],
    [
      'doublon dont l’original est manquant',
      () => setup({ decisions: [decision(duplicateOutput())], documents: [doc(DOC)] }),
    ],
    [
      'doublon sans document ni original',
      () => setup({ decisions: [decision(duplicateOutput(), { documentId: null })], documents: [] }),
    ],
  ];

  it.each(orphanCases)('administrateur rejette : %s', async (_l, make) => {
    const t = make();
    await expect(t.service.reject(99, ADMIN)).resolves.toBeUndefined();
    expect(t.decision().status).toBe(GedAiDecisionStatus.Rejetee);
    expect(t.decision().validatedBy).toBe(ADMIN.userGroupId);
    expect(t.decision().validatedAt).toBeInstanceOf(Date);
    expect(t.audit.dataChange).toHaveBeenCalledTimes(1);
    const entry = t.audit.dataChange.mock.calls[0][0] as Record<string, string>;
    expect(entry.objectRef).toBe('governance:99');
    expect(entry.oldValue).toBe('proposée');
    expect(entry.newValue).toContain('orpheline');
    expect(JSON.stringify(entry)).not.toContain('jean.dupont');
  });

  it.each(orphanCases)('utilisateur non administrateur : 404 (%s)', async (_l, make) => {
    const t = make();
    const e = await errorOf(t.service.reject(99, ORDINARY));
    expect(e).toBeInstanceOf(NotFoundException);
    expect(e.message).toBe('Proposition de gouvernance introuvable.');
    expect(t.decision().status).toBe(GedAiDecisionStatus.Proposee);
    expect(t.prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each(orphanCases)('administrateur ne peut pas VALIDER : 404 (%s)', async (_l, make) => {
    const t = make();
    expect(await errorOf(t.service.validate(99, ADMIN, {}))).toBeInstanceOf(NotFoundException);
    expect(t.decision().status).toBe(GedAiDecisionStatus.Proposee);
    expect(t.audit.dataChange).not.toHaveBeenCalled();
  });

  it('agent de numérisation : refusé (403) avant toute lecture', async () => {
    const t = setup({ decisions: [decision(sensitivityOutput(), { documentId: null })] });
    expect(await errorOf(t.service.reject(99, SCAN_AGENT))).toBeInstanceOf(ForbiddenException);
    expect(t.prisma.gedAiDecision.findUnique).not.toHaveBeenCalled();
  });

  it('double rejet d’un orphelin : 409', async () => {
    const t = setup({ decisions: [decision(sensitivityOutput(), { documentId: null })] });
    await t.service.reject(99, ADMIN);
    expect(await errorOf(t.service.reject(99, ADMIN))).toBeInstanceOf(ConflictException);
    expect(t.audit.dataChange).toHaveBeenCalledTimes(1);
  });

  it('orphelin déjà validé : 409 au rejet', async () => {
    const t = setup({
      decisions: [decision(sensitivityOutput(), { documentId: null, status: GedAiDecisionStatus.Validee })],
    });
    expect(await errorOf(t.service.reject(99, ADMIN))).toBeInstanceOf(ConflictException);
  });

  it('orphelin hors périmètre (output invalide, autre prompt_version, autre tâche) : 404 même pour un administrateur', async () => {
    for (const row of [
      decision({ ...piiOutput(), extra: 1 }, { documentId: null }),
      decision(sensitivityOutput(), { documentId: null, promptVersion: 'ged-ai-v1' }),
      decision(sensitivityOutput(), { documentId: null, task: GedAiTask.Similarite }),
    ]) {
      const t = setup({ decisions: [row] });
      expect(await errorOf(t.service.reject(99, ADMIN))).toBeInstanceOf(NotFoundException);
    }
  });

  it('proposition NON orpheline : reste soumise à canAccess (utilisateur sans droit => 404)', async () => {
    const t = setup({ decisions: [decision(piiOutput())], access: [] });
    expect(await errorOf(t.service.reject(99, ORDINARY))).toBeInstanceOf(NotFoundException);
    expect(t.documents.canAccess).toHaveBeenCalledWith(DOC, ORDINARY);
    // L'administrateur la rejette comme une proposition ordinaire : audit « document #… ».
    await t.service.reject(99, ADMIN);
    const entry = t.audit.dataChange.mock.calls[0][0] as Record<string, string>;
    expect(entry.newValue).toContain(`document #${DOC}`);
    expect(entry.newValue).not.toContain('orpheline');
  });

  it('doublon dont seul l’original est invisible (non orphelin) : 404 pour un non-administrateur', async () => {
    const t = setup({ decisions: [decision(duplicateOutput())], access: [DOC] });
    expect(await errorOf(t.service.reject(99, ORDINARY))).toBeInstanceOf(NotFoundException);
  });
});
