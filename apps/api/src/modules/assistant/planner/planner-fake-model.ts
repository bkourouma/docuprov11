import { AsstActionTool, GedAiDecisionStatus, type AsstPageContext, type AsstProposedAction } from '@archivage/types';
import type { AiService } from '../../ai/ai.service';
import { AiProviderError, type AiRunOptions, type AiRunResult } from '../../ai/ai.types';
import type { AuthUser } from '../../auth/auth.types';
import { ActionApplierRegistry } from '../../workflow-agent-catalog/appliers/action-applier.registry';
import { parseStrict } from '../../workflow-agent-catalog/appliers/extra/extra-applier.utils';
import {
  MAIL_INPUTATION_TYPE_IDS,
  brouillonReponseArgsSchema,
  imputationCourrierArgsSchema,
  relanceArgsSchema,
  type ActionApplier,
} from '../../workflow-agent-catalog/catalog.contracts';
import type { AgentReservation, AgentUsage, WfAgentGate } from '../../workflow-agents/agent.contracts';
import type { AsstGatePort, AsstIdentity, AsstPlanInput, AsstReservation, AsstUserCap } from '../assistant.contracts';
import { makeAsstIdentity } from '../testing/fake-identity';
import { AsstActionValidatorService } from './action-validator';
import { AsstPlannerService } from './asst-planner.service';
import { foldText } from './intent-guards';
import type {
  AsstPlannerDataPort,
  PlannerActorView,
  PlannerDraftResult,
  PlannerDraftTemplateView,
  PlannerInputationTypeView,
  PlannerInputationView,
  PlannerMailHit,
  PlannerMailView,
  PlannerSpaceView,
} from './planner.types';

// AIDES DE TEST du planificateur de l'assistant (hors production : aucun module ne les fournit).
//  - `FakeAiService` : faux `AiService` SCRIPTÉ (rejoue des tours bruts JSON ou des erreurs, enregistre les prompts) ;
//  - `FakeAsstGate` : porte de coût en mémoire (compte réservations, règlements, libérations) ;
//  - `FakeWfCostGate` : tarif des jetons seulement (`costOf`) ;
//  - `InMemoryPlannerData` : port de données en mémoire, LECTURE SEULE (aucune méthode d'écriture), configurable ;
//  - `createPlannerHarness` : assemble le service réel, le validateur réel et ces faux.
// Aucune dépendance à `jest` : ce fichier compile avec le reste de l'API.

// ---------------------------------------------------------------------------------------------
// Jeu de données de référence
// ---------------------------------------------------------------------------------------------

export const PLANNER_TEST_NOW = new Date('2026-11-22T12:00:00Z');
export const PAGE_MAIL_4321: AsstPageContext = { route: '/courriers/4321', subjectType: 'mail', subjectId: '4321' };
export const PAGE_HOME: AsstPageContext = { route: '/accueil' };

export const MAIL_4321: PlannerMailView = {
  mailId: 4321,
  reference: 'CE/2026/0042',
  title: 'Demande de subvention',
  date: '2026-11-01',
  senderLabel: 'Mairie de Kaolack',
  natureLabel: 'Lettre',
  objetLabel: 'Subvention',
  confidentialiteLabel: null,
  text: 'Madame, Monsieur, nous sollicitons une subvention pour le projet de bibliothèque municipale.',
};
export const MAIL_5000: PlannerMailView = {
  mailId: 5000,
  reference: 'CE/2026/0100',
  title: 'Facture fournisseur',
  date: '2026-11-10',
  senderLabel: 'Société Alpha',
  natureLabel: 'Facture',
  objetLabel: null,
  confidentialiteLabel: null,
  text: 'Veuillez trouver ci-joint notre facture n° F-2026-77.',
};

function actor(userGroupId: number, label: string, roleName: string | null = null, organigrammeLabel: string | null = null): PlannerActorView {
  return { userGroupId, label, roleName, organigrammeLabel };
}
export const ACTOR_AWA = actor(31, 'Awa Diallo — DAF', 'Directrice administrative et financière', 'DAF');
export const ACTOR_MOUSSA = actor(32, 'Moussa Keita — DAF', 'Comptable', 'DAF');
export const ACTOR_FATOU = actor(33, 'Fatou Ndiaye — DRH', 'Responsable RH', 'DRH');
export const ACTOR_DG = actor(34, 'Ibrahima Sow — Direction générale', 'Directeur général', 'DG');
export const ACTOR_PIEGE = actor(99, 'Jean Piège — Externe', null, null);

export const PLANNER_TEST_TYPES: PlannerInputationTypeView[] = [
  { id: MAIL_INPUTATION_TYPE_IDS.validationDG, label: 'Validation DG', suivi: false },
  { id: MAIL_INPUTATION_TYPE_IDS.pourSuivi, label: 'Pour suivi', suivi: true },
  { id: MAIL_INPUTATION_TYPE_IDS.validationDirection, label: 'Validation Direction', suivi: false },
  { id: MAIL_INPUTATION_TYPE_IDS.enCopie, label: 'En copie', suivi: false },
];

/** Imputation stockée (le retard est recalculé à la lecture, à l'instant fourni). */
export type StoredInputation = Omit<PlannerInputationView, 'late'>;

/** Imputation 55 : Awa (DAF), Validation Direction, échéance dépassée. */
export const INP_AWA_LATE: StoredInputation = {
  mailInputationId: 55,
  mailId: 4321,
  actorUserGroupId: 31,
  actorLabel: ACTOR_AWA.label,
  actorActive: true,
  typeId: MAIL_INPUTATION_TYPE_IDS.validationDirection,
  typeLabel: 'Validation Direction',
  deadline: new Date('2026-11-20T08:00:00Z'),
  treated: false,
  createdBy: 10,
};
/** Imputation 57 : Fatou (DRH), pour suivi, échéance NON dépassée. */
export const INP_FATOU_ON_TIME: StoredInputation = {
  mailInputationId: 57,
  mailId: 4321,
  actorUserGroupId: 33,
  actorLabel: ACTOR_FATOU.label,
  actorActive: true,
  typeId: MAIL_INPUTATION_TYPE_IDS.pourSuivi,
  typeLabel: 'Pour suivi',
  deadline: new Date('2026-11-30T08:00:00Z'),
  treated: false,
  createdBy: 10,
};

export const PLANNER_TEST_TEMPLATES: PlannerDraftTemplateView[] = [
  { id: 'accuse-reception', label: 'Accusé de réception' },
  { id: 'reponse-standard', label: 'Réponse standard' },
];

export interface PlannerDataFixture {
  mails: PlannerMailView[];
  /** Courriers lisibles par l'utilisateur (`null` = tous). */
  readableMailIds: number[] | null;
  /** Acteurs imputables par l'utilisateur. */
  actors: PlannerActorView[];
  /** Acteurs dont le compte est inactif (jamais résolus comme imputables). */
  inactiveActorIds: number[];
  types: PlannerInputationTypeView[];
  inputations: StoredInputation[];
  mayImpute: boolean;
  templates: PlannerDraftTemplateView[];
  spaces: PlannerSpaceView[];
  /** Résultats imposés d'une recherche (clé : texte cherché en minuscules) ; sinon recherche dans l'objet et la référence. */
  searchHits: Record<string, number[]>;
  /** Relances du jour par `courrier:destinataire`. */
  relancesToday: Record<string, number>;
  draftResult: PlannerDraftResult;
}

export function defaultPlannerFixture(): PlannerDataFixture {
  return {
    mails: [{ ...MAIL_4321 }, { ...MAIL_5000 }],
    readableMailIds: null,
    actors: [ACTOR_AWA, ACTOR_FATOU, ACTOR_DG, ACTOR_PIEGE].map((a) => ({ ...a })),
    inactiveActorIds: [],
    types: PLANNER_TEST_TYPES.map((t) => ({ ...t })),
    inputations: [{ ...INP_AWA_LATE }, { ...INP_FATOU_ON_TIME }],
    mayImpute: true,
    templates: PLANNER_TEST_TEMPLATES.map((t) => ({ ...t })),
    spaces: [{ spaceId: 7, label: 'Espace Juridique' }],
    searchHits: {},
    relancesToday: {},
    draftResult: { status: 'ok', draftHtml: '<p>Madame, Monsieur,</p><p>Nous accusons réception de votre courrier.</p>', decisionId: '777' },
  };
}

// ---------------------------------------------------------------------------------------------
// Port de données en mémoire (LECTURE SEULE)
// ---------------------------------------------------------------------------------------------

/** Méthodes du port de données : toutes de LECTURE (plus la génération budgétée d'un brouillon, sans écriture). */
export const PLANNER_DATA_METHODS = [
  'readMail',
  'searchMails',
  'listActors',
  'listInputationTypes',
  'listInputations',
  'canImpute',
  'resolveImputableActor',
  'getActiveInputationType',
  'hasOpenImputation',
  'readInputation',
  'countTargetRelancesToday',
  'listDraftTemplates',
  'listWritableSpaces',
  'generateDraft',
] as const;

export class InMemoryPlannerData implements AsstPlannerDataPort {
  /** Journal des appels : méthode et utilisateur (null pour les méthodes sans utilisateur). */
  readonly calls: Array<{ method: string; userId: number | null }> = [];
  readonly draftRequests: Array<{ templateId: string; instruction: string; mailId?: number; requestedBy: number }> = [];
  readonly fixture: PlannerDataFixture;

  constructor(fixture: Partial<PlannerDataFixture> = {}) {
    this.fixture = { ...defaultPlannerFixture(), ...fixture };
  }

  get draftCalls(): number {
    return this.draftRequests.length;
  }

  countOf(method: string): number {
    return this.calls.filter((c) => c.method === method).length;
  }

  private track(method: string, user: AuthUser | null): void {
    this.calls.push({ method, userId: user ? user.userId : null });
  }

  private readable(mailId: number): PlannerMailView | null {
    const f = this.fixture;
    if (f.readableMailIds !== null && !f.readableMailIds.includes(mailId)) return null;
    return f.mails.find((m) => m.mailId === mailId) ?? null;
  }

  private view(i: StoredInputation, now: Date): PlannerInputationView {
    const late = !i.treated && i.deadline !== null && i.deadline.getTime() < now.getTime();
    return { ...i, late };
  }

  async readMail(user: AuthUser, mailId: number, maxChars: number): Promise<PlannerMailView | null> {
    this.track('readMail', user);
    const m = this.readable(mailId);
    if (!m) return null;
    const text = m.text === null ? null : Array.from(m.text).slice(0, Math.max(0, maxChars)).join('');
    return { ...m, text: maxChars > 0 ? text : null };
  }

  async searchMails(user: AuthUser, query: string, limit: number): Promise<PlannerMailHit[]> {
    this.track('searchMails', user);
    const forced = this.fixture.searchHits[query.trim().toLowerCase()];
    const q = foldText(query).trim();
    const ids = forced ?? this.fixture.mails.filter((m) => foldText(`${m.title ?? ''} ${m.reference ?? ''}`).includes(q)).map((m) => m.mailId);
    const hits: PlannerMailHit[] = [];
    for (const id of ids) {
      const m = this.readable(id);
      if (m) hits.push({ mailId: m.mailId, reference: m.reference, title: m.title, date: m.date, senderLabel: m.senderLabel });
    }
    return hits.slice(0, limit);
  }

  async listActors(user: AuthUser, opts: { search?: string; limit: number }): Promise<PlannerActorView[]> {
    this.track('listActors', user);
    if (!this.fixture.mayImpute) return [];
    const s = opts.search ? foldText(opts.search).trim() : '';
    return this.fixture.actors
      .filter((a) => !s || foldText(`${a.label} ${a.roleName ?? ''} ${a.organigrammeLabel ?? ''}`).includes(s))
      .slice(0, opts.limit)
      .map((a) => ({ ...a }));
  }

  async listInputationTypes(): Promise<PlannerInputationTypeView[]> {
    this.track('listInputationTypes', null);
    return this.fixture.types.map((t) => ({ ...t }));
  }

  async listInputations(user: AuthUser, mailId: number, now: Date, limit: number): Promise<PlannerInputationView[] | null> {
    this.track('listInputations', user);
    if (!this.readable(mailId)) return null;
    return this.fixture.inputations
      .filter((i) => i.mailId === mailId)
      .slice(0, limit)
      .map((i) => this.view(i, now));
  }

  async canImpute(user: AuthUser): Promise<boolean> {
    this.track('canImpute', user);
    return this.fixture.mayImpute;
  }

  async resolveImputableActor(user: AuthUser, userGroupId: number): Promise<{ userGroupId: number; label: string } | null> {
    this.track('resolveImputableActor', user);
    if (!this.fixture.mayImpute || this.fixture.inactiveActorIds.includes(userGroupId)) return null;
    const a = this.fixture.actors.find((x) => x.userGroupId === userGroupId);
    return a ? { userGroupId: a.userGroupId, label: a.label } : null;
  }

  async getActiveInputationType(typeId: number): Promise<PlannerInputationTypeView | null> {
    this.track('getActiveInputationType', null);
    const t = this.fixture.types.find((x) => x.id === typeId);
    return t ? { ...t } : null;
  }

  async hasOpenImputation(mailId: number, userGroupId: number, typeId: number): Promise<boolean> {
    this.track('hasOpenImputation', null);
    return this.fixture.inputations.some(
      (i) => i.mailId === mailId && i.actorUserGroupId === userGroupId && i.typeId === typeId && !i.treated,
    );
  }

  async readInputation(user: AuthUser, mailId: number, mailInputationId: number, now: Date): Promise<PlannerInputationView | null> {
    this.track('readInputation', user);
    if (!this.readable(mailId)) return null;
    const i = this.fixture.inputations.find((x) => x.mailInputationId === mailInputationId && x.mailId === mailId);
    return i ? this.view(i, now) : null;
  }

  async countTargetRelancesToday(mailId: number, recipientUserGroupId: number): Promise<number> {
    this.track('countTargetRelancesToday', null);
    return this.fixture.relancesToday[`${mailId}:${recipientUserGroupId}`] ?? 0;
  }

  listDraftTemplates(): PlannerDraftTemplateView[] {
    this.track('listDraftTemplates', null);
    return this.fixture.templates.map((t) => ({ ...t }));
  }

  async listWritableSpaces(user: AuthUser, limit: number): Promise<PlannerSpaceView[]> {
    this.track('listWritableSpaces', user);
    return this.fixture.spaces.slice(0, limit).map((s) => ({ ...s }));
  }

  async generateDraft(
    user: AuthUser,
    request: { templateId: string; instruction: string; mailId?: number },
    requestedBy: number,
  ): Promise<PlannerDraftResult> {
    this.track('generateDraft', user);
    this.draftRequests.push({ ...request, requestedBy });
    return { ...this.fixture.draftResult };
  }
}

// ---------------------------------------------------------------------------------------------
// Faux modèle scripté
// ---------------------------------------------------------------------------------------------

/** Étape « IA désactivée » (`AiService.run` renvoie `{ disabled: true }`). */
export const AI_DISABLED_STEP: unique symbol = Symbol('ia-desactivee');

/** Une étape : tour brut (texte JSON ou objet sérialisé), erreur levée, IA désactivée, ou fonction du prompt reçu. */
export type FakeModelStep =
  | string
  | Record<string, unknown>
  | Error
  | typeof AI_DISABLED_STEP
  | ((prompt: FakeModelPrompt, index: number) => string | Record<string, unknown> | Error);

export interface FakeModelPrompt {
  system: string;
  text: string;
  /** Jeton de l'appel, relu dans la balise du message utilisateur. */
  nonce: string | null;
  promptVersion: string | undefined;
  requestedBy: number | null | undefined;
  hasAttachments: boolean;
}

/** Faux `AiService` : rejoue un script, applique `parse` comme le vrai, renvoie des jetons réels configurables. */
export class FakeAiService {
  readonly prompts: FakeModelPrompt[] = [];
  readonly steps: FakeModelStep[];
  tokens: { promptTokens: number | null; completionTokens: number | null } = { promptTokens: 150, completionTokens: 40 };
  private decision = 9000n;

  constructor(steps: FakeModelStep[] = []) {
    this.steps = [...steps];
  }

  get calls(): number {
    return this.prompts.length;
  }

  async run<T>(opts: AiRunOptions<T>): Promise<AiRunResult<T>> {
    const nonce = /<<MESSAGE_UTILISATEUR ([A-Z]+)>>/.exec(opts.request.text)?.[1] ?? null;
    const prompt: FakeModelPrompt = {
      system: opts.request.system,
      text: opts.request.text,
      nonce,
      promptVersion: opts.promptVersion,
      requestedBy: opts.requestedBy,
      hasAttachments: (opts.request.attachments ?? []).length > 0,
    };
    this.prompts.push(prompt);
    let step = this.steps.shift();
    if (step === undefined) throw new AiProviderError('Script du faux modèle épuisé.');
    if (typeof step === 'function') step = step(prompt, this.prompts.length - 1);
    if (step === AI_DISABLED_STEP) return { disabled: true, message: 'IA désactivée.' };
    if (step instanceof Error) throw step;
    const raw = typeof step === 'string' ? step : JSON.stringify(step);
    const data = opts.parse(raw); // comme le vrai service : une sortie inexploitable lève l'erreur de `parse`
    this.decision += 1n;
    return {
      disabled: false,
      data,
      decisionId: this.decision,
      status: GedAiDecisionStatus.Proposee,
      confidence: null,
      provider: 'faux',
      model: 'faux-modele',
      promptTokens: this.tokens.promptTokens,
      completionTokens: this.tokens.completionTokens,
    };
  }
}

/** Constructeurs de tours bruts du modèle. */
export const T = {
  tool: (tool: string, args: Record<string, unknown> = {}): Record<string, unknown> => ({ type: 'tool_call', tool, arguments: args }),
  propose: (
    actions: Array<{ tool: string; args: Record<string, unknown> }>,
    o: { intentSource?: string; suspicion?: boolean } = {},
  ): Record<string, unknown> => ({
    type: 'propose',
    actions,
    intent_source: o.intentSource ?? 'message_utilisateur',
    suspicion: o.suspicion ?? false,
  }),
  answer: (text: string): Record<string, unknown> => ({ type: 'answer', text }),
  clarify: (question: string, choices: string[]): Record<string, unknown> => ({
    type: 'clarify',
    question,
    choices: choices.map((label) => ({ label })),
  }),
};

// ---------------------------------------------------------------------------------------------
// Portes de coût en mémoire
// ---------------------------------------------------------------------------------------------

export type FakeGateEvent =
  | { op: 'assert'; userId: number }
  | { op: 'reserve'; id: string; usage: AgentUsage }
  | { op: 'settle'; id: string; usage: AgentUsage }
  | { op: 'release'; id: string };

export class FakeAsstGate implements AsstGatePort {
  readonly events: FakeGateEvent[] = [];
  /** Erreur levée par `assertRunnable` (ex. `AsstError('budget_exceeded')`). */
  assertError: Error | null = null;
  /** Erreur levée par la n-ième réservation (1 = la première) ; `null` = jamais. */
  reserveErrorAt: { at: number; error: Error } | null = null;
  /** Opérations invalides (règlement ou libération d'une réservation inconnue ou déjà soldée). */
  invalidOps = 0;
  private seq = 0;
  private readonly open = new Map<string, AsstReservation>();

  get reserves(): number {
    return this.events.filter((e) => e.op === 'reserve').length;
  }
  get settles(): number {
    return this.events.filter((e) => e.op === 'settle').length;
  }
  get releases(): number {
    return this.events.filter((e) => e.op === 'release').length;
  }
  get openCount(): number {
    return this.open.size;
  }

  async assertRunnable(userId: number): Promise<void> {
    this.events.push({ op: 'assert', userId });
    if (this.assertError) throw this.assertError;
  }

  async reserve(userId: number, estimate: AgentUsage): Promise<AsstReservation> {
    const n = this.reserves + 1;
    if (this.reserveErrorAt && this.reserveErrorAt.at === n) {
      this.events.push({ op: 'reserve', id: 'refusee', usage: { ...estimate } });
      throw this.reserveErrorAt.error;
    }
    const id = `r${++this.seq}`;
    const r: AsstReservation = { id, userId, reserved: { ...estimate }, globalReservationId: `g${this.seq}` };
    this.open.set(id, r);
    this.events.push({ op: 'reserve', id, usage: { ...estimate } });
    return r;
  }

  async settle(reservation: AsstReservation, actual: AgentUsage): Promise<void> {
    if (!this.open.delete(reservation.id)) this.invalidOps++;
    this.events.push({ op: 'settle', id: reservation.id, usage: { ...actual } });
  }

  async release(reservation: AsstReservation): Promise<void> {
    if (!this.open.delete(reservation.id)) this.invalidOps++;
    this.events.push({ op: 'release', id: reservation.id });
  }

  async userCap(): Promise<AsstUserCap> {
    return { capAmount: null, capTokens: null, consumedAmount: 0, consumedTokens: 0 };
  }
}

/** Porte des agents réduite au TARIF (`costOf`) : toute autre méthode lève (le planificateur ne doit pas s'en servir). */
export class FakeWfCostGate implements WfAgentGate {
  costCalls = 0;
  async assertRunnable(): Promise<void> {
    throw new Error('WfAgentGate.assertRunnable ne doit pas être appelée par le planificateur.');
  }
  async reserve(): Promise<AgentReservation> {
    throw new Error('WfAgentGate.reserve ne doit pas être appelée par le planificateur.');
  }
  async settle(): Promise<void> {
    throw new Error('WfAgentGate.settle ne doit pas être appelée par le planificateur.');
  }
  async release(): Promise<void> {
    throw new Error('WfAgentGate.release ne doit pas être appelée par le planificateur.');
  }
  costOf(tokens: { promptTokens: number; completionTokens: number }): number {
    this.costCalls++;
    return tokens.promptTokens * 0.001 + tokens.completionTokens * 0.002;
  }
}

// ---------------------------------------------------------------------------------------------
// Registre d'applicateurs minimal (schémas réels du catalogue, sans effet)
// ---------------------------------------------------------------------------------------------

function minimalApplier<A>(toolKey: string, schema: Parameters<typeof parseStrict<A>>[0]): ActionApplier<A> {
  return {
    toolKey,
    sideEffect: 1,
    parse: (args: unknown) => parseStrict(schema, args, toolKey),
    apply: async () => {
      throw new Error('Aucun effet ne doit être appliqué par le planificateur.');
    },
  };
}

export function makePlannerTestRegistry(): ActionApplierRegistry {
  const registry = new ActionApplierRegistry();
  registry.register(minimalApplier(AsstActionTool.ImputationCourrier, imputationCourrierArgsSchema) as ActionApplier);
  registry.register(minimalApplier(AsstActionTool.Relance, relanceArgsSchema) as ActionApplier);
  registry.register(minimalApplier(AsstActionTool.BrouillonReponse, brouillonReponseArgsSchema) as ActionApplier);
  return registry;
}

// ---------------------------------------------------------------------------------------------
// Assemblage
// ---------------------------------------------------------------------------------------------

export interface PlannerHarness {
  service: AsstPlannerService;
  ai: FakeAiService;
  gate: FakeAsstGate;
  wfGate: FakeWfCostGate;
  data: InMemoryPlannerData;
  identity: AsstIdentity;
  /** Entrée de `plan` pour ce message (contexte de page par défaut : courrier 4321). */
  input(message: string, over?: Partial<Omit<AsstPlanInput, 'message'>>): AsstPlanInput;
}

export function createPlannerHarness(
  opts: { steps?: FakeModelStep[]; fixture?: Partial<PlannerDataFixture>; now?: Date } = {},
): PlannerHarness {
  const ai = new FakeAiService(opts.steps ?? []);
  const gate = new FakeAsstGate();
  const wfGate = new FakeWfCostGate();
  const data = new InMemoryPlannerData(opts.fixture ?? {});
  const validator = new AsstActionValidatorService(data, makePlannerTestRegistry());
  const service = new AsstPlannerService(ai as unknown as AiService, gate, wfGate, data, validator);
  const now = opts.now ?? PLANNER_TEST_NOW;
  service.now = () => new Date(now.getTime());
  const identity = makeAsstIdentity(1); // userId 1, userGroupId 10
  return {
    service,
    ai,
    gate,
    wfGate,
    data,
    identity,
    input: (message, over = {}) => ({
      identity,
      conversationId: '00000000-0000-4000-8000-000000000001',
      message,
      pageContext: PAGE_MAIL_4321,
      history: [],
      ...over,
    }),
  };
}

/** Motif d'imputation que le validateur construit à partir du message de l'utilisateur. */
export function expectedRationale(userMessage: string): string {
  return `Demande de l'utilisateur (assistant) : « ${userMessage} »`;
}

/** Action d'imputation attendue (un destinataire). */
export function expectedImputation(
  mailId: number,
  userGroupId: number,
  userMessage: string,
  o: { typeId?: number; delayDays?: number | null } = {},
): AsstProposedAction {
  const typeId = o.typeId ?? MAIL_INPUTATION_TYPE_IDS.pourSuivi;
  const delay = o.delayDays === undefined ? null : o.delayDays;
  return {
    tool: AsstActionTool.ImputationCourrier,
    args: {
      mailId,
      recipients: [{ userGroupId, mailInputationTypeId: typeId, ...(delay !== null ? { delayDays: delay } : {}) }],
      rationale: expectedRationale(userMessage),
    },
  } as AsstProposedAction;
}
