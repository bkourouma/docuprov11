import {
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  DocumentState,
  GED_GOVERNANCE_PROMPT_VERSION,
  GedAiDecisionStatus,
  GOVERNANCE_KIND_LABELS,
  GOVERNANCE_KIND_TASK,
  GovernanceKind,
  parseGovernanceOutput,
  type GovernanceApplied,
  type GovernanceDuplicateOutput,
  type GovernanceOutput,
  type GovernanceSensitivityOutput,
  type GovernanceValidateRequest,
} from '@archivage/types';
import { AuditService, type DataChangeEntry } from '../audit/audit.service';
import { actorName, DocumentsService } from '../documents/documents.service';
import type { AuthUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Revue HUMAINE des propositions de gouvernance (lot 5) : validation (avec effet) ou rejet.
 *
 * Ne passe PAS par `AiDecisionService.review` : celui-ci appliquerait le patch du socle IA et
 * ignorerait les règles ci-dessous. Aucune voie automatique : rien ici n'est appelé par le worker,
 * et une proposition ne modifie un document qu'après une validation explicite d'un humain.
 *
 * Règles (accès refusé par défaut) :
 *  - 404 IDENTIQUE pour une proposition introuvable, hors périmètre (prompt_version, tâche, nature,
 *    `output` non conforme), au document supprimé, ou NON VISIBLE (document — et original pour un
 *    doublon — inexistant ou non ouvrable par `DocumentsService.canAccess`). Jamais de 403 à ce
 *    stade : il révélerait l'existence de la proposition.
 *  - EXCEPTION (rejet seulement) : un ADMINISTRATEUR humain peut REJETER une proposition ORPHELINE
 *    (document supprimé, ou doublon dont l'original est supprimé), invisible pour tous sinon. Jamais
 *    de validation d'un orphelin (404), jamais pour un non-administrateur ni l'agent de numérisation.
 *  - 409 si la proposition n'est plus « proposée » ; la revendication est ATOMIQUE
 *    (`updateMany ... where status = Proposée`) dans la transaction : de deux validations
 *    simultanées, une seule réussit.
 *  - 403 si le droit est insuffisant (le document est déjà prouvé accessible : rien n'est révélé).
 *    Doublon : niveau effectif >= 3 sur le doublon (et accès à l'original) ; données
 *    personnelles : >= 2 ; sensibilité : >= 3, et pour un ABAISSEMENT administrateur, ou niveau 5
 *    avec un rang de confidentialité propre >= rang courant du document, plus `confirmLowering`.
 *  - La direction (élévation / abaissement) est RECALCULÉE dans la transaction à partir de l'état
 *    VIVANT du document, verrouillé (`FOR UPDATE`), et du rang du niveau proposé relu en base
 *    (niveau désactivé ou disparu : 409, proposition périmée). `output.direction` et
 *    `output.proposedRank` ne sont jamais crus.
 *  - Effets dans la MÊME transaction que le changement de statut ; `output.applied` validé par le
 *    schéma zod strict avant écriture. Tout échec annule l'ensemble (statut inchangé).
 *  - Journal d'audit après validation comme après rejet, sans donnée personnelle ; un échec
 *    d'audit APRÈS validation n'annule pas l'action (avertissement journalisé, sans contenu).
 *
 * LIMITE : les tests (`governance-review.service.spec.ts`) utilisent un faux Prisma en mémoire
 * qui sérialise les transactions et restaure l'état en cas d'erreur, comme le ferait PostgreSQL.
 * Ils prouvent l'enchaînement des règles et des écritures ; ils ne prouvent pas le comportement
 * réel des verrous `FOR UPDATE` ni de l'isolation PostgreSQL (test d'intégration requis).
 */

/** Code exposé dans le message quand un abaissement n'est pas confirmé (l'interface le détecte). */
export const GOVERNANCE_LOWERING_CONFIRMATION_REQUIRED = 'LOWERING_CONFIRMATION_REQUIRED';

/** Niveau de permission minimal pour MODIFIER un document (1 refus, 2 consultation, 3 modification). */
const LEVEL_CONSULTATION = 2;
const LEVEL_MODIFICATION = 3;
const LEVEL_ARCHIVISTIQUE = 5;

const NOT_FOUND_MESSAGE = 'Proposition de gouvernance introuvable.';
const ALREADY_REVIEWED_MESSAGE = 'Cette proposition a déjà été traitée.';
const CONCURRENT_REVIEW_MESSAGE = "Cette proposition vient d'être traitée par un autre utilisateur.";

interface VisibleProposal {
  decisionId: bigint;
  /** Document concerné (pour un doublon : le DOUBLON). */
  documentId: number;
  status: number;
  output: GovernanceOutput;
  /** Doublons uniquement. */
  originalDocumentId: number | null;
}

/** Proposition chargée pour un rejet : le document concerné peut être absent (orphelin). */
interface ReviewableProposal extends Omit<VisibleProposal, 'documentId'> {
  documentId: number | null;
  orphan: boolean;
}

/** Ligne verrouillée de `document` (noms de colonnes SQL). */
interface LockedDocumentRow {
  document_id: number;
  confidentialite_id: number | null;
  is_frozen: boolean;
  document_state: number;
}

/** Résultat d'une validation, de quoi écrire l'audit après validation de la transaction. */
interface ValidationOutcome {
  applied: GovernanceApplied | null;
  audit: Pick<DataChangeEntry, 'objectRef' | 'oldValue' | 'newValue'>;
}

const isDuplicate = (o: GovernanceOutput): o is GovernanceDuplicateOutput =>
  o.kind === GovernanceKind.DoublonExact || o.kind === GovernanceKind.QuasiDoublon;

const isSensitivity = (o: GovernanceOutput): o is GovernanceSensitivityOutput =>
  o.kind === GovernanceKind.Sensibilite;

@Injectable()
export class GovernanceReviewService {
  private readonly logger = new Logger(GovernanceReviewService.name);

  constructor(
    protected readonly prisma: PrismaService,
    protected readonly documents: DocumentsService,
    protected readonly audit: AuditService,
  ) {}

  /** Valide une proposition et applique son effet (doublon : gel ; sensibilité : niveau ; pii : rien). */
  async validate(
    id: number,
    user: AuthUser,
    body: GovernanceValidateRequest,
  ): Promise<{ applied: GovernanceApplied | null }> {
    const proposal = await this.loadVisible(id, user);
    this.assertProposed(proposal);

    const level = await this.documents.getEffectivePermissionLevel(proposal.documentId, user);
    // Document supprimé entre-temps : même réponse qu'une proposition invisible.
    if (level == null) throw new NotFoundException(NOT_FOUND_MESSAGE);
    // Comparaison stricte : seul le booléen `true` vaut confirmation.
    const confirmLowering = body?.confirmLowering === true;

    const output = proposal.output;
    let outcome: ValidationOutcome;
    if (isDuplicate(output)) {
      if (level < LEVEL_MODIFICATION) {
        throw new ForbiddenException(
          'Archiver un doublon exige le droit de modification sur ce document.',
        );
      }
      outcome = await this.prisma.$transaction((tx) =>
        this.validateDuplicate(tx, proposal, output, user),
      );
    } else if (isSensitivity(output)) {
      outcome = await this.prisma.$transaction((tx) =>
        this.validateSensitivity(tx, proposal, output, user, level, confirmLowering),
      );
    } else {
      if (level < LEVEL_CONSULTATION) {
        throw new ForbiddenException('Droit de consultation requis sur ce document.');
      }
      outcome = await this.prisma.$transaction(async (tx) => {
        await this.claim(tx, proposal.decisionId, GedAiDecisionStatus.Validee, user);
        return {
          applied: null,
          audit: {
            objectRef: `governance:${proposal.decisionId.toString()}`,
            oldValue: 'proposée',
            newValue: `validée (données personnelles : prise d'acte, document #${proposal.documentId})`,
          },
        };
      });
    }

    await this.writeAudit(proposal.decisionId, user, outcome.audit);
    return { applied: outcome.applied };
  }

  /**
   * Rejette une proposition : aucun effet sur le document. Un administrateur peut aussi rejeter une
   * proposition ORPHELINE (document ou original supprimé) ; jamais la valider.
   */
  async reject(id: number, user: AuthUser): Promise<void> {
    const proposal = await this.loadForReview(id, user, true);
    this.assertProposed(proposal);

    await this.prisma.$transaction((tx) =>
      this.claim(tx, proposal.decisionId, GedAiDecisionStatus.Rejetee, user),
    );

    const target = proposal.orphan
      ? 'proposition orpheline, document supprimé'
      : `document #${proposal.documentId}`;
    await this.writeAudit(proposal.decisionId, user, {
      objectRef: `governance:${proposal.decisionId.toString()}`,
      oldValue: 'proposée',
      newValue: `rejet (${GOVERNANCE_KIND_LABELS[proposal.output.kind]}, ${target})`,
    });
  }

  // --- Chargement et visibilité -----------------------------------------------------------------

  /** Charge une proposition de gouvernance VISIBLE par `user`, sinon 404 (sans distinguer pourquoi). */
  private async loadVisible(id: number, user: AuthUser): Promise<VisibleProposal> {
    const proposal = await this.loadForReview(id, user, false);
    if (proposal.documentId == null) throw new NotFoundException(NOT_FOUND_MESSAGE);
    return { ...proposal, documentId: proposal.documentId };
  }

  /**
   * Charge une proposition pour revue. `allowOrphan` (rejet) : un ADMINISTRATEUR humain obtient une
   * proposition orpheline (document absent, ou original d'un doublon absent) avec `orphan: true` ;
   * tout autre cas d'orphelin reste 404. Une proposition NON orpheline reste soumise à `canAccess`.
   */
  private async loadForReview(
    id: number,
    user: AuthUser,
    allowOrphan: boolean,
  ): Promise<ReviewableProposal> {
    this.assertActor(user);
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
      throw new NotFoundException(NOT_FOUND_MESSAGE);
    }

    const row = await this.prisma.gedAiDecision.findUnique({
      where: { gedAiDecisionId: BigInt(id) },
      select: {
        gedAiDecisionId: true,
        documentId: true,
        task: true,
        promptVersion: true,
        output: true,
        status: true,
      },
    });
    if (!row || row.promptVersion !== GED_GOVERNANCE_PROMPT_VERSION) {
      throw new NotFoundException(NOT_FOUND_MESSAGE);
    }
    const output = parseGovernanceOutput(row.output);
    if (!output || row.task !== GOVERNANCE_KIND_TASK[output.kind]) {
      throw new NotFoundException(NOT_FOUND_MESSAGE);
    }
    // Doublon incohérent (le doublon désigné n'est pas le document de la proposition) : hors périmètre.
    if (row.documentId != null && isDuplicate(output) && output.duplicateDocumentId !== row.documentId) {
      throw new NotFoundException(NOT_FOUND_MESSAGE);
    }
    const originalDocumentId = isDuplicate(output) ? output.originalDocumentId : null;
    const base = { decisionId: row.gedAiDecisionId, status: row.status, output, originalDocumentId };

    const documentExists =
      row.documentId != null && (await this.documentExists(row.documentId));
    const originalExists =
      originalDocumentId == null || (await this.documentExists(originalDocumentId));
    if (!documentExists || !originalExists) {
      // Orphelin : invisible pour tous, sauf rejet par un administrateur humain (assertActor a déjà
      // écarté l'agent de numérisation).
      if (allowOrphan && user.isAdmin === true) {
        return { ...base, documentId: row.documentId, orphan: true };
      }
      throw new NotFoundException(NOT_FOUND_MESSAGE);
    }

    const documentId = row.documentId as number;
    if (!(await this.documents.canAccess(documentId, user))) {
      throw new NotFoundException(NOT_FOUND_MESSAGE);
    }
    if (originalDocumentId != null && !(await this.documents.canAccess(originalDocumentId, user))) {
      throw new NotFoundException(NOT_FOUND_MESSAGE);
    }
    return { ...base, documentId, orphan: false };
  }

  private async documentExists(documentId: number): Promise<boolean> {
    const exists = await this.prisma.document.findUnique({
      where: { documentId },
      select: { documentId: true },
    });
    return exists != null;
  }

  /**
   * Identité exigée : un utilisateur humain authentifié. L'agent de numérisation (identité
   * machine) ne revoit jamais une proposition : aucune voie automatique.
   */
  private assertActor(user: AuthUser): void {
    if (
      user == null ||
      typeof user !== 'object' ||
      typeof user.userId !== 'number' ||
      !Number.isSafeInteger(user.userId) ||
      user.isScanAgent === true ||
      (user.isAdmin !== true && user.userId <= 0)
    ) {
      throw new ForbiddenException('Revue réservée à un utilisateur authentifié.');
    }
  }

  private assertProposed(proposal: { status: number }): void {
    if (proposal.status !== GedAiDecisionStatus.Proposee) {
      throw new ConflictException(ALREADY_REVIEWED_MESSAGE);
    }
  }

  // --- Transaction : revendication et effets ----------------------------------------------------

  /** Revendication ATOMIQUE : seule la première revue d'une proposition « proposée » réussit. */
  private async claim(
    tx: Prisma.TransactionClient,
    decisionId: bigint,
    status: typeof GedAiDecisionStatus.Validee | typeof GedAiDecisionStatus.Rejetee,
    user: AuthUser,
  ): Promise<void> {
    const claimed = await tx.gedAiDecision.updateMany({
      where: { gedAiDecisionId: decisionId, status: GedAiDecisionStatus.Proposee },
      data: { status, validatedBy: user.userGroupId, validatedAt: new Date() },
    });
    if (claimed.count === 0) throw new ConflictException(CONCURRENT_REVIEW_MESSAGE);
  }

  /** Verrouille les documents (ordre croissant des identifiants : pas d'interblocage entre revues). */
  private async lockDocuments(
    tx: Prisma.TransactionClient,
    documentIds: number[],
  ): Promise<Map<number, LockedDocumentRow>> {
    const ids = [...new Set(documentIds)].sort((x, y) => x - y);
    const rows = await tx.$queryRaw<LockedDocumentRow[]>(Prisma.sql`
      SELECT document_id, confidentialite_id, is_frozen, document_state
      FROM document
      WHERE document_id IN (${Prisma.join(ids)})
      ORDER BY document_id
      FOR UPDATE`);
    return new Map(rows.map((r) => [Number(r.document_id), r]));
  }

  /** Doublon : archivage LOGIQUE (gel), jamais de suppression. Idempotent si déjà gelé. */
  private async validateDuplicate(
    tx: Prisma.TransactionClient,
    proposal: VisibleProposal,
    output: GovernanceDuplicateOutput,
    user: AuthUser,
  ): Promise<ValidationOutcome> {
    const duplicateId = proposal.documentId;
    const originalId = output.originalDocumentId;
    if (originalId === duplicateId) {
      throw new ConflictException('Un document ne peut pas être le doublon de lui-même.');
    }

    const locked = await this.lockDocuments(tx, [duplicateId, originalId]);
    const duplicate = locked.get(duplicateId);
    if (!duplicate) throw new NotFoundException(NOT_FOUND_MESSAGE);
    const original = locked.get(originalId);
    if (!original) throw new ConflictException('Document original introuvable : proposition périmée.');
    if (Number(duplicate.document_state) === DocumentState.Epure) {
      throw new ConflictException('Le doublon a été épuré : archivage impossible.');
    }
    // Décisions PRUDENTES (réversibles : il suffit de revalider plus tard) : ne jamais geler la
    // dernière copie vivante. Un original épuré, ou lui-même gelé (doublon d'un autre, ou paire
    // de propositions croisées A↔B), laisserait le contenu sans aucune copie consultable.
    if (Number(original.document_state) === DocumentState.Epure) {
      throw new ConflictException("L'original a été épuré : le doublon est conservé.");
    }
    if (original.is_frozen) {
      throw new ConflictException("L'original est lui-même gelé : le doublon est conservé.");
    }

    await this.claim(tx, proposal.decisionId, GedAiDecisionStatus.Validee, user);

    const wasFrozen = duplicate.is_frozen === true;
    if (!wasFrozen) {
      const now = new Date();
      const frozen = await tx.document.updateMany({
        where: {
          documentId: duplicateId,
          isFrozen: false,
          documentState: { not: DocumentState.Epure },
        },
        data: { isFrozen: true, modifiedBy: user.userGroupId, modifiedAt: now },
      });
      if (frozen.count !== 1) {
        throw new ConflictException('Le doublon a changé entre-temps : proposition périmée.');
      }
    }

    const applied: GovernanceApplied = {
      action: 'duplicate_archived',
      at: new Date().toISOString(),
      by: user.userGroupId,
    };
    await this.writeApplied(tx, proposal, applied);
    return {
      applied,
      audit: {
        objectRef: `document:${duplicateId}`,
        oldValue: wasFrozen ? 'gelé' : 'non gelé',
        newValue: `gelé (doublon du document #${originalId}, proposition de gouvernance #${proposal.decisionId.toString()} validée)`,
      },
    };
  }

  /** Sensibilité : pose le niveau proposé, direction recalculée sur l'état VIVANT. */
  private async validateSensitivity(
    tx: Prisma.TransactionClient,
    proposal: VisibleProposal,
    output: GovernanceSensitivityOutput,
    user: AuthUser,
    level: number,
    confirmLowering: boolean,
  ): Promise<ValidationOutcome> {
    const documentId = proposal.documentId;
    const decisionRef = proposal.decisionId.toString();

    const document = (await this.lockDocuments(tx, [documentId])).get(documentId);
    if (!document) throw new NotFoundException(NOT_FOUND_MESSAGE);

    const proposed = await tx.confidentialite.findFirst({
      where: { confidentialiteId: output.proposedConfidentialiteId, isActive: true },
      select: { confidentialiteId: true, rank: true, label: true },
    });
    if (!proposed) {
      throw new ConflictException(
        "Proposition périmée : le niveau de confidentialité proposé n'existe plus ou est désactivé.",
      );
    }

    const currentId = document.confidentialite_id == null ? null : Number(document.confidentialite_id);
    let current: { rank: number; label: string } | null = null;
    if (currentId != null) {
      current = await tx.confidentialite.findUnique({
        where: { confidentialiteId: currentId },
        select: { rank: true, label: true },
      });
      if (!current) {
        throw new ConflictException(
          'Proposition périmée : le niveau de confidentialité actuel du document est introuvable.',
        );
      }
    }

    // Toute validation de sensibilité modifie (ou confirme) la protection du document : droit de
    // modification exigé, y compris quand il n'y a finalement rien à changer.
    if (level < LEVEL_MODIFICATION) {
      throw new ForbiddenException(
        'Modifier la confidentialité exige le droit de modification sur ce document.',
      );
    }

    const direction: 'raise' | 'lower' | 'same' =
      current == null
        ? 'raise'
        : proposed.rank > current.rank
          ? 'raise'
          : proposed.rank < current.rank
            ? 'lower'
            : 'same';

    if (direction === 'lower') {
      // `current` est non nul ici (sinon élévation).
      const currentRank = (current as { rank: number }).rank;
      if (!(await this.mayLower(tx, user, level, currentRank))) {
        throw new ForbiddenException(
          "Abaisser la confidentialité est réservé à un administrateur, ou au niveau « archivistique » habilité au niveau actuel du document.",
        );
      }
      if (!confirmLowering) {
        throw new ConflictException(
          `${GOVERNANCE_LOWERING_CONFIRMATION_REQUIRED} : abaisser la confidentialité exige une confirmation explicite.`,
        );
      }
    }

    await this.claim(tx, proposal.decisionId, GedAiDecisionStatus.Validee, user);

    if (direction === 'same') {
      // Rien à changer : pas de nouvelle élévation inutile, aucune trace d'application.
      return {
        applied: null,
        audit: {
          objectRef: `governance:${decisionRef}`,
          oldValue: 'proposée',
          newValue: `validée (aucun changement : niveau déjà en place sur le document #${documentId})`,
        },
      };
    }

    // Écriture conditionnée par la valeur lue (défense en profondeur en plus du verrou).
    const updated = await tx.document.updateMany({
      where: { documentId, confidentialiteId: currentId },
      data: {
        confidentialiteId: proposed.confidentialiteId,
        modifiedBy: user.userGroupId,
        modifiedAt: new Date(),
      },
    });
    if (updated.count !== 1) {
      throw new ConflictException('Le document a changé entre-temps : proposition périmée.');
    }

    const applied: GovernanceApplied = {
      action: 'confidentiality_set',
      at: new Date().toISOString(),
      by: user.userGroupId,
      previousConfidentialiteId: currentId,
      loweredWithConfirmation: direction === 'lower',
    };
    await this.writeApplied(tx, proposal, applied);

    const describe = (label: string | null, id: number | null) =>
      id == null ? 'aucune' : `${label ?? '?'} (#${id})`;
    return {
      applied,
      audit: {
        objectRef: `document:${documentId}`,
        oldValue: `Confidentialité : ${describe(current?.label ?? null, currentId)}`,
        newValue:
          `Confidentialité : ${describe(proposed.label, proposed.confidentialiteId)} ` +
          `(proposition de gouvernance #${decisionRef} validée` +
          `${direction === 'lower' ? ', abaissement confirmé' : ''})`,
      },
    };
  }

  /**
   * Droit d'ABAISSER : administrateur, ou niveau effectif 5 (archivistique) avec un rang de
   * confidentialité PROPRE au moins égal au rang courant du document (on n'abaisse pas ce qu'on
   * n'est pas soi-même habilité à protéger).
   */
  private async mayLower(
    tx: Prisma.TransactionClient,
    user: AuthUser,
    level: number,
    currentRank: number,
  ): Promise<boolean> {
    if (user.isAdmin === true) return true;
    if (level < LEVEL_ARCHIVISTIQUE) return false;
    const account = await tx.appUser.findUnique({
      where: { userId: user.userId },
      select: { confidentialite: { select: { rank: true } } },
    });
    const ownRank = account?.confidentialite?.rank ?? null;
    return ownRank != null && ownRank >= currentRank;
  }

  /** Écrit `output.applied` (reste de `output` conservé), validé par le schéma strict. */
  private async writeApplied(
    tx: Prisma.TransactionClient,
    proposal: VisibleProposal,
    applied: GovernanceApplied,
  ): Promise<void> {
    const next = { ...proposal.output, applied };
    if (parseGovernanceOutput(next) === null) {
      // Lève dans la transaction : statut et effet sont annulés ensemble.
      throw new InternalServerErrorException("Trace d'application invalide : validation annulée.");
    }
    await tx.gedAiDecision.update({
      where: { gedAiDecisionId: proposal.decisionId },
      data: { output: next as Prisma.InputJsonValue },
    });
  }

  // --- Audit ------------------------------------------------------------------------------------

  /** Journal d'audit APRÈS validation de la transaction : un échec ici n'annule pas l'action. */
  private async writeAudit(
    decisionId: bigint,
    user: AuthUser,
    entry: Pick<DataChangeEntry, 'objectRef' | 'oldValue' | 'newValue'>,
  ): Promise<void> {
    try {
      await this.audit.dataChange({
        userGroupId: user.userGroupId,
        actorFullName: actorName(user),
        ...entry,
      });
    } catch {
      // Aucun contenu (ni message d'erreur, ni valeur) : seulement l'identifiant de la proposition.
      this.logger.warn(
        `Journal d'audit non écrit pour la proposition de gouvernance #${decisionId.toString()}.`,
      );
    }
  }
}
