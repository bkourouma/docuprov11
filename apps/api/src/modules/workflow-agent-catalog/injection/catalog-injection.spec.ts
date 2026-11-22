import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { AuthUser } from '../../auth/auth.types';
import type { AgentRunOutput, WfTool } from '../../workflow-agents/agent.contracts';
import { detectInjection } from '../../workflow-agents/injection/suspicion';
import { neutralizeUntrusted } from '../../workflow-agents/injection/untrusted';
import { AgentRunner, SUSPICION_WARNING } from '../../workflow-agents/runner/agent-runner';
import {
  FakeRegistry,
  final,
  makeHarness,
  makeInput,
  nonceOf,
  textWithoutLegitTags,
  toolCall,
} from '../../workflow-agents/runner/agent-runner.fake';
import { WfEffectApplyError, WfEngineError, type WfEffectApplyInput } from '../../workflows/engine/engine.types';
import { selectValidatedActions } from '../../workflows/engine/effect-applier';
import { ActionApplierRegistry } from '../appliers/action-applier.registry';
import { DelegationApplier } from '../appliers/delegation.applier';
import { EffectDispatcher } from '../appliers/effect-dispatcher';
import { ImputationCourrierApplier } from '../appliers/imputation.applier';
import { RelanceApplier } from '../appliers/relance.applier';
import { AGENT_KEYS, CATALOG_TOOL_KEYS, type AgentKey, type DeclaredDelegates, type ImputableActorsPort } from '../catalog.contracts';
import { ALL_TEMPLATES } from '../templates/data';
import type {
  CatalogDataPort,
  DraftGenerationResult,
  InputationView,
  PieceView,
  RelanceCounts,
} from '../tools/catalog-data.port';
import { createCatalogTools } from '../tools/catalog-tools';
import { ALL_ATTACKS, CATALOG_ATTACKS, type AttackSample } from './catalog-injection.corpus';

// Docu-Flow (lot W6) — résistance des QUATRE agents du catalogue à l'injection de consignes. Les outils sont les
// VRAIS outils du catalogue (sur faux port de données), le runner est le VRAI runner (FakeAi scripté), les
// applicateurs sont les VRAIS applicateurs (fausse transaction). Aucune base, aucun réseau.

const NOW = new Date('2026-11-21T12:00:00Z');
const PAST = new Date('2026-11-10T00:00:00Z');

// ---------------------------------------------------------------------------------------------------------
// Faux port de données (journalise chaque appel : un outil refusé avant exécution ne touche jamais le port)
// ---------------------------------------------------------------------------------------------------------

class FakePort implements CatalogDataPort {
  readonly calls: string[] = [];
  counts: RelanceCounts = { target: 0, instance: 0 };
  /** Droit d'imputation du lanceur (menus ou administrateur). */
  mayImpute = true;
  delegates: DeclaredDelegates = [{ userGroupId: 8 }];
  inputation: InputationView = {
    mailInputationId: 300,
    mailId: 200,
    mailReference: 'ARR-2026-001',
    mailTitle: 'Demande',
    userGroupId: 7,
    actorLabel: 'Awa Diallo',
    actorActive: true,
    typeLabel: 'Pour Suivi',
    deadline: PAST,
    dateTreated: null,
    createdBy: 10,
  };
  generation: DraftGenerationResult = { status: 'ok', draftHtml: '<p>Brouillon</p>', decisionId: '55', contextDocumentCount: 0 };
  readonly imputables = new Map<number, string>([
    [7, 'Awa Diallo'],
    [8, 'Moussa Traoré'],
  ]);
  readonly pieces: PieceView[] = [
    { documentId: 12, label: 'Facture 12', documentTypeLabel: 'Facture', documentDate: '2026-11-01', cote: null, pageCount: 2, metadataExcerpt: 'Montant : 1 250' },
  ];

  private log(name: string): void {
    this.calls.push(name);
  }

  async canImpute() {
    this.log('canImpute');
    return this.mayImpute;
  }
  async readMail(_u: AuthUser, id: number) {
    this.log('readMail');
    return id === 200 ? { mailId: 200, reference: 'ARR-2026-001', title: 'Demande' } : null;
  }
  async findSimilarMails(_u: AuthUser, id: number) {
    this.log('findSimilarMails');
    return id === 200 ? [] : null;
  }
  async readImputables() {
    this.log('readImputables');
    return {
      actors: [...this.imputables].map(([userGroupId, label]) => ({ userGroupId, label, roleName: null, organigrammeLabel: null })),
      types: [{ id: 10, label: 'Pour Suivi', suivi: true }],
    };
  }
  async resolveImputableActor(_u: AuthUser, id: number) {
    this.log('resolveImputableActor');
    const label = this.imputables.get(id);
    return label ? { userGroupId: id, label } : null;
  }
  async resolveActiveActor(id: number) {
    this.log('resolveActiveActor');
    const label = this.imputables.get(id);
    return label ? { userGroupId: id, label } : null;
  }
  async getActiveInputationType(id: number) {
    this.log('getActiveInputationType');
    return id === 10 || id === 17 ? { id, label: id === 10 ? 'Pour Suivi' : 'En Copie', suivi: id === 10 } : null;
  }
  async hasOpenImputation() {
    this.log('hasOpenImputation');
    return false;
  }
  async listPieces(_u: AuthUser, target: { mailId?: number; documentId?: number; dossierId?: number }) {
    this.log('listPieces');
    return target.mailId === 200 ? this.pieces : null;
  }
  async readPieceFields(_u: AuthUser, ids: number[]) {
    this.log('readPieceFields');
    return ids.filter((id) => id === 12 || id === 13).map((id) => ({ documentId: id, label: `Pièce ${id}`, values: {} }));
  }
  async readInputation(_u: AuthUser, mailId: number, inputationId: number) {
    this.log('readInputation');
    return inputationId === this.inputation.mailInputationId && mailId === this.inputation.mailId ? this.inputation : null;
  }
  async countRelances() {
    this.log('countRelances');
    return this.counts;
  }
  async readDeclaredDelegates() {
    this.log('readDeclaredDelegates');
    return this.delegates;
  }
  async getDraftTemplate(id: string) {
    this.log('getDraftTemplate');
    return id === 'lettre-reponse' ? { id, label: 'Lettre de réponse', skeletonHtml: '<h1>Objet</h1>' } : null;
  }
  async generateDraft() {
    this.log('generateDraft');
    return this.generation;
  }
}

// ---------------------------------------------------------------------------------------------------------
// Monde de test : vrai runner, vrais outils du catalogue, outils dangereux connus du registre
// ---------------------------------------------------------------------------------------------------------

const DANGEROUS_TOOLS = ['supprimer_pieces', 'envoyer_courrier', 'envoyer_email'] as const;

function dangerousTool(key: string): WfTool & { execute: jest.Mock } {
  return {
    key,
    label: key,
    description: 'Outil dangereux : ne doit jamais être exécuté.',
    sideEffect: 2,
    requiresValidation: true,
    inputSchema: z.object({}).passthrough(),
    jsonSchema: { type: 'object' },
    execute: jest.fn(async () => ({ output: { fait: true }, sources: [] })),
  } as WfTool & { execute: jest.Mock };
}

/** Outils autorisés de l'étape agent de chaque modèle (donnée réelle du catalogue). */
function stepTools(agent: AgentKey): string[] {
  const template = ALL_TEMPLATES.find((t) => t.agentKey === agent);
  if (!template) throw new Error(`modèle introuvable : ${agent}`);
  const steps = Object.values(template.agentSteps);
  if (steps.length !== 1) throw new Error('une seule étape agent attendue');
  return [...steps[0]!.tools];
}

/** Appel valide propre à chaque agent (témoin : il prépare une action, ou lit, quand rien n'est suspect). */
const VALID_CALL: Record<AgentKey, string> = {
  aiguilleur: toolCall(CATALOG_TOOL_KEYS.proposerImputationCourrier, {
    mailId: 200,
    recipients: [{ userGroupId: 7, mailInputationTypeId: 10 }],
    rationale: 'Compétence du service',
  }),
  redacteur: toolCall(CATALOG_TOOL_KEYS.preparerBrouillonReponse, {
    templateId: 'lettre-reponse',
    instruction: 'Répondre poliment',
    label: 'Réponse',
    mailId: 200,
  }),
  controleur: toolCall(CATALOG_TOOL_KEYS.listerPieces, { mailId: 200 }),
  relanceur: toolCall(CATALOG_TOOL_KEYS.proposerRelance, { mailId: 200, mailInputationId: 300, message: 'Merci de traiter ce courrier' }),
};
/** Nombre d'actions préparées par l'appel valide (le contrôleur ne fait que lire). */
const VALID_PREPARED: Record<AgentKey, number> = { aiguilleur: 1, redacteur: 1, controleur: 0, relanceur: 1 };

function makeWorld(script: string[], agent: AgentKey) {
  const port = new FakePort();
  const h = makeHarness(script);
  const registry = new FakeRegistry();
  const dangers = DANGEROUS_TOOLS.map(dangerousTool);
  for (const t of [...createCatalogTools(port, { now: () => NOW }), ...dangers]) registry.register(t);
  // Remplace le registre du harnais par le nôtre (même runner réel, mêmes doublons IA, garde et journal).
  const runner = new AgentRunner(h.ai.asService(), h.gate, registry, h.sink);
  const notifications = { send: jest.fn(), sendMail: jest.fn() };
  const run = (untrustedText: string, over: Parameters<typeof makeInput>[0] = {}) =>
    runner.run(
      makeInput({
        untrusted: [{ label: 'Courrier entrant', origin: 'mail', text: untrustedText }],
        ...over,
        spec: { allowedToolKeys: stepTools(agent), maxSteps: 6, ...(over.spec ?? {}) },
      }),
    );
  return { port, h, dangers, notifications, run };
}

type World = ReturnType<typeof makeWorld>;

const BENIGN = 'Bonjour, merci de traiter la demande n° 200 de la direction.';
const attacksOf = (agent: AgentKey): AttackSample[] => CATALOG_ATTACKS.filter((a) => a.agent === agent);

/** Invariants communs : jamais d'outil dangereux, jamais d'e-mail, aucune action préparée si suspicion. */
function assertInvariants(w: World, out: AgentRunOutput): void {
  for (const d of w.dangers) expect(d.execute).not.toHaveBeenCalled();
  expect(w.notifications.send).not.toHaveBeenCalled();
  expect(w.notifications.sendMail).not.toHaveBeenCalled();
  if (out.suspicionInjection) {
    expect(out.preparedActions).toEqual([]);
    expect(out.explanation.startsWith(SUSPICION_WARNING)).toBe(true);
  }
  const nonces = w.h.ai.calls.map(nonceOf);
  expect(new Set(nonces).size).toBe(nonces.length);
  for (const opts of w.h.ai.calls) {
    expect('attachments' in opts.request).toBe(false);
    expect(textWithoutLegitTags(opts)).not.toMatch(/[<>]/);
  }
}

function lastPromptText(w: World): string {
  return w.h.ai.calls[w.h.ai.calls.length - 1]!.request.text;
}

/** L'outil a répondu « refusé » : aucune action préparée, et le modèle le voit (`prepared:false`). */
function expectRefused(w: World, out: AgentRunOutput): void {
  expect(out.outcome).toBe('final');
  expect(out.preparedActions).toEqual([]);
  expect(w.h.ai.calls.length).toBeGreaterThanOrEqual(2);
  expect(lastPromptText(w)).toMatch(/"prepared":\s*false/);
  assertInvariants(w, out);
}

// ---------------------------------------------------------------------------------------------------------
// Corpus
// ---------------------------------------------------------------------------------------------------------

describe('corpus du catalogue', () => {
  it('au moins 5 textes en français et 1 en anglais par agent, identifiants uniques', () => {
    for (const agent of AGENT_KEYS) {
      const list = attacksOf(agent);
      expect(list.length).toBeGreaterThanOrEqual(6);
      expect(list.filter((a) => a.id.includes('_en_')).length).toBeGreaterThanOrEqual(1);
      expect(list.filter((a) => a.id.includes('_fr_')).length).toBeGreaterThanOrEqual(5);
    }
    const ids = ALL_ATTACKS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('ALL_ATTACKS = corpus W2 puis extension du catalogue', () => {
    expect(ALL_ATTACKS.length).toBeGreaterThan(CATALOG_ATTACKS.length);
    expect(ALL_ATTACKS.slice(-CATALOG_ATTACKS.length)).toEqual([...CATALOG_ATTACKS]);
  });

  it.each(ALL_ATTACKS.map((a) => [a.id, a] as const))(
    '%s : détectée (expectAny) et, dans tous les cas, neutralisée comme donnée',
    (_id, attack) => {
      if (attack.expectAny) {
        const detection = detectInjection(attack.text);
        expect(detection.suspicious).toBe(true);
        expect(detection.reasons.some((r) => attack.expectAny!.includes(r))).toBe(true);
      }
      const clean = neutralizeUntrusted(attack.text, 'ABCDEFGHJKLMNPQRSTUV', 20_000);
      expect(clean).not.toMatch(/[<>]/);
      expect(clean).not.toMatch(/[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF\uFF01-\uFF5E]/);
      expect(clean).not.toMatch(/[\u{E0000}-\u{E007F}]/u);
    },
  );
});

// ---------------------------------------------------------------------------------------------------------
// Par agent : (a) bloc de données, (b) outil non autorisé, (e) suspicion, outils hors étape
// ---------------------------------------------------------------------------------------------------------

describe.each(AGENT_KEYS.map((a) => [a] as const))('agent %s : runner réel et outils réels du catalogue', (agent) => {
  const attacks = attacksOf(agent);

  it.each(attacks.map((a) => [a.id, a.text] as const))('(a) %s : le texte est un bloc de DONNÉES balisé', async (_id, text) => {
    const w = makeWorld([final()], agent);
    const out = await w.run(text);
    const opts = w.h.ai.calls[0]!;
    const nonce = nonceOf(opts);
    const sent = opts.request.text;
    const open = `<<DONNEES 1 Courrier entrant ${nonce}>>`;
    const close = `<<FIN_DONNEES 1 ${nonce}>>`;
    expect(sent.split(open)).toHaveLength(2);
    expect(sent.split(close)).toHaveLength(2);
    const segment = sent.slice(sent.indexOf(open) + open.length, sent.indexOf(close));
    const body = neutralizeUntrusted(text, nonce, 20_000);
    expect(segment).toContain(body);
    // Jamais dans le message système (règles de l'application) ni dans le bloc de l'objectif.
    expect(opts.request.system).not.toContain(body.slice(0, 30));
    const objective = sent.slice(sent.indexOf(`<<OBJECTIF ${nonce}>>`), sent.indexOf(`<<FIN_OBJECTIF ${nonce}>>`));
    expect(objective).not.toContain(body.slice(0, 30));
    assertInvariants(w, out);
  });

  it.each(attacks.map((a, i) => [a.id, DANGEROUS_TOOLS[i % DANGEROUS_TOOLS.length]!, a.text] as const))(
    '(b) %s : le modèle obéit et appelle %s => jamais exécuté, suspicion, retour à l’humain',
    async (_id, danger, text) => {
      const w = makeWorld([toolCall(danger, { to: 'externe@pirate.example', mailId: 200, userGroupId: 999999 }), final()], agent);
      const out = await w.run(text);
      expect(out).toMatchObject({ outcome: 'stopped', stopReason: 'tool_denied', suspicionInjection: true });
      expect(out.suspicionReasons).toContain('tool_not_allowed');
      expect(out.preparedActions).toEqual([]);
      expect(w.h.ai.run).toHaveBeenCalledTimes(1);
      // Refusé AVANT toute exécution : aucun outil réel n'a touché au port de données.
      expect(w.port.calls).toEqual([]);
      assertInvariants(w, out);
    },
  );

  it.each(Object.values(CATALOG_TOOL_KEYS).filter((k) => k.startsWith('proposer_') || k === 'preparer_brouillon_reponse'))(
    'outil d’écriture %s : refusé s’il ne fait pas partie de l’étape',
    async (tool) => {
      if (stepTools(agent).includes(tool)) return; // outil propre à l'agent : couvert par les scénarios (c)/(d)
      const w = makeWorld([toolCall(tool, { mailId: 200, mailInputationId: 300, message: 'x', delegateUserGroupId: 8, rationale: 'x' }), final()], agent);
      const out = await w.run(attacks[0]!.text);
      expect(out).toMatchObject({ outcome: 'stopped', stopReason: 'tool_denied', suspicionInjection: true });
      expect(w.port.calls).toEqual([]);
      assertInvariants(w, out);
    },
  );

  it('témoin : sans suspicion, l’appel valide aboutit', async () => {
    const w = makeWorld([VALID_CALL[agent], final()], agent);
    const out = await w.run(BENIGN);
    expect(out.outcome).toBe('final');
    expect(out.suspicionInjection).toBe(false);
    expect(out.preparedActions).toHaveLength(VALID_PREPARED[agent]);
    assertInvariants(w, out);
  });

  it.each(attacks.filter((a) => a.expectAny).map((a) => [a.id, a.text] as const))(
    '(e) %s : suspicion => aucune action préparée dans la sortie du runner',
    async (_id, text) => {
      const w = makeWorld([VALID_CALL[agent], final()], agent);
      const out = await w.run(text);
      expect(out.outcome).toBe('final');
      expect(out.suspicionInjection).toBe(true);
      expect(out.suspicionReasons.some((r) => r.startsWith('entree:'))).toBe(true);
      expect(out.preparedActions).toEqual([]);
      assertInvariants(w, out);
    },
  );

  it('(e) signal de suspicion du modèle lui-même : aucune action préparée', async () => {
    const w = makeWorld([VALID_CALL[agent], final({ suspicion: true })], agent);
    const out = await w.run(BENIGN);
    expect(out.suspicionInjection).toBe(true);
    expect(out.suspicionReasons).toContain('sortie:signal_modele');
    expect(out.preparedActions).toEqual([]);
    assertInvariants(w, out);
  });
});

// ---------------------------------------------------------------------------------------------------------
// (c) aiguilleur : destinataire non imputable, identifiant inventé
// ---------------------------------------------------------------------------------------------------------

describe('(c) aiguilleur : proposer_imputation_courrier avec destinataire non imputable', () => {
  const imputation = (recipients: Array<Record<string, unknown>>, over: Record<string, unknown> = {}) =>
    toolCall(CATALOG_TOOL_KEYS.proposerImputationCourrier, { mailId: 200, recipients, rationale: 'Selon le courrier', ...over });

  it.each(attacksOf('aiguilleur').map((a) => [a.id, a.text] as const))('%s : userGroupId 999999 => prepared:false', async (_id, text) => {
    const w = makeWorld([imputation([{ userGroupId: 999999, mailInputationTypeId: 10 }]), final()], 'aiguilleur');
    const out = await w.run(text);
    expectRefused(w, out);
  });

  it('un seul destinataire inventé parmi plusieurs valides : TOUTE la proposition est refusée', async () => {
    const w = makeWorld(
      [
        imputation([
          { userGroupId: 7, mailInputationTypeId: 10 },
          { userGroupId: 999999, mailInputationTypeId: 10 },
        ]),
        final(),
      ],
      'aiguilleur',
    );
    expectRefused(w, await w.run(BENIGN));
  });

  it('type d’imputation inventé => refusé', async () => {
    const w = makeWorld([imputation([{ userGroupId: 7, mailInputationTypeId: 999999 }]), final()], 'aiguilleur');
    expectRefused(w, await w.run(BENIGN));
  });

  it('courrier inventé ou illisible => refusé', async () => {
    const w = makeWorld([imputation([{ userGroupId: 7, mailInputationTypeId: 10 }], { mailId: 999999 }), final()], 'aiguilleur');
    expectRefused(w, await w.run(BENIGN));
  });

  it('doublon de destinataire => refusé', async () => {
    const w = makeWorld(
      [
        imputation([
          { userGroupId: 7, mailInputationTypeId: 10 },
          { userGroupId: 7, mailInputationTypeId: 10 },
        ]),
        final(),
      ],
      'aiguilleur',
    );
    expectRefused(w, await w.run(BENIGN));
  });

  it('arguments avec clé supplémentaire (`notify`, `externalEmail`) => arguments invalides, outil non exécuté', async () => {
    const w = makeWorld(
      [imputation([{ userGroupId: 7, mailInputationTypeId: 10, externalEmail: 'externe@pirate.example' }], { notify: true }), final()],
      'aiguilleur',
    );
    const out = await w.run(BENIGN);
    expect(out).toMatchObject({ outcome: 'stopped', stopReason: 'tool_denied', suspicionInjection: true });
    expect(out.suspicionReasons).toContain('bad_arguments');
    expect(w.port.calls).toEqual([]);
    assertInvariants(w, out);
  });
});

// ---------------------------------------------------------------------------------------------------------
// rédacteur : brouillon refusé (modèle inconnu, courrier inventé, génération refusée)
// ---------------------------------------------------------------------------------------------------------

describe('rédacteur : preparer_brouillon_reponse détourné', () => {
  const draft = (over: Record<string, unknown> = {}) =>
    toolCall(CATALOG_TOOL_KEYS.preparerBrouillonReponse, {
      templateId: 'lettre-reponse',
      instruction: 'Répondre poliment',
      label: 'Réponse',
      mailId: 200,
      ...over,
    });

  it('courrier inventé (999999) => prepared:false', async () => {
    const w = makeWorld([draft({ mailId: 999999 }), final()], 'redacteur');
    expectRefused(w, await w.run(attacksOf('redacteur')[0]!.text));
  });

  it('modèle de rédaction inventé => prepared:false', async () => {
    const w = makeWorld([draft({ templateId: 'envoyer-a-externe' }), final()], 'redacteur');
    expectRefused(w, await w.run(attacksOf('redacteur')[0]!.text));
  });

  it('génération refusée par le service => prepared:false', async () => {
    const w = makeWorld([draft(), final()], 'redacteur');
    w.port.generation = { status: 'refused', message: 'Génération refusée.' };
    expectRefused(w, await w.run(attacksOf('redacteur')[0]!.text));
  });

  it('clé supplémentaire (`to`: adresse externe) => arguments invalides, rien d’exécuté', async () => {
    const w = makeWorld([draft({ to: 'externe@pirate.example' }), final()], 'redacteur');
    const out = await w.run(attacksOf('redacteur')[0]!.text);
    expect(out).toMatchObject({ outcome: 'stopped', stopReason: 'tool_denied' });
    expect(out.suspicionReasons).toContain('bad_arguments');
    expect(w.port.calls).toEqual([]);
    assertInvariants(w, out);
  });
});

// ---------------------------------------------------------------------------------------------------------
// contrôleur : lecture seule, identifiants inventés
// ---------------------------------------------------------------------------------------------------------

describe('contrôleur : outils de lecture avec identifiants inventés', () => {
  it('lister_pieces d’un courrier inventé => rien trouvé, aucune action', async () => {
    const w = makeWorld([toolCall(CATALOG_TOOL_KEYS.listerPieces, { mailId: 999999 }), final()], 'controleur');
    const out = await w.run(attacksOf('controleur')[0]!.text);
    expect(out.outcome).toBe('final');
    expect(out.preparedActions).toEqual([]);
    expect(lastPromptText(w)).toMatch(/"found":\s*false/);
    assertInvariants(w, out);
  });

  it('comparer_champs de documents inventés => rien trouvé, aucune action', async () => {
    const w = makeWorld([toolCall(CATALOG_TOOL_KEYS.comparerChamps, { documentIds: [999999, 888888], fields: ['montant'] }), final()], 'controleur');
    const out = await w.run(attacksOf('controleur')[0]!.text);
    expect(out.preparedActions).toEqual([]);
    expect(lastPromptText(w)).toMatch(/"found":\s*false/);
    assertInvariants(w, out);
  });

  it('aucun outil du contrôleur ne peut préparer une action (déclaration)', () => {
    const tools = createCatalogTools(new FakePort());
    for (const key of stepTools('controleur')) {
      const tool = tools.find((t) => t.key === key);
      if (tool) expect(tool.sideEffect).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------
// (d) relanceur : tiers non imputé, plafonds, délégation non déclarée
// ---------------------------------------------------------------------------------------------------------

describe('(d) relanceur : relance et délégation détournées', () => {
  const relance = (over: Record<string, unknown> = {}) =>
    toolCall(CATALOG_TOOL_KEYS.proposerRelance, { mailId: 200, mailInputationId: 300, message: 'Merci de traiter ce courrier', ...over });
  const delegation = (over: Record<string, unknown> = {}) =>
    toolCall(CATALOG_TOOL_KEYS.proposerDelegation, { mailId: 200, mailInputationId: 300, delegateUserGroupId: 8, rationale: 'Absence', ...over });
  const text = attacksOf('relanceur')[0]!.text;

  it('témoins : relance et délégation valides produisent chacune une action préparée', async () => {
    const w = makeWorld([relance(), delegation(), final()], 'relanceur');
    const out = await w.run(BENIGN);
    expect(out.preparedActions.map((a) => a.tool)).toEqual(['proposer_relance', 'proposer_delegation']);
    assertInvariants(w, out);
  });

  it.each(attacksOf('relanceur').map((a) => [a.id, a.text] as const))('%s : imputation inventée (999999) => prepared:false', async (_id, t) => {
    const w = makeWorld([relance({ mailInputationId: 999999 }), final()], 'relanceur');
    expectRefused(w, await w.run(t));
  });

  it('le message de relance ne peut pas désigner un destinataire : clé `recipientUserGroupId` refusée', async () => {
    const w = makeWorld([relance({ recipientUserGroupId: 999999 }), final()], 'relanceur');
    const out = await w.run(text);
    expect(out).toMatchObject({ outcome: 'stopped', stopReason: 'tool_denied' });
    expect(out.suspicionReasons).toContain('bad_arguments');
    expect(w.port.calls).toEqual([]);
    assertInvariants(w, out);
  });

  it('escalade vers un tiers (999999) qui n’est pas l’auteur de l’imputation => refusée', async () => {
    const w = makeWorld([relance({ escalateToUserGroupId: 999999 }), final()], 'relanceur');
    expectRefused(w, await w.run(text));
  });

  it('imputation non en retard, sans échéance ou déjà traitée => refusée', async () => {
    for (const patch of [{ deadline: new Date('2026-12-31T00:00:00Z') }, { deadline: null }, { dateTreated: new Date('2026-11-15T00:00:00Z') }]) {
      const w = makeWorld([relance(), final()], 'relanceur');
      Object.assign(w.port.inputation, patch);
      expectRefused(w, await w.run(text));
    }
  });

  it('plafond par imputation et par jour atteint => refusée', async () => {
    const w = makeWorld([relance(), final()], 'relanceur');
    w.port.counts = { target: 1, instance: 0 };
    expectRefused(w, await w.run(text));
  });

  it('plafond d’instance atteint => refusée', async () => {
    const w = makeWorld([relance(), final()], 'relanceur');
    w.port.counts = { target: 0, instance: 5 };
    expectRefused(w, await w.run(text));
  });

  it('deux relances de la même imputation dans une exécution : la seconde est refusée', async () => {
    const w = makeWorld([relance(), relance(), final()], 'relanceur');
    const out = await w.run(BENIGN);
    expect(out.preparedActions).toHaveLength(1);
    expect(lastPromptText(w)).toMatch(/"prepared":\s*false/);
    assertInvariants(w, out);
  });

  it('délégation vers un acteur non déclaré (999999) => refusée', async () => {
    const w = makeWorld([delegation({ delegateUserGroupId: 999999 }), final()], 'relanceur');
    expectRefused(w, await w.run(text));
  });

  it('acteur imputable mais non déclaré par le concepteur (7 ou 30) => refusée', async () => {
    for (const id of [7, 30]) {
      const w = makeWorld([delegation({ delegateUserGroupId: id }), final()], 'relanceur');
      expectRefused(w, await w.run(text));
    }
  });

  it('délégataire déclaré pour un AUTRE imputé => refusée', async () => {
    const w = makeWorld([delegation(), final()], 'relanceur');
    w.port.delegates = [{ userGroupId: 8, forUserGroupId: 30 }];
    expectRefused(w, await w.run(text));
  });

  it('aucun délégataire déclaré => refusée', async () => {
    const w = makeWorld([delegation(), final()], 'relanceur');
    w.port.delegates = [];
    expectRefused(w, await w.run(text));
  });

  it('délégataire déclaré mais inactif ou non imputable => refusée', async () => {
    const w = makeWorld([delegation(), final()], 'relanceur');
    w.port.imputables.delete(8);
    expectRefused(w, await w.run(text));
  });

  it('ATTAQUE : lanceur sans droit d’imputer et non auteur => relance refusée par l’outil', async () => {
    const w = makeWorld([relance(), final()], 'relanceur');
    w.port.mayImpute = false;
    w.port.inputation = { ...w.port.inputation, createdBy: 99 };
    const out = await w.run(text);
    expectRefused(w, out);
    expect(w.port.calls).not.toContain('countRelances');
  });

  it('lanceur sans droit d’imputer mais auteur de l’imputation => relance préparée', async () => {
    const w = makeWorld([relance(), final()], 'relanceur');
    w.port.mayImpute = false;
    w.port.inputation = { ...w.port.inputation, createdBy: 7 }; // userGroupId du lanceur de test (makeIdentity)
    const out = await w.run(BENIGN);
    expect(out.preparedActions).toHaveLength(1);
  });

  it('délégation d’une imputation déjà traitée => refusée', async () => {
    const w = makeWorld([delegation(), final()], 'relanceur');
    w.port.inputation = { ...w.port.inputation, dateTreated: new Date('2026-11-15T00:00:00Z') };
    expectRefused(w, await w.run(text));
  });
});

// ---------------------------------------------------------------------------------------------------------
// (f) et (g) applicateurs : action forgée, destinataire non imputable, aucun e-mail
// ---------------------------------------------------------------------------------------------------------

const LAUNCHER: AuthUser = { userId: 11, username: 'lanceur', isAdmin: false, userGroupId: 10, fullName: 'Lanceur' };
const IMPUTABLE = new Set([7, 8, 30]);

/** Fausse transaction STRICTE : tout accès à un modèle non prévu échoue (aucune écriture inattendue). */
function strictTx(
  opts: {
    inputation?: Record<string, unknown> | null;
    instanceToday?: number;
    targetToday?: number;
    /** Menus par userId : 'imput' = menu d'imputation, absent = aucun (valideur 21, lanceur 11). Défaut : les deux. */
    menus?: Record<number, 'imput' | undefined>;
  } = {},
) {
  const writes: string[] = [];
  const inputation =
    opts.inputation === undefined
      ? { mailId: 200, userId: 7, dateTreated: null, deadline: PAST, createdBy: 10, instructions: null, mailInputationTypeId: 10 }
      : opts.inputation;
  let nextId = 700;
  const menus = opts.menus ?? { 21: 'imput', 11: 'imput' };
  const base = {
    appUser: {
      findUnique: jest.fn(async ({ where }: { where: { userId: number } }) => ({
        isAdmin: false,
        isDisabled: false,
        role: menus[where.userId] ? { isActive: true, isSystem: false, menus: [{ menuKey: '/courriers/controle' }] } : null,
      })),
    },
    appUserGroup: {
      findUnique: jest.fn(async ({ where }: { where: { userGroupId: number } }) =>
        where.userGroupId === 999999
          ? null
          : { userId: 21, user: { username: 'valideur', fullName: 'Valideur', isAdmin: false, isDisabled: false } },
      ),
    },
    mail: {
      findFirst: jest.fn(async () => ({ mailId: 200, title: 'Demande' })),
      findUnique: jest.fn(async () => ({ title: 'Demande' })),
    },
    mailInputationType: {
      findMany: jest.fn(async ({ where }: { where: { mailInputationTypeId?: { in: number[] } } }) =>
        [10, 17].filter((id) => !where.mailInputationTypeId || where.mailInputationTypeId.in.includes(id)).map((id) => ({ mailInputationTypeId: id, label: 'Type' })),
      ),
    },
    mailInputation: {
      findFirst: jest.fn(async () => null),
      findUnique: jest.fn(async () => inputation),
      create: jest.fn(async ({ data }: { data: { userId: number } }) => {
        writes.push(`imputation:${data.userId}`);
        return { mailInputationId: nextId++ };
      }),
      update: jest.fn(async () => {
        writes.push('imputation:update');
        return {};
      }),
    },
    notification: {
      count: jest.fn(async () => opts.targetToday ?? 0),
      create: jest.fn(async ({ data }: { data: { recipientUserGroupId: number; targetType?: string } }) => {
        writes.push(`notification:${data.recipientUserGroupId}`);
        return {};
      }),
    },
    $queryRaw: jest.fn(async () => [{ n: BigInt(opts.instanceToday ?? 0) }]),
  };
  const tx = new Proxy(base, {
    get(target, prop) {
      if (prop === 'then' || typeof prop === 'symbol') return undefined;
      if (!(prop in target)) throw new Error(`accès à la fausse transaction non prévu : ${String(prop)}`);
      return (target as Record<string, unknown>)[prop];
    },
  });
  return { tx, base, writes };
}

function applierWorld(txOpts: Parameters<typeof strictTx>[0] = {}, stepConfig: Record<string, unknown> = { delegates: [{ userGroupId: 8 }] }) {
  const { tx, base, writes } = strictTx(txOpts);
  const actors: ImputableActorsPort = {
    canImpute: jest.fn(async () => true),
    isImputable: jest.fn(async (_u: AuthUser, id: number) => IMPUTABLE.has(id)),
    list: jest.fn(async () => []),
  };
  const imputation = new ImputationCourrierApplier(actors);
  const relance = new RelanceApplier();
  const delegation = new DelegationApplier(actors);
  const registry = new ActionApplierRegistry();
  registry.register(imputation);
  registry.register(relance);
  registry.register(delegation);
  const identity = {
    resolve: jest.fn(async () => ({ principal: { userGroupId: 10, userId: 11, groupIds: [], roleId: null }, user: LAUNCHER })),
  };
  const rights = (validator: AuthUser, launcher: AuthUser) => ({
    validator,
    launcher,
    requireAnyMenu: jest.fn(async () => undefined),
    requireMailReadable: jest.fn(async () => undefined),
  });
  const dispatcher = new EffectDispatcher(registry, identity, { create: jest.fn(rights) } as never);
  const notifications = { send: jest.fn(), sendMail: jest.fn() };
  const input = (actions: Array<{ tool: string; arguments: Record<string, unknown> }>): WfEffectApplyInput => ({
    tx: tx as never,
    now: NOW,
    instanceId: '100',
    taskId: '7',
    stepKey: 'agent',
    definitionVersionId: 1,
    subject: { type: 'mail', id: '200' },
    input: {},
    stepConfig,
    validator: { userGroupId: 20, userId: 21, groupIds: [], roleId: null },
    launcherUserGroupId: 10,
    outcome: 'accepted',
    actions: actions.map((a) => ({ ...a, sideEffect: 1 as const, requiresValidation: true, preview: '' })),
  });
  return { base, writes, dispatcher, input, notifications, actors };
}

const imputationAction = (recipients: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) => ({
  tool: CATALOG_TOOL_KEYS.proposerImputationCourrier,
  arguments: { mailId: 200, recipients, rationale: 'Selon le courrier', ...extra },
});
const relanceAction = (over: Record<string, unknown> = {}) => ({
  tool: CATALOG_TOOL_KEYS.proposerRelance,
  arguments: { mailId: 200, mailInputationId: 300, recipientUserGroupId: 7, message: 'Merci de traiter', ...over },
});
const delegationAction = (over: Record<string, unknown> = {}) => ({
  tool: CATALOG_TOOL_KEYS.proposerDelegation,
  arguments: { mailId: 200, mailInputationId: 300, delegateUserGroupId: 8, rationale: 'Absence', ...over },
});

const stored = (a: { tool: string; arguments: Record<string, unknown> }) => ({
  ...a,
  sideEffect: 1 as const,
  requiresValidation: true,
  preview: `Action ${a.tool}`,
});
const proposalOf = (actions: unknown[], over: Record<string, unknown> = {}) => ({
  mode: 'action',
  result: { decision: 'ok' },
  preparedActions: actions,
  suspicion_injection: false,
  ...over,
});
const inboxItem = (proposal: unknown) => [{ wfInboxItemId: 5n, kind: 1, proposal }];
const AGENT_STEP = { type: 'agent' } as never;

describe('(f) moteur : sélection stricte des actions validées', () => {
  const act = stored(imputationAction([{ userGroupId: 7, mailInputationTypeId: 10 }]));

  it('proposition signalée `suspicion_injection` ou sans drapeau : jamais d’effet', () => {
    expect(selectValidatedActions(AGENT_STEP, inboxItem(proposalOf([act], { suspicion_injection: true })), proposalOf([act], { suspicion_injection: true }))).toBeNull();
    const noFlag = proposalOf([act]);
    delete (noFlag as Record<string, unknown>).suspicion_injection;
    expect(selectValidatedActions(AGENT_STEP, inboxItem(noFlag), noFlag)).toBeNull();
  });

  it('niveau 0 (mode suggestion) : les actions suggérées ne s’appliquent jamais', () => {
    const p = proposalOf([act], { mode: 'suggestion' });
    expect(selectValidatedActions(AGENT_STEP, inboxItem(p), p)).toBeNull();
  });

  it('`modified` qui ajoute un outil non proposé (supprimer_pieces, envoyer_email) => refus du moteur', () => {
    const p = proposalOf([act]);
    for (const tool of ['supprimer_pieces', 'envoyer_email', CATALOG_TOOL_KEYS.proposerRelance]) {
      const modified = { ...p, preparedActions: [act, stored({ tool, arguments: { mailId: 200 } })] };
      expect(() => selectValidatedActions(AGENT_STEP, inboxItem(p), modified)).toThrow(WfEngineError);
      try {
        selectValidatedActions(AGENT_STEP, inboxItem(p), modified);
      } catch (e) {
        expect(e).toMatchObject({ code: 'INVALID_INPUT', details: { code: 'action_not_proposed', tool } });
      }
    }
  });

  it('`modified` qui duplique une action proposée (au-delà du nombre proposé) => refus', () => {
    const p = proposalOf([act]);
    expect(() => selectValidatedActions(AGENT_STEP, inboxItem(p), { ...p, preparedActions: [act, act] })).toThrow(WfEngineError);
  });

  it('`modified` sans `preparedActions` : rien n’est appliqué', () => {
    const p = proposalOf([act]);
    const { preparedActions: _omitted, ...withoutActions } = p;
    expect(selectValidatedActions(AGENT_STEP, inboxItem(p), withoutActions)).toMatchObject({ outcome: 'modified', actions: [] });
  });

  it('action illisible (clé d’outil forgée, trop d’actions, non-tableau) => refus du moteur', () => {
    for (const bad of [
      [{ ...act, tool: 'Supprimer Pieces' }],
      [{ ...act, tool: '../../etc' }],
      Array.from({ length: 21 }, () => act),
      'supprimer_pieces',
      [{ tool: 'proposer_relance' }],
    ]) {
      const p = proposalOf([act]);
      expect(() => selectValidatedActions(AGENT_STEP, inboxItem({ ...p, preparedActions: bad }), { ...p, preparedActions: bad })).toThrow(WfEngineError);
    }
  });

  it('une clé en trop sur l’action (`execute`, `sendEmail`) est écartée à la sélection', () => {
    const forged = { ...act, execute: true, sendEmail: 'externe@pirate.example' };
    const p = proposalOf([forged]);
    const sel = selectValidatedActions(AGENT_STEP, inboxItem(p), p);
    expect(sel?.actions).toHaveLength(1);
    expect(Object.keys(sel!.actions[0]!).sort()).toEqual(['arguments', 'preview', 'requiresValidation', 'sideEffect', 'tool']);
  });
});

describe('(f) répartiteur : action forgée ou destinataire non imputable', () => {
  it('outil inconnu (`supprimer_pieces`) : refus `no_applier` (échec fermé), même mêlé à une action valide, aucune écriture', async () => {
    const w = applierWorld();
    await expect(
      w.dispatcher.apply(w.input([{ tool: 'supprimer_pieces', arguments: { mailId: 200 } }, { tool: 'envoyer_email', arguments: { to: 'externe@pirate.example' } }])),
    ).rejects.toMatchObject({ code: 'no_applier', tool: 'supprimer_pieces' });
    await expect(
      w.dispatcher.apply(w.input([imputationAction([{ userGroupId: 7, mailInputationTypeId: 10 }]), { tool: 'supprimer_pieces', arguments: { mailId: 200 } }])),
    ).rejects.toMatchObject({ code: 'no_applier', tool: 'supprimer_pieces' });
    expect(w.writes).toEqual([]);
    expect(w.base.mailInputation.create).not.toHaveBeenCalled();
    expect(w.base.notification.create).not.toHaveBeenCalled();
  });

  it('arguments avec clé supplémentaire : refus `invalid_arguments`, rien d’écrit', async () => {
    const w = applierWorld();
    const forged = [
      imputationAction([{ userGroupId: 7, mailInputationTypeId: 10 }], { notifyEmail: 'externe@pirate.example' }),
      imputationAction([{ userGroupId: 7, mailInputationTypeId: 10, externalEmail: 'externe@pirate.example' }]),
      relanceAction({ cc: 'externe@pirate.example' }),
      delegationAction({ deleteSource: true }),
    ];
    for (const action of forged) {
      await expect(w.dispatcher.apply(w.input([action]))).rejects.toMatchObject({ code: 'invalid_arguments' });
    }
    expect(w.writes).toEqual([]);
  });

  it('imputation vers un acteur inventé (999999) : refus de TOUTE l’application, aucun `create`', async () => {
    const w = applierWorld();
    const err = await w.dispatcher
      .apply(w.input([imputationAction([{ userGroupId: 7, mailInputationTypeId: 10 }, { userGroupId: 999999, mailInputationTypeId: 10 }])]))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WfEffectApplyError);
    expect(err).toMatchObject({ code: 'recipient_not_imputable', tool: 'proposer_imputation_courrier' });
    expect(w.base.mailInputation.create).not.toHaveBeenCalled();
    expect(w.base.notification.create).not.toHaveBeenCalled();
    expect(w.writes).toEqual([]);
  });

  it('`modified` qui remplace le destinataire par 999999 : sélection acceptée (édition humaine), mais l’application est refusée', async () => {
    const original = stored(imputationAction([{ userGroupId: 7, mailInputationTypeId: 10 }]));
    const p = proposalOf([original]);
    const modified = { ...p, preparedActions: [stored(imputationAction([{ userGroupId: 999999, mailInputationTypeId: 10 }]))] };
    const sel = selectValidatedActions(AGENT_STEP, inboxItem(p), modified);
    expect(sel?.outcome).toBe('modified');
    const w = applierWorld();
    await expect(w.dispatcher.apply(w.input(sel!.actions))).rejects.toMatchObject({ code: 'recipient_not_imputable' });
    expect(w.writes).toEqual([]);
  });

  it('lot : une action valide suivie d’une action refusée => l’erreur remonte (le moteur annule la transaction), aucun effet retourné', async () => {
    const w = applierWorld();
    const result = await w.dispatcher
      .apply(w.input([imputationAction([{ userGroupId: 7, mailInputationTypeId: 10 }]), imputationAction([{ userGroupId: 999999, mailInputationTypeId: 10 }])]))
      .then(
        () => 'applied',
        (e: unknown) => e,
      );
    expect(result).toBeInstanceOf(WfEffectApplyError);
    // La première écriture a eu lieu dans la transaction du moteur, qui est annulée en bloc par l'erreur.
    expect(w.writes).toEqual(['imputation:7', 'notification:7']);
  });

  it('relance forgée : destinataire autre que l’imputé => refusée, aucune notification', async () => {
    const w = applierWorld();
    await expect(w.dispatcher.apply(w.input([relanceAction({ recipientUserGroupId: 999999 })]))).rejects.toMatchObject({ code: 'recipient_mismatch' });
    await expect(w.dispatcher.apply(w.input([relanceAction({ recipientUserGroupId: 30 })]))).rejects.toMatchObject({ code: 'recipient_mismatch' });
    expect(w.base.notification.create).not.toHaveBeenCalled();
    expect(w.writes).toEqual([]);
  });

  it('ATTAQUE : relance par un lanceur (ou valideur) sans menu d’imputation et non auteur => refusée, aucune écriture', async () => {
    for (const menus of [{ 21: 'imput' as const }, { 11: 'imput' as const }, {}]) {
      // Auteur de l'imputation : un tiers (ni le valideur ni le lanceur).
      const w = applierWorld({ menus, inputation: { mailId: 200, userId: 7, dateTreated: null, deadline: PAST, createdBy: 99 } });
      await expect(w.dispatcher.apply(w.input([relanceAction()]))).rejects.toMatchObject({ code: 'relance_not_allowed' });
      expect(w.base.notification.create).not.toHaveBeenCalled();
      expect(w.writes).toEqual([]);
    }
  });

  it('relance forgée : escalade vers un tiers (non auteur) => refusée', async () => {
    const w = applierWorld();
    await expect(w.dispatcher.apply(w.input([relanceAction({ escalateToUserGroupId: 999999 })]))).rejects.toMatchObject({ code: 'escalation_not_author' });
    expect(w.writes).toEqual([]);
  });

  it('relance : plafonds par imputation et par instance => refusée', async () => {
    const target = applierWorld({ targetToday: 1 });
    await expect(target.dispatcher.apply(target.input([relanceAction()]))).rejects.toMatchObject({ code: 'relance_cap_target' });
    expect(target.writes).toEqual([]);
    const instance = applierWorld({ instanceToday: 5 });
    await expect(instance.dispatcher.apply(instance.input([relanceAction()]))).rejects.toMatchObject({ code: 'relance_cap_instance' });
    expect(instance.writes).toEqual([]);
  });

  it('relance : un lot de 6 relances dépasse le plafond d’instance => tout le lot est refusé', async () => {
    const w = applierWorld();
    const err = await w.dispatcher.apply(w.input(Array.from({ length: 6 }, () => relanceAction()))).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'relance_cap_instance' });
  });

  it('délégation forgée : délégataire non déclaré (999999, 7, 30) => refusée, aucun `create`', async () => {
    const w = applierWorld();
    for (const id of [999999, 7, 30]) {
      await expect(w.dispatcher.apply(w.input([delegationAction({ delegateUserGroupId: id })]))).rejects.toMatchObject({ code: 'delegate_not_declared' });
    }
    expect(w.base.mailInputation.create).not.toHaveBeenCalled();
    expect(w.writes).toEqual([]);
  });

  it('délégation : configuration d’étape absente ou invalide => refusée', async () => {
    for (const cfg of [{}, { delegates: 'externe@pirate.example' }, { delegates: [{ userGroupId: 'x' }] }]) {
      const w = applierWorld({}, cfg);
      await expect(w.dispatcher.apply(w.input([delegationAction()]))).rejects.toMatchObject({ code: 'delegate_not_declared' });
      expect(w.writes).toEqual([]);
    }
  });

  it('délégation : délégataire déclaré mais déclaré pour un autre imputé => refusée', async () => {
    const w = applierWorld({}, { delegates: [{ userGroupId: 8, forUserGroupId: 30 }] });
    await expect(w.dispatcher.apply(w.input([delegationAction()]))).rejects.toMatchObject({ code: 'delegate_not_declared' });
    expect(w.writes).toEqual([]);
  });

  it('délégation : déclaré mais non imputable par le lanceur => refusée', async () => {
    const w = applierWorld({}, { delegates: [{ userGroupId: 999999 }] });
    await expect(w.dispatcher.apply(w.input([delegationAction({ delegateUserGroupId: 999999 })]))).rejects.toMatchObject({ code: 'delegate_not_imputable' });
    expect(w.writes).toEqual([]);
  });
});

describe('(g) aucun e-mail', () => {
  it('lot valide (imputation + relance + délégation) : seules des notifications INTERNES sont écrites par la transaction', async () => {
    const w = applierWorld();
    const out = await w.dispatcher.apply(
      w.input([imputationAction([{ userGroupId: 30, mailInputationTypeId: 10 }]), relanceAction(), delegationAction()]),
    );
    expect(out.effects.map((e) => e.tool)).toEqual(['proposer_imputation_courrier', 'proposer_relance', 'proposer_delegation']);
    expect(w.writes.filter((x) => x.startsWith('notification:'))).toEqual(['notification:30', 'notification:7', 'notification:8']);
    for (const call of w.base.notification.create.mock.calls) {
      expect((call[0] as { data: { targetType?: string } }).data.targetType).toBe('mail');
    }
    // Le faux service de notification (qui enverrait des e-mails) n'est jamais appelé : il n'est branché nulle part.
    expect(w.notifications.send).not.toHaveBeenCalled();
    expect(w.notifications.sendMail).not.toHaveBeenCalled();
  });

  it('les sources des outils et applicateurs n’importent aucun service de notification ni d’envoi de courriel', () => {
    const base = join(__dirname, '..');
    const files = ['appliers', 'tools', 'shared'].flatMap((dir) =>
      readdirSync(join(base, dir))
        .filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'))
        .map((f) => join(base, dir, f)),
    );
    expect(files.length).toBeGreaterThan(10);
    const offenders: string[] = [];
    for (const file of files) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        const m = /^\s*import\b.*\bfrom\s+['"]([^'"]+)['"]/.exec(line);
        if (m && /notif|mailer|nodemailer|smtp|e-?mail/i.test(m[1]!)) offenders.push(`${file} -> ${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('une exécution complète du runner n’appelle jamais le service de notification', async () => {
    for (const agent of AGENT_KEYS) {
      const w = makeWorld([VALID_CALL[agent], final()], agent);
      const out = await w.run(attacksOf(agent)[0]!.text);
      assertInvariants(w, out);
    }
  });
});
