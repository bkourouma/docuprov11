import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  ASST_ACTION_TOOL_VALUES,
  AsstActionTool,
  AsstProposalStatus,
  type AsstProposalDto,
  type AsstProposedAction,
} from '@archivage/types';
import type { PrismaService } from '../../prisma/prisma.service';
import type { ActionApplierRegistry } from '../../workflow-agent-catalog/appliers/action-applier.registry';
import type { ApplierRightsService } from '../../workflow-agent-catalog/appliers/applier-rights';
import { lockMailInputationRow, lockMailRow } from '../../workflow-agent-catalog/appliers/row-locks';
import {
  EffectRefusedError,
  type ActionApplier,
  type AppliedEffect,
  type ApplierContext,
} from '../../workflow-agent-catalog/catalog.contracts';
import type { AsstIdentity, AsstProposalStore } from '../assistant.contracts';

// Exécution TRANSACTIONNELLE des actions d'une proposition confirmée (lot A2).
//
// Tout ou rien : verrous de ligne, effets des applicateurs du catalogue, traçabilité (`data_change_audit`) et
// transition 1 -> 2 (Appliquée) sont écrits dans UNE transaction. Une erreur n'importe où (application,
// traçabilité, transition finale, validation de la transaction) annule tout ; les effets NON transactionnels
// (brouillons) sont alors compensés, en ordre inverse, une seule fois.
// Aucun e-mail n'est envoyé ; aucun journal ne contient de contenu de courrier ni de brouillon.

/** Options de la transaction interactive (attente du verrou de connexion, durée maximale). */
export const ASST_EFFECT_TX_OPTIONS = { maxWait: 5_000, timeout: 15_000 } as const;

/**
 * Attente maximale (ms) du verrou de ligne lors de la relecture d'une issue ambiguë (`SET LOCAL lock_timeout`) :
 * le verrou attend la fin de la transaction encore en vol ; au-delà, l'erreur 55P03 donne un essai raté.
 */
export const ASST_AMBIGUOUS_LOCK_TIMEOUT_MS = 2_000;

/** Liste blanche des outils exécutables par l'assistant (la délégation est exclue en v1). */
const ALLOWED_TOOLS: ReadonlySet<string> = new Set<string>(ASST_ACTION_TOOL_VALUES);

/** Codes de refus d'applicateur qui relèvent des DROITS de l'utilisateur (HTTP 403 `effect_forbidden`). */
const FORBIDDEN_CODES: ReadonlySet<string> = new Set([
  'menu_denied',
  'mail_not_readable',
  'recipient_not_imputable',
  'space_denied',
  'relance_not_allowed',
  'account_inactive',
]);

const ERROR_CODE_PATTERN = /^[a-z0-9_.]+$/;
/** Borne de `asst_proposal.error_code` (VARCHAR(60)). */
const ERROR_CODE_MAX = 60;
/** Bornes de `data_change_audit`. */
const OBJECT_REF_MAX = 256;
const ACTOR_NAME_MAX = 200;

const TECHNICAL_MESSAGE = "L'action n'a pas pu être appliquée (erreur technique) : rien n'a été enregistré.";
const UNCERTAIN_MESSAGE =
  "Résultat incertain : la connexion s'est interrompue pendant la validation. Vérifiez l'état de la proposition avant toute nouvelle demande.";
const STATE_LOST_MESSAGE =
  "L'état de la proposition a changé pendant l'exécution (traitement concurrent) : rien n'a été enregistré.";

/** Fabrique des droits (même classe que celle injectée dans `EffectDispatcher`). */
export type AsstRightsFactory = Pick<ApplierRightsService, 'create'>;

/** Échec explicable d'une exécution : `forbidden` (droits) ou `failed` (refus métier ou erreur technique). */
export interface AsstRunFailure {
  readonly kind: 'forbidden' | 'failed' | 'uncertain';
  /** Conforme à `^[a-z0-9_.]+$`, au plus 60 caractères. */
  readonly errorCode: string;
  /** Français, sans contenu de courrier. */
  readonly message: string;
}

export type AsstRunOutcome =
  | { readonly ok: true; readonly proposal: AsstProposalDto }
  | { readonly ok: false; readonly failure: AsstRunFailure };

export interface AsstEffectRunInput {
  /** Identité FRAÎCHE (relue en base) de l'utilisateur qui confirme. */
  readonly identity: AsstIdentity;
  /** Proposition au statut Confirmée (retour de la transition 0 -> 1). */
  readonly proposal: AsstProposalDto;
  /** Actions REVALIDÉES par `asstProposedActionsSchema` (jamais le JSON brut). */
  readonly actions: readonly AsstProposedAction[];
  readonly now: Date;
}

interface PreparedAction {
  readonly action: AsstProposedAction;
  readonly applier: ActionApplier;
  readonly args: unknown;
}

/** Issue relue d'une transaction ambiguë. */
type AmbiguousRead =
  | { readonly kind: 'applied'; readonly proposal: AsstProposalDto }
  | { readonly kind: 'rolled_back' }
  | { readonly kind: 'unknown' };

/** Erreur interne : la transition finale 1 -> 2 a perdu son CAS (la transaction est annulée). */
class AsstStateLostError extends Error {
  constructor() {
    super('transition finale perdue');
    this.name = 'AsstStateLostError';
  }
}

/** Refus avant toute écriture (liste blanche, applicateur absent, arguments invalides). */
class AsstPreflightRefusal extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'AsstPreflightRefusal';
  }
}

export class AsstEffectRunner {
  private readonly logger = new Logger(AsstEffectRunner.name);
  /** Délais (ms) entre les relectures d'une issue ambiguë ; modifiable en test. */
  retryDelaysMs: number[] = [200, 500, 1000];
  /** Attente maximale (ms) du verrou de ligne à chaque relecture d'une issue ambiguë ; modifiable en test. */
  lockTimeoutMs: number = ASST_AMBIGUOUS_LOCK_TIMEOUT_MS;

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ActionApplierRegistry,
    private readonly rightsFactory: AsstRightsFactory,
    private readonly store: AsstProposalStore,
  ) {}

  /** Applique les actions ; ne lève jamais (le résultat porte l'échec explicable). */
  async run(input: AsstEffectRunInput): Promise<AsstRunOutcome> {
    const proposalId = input.proposal.proposalId;

    // 1. Contrôles préalables, AVANT toute transaction et toute écriture (échec fermé : rien n'est appliqué).
    let prepared: PreparedAction[];
    try {
      prepared = this.prepare(input.actions);
    } catch (err) {
      return { ok: false, failure: this.toFailure(err, proposalId) };
    }

    // 2. Transaction : verrous, effets, traçabilité, transition 1 -> 2.
    //    `callbackReturned` distingue l'échec AVANT la fin du callback (annulation CERTAINE : compensation permise)
    //    de l'échec APRÈS (COMMIT en erreur : issue AMBIGUË, la transaction a pu être validée).
    const compensations: Array<() => Promise<void>> = [];
    let callbackReturned = false;
    try {
      const applied = await this.prisma.$transaction(async (tx) => {
        const done = await this.applyInTransaction(tx, input, prepared, compensations);
        callbackReturned = true;
        return done;
      }, ASST_EFFECT_TX_OPTIONS);
      return { ok: true, proposal: applied };
    } catch (err) {
      if (callbackReturned) return this.resolveAmbiguous(input, err, compensations);
      await this.compensate(compensations, proposalId);
      return { ok: false, failure: this.toFailure(err, proposalId) };
    }
  }

  /**
   * Issue ambiguë (erreur APRÈS le retour du callback : coupure pendant ou après le COMMIT). Le statut est relu SOUS
   * VERROU DE LIGNE (le verrou attend la fin de la transaction encore en vol), avec quelques essais espacés :
   * « Appliquée » => succès (jamais de compensation) ; « Confirmée »/« Échec » lu sous verrou => la transaction a été
   * annulée, compensation permise ; TOUT autre cas (statut inattendu, lecture impossible, lock_timeout épuisé,
   * proposition introuvable) => AUCUNE compensation (un brouillon supprimé alors que tout est appliqué serait
   * irréparable) : échec `uncertain`, le statut est laissé au balayage `recoverInterrupted`.
   */
  private async resolveAmbiguous(
    input: AsstEffectRunInput,
    err: unknown,
    compensations: Array<() => Promise<void>>,
  ): Promise<AsstRunOutcome> {
    const proposalId = input.proposal.proposalId;
    this.logger.error(`issue ambiguë après exécution (proposition ${proposalId}) : ${errorName(err)}`);
    const read = await this.readWithRetry(input);
    if (read.kind === 'applied') return { ok: true, proposal: read.proposal };
    if (read.kind === 'rolled_back') {
      await this.compensate(compensations, proposalId);
      return { ok: false, failure: this.toFailure(err, proposalId) };
    }
    return { ok: false, failure: { kind: 'uncertain', errorCode: 'result_uncertain', message: UNCERTAIN_MESSAGE } };
  }

  /** Relit l'issue (essais espacés, chacun sous verrou de ligne). Ne lève jamais. */
  private async readWithRetry(input: AsstEffectRunInput): Promise<AmbiguousRead> {
    for (let attempt = 0; attempt <= this.retryDelaysMs.length; attempt++) {
      if (attempt > 0) await sleep(this.retryDelaysMs[attempt - 1]);
      try {
        const status = await this.readStatusLocked(input.proposal.proposalId);
        if (status === null) return { kind: 'unknown' }; // introuvable : jamais de compensation
        if (status === AsstProposalStatus.Applied) {
          const current = await this.store.getProposal(input.identity.user.userId, input.proposal.proposalId);
          if (current && current.status === AsstProposalStatus.Applied) return { kind: 'applied', proposal: current };
          continue; // DTO illisible : essai suivant
        }
        if (status === AsstProposalStatus.Confirmed || status === AsstProposalStatus.Failed) {
          return { kind: 'rolled_back' };
        }
        return { kind: 'unknown' }; // statut inattendu (0, 3, 4...) : ambigu
      } catch {
        // lock_timeout (55P03), connexion coupée... : essai suivant
      }
    }
    return { kind: 'unknown' };
  }

  /**
   * Statut de la proposition lu SOUS VERROU DE LIGNE dans une transaction courte : `lock_timeout` borné puis
   * `SELECT ... FOR UPDATE`, qui attend la fin (validation ou annulation) de la transaction encore en vol.
   * `null` si la ligne n'existe pas ; lève si le verrou n'est pas obtenu à temps.
   */
  private async readStatusLocked(proposalId: string): Promise<number | null> {
    if (!/^[1-9]\d{0,18}$/.test(proposalId)) return null;
    const id = BigInt(proposalId);
    const ms = Math.max(1, Math.trunc(Number(this.lockTimeoutMs)) || ASST_AMBIGUOUS_LOCK_TIMEOUT_MS);
    return this.prisma.$transaction(
      async (tx) => {
        // `SET LOCAL` n'accepte pas de paramètre lié : entier borné, injecté en littéral.
        await tx.$executeRaw(Prisma.sql`SET LOCAL lock_timeout = ${Prisma.raw(`'${ms}ms'`)}`);
        const rows = await tx.$queryRaw<Array<{ status: number }>>(
          Prisma.sql`SELECT status FROM asst_proposal WHERE asst_proposal_id = ${id} FOR UPDATE`,
        );
        return rows.length > 0 ? Number(rows[0].status) : null;
      },
      { maxWait: ASST_EFFECT_TX_OPTIONS.maxWait, timeout: ms + 5_000 },
    );
  }

  /** Liste blanche, applicateur du registre, arguments revalidés STRICTEMENT par l'applicateur. */
  private prepare(actions: readonly AsstProposedAction[]): PreparedAction[] {
    if (actions.length === 0) {
      throw new AsstPreflightRefusal("Aucune action à appliquer : rien n'a été enregistré.", 'no_action');
    }
    const appliers: ActionApplier[] = [];
    for (const action of actions) {
      const tool = String(action?.tool);
      if (!ALLOWED_TOOLS.has(tool)) {
        throw new AsstPreflightRefusal(
          "Action non autorisée pour l'assistant : aucune action n'a été appliquée.",
          'tool_not_allowed',
        );
      }
      const applier = this.registry.get(tool);
      if (!applier) {
        throw new AsstPreflightRefusal(
          `Aucun applicateur pour l'action « ${tool} » : elle ne peut pas être appliquée et rien n'a été enregistré.`,
          'no_applier',
        );
      }
      appliers.push(applier);
    }
    // Arguments relus pour TOUTES les actions avant la première application : un lot invalide ne crée rien
    // (pas même un brouillon à compenser).
    return actions.map((action, i) => {
      const applier = appliers[i];
      let args: unknown;
      try {
        args = applier.parse(action.args);
      } catch (err) {
        if (err instanceof EffectRefusedError) throw err;
        throw new EffectRefusedError(
          `Arguments invalides pour l'action « ${action.tool} » : aucune action n'a été appliquée.`,
          'invalid_arguments',
        );
      }
      return { action, applier, args };
    });
  }

  private async applyInTransaction(
    tx: Prisma.TransactionClient,
    input: AsstEffectRunInput,
    prepared: readonly PreparedAction[],
    compensations: Array<() => Promise<void>>,
  ): Promise<AsstProposalDto> {
    const { identity, proposal, now } = input;
    const proposalId = proposal.proposalId;

    // Verrous en ORDRE FIXE avant toute action : courriers (croissant) puis imputations (croissant).
    const { mailIds, inputationIds, firstMailId } = lockTargets(input.actions);
    for (const mailId of mailIds) await lockMailRow(tx, mailId);
    for (const id of inputationIds) await lockMailInputationRow(tx, id);

    const user = identity.user;
    const ctx: ApplierContext = {
      tx,
      now,
      // Sentinelle NON numérique : aucun plafond « par instance » de workflow ne s'applique (compte = 0) ;
      // le plafond par imputé et par jour reste appliqué par l'applicateur de relance.
      instanceId: `asst:${proposalId}`,
      taskId: `asst:${proposalId}`,
      stepKey: 'assistant',
      definitionVersionId: 0,
      subject: firstMailId === null ? { type: null, id: null } : { type: 'mail', id: String(firstMailId) },
      input: {},
      stepConfig: {},
      validatorPrincipal: identity.principal,
      // Le même utilisateur tient les deux rôles : l'effet s'applique avec SES droits, jamais plus.
      rights: this.rightsFactory.create(user, user, tx),
      scratch: new Map<string, unknown>(),
    };

    const effects: AppliedEffect[] = [];
    for (const p of prepared) {
      const result = await p.applier.apply(ctx, p.args);
      if (typeof result?.compensate === 'function') compensations.push(result.compensate);
      for (const e of Array.isArray(result?.effects) ? result.effects : []) {
        const effect: AppliedEffect = {
          tool: typeof e?.tool === 'string' ? e.tool : p.action.tool,
          summary: { ...(e?.summary ?? {}) },
        };
        effects.push(effect);
        await this.audit(tx, input, p.action, effect);
      }
    }

    // DERNIÈRE opération de la transaction : 1 -> 2 (CAS), atomique avec les effets.
    const done = await this.store.transitionProposal({
      proposalId,
      expectedRowVersion: proposal.rowVersion,
      expectedStatus: AsstProposalStatus.Confirmed,
      to: AsstProposalStatus.Applied,
      result: { effects: effects.map((e) => ({ tool: e.tool, summary: { ...e.summary } })) },
      now,
      db: tx,
    });
    if (!done) throw new AsstStateLostError();
    return done;
  }

  /** Traçabilité DANS la transaction (atomique avec l'effet). Jamais de contenu de courrier ni de brouillon. */
  private async audit(
    tx: Prisma.TransactionClient,
    input: AsstEffectRunInput,
    action: AsstProposedAction,
    effect: AppliedEffect,
  ): Promise<void> {
    const user = input.identity.user;
    const proposalId = input.proposal.proposalId;
    const mailId = effect.summary['mailId'];
    const objectRef =
      typeof mailId === 'number' && Number.isSafeInteger(mailId) ? `mail:${mailId}` : `asst_proposal:${proposalId}`;
    const parts = ['via assistant', `proposition ${proposalId}`, `outil ${effect.tool}`];
    if (action.tool === AsstActionTool.BrouillonReponse && action.args.decisionId !== undefined) {
      // Décision IA : identifiant tracé seulement (la revue `AiDecisionService` vise le classement, pas ce cas).
      parts.push(`décision IA ${action.args.decisionId}`);
    }
    parts.push(JSON.stringify(effect.summary));
    await tx.dataChangeAudit.create({
      data: {
        userGroupId: user.userGroupId,
        actorFullName: truncate(user.fullName ?? user.username, ACTOR_NAME_MAX),
        objectRef: truncate(objectRef, OBJECT_REF_MAX),
        newValue: parts.join(' ; '),
      },
    });
  }

  /** Compensations en ordre INVERSE, chacune isolée : ne lève jamais ; une seule passe. */
  private async compensate(compensations: Array<() => Promise<void>>, proposalId: string): Promise<void> {
    const list = compensations.splice(0, compensations.length).reverse();
    for (const fn of list) {
      try {
        await fn();
      } catch (err) {
        this.logger.warn(`compensation en échec (proposition ${proposalId}) : ${errorName(err)}`);
      }
    }
  }

  private toFailure(err: unknown, proposalId: string): AsstRunFailure {
    if (err instanceof AsstPreflightRefusal) {
      return { kind: 'failed', errorCode: safeCode(err.code), message: err.message };
    }
    if (err instanceof EffectRefusedError) {
      const code = safeCode(err.code);
      return { kind: FORBIDDEN_CODES.has(code) ? 'forbidden' : 'failed', errorCode: code, message: err.message };
    }
    if (err instanceof AsstStateLostError) {
      this.logger.warn(`transition finale perdue (proposition ${proposalId}) : effets annulés`);
      return { kind: 'failed', errorCode: 'proposal_state_changed', message: STATE_LOST_MESSAGE };
    }
    this.logger.error(`exécution en échec (proposition ${proposalId}) : ${errorName(err)}`);
    return { kind: 'failed', errorCode: 'effect_failed', message: TECHNICAL_MESSAGE };
  }
}

/** Cibles à verrouiller : courriers et imputations DISTINCTS, triés par ordre croissant. */
export function lockTargets(actions: readonly AsstProposedAction[]): {
  mailIds: number[];
  inputationIds: number[];
  firstMailId: number | null;
} {
  const mails = new Set<number>();
  const inputations = new Set<number>();
  let firstMailId: number | null = null;
  for (const action of actions) {
    const args = (action?.args ?? {}) as Record<string, unknown>;
    const mailId = args['mailId'];
    if (isPositiveInt(mailId)) {
      mails.add(mailId);
      if (firstMailId === null) firstMailId = mailId;
    }
    const inputationId = args['mailInputationId'];
    if (isPositiveInt(inputationId)) inputations.add(inputationId);
  }
  const asc = (a: number, b: number): number => a - b;
  return { mailIds: [...mails].sort(asc), inputationIds: [...inputations].sort(asc), firstMailId };
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function safeCode(code: unknown): string {
  return typeof code === 'string' && code.length <= ERROR_CODE_MAX && ERROR_CODE_PATTERN.test(code) ? code : 'effect_failed';
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max);
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : 'erreur inconnue';
}
