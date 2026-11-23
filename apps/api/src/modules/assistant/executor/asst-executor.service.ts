import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  AsstProposalStatus,
  asstProposedActionsSchema,
  isAsstProposalExpired,
  type AsstConfirmProposalBody,
  type AsstProposalDto,
} from '@archivage/types';
import { PrismaService } from '../../prisma/prisma.service';
import { ActionApplierRegistry } from '../../workflow-agent-catalog/appliers/action-applier.registry';
import { ApplierRightsService } from '../../workflow-agent-catalog/appliers/applier-rights';
import {
  ASST_IDENTITY,
  ASST_PROPOSAL_STORE,
  AsstError,
  type AsstExecutorPort,
  type AsstIdentity,
  type AsstIdentityPort,
  type AsstProposalStore,
} from '../assistant.contracts';
import { asstActionsHash } from './asst-actions-hash';
import { AsstConfirmLimiter } from './asst-confirm-limiter';
import { AsstEffectRunner } from './asst-effect-runner';

const NOT_FOUND = 'Proposition introuvable.';
const OTHER_ACTOR = 'Identité refusée : cette proposition a été préparée pour un autre de vos profils.';
const NOT_PENDING = "Cette proposition n'est plus en attente de confirmation.";
const EXPIRED = 'Cette proposition a expiré : reformulez la demande.';
const HASH_CONFLICT =
  'Le contenu de la proposition a changé depuis son affichage : relisez-la puis confirmez à nouveau.';
const INVALID_CONTENT =
  "Le contenu de la proposition n'est plus valide : relisez-la, puis refusez-la ou reformulez la demande.";
const CONCURRENT_CONFIRM =
  "Cette proposition vient d'être traitée par une autre confirmation : relisez-la pour voir son état.";
const CONCURRENT_REFUSE =
  "Cette proposition vient d'être modifiée par une autre opération : relisez-la pour voir son état.";
const INTERRUPTED_MESSAGE =
  "L'exécution a été interrompue : aucun effet sur les courriers n'a été validé. Vérifiez l'état (un brouillon a pu être créé) puis refaites la demande.";

const ERROR_MESSAGE_MAX = 1_000;
const REASON_LOG_MAX = 500;
/** Délai de grâce avant de considérer une exécution « confirmée » comme interrompue. */
const DEFAULT_INTERRUPT_GRACE_MS = 120_000;

/**
 * Exécuteur des propositions de l'assistant (port `AsstExecutorPort`, lot A2).
 *
 * Confirmation : identité RELUE en base, limiteur, propriété (`not_found`), acteur (`identity_refused`), statut,
 * échéance, revalidation du contenu et du hash, CAS 0 -> 1, puis exécution transactionnelle (`AsstEffectRunner`) avec
 * les droits de l'utilisateur seul ; succès 1 -> 2 (dans la transaction des effets), échec 1 -> 5 (hors transaction).
 * Aucun e-mail n'est envoyé ; aucun journal ne contient de contenu de courrier ni de brouillon.
 */
@Injectable()
export class AsstExecutorService implements AsstExecutorPort {
  private readonly logger = new Logger(AsstExecutorService.name);
  private readonly runner: AsstEffectRunner;

  /** Horloge (remplaçable en test). */
  clock: () => Date = () => new Date();

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ActionApplierRegistry,
    private readonly rightsFactory: ApplierRightsService,
    @Inject(ASST_IDENTITY) private readonly identityPort: AsstIdentityPort,
    @Inject(ASST_PROPOSAL_STORE) private readonly store: AsstProposalStore,
    private readonly limiter: AsstConfirmLimiter,
  ) {
    this.runner = new AsstEffectRunner(this.prisma, this.registry, this.rightsFactory, this.store);
  }

  // ---------------------------------------------------------------------------
  // Confirmer
  // ---------------------------------------------------------------------------

  async confirm(identity: AsstIdentity, proposalId: string, body: AsstConfirmProposalBody): Promise<AsstProposalDto> {
    // 1. Identité relue en base : seule celle-ci est utilisée ensuite.
    const id = await this.identityPort.resolve(identity.user);
    const now = this.clock();
    const userId = id.user.userId;

    // 2. Limiteur (avant toute lecture du magasin).
    this.limiter.consume(userId, now);

    // 3. Propriété et acteur.
    const proposal = await this.ownedProposal(id, proposalId);

    // 4. Statut.
    if (proposal.status !== AsstProposalStatus.Proposed) {
      throw new AsstError('proposal_not_pending', NOT_PENDING, undefined, proposal);
    }

    // 5. Échéance : la proposition est close (meilleur effort) puis refusée.
    if (isAsstProposalExpired(proposal.expiresAt, now)) {
      const closed = await this.tryExpire(proposal, now);
      throw new AsstError('proposal_expired', EXPIRED, undefined, closed ?? undefined);
    }

    // 6. Revalidation stricte du contenu stocké et du lien au contenu affiché. Aucune écriture.
    const parsed = asstProposedActionsSchema.safeParse(proposal.actions);
    if (!parsed.success) throw new AsstError('conflict', INVALID_CONTENT);
    const recomputed = asstActionsHash(parsed.data);
    if (body.argsHash !== proposal.argsHash || recomputed !== proposal.argsHash) {
      throw new AsstError('conflict', HASH_CONFLICT);
    }

    // 7. CAS 0 -> 1 : une seule confirmation concurrente gagne.
    let confirmed: AsstProposalDto | null;
    try {
      confirmed = await this.store.transitionProposal({
        proposalId: proposal.proposalId,
        expectedRowVersion: proposal.rowVersion,
        expectedStatus: AsstProposalStatus.Proposed,
        to: AsstProposalStatus.Confirmed,
        now,
      });
    } catch (err) {
      // Le déclencheur refuse 0 -> 1 sur une proposition échue entre-temps.
      const fresh = await this.store.getProposal(userId, proposal.proposalId);
      if (fresh && fresh.status === AsstProposalStatus.Proposed && isAsstProposalExpired(fresh.expiresAt, this.clock())) {
        const closed = await this.tryExpire(fresh, this.clock());
        throw new AsstError('proposal_expired', EXPIRED, undefined, closed ?? undefined);
      }
      throw err;
    }
    if (!confirmed) throw new AsstError('conflict', CONCURRENT_CONFIRM);

    // 8. Arrêt d'urgence : journalisé, n'empêche pas d'appliquer une proposition déjà préparée et confirmée.
    await this.logEmergencyStop(confirmed.proposalId);

    // 9. Exécution transactionnelle.
    const outcome = await this.runner.run({ identity: id, proposal: confirmed, actions: parsed.data, now });
    if (outcome.ok) return outcome.proposal;

    const failure = outcome.failure;
    if (failure.kind === 'uncertain') {
      // Issue ambiguë : on ne clôt PAS la proposition (elle a pu être appliquée) ; le balayage tranchera.
      const current = await this.store.getProposal(userId, confirmed.proposalId).catch(() => null);
      throw new AsstError('effect_failed', failure.message, { outcome: 'uncertain' }, current ?? undefined);
    }
    const failed = await this.markFailed(userId, confirmed, failure.errorCode, failure.message, now);
    throw new AsstError(failure.kind === 'forbidden' ? 'effect_forbidden' : 'effect_failed', failure.message, undefined, failed);
  }

  // ---------------------------------------------------------------------------
  // Refuser
  // ---------------------------------------------------------------------------

  async refuse(identity: AsstIdentity, proposalId: string, reason?: string): Promise<AsstProposalDto> {
    const id = await this.identityPort.resolve(identity.user);
    const now = this.clock();
    const proposal = await this.ownedProposal(id, proposalId);
    if (proposal.status !== AsstProposalStatus.Proposed) {
      throw new AsstError('proposal_not_pending', NOT_PENDING, undefined, proposal);
    }
    if (isAsstProposalExpired(proposal.expiresAt, now)) {
      const closed = await this.tryExpire(proposal, now);
      throw new AsstError('proposal_expired', EXPIRED, undefined, closed ?? undefined);
    }
    const refused = await this.store.transitionProposal({
      proposalId: proposal.proposalId,
      expectedRowVersion: proposal.rowVersion,
      expectedStatus: AsstProposalStatus.Proposed,
      to: AsstProposalStatus.Refused,
      now,
    });
    if (!refused) throw new AsstError('conflict', CONCURRENT_REFUSE);
    const motive = sanitizeReason(reason);
    this.logger.log(
      motive === null
        ? `proposition ${refused.proposalId} refusée`
        : `proposition ${refused.proposalId} refusée ; motif : ${motive}`,
    );
    return refused;
  }

  // ---------------------------------------------------------------------------
  // Lire
  // ---------------------------------------------------------------------------

  async get(identity: AsstIdentity, proposalId: string): Promise<AsstProposalDto> {
    const id = await this.identityPort.resolve(identity.user);
    const now = this.clock();
    const proposal = await this.store.getProposal(id.user.userId, proposalId);
    if (!proposal) throw new AsstError('not_found', NOT_FOUND);
    if (proposal.status !== AsstProposalStatus.Proposed || !isAsstProposalExpired(proposal.expiresAt, now)) {
      return proposal;
    }
    const closed = await this.tryExpire(proposal, now);
    if (closed) return closed;
    const fresh = (await this.safeGet(id.user.userId, proposal.proposalId)) ?? proposal;
    // Clôture impossible à l'instant : la proposition échue est PRÉSENTÉE comme expirée (aucun bouton Confirmer).
    if (fresh.status === AsstProposalStatus.Proposed && isAsstProposalExpired(fresh.expiresAt, now)) {
      return { ...fresh, status: AsstProposalStatus.Expired };
    }
    return fresh;
  }

  // ---------------------------------------------------------------------------
  // Jobs
  // ---------------------------------------------------------------------------

  async expireDue(now: Date, limit: number): Promise<number> {
    const due = await this.store.listExpirableProposals(now, limit);
    let count = 0;
    for (const p of due) {
      try {
        const done = await this.store.transitionProposal({
          proposalId: p.proposalId,
          expectedRowVersion: p.rowVersion,
          expectedStatus: AsstProposalStatus.Proposed,
          to: AsstProposalStatus.Expired,
          now,
        });
        if (done) count += 1;
      } catch (err) {
        this.logger.warn(`expiration de la proposition ${p.proposalId} en échec : ${errorName(err)}`);
      }
    }
    return count;
  }

  /**
   * Clôt en « échec » (`execution_interrupted`) les propositions restées « confirmées » depuis plus de `graceMs` :
   * effets et transition 1 -> 2 étant dans UNE transaction, un statut 1 durable signifie que rien n'a été validé
   * (hors brouillons, non transactionnels). Retourne le nombre de propositions closes.
   */
  async recoverInterrupted(now: Date, limit: number, graceMs: number = DEFAULT_INTERRUPT_GRACE_MS): Promise<number> {
    const before = new Date(now.getTime() - graceMs);
    const stale = await this.store.listStaleConfirmedProposals(before, limit);
    let count = 0;
    for (const p of stale) {
      try {
        const done = await this.store.transitionProposal({
          proposalId: p.proposalId,
          expectedRowVersion: p.rowVersion,
          expectedStatus: AsstProposalStatus.Confirmed,
          to: AsstProposalStatus.Failed,
          errorCode: 'execution_interrupted',
          errorMessage: INTERRUPTED_MESSAGE,
          now,
        });
        if (done) {
          count += 1;
          this.logger.warn(`proposition ${p.proposalId} : exécution interrompue, close en échec`);
        }
      } catch (err) {
        this.logger.warn(`reprise de la proposition ${p.proposalId} en échec : ${errorName(err)}`);
      }
    }
    return count;
  }

  // ---------------------------------------------------------------------------
  // Internes
  // ---------------------------------------------------------------------------

  /** Proposition de l'utilisateur (sinon `not_found`), préparée pour l'acteur courant (sinon `identity_refused`). */
  private async ownedProposal(id: AsstIdentity, proposalId: string): Promise<AsstProposalDto> {
    const userId = id.user.userId;
    const proposal = await this.store.getProposal(userId, proposalId);
    if (!proposal) throw new AsstError('not_found', NOT_FOUND);
    const actor = await this.store.getProposalActor(userId, proposalId);
    if (!actor) throw new AsstError('not_found', NOT_FOUND);
    if (actor.userId !== userId || actor.userGroupId !== id.user.userGroupId) {
      throw new AsstError('identity_refused', OTHER_ACTOR);
    }
    return proposal;
  }

  /** Transition 0 -> 4 en meilleur effort : `null` si le CAS est perdu ou si le magasin refuse. */
  private async tryExpire(proposal: AsstProposalDto, now: Date): Promise<AsstProposalDto | null> {
    try {
      return await this.store.transitionProposal({
        proposalId: proposal.proposalId,
        expectedRowVersion: proposal.rowVersion,
        expectedStatus: AsstProposalStatus.Proposed,
        to: AsstProposalStatus.Expired,
        now,
      });
    } catch (err) {
      this.logger.warn(`clôture de la proposition échue ${proposal.proposalId} impossible : ${errorName(err)}`);
      return null;
    }
  }

  /** Transition 1 -> 5 hors transaction ; si elle échoue (balayage concurrent…), la proposition est relue. */
  private async markFailed(
    userId: number,
    confirmed: AsstProposalDto,
    errorCode: string,
    message: string,
    now: Date,
  ): Promise<AsstProposalDto | undefined> {
    try {
      const failed = await this.store.transitionProposal({
        proposalId: confirmed.proposalId,
        expectedRowVersion: confirmed.rowVersion,
        expectedStatus: AsstProposalStatus.Confirmed,
        to: AsstProposalStatus.Failed,
        errorCode,
        errorMessage: message.slice(0, ERROR_MESSAGE_MAX),
        now,
      });
      if (failed) return failed;
    } catch (err) {
      this.logger.warn(`passage en échec de la proposition ${confirmed.proposalId} impossible : ${errorName(err)}`);
    }
    return (await this.safeGet(userId, confirmed.proposalId)) ?? undefined;
  }

  private async safeGet(userId: number, proposalId: string): Promise<AsstProposalDto | null> {
    try {
      return await this.store.getProposal(userId, proposalId);
    } catch (err) {
      this.logger.warn(`relecture de la proposition ${proposalId} impossible : ${errorName(err)}`);
      return null;
    }
  }

  /** Journalise l'arrêt d'urgence global s'il est actif ; une lecture en échec ne bloque pas. */
  private async logEmergencyStop(proposalId: string): Promise<void> {
    try {
      const budget = await this.prisma.wfBudget.findFirst({
        where: { definitionId: null },
        select: { emergencyStop: true },
      });
      if (budget?.emergencyStop === true) {
        this.logger.warn(
          `arrêt d'urgence actif : la proposition ${proposalId}, déjà préparée et confirmée, est appliquée quand même`,
        );
      }
    } catch (err) {
      this.logger.warn(`lecture de l'arrêt d'urgence impossible (proposition ${proposalId}) : ${errorName(err)}`);
    }
  }
}

/** Motif de refus pour le journal : une ligne, sans caractères de contrôle, au plus 500 caractères. */
function sanitizeReason(reason: string | undefined): string | null {
  if (typeof reason !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const flat = reason.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return flat === '' ? null : flat.slice(0, REASON_LOG_MAX);
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : 'erreur inconnue';
}
