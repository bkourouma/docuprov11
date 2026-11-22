import { PrismaClient } from '@prisma/client';
import {
  AsstActionTool,
  AsstMessageRole,
  AsstProposalStatus,
  type AsstProposalDto,
  type AsstProposedAction,
} from '@archivage/types';
import type { AuthUser } from '../../auth/auth.types';
import { MailsService } from '../../courriers/mails.service';
import { DocumentsService } from '../../documents/documents.service';
import type { PrismaService } from '../../prisma/prisma.service';
import { ActionApplierRegistry } from '../../workflow-agent-catalog/appliers/action-applier.registry';
import { ApplierRightsService } from '../../workflow-agent-catalog/appliers/applier-rights';
import { ImputableActorsService } from '../../workflow-agent-catalog/appliers/imputable-actors.service';
import { ImputationCourrierApplier } from '../../workflow-agent-catalog/appliers/imputation.applier';
import { RelanceApplier } from '../../workflow-agent-catalog/appliers/relance.applier';
import type { ActionApplier } from '../../workflow-agent-catalog/catalog.contracts';
import { AgentDataAdapter } from '../../workflow-agents/tools/agent-data.adapter';
import { AsstError, type AsstIdentity } from '../assistant.contracts';
import { AsstIdentityService } from '../identity/asst-identity.service';
import { asstActionsHash } from './asst-actions-hash';
import { AsstConfirmLimiter } from './asst-confirm-limiter';
import { AsstExecutorService } from './asst-executor.service';
import { PrismaTestProposalStore } from './testing/prisma-test-proposal-store';

// Test d'intégration PostgreSQL de l'exécuteur de propositions de l'assistant (lot A2) : vrai client Prisma, vrais
// verrous de ligne, vrai déclencheur `asst_proposal_guard`, vrais applicateurs d'imputation et de relance, vraie
// identité (relue en base), vrais droits (menus, lecture du courrier). Seul l'applicateur de brouillon est factice
// (aucun brouillon réel n'existe dans ce lot) ; le magasin est un magasin Prisma MINIMAL réservé aux tests.
//
// Ne s'exécute que si WF_TEST_DATABASE_URL est définie (JAMAIS la base de développement : refus si elle est égale à
// DATABASE_URL). Données de test préfixées TAG ; courriers, imputations, notifications, conversations et propositions
// sont supprimés en fin de suite, ainsi que les utilisateurs, groupes et rôles de test (une proposition restée
// « confirmée » est d'abord close en échec par la transition légale ; une erreur de nettoyage fait échouer la suite).
// Le journal d'audit est en ajout seul : ses lignes restent (leur `user_group_id` passe à NULL), accepté.
// À lancer en série (`-i`), cf. docs/workflow-moteur.md §8.2.

const url = process.env.WF_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
const title = url
  ? 'Exécuteur de l’assistant — intégration PostgreSQL'
  : 'Exécuteur de l’assistant — intégration PostgreSQL (IGNORÉ : définir WF_TEST_DATABASE_URL)';

const TAG = `asstx-${Date.now()}`;
const MIN = 60_000;
const IMPUTATION_MENUS = ['/courriers/parapheur', '/courriers/suivi'];

interface Actor {
  userId: number;
  userGroupId: number;
  roleId: number;
  auth: AuthUser;
  identity: AsstIdentity;
}

suite(title, () => {
  jest.setTimeout(120_000);

  let prisma: PrismaClient;
  let store: PrismaTestProposalStore;
  let registry: ActionApplierRegistry;
  let rights: ApplierRightsService;
  let identities: AsstIdentityService;
  let seq = 0;
  let recipient: Actor; // imputable
  let outsider: Actor; // non imputable (aucun menu courrier)
  const mailIds: number[] = [];

  /** Comportement du brouillon factice, repositionné par chaque test. */
  let brouillonMode: 'ok' | 'writes_then_throws' = 'ok';
  const compensateDraft = jest.fn(async () => undefined);

  /** Applicateur factice du brouillon : écrit une notification repérable via ctx.tx ; fournit un `compensate`. */
  const draftApplier: ActionApplier = {
    toolKey: AsstActionTool.BrouillonReponse,
    sideEffect: 1,
    parse: (args) => args,
    apply: async (ctx) => {
      await ctx.tx.notification.create({
        data: { recipientUserGroupId: recipient.userGroupId, message: `${TAG} brouillon`, targetType: 'asst-test' },
      });
      if (brouillonMode === 'writes_then_throws') throw new Error('Panne technique factice après écriture.');
      return {
        effects: [{ tool: AsstActionTool.BrouillonReponse, summary: { status: 'drafted' } }],
        compensate: compensateDraft,
      };
    },
  };

  beforeAll(async () => {
    if (process.env.DATABASE_URL && process.env.DATABASE_URL === url) {
      throw new Error('WF_TEST_DATABASE_URL pointe vers DATABASE_URL : refus de toucher la base de développement.');
    }
    prisma = new PrismaClient({ datasourceUrl: url });
    await prisma.$connect();

    // Référentiel des types d'imputation (valeurs figées du seed), créé seulement s'il manque.
    await prisma.mailInputationType.createMany({
      data: [
        { mailInputationTypeId: 5, label: 'Validation DG', suivi: false },
        { mailInputationTypeId: 10, label: 'Pour Suivi', suivi: true },
        { mailInputationTypeId: 14, label: 'Validation Direction', suivi: false },
        { mailInputationTypeId: 17, label: 'En copie', suivi: true },
      ],
      skipDuplicates: true,
    });

    recipient = await makeActor('destinataire', ['/courriers/suivi-dc']);
    outsider = await makeActor('sans-courrier', ['/ged/recherche']);

    registry = new ActionApplierRegistry();
    const actors = new ImputableActorsService(prisma as never);
    registry.register(new ImputationCourrierApplier(actors));
    registry.register(new RelanceApplier());
    registry.register(draftApplier);

    const mails = new MailsService(prisma as never, {} as never, {} as never);
    const adapter = new AgentDataAdapter(prisma as never, {} as never, {} as never, mails, new DocumentsService(prisma as never, {} as never, {} as never));
    rights = new ApplierRightsService(adapter);
    identities = new AsstIdentityService(prisma as unknown as PrismaService);
    store = new PrismaTestProposalStore(prisma);
  });

  afterAll(async () => {
    if (!prisma) return;
    try {
      const users = await prisma.appUser.findMany({ where: { username: { startsWith: TAG } }, select: { userId: true } });
      const userIds = users.map((u) => u.userId);
      const userGroupIds = (await prisma.appUserGroup.findMany({ where: { userId: { in: userIds } }, select: { userGroupId: true } })).map((g) => g.userGroupId);

      // Une proposition restée « confirmée » (1) ne peut pas être supprimée (déclencheur SQL) : on la clôt d'abord en
      // échec (1 -> 5) par la transition légale du magasin, comme le balayage de reprise le ferait.
      const stuck = await prisma.asstProposal.findMany({ where: { userId: { in: userIds }, status: AsstProposalStatus.Confirmed } });
      for (const p of stuck) {
        const closed = await store.transitionProposal({
          proposalId: String(p.asstProposalId),
          expectedRowVersion: p.rowVersion,
          expectedStatus: AsstProposalStatus.Confirmed,
          to: AsstProposalStatus.Failed,
          errorCode: 'execution_interrupted',
          errorMessage: 'Nettoyage de la suite de tests.',
          now: new Date(),
        });
        if (!closed) throw new Error(`nettoyage ${TAG} : proposition ${p.asstProposalId} non clôturable`);
      }

      await prisma.notification.deleteMany({
        where: {
          OR: [
            { message: { startsWith: TAG } },
            { targetType: 'mail', targetId: { in: mailIds } },
            { recipientUserGroupId: { in: userGroupIds } },
          ],
        },
      });
      await prisma.mail.deleteMany({ where: { mailId: { in: mailIds } } }); // supprime aussi les imputations (cascade)
      // Conversations de test : la garde SQL exige purge_at échue pour une trace d'exécution (statuts 2 et 5).
      // `purge_at` ne peut précéder `created_at` (CHECK) : on l'y ramène ; `timestamptz(0)` arrondit, d'où la courte attente.
      await new Promise((resolve) => setTimeout(resolve, 1100));
      await prisma.$executeRaw`UPDATE asst_conversation SET purge_at = created_at WHERE user_id = ANY(${userIds}::int[])`;
      await prisma.asstConversation.deleteMany({ where: { userId: { in: userIds } } }); // cascade : messages, propositions
      // Utilisateurs (cascade : liens utilisateur-groupe ; les lignes d'audit passent à user_group_id NULL), puis groupes et rôles.
      await prisma.appUser.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.appGroup.deleteMany({ where: { name: { startsWith: TAG } } });
      await prisma.role.deleteMany({ where: { name: { startsWith: TAG } } }); // cascade : menus du rôle
    } finally {
      // Un nettoyage en échec FAIT ÉCHOUER la suite (l'erreur remonte) ; la connexion est fermée dans tous les cas.
      await prisma.$disconnect();
    }
  });

  beforeEach(() => {
    compensateDraft.mockClear();
    brouillonMode = 'ok';
  });

  // ---------------------------------------------------------------------------
  // Aides
  // ---------------------------------------------------------------------------

  async function makeActor(key: string, menus: string[]): Promise<Actor> {
    seq += 1;
    const group = await prisma.appGroup.create({ data: { name: `${TAG} groupe ${key} ${seq}` } });
    const role = await prisma.role.create({
      data: { name: `${TAG} ${key} ${seq}`, menus: { create: menus.map((menuKey) => ({ menuKey })) } },
    });
    const user = await prisma.appUser.create({
      data: { username: `${TAG}-${key}-${seq}`, firstName: 'Test', lastName: `${TAG} ${key}`, roleId: role.roleId },
    });
    const ug = await prisma.appUserGroup.create({ data: { userId: user.userId, groupId: group.groupId } });
    const auth: AuthUser = { userId: user.userId, username: user.username, isAdmin: false, userGroupId: ug.userGroupId, fullName: null };
    return {
      userId: user.userId,
      userGroupId: ug.userGroupId,
      roleId: role.roleId,
      auth,
      identity: { user: auth, principal: { userGroupId: ug.userGroupId, userId: user.userId, groupIds: [group.groupId], roleId: role.roleId } },
    };
  }

  /** Acteur qui peut imputer (menus parapheur + suivi), comme le valideur du test des applicateurs. */
  const makeImputer = (key = 'imputeur') => makeActor(key, IMPUTATION_MENUS);

  /** Exécuteur neuf (limiteur neuf : jamais de plafond de confirmations atteint entre deux tests). */
  function makeExecutor(): AsstExecutorService {
    return new AsstExecutorService(
      prisma as unknown as PrismaService,
      registry,
      rights,
      identities,
      store,
      new AsstConfirmLimiter(),
    );
  }

  async function newMail(owner: Actor): Promise<number> {
    seq += 1;
    const m = await prisma.mail.create({
      data: { title: `${TAG} courrier ${seq}`, date: new Date('2026-11-20'), mailType: 0, status: 0, destinataireExpediteur: owner.userGroupId },
    });
    mailIds.push(m.mailId);
    return m.mailId;
  }

  const imputation = (mailId: number, userGroupId: number): AsstProposedAction => ({
    tool: AsstActionTool.ImputationCourrier,
    args: { mailId, recipients: [{ userGroupId, mailInputationTypeId: 10, instructions: 'Pour traitement' }], rationale: 'Compétence RH' },
  });

  const draft = (mailId?: number): AsstProposedAction => ({
    tool: AsstActionTool.BrouillonReponse,
    args: { templateId: 'reponse-simple', label: `${TAG} brouillon`, draftHtml: '<p>Bonjour</p>', ...(mailId ? { mailId } : {}) },
  });

  /** Crée conversation, message assistant et proposition (statut 0) pour `actor`. */
  async function newProposal(
    actor: Actor,
    actions: AsstProposedAction[],
    opts: { createdAt?: Date; expiresAt?: Date } = {},
  ): Promise<AsstProposalDto> {
    const now = new Date();
    const conv = await store.createConversation({ userId: actor.userId, userGroupId: actor.userGroupId, title: `${TAG} échange`, now });
    const msg = await store.appendMessage(
      actor.userId,
      { conversationId: conv.conversationId, role: AsstMessageRole.Assistant, content: `${TAG} réponse` },
      now,
    );
    if (!msg) throw new Error('message non créé');
    return store.createProposal(
      {
        conversationId: conv.conversationId,
        messageId: msg.messageId,
        userId: actor.userId,
        userGroupId: actor.userGroupId,
        actions,
        summary: `${TAG} résumé`,
        argsHash: asstActionsHash(actions),
        expiresAt: opts.expiresAt ?? new Date(now.getTime() + 15 * MIN),
      },
      opts.createdAt ?? now,
    );
  }

  /** Fait avancer une proposition par des transitions LÉGALES du magasin (jamais en contournant le déclencheur). */
  async function advanceTo(p: AsstProposalDto, to: typeof AsstProposalStatus.Confirmed | typeof AsstProposalStatus.Applied): Promise<AsstProposalDto> {
    const now = new Date();
    const confirmed = await store.transitionProposal({
      proposalId: p.proposalId,
      expectedRowVersion: p.rowVersion,
      expectedStatus: AsstProposalStatus.Proposed,
      to: AsstProposalStatus.Confirmed,
      now,
    });
    if (!confirmed) throw new Error('confirmation de mise en place refusée');
    if (to === AsstProposalStatus.Confirmed) return confirmed;
    const applied = await store.transitionProposal({
      proposalId: p.proposalId,
      expectedRowVersion: confirmed.rowVersion,
      expectedStatus: AsstProposalStatus.Confirmed,
      to: AsstProposalStatus.Applied,
      result: { effects: [] },
      now,
    });
    if (!applied) throw new Error('application de mise en place refusée');
    return applied;
  }

  const body = (p: AsstProposalDto) => ({ argsHash: p.argsHash });
  const dbProposal = (p: { proposalId: string }) => prisma.asstProposal.findUniqueOrThrow({ where: { asstProposalId: BigInt(p.proposalId) } });
  const imputationsOf = (mailId: number) => prisma.mailInputation.findMany({ where: { mailId } });
  const mailNotes = (mailId: number) => prisma.notification.count({ where: { targetType: 'mail', targetId: mailId } });
  const draftNotes = () => prisma.notification.count({ where: { message: `${TAG} brouillon` } });
  const auditOf = (p: { proposalId: string }) =>
    prisma.dataChangeAudit.findMany({ where: { newValue: { contains: `proposition ${p.proposalId} ;` } } });

  async function rejection(promise: Promise<unknown>): Promise<AsstError> {
    try {
      await promise;
    } catch (err) {
      if (err instanceof AsstError) return err;
      throw err;
    }
    throw new Error('rejet attendu');
  }

  // ---------------------------------------------------------------------------
  // 1. Succès
  // ---------------------------------------------------------------------------

  it('succès : imputation confirmée => statut 2, imputation et notification en base, audit « via assistant »', async () => {
    const a = await makeImputer();
    const mailId = await newMail(a);
    const p = await newProposal(a, [imputation(mailId, recipient.userGroupId)]);

    const out = await makeExecutor().confirm(a.identity, p.proposalId, body(p));

    expect(out.status).toBe(AsstProposalStatus.Applied);
    const row = await dbProposal(p);
    expect(row.status).toBe(2);
    expect(row.rowVersion).toBe(2);
    expect(row.confirmedAt).not.toBeNull();
    expect(row.finishedAt).not.toBeNull();
    expect((row.result as { effects: unknown[] }).effects).toHaveLength(1);

    const rows = await imputationsOf(mailId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: recipient.userGroupId, mailInputationTypeId: 10, createdBy: a.userGroupId, dateTreated: null });
    expect(await mailNotes(mailId)).toBe(1);

    const audit = await auditOf(p);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ userGroupId: a.userGroupId, objectRef: `mail:${mailId}` });
    expect(audit[0].newValue).toContain('via assistant');
    expect(audit[0].newValue).toContain(`proposition ${p.proposalId}`);
  });

  // ---------------------------------------------------------------------------
  // 2. Atomicité d'un lot
  // ---------------------------------------------------------------------------

  it('atomicité : la 2e action est refusée => rien de la 1re, statut 5 avec code et message', async () => {
    const a = await makeImputer();
    const mailId = await newMail(a);
    const p = await newProposal(a, [imputation(mailId, recipient.userGroupId), imputation(mailId, outsider.userGroupId)]);

    const err = await rejection(makeExecutor().confirm(a.identity, p.proposalId, body(p)));

    expect(err.errorCode).toBe('effect_forbidden'); // recipient_not_imputable : refus lié aux droits
    expect(err.proposal).toMatchObject({ status: AsstProposalStatus.Failed, errorCode: 'recipient_not_imputable' });
    const row = await dbProposal(p);
    expect(row.status).toBe(5);
    expect(row.errorCode).toBe('recipient_not_imputable');
    expect(row.errorMessage).toEqual(expect.stringContaining(`n°${outsider.userGroupId}`));
    expect(row.result).toBeNull();
    expect(await imputationsOf(mailId)).toHaveLength(0);
    expect(await mailNotes(mailId)).toBe(0);
    expect(await auditOf(p)).toHaveLength(0);
  });

  it('atomicité : un brouillon qui précède est compensé (une fois), sans notification ni imputation restantes', async () => {
    const a = await makeImputer();
    const mailId = await newMail(a);
    const p = await newProposal(a, [draft(mailId), imputation(mailId, recipient.userGroupId), imputation(mailId, outsider.userGroupId)]);

    const err = await rejection(makeExecutor().confirm(a.identity, p.proposalId, body(p)));

    expect(err.errorCode).toBe('effect_forbidden');
    expect(compensateDraft).toHaveBeenCalledTimes(1);
    expect((await dbProposal(p)).status).toBe(5);
    expect(await draftNotes()).toBe(0); // la notification du brouillon factice est écrite via ctx.tx : annulée
    expect(await imputationsOf(mailId)).toHaveLength(0);
    expect(await mailNotes(mailId)).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // 3. Concurrence
  // ---------------------------------------------------------------------------

  it('concurrence : deux confirmations de la MÊME proposition => une seule réussit, une seule imputation', async () => {
    const a = await makeImputer();
    const mailId = await newMail(a);
    const p = await newProposal(a, [imputation(mailId, recipient.userGroupId)]);

    const results = await Promise.allSettled([
      makeExecutor().confirm(a.identity, p.proposalId, body(p)),
      makeExecutor().confirm(a.identity, p.proposalId, body(p)),
    ]);

    const ok = results.filter((r) => r.status === 'fulfilled');
    const ko = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(ko).toHaveLength(1);
    expect(ko[0].reason).toBeInstanceOf(AsstError);
    expect(['conflict', 'proposal_not_pending']).toContain((ko[0].reason as AsstError).errorCode);
    expect((await dbProposal(p)).status).toBe(2);
    expect(await imputationsOf(mailId)).toHaveLength(1);
    expect(await mailNotes(mailId)).toBe(1);
  });

  it('concurrence : deux propositions distinctes sur le même courrier et destinataire => une seule imputation ouverte, sans interblocage', async () => {
    const a = await makeImputer();
    const mailId = await newMail(a);
    const p1 = await newProposal(a, [imputation(mailId, recipient.userGroupId)]);
    const p2 = await newProposal(a, [imputation(mailId, recipient.userGroupId)]);

    const results = await Promise.allSettled([
      makeExecutor().confirm(a.identity, p1.proposalId, body(p1)),
      makeExecutor().confirm(a.identity, p2.proposalId, body(p2)),
    ]);

    // Les verrous de ligne sérialisent les deux transactions : la seconde relit l'imputation de la première
    // (effet `already_present`) et réussit sans doublon. Aucune ne doit échouer pour cause technique.
    for (const r of results) {
      if (r.status === 'rejected') throw r.reason;
    }
    expect((await dbProposal(p1)).status).toBe(2);
    expect((await dbProposal(p2)).status).toBe(2);
    expect(await imputationsOf(mailId)).toHaveLength(1);
    expect(await mailNotes(mailId)).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // 4. Déclencheur SQL et échéance
  // ---------------------------------------------------------------------------

  describe('transitions illégales refusées par le déclencheur', () => {
    const status = async (p: { proposalId: string }) => (await dbProposal(p)).status;

    it('0 -> 2 et 0 -> 5 : refusées', async () => {
      const a = await makeImputer();
      const p = await newProposal(a, [draft()]);
      const id = BigInt(p.proposalId);
      await expect(prisma.$executeRaw`UPDATE asst_proposal SET status = 2 WHERE asst_proposal_id = ${id}`).rejects.toThrow(/illégale/);
      await expect(prisma.$executeRaw`UPDATE asst_proposal SET status = 5 WHERE asst_proposal_id = ${id}`).rejects.toThrow(/illégale/);
      expect(await status(p)).toBe(0);
    });

    it('1 -> 3 : refusée', async () => {
      const a = await makeImputer();
      const p = await advanceTo(await newProposal(a, [draft()]), AsstProposalStatus.Confirmed);
      await expect(
        prisma.$executeRaw`UPDATE asst_proposal SET status = 3 WHERE asst_proposal_id = ${BigInt(p.proposalId)}`,
      ).rejects.toThrow(/illégale/);
      expect(await status(p)).toBe(1);
    });

    it('2 -> 1 et modification d’une proposition terminée : refusées (ligne figée)', async () => {
      const a = await makeImputer();
      const p = await advanceTo(await newProposal(a, [draft()]), AsstProposalStatus.Applied);
      const id = BigInt(p.proposalId);
      await expect(prisma.$executeRaw`UPDATE asst_proposal SET status = 1 WHERE asst_proposal_id = ${id}`).rejects.toThrow();
      await expect(prisma.$executeRaw`UPDATE asst_proposal SET summary = 'altéré' WHERE asst_proposal_id = ${id}`).rejects.toThrow();
      await expect(prisma.$executeRaw`UPDATE asst_proposal SET row_version = row_version + 1 WHERE asst_proposal_id = ${id}`).rejects.toThrow();
      const row = await dbProposal(p);
      expect(row.status).toBe(2);
      expect(row.summary).toBe(`${TAG} résumé`);
    });

    it('confirmer une proposition échue en base : `proposal_expired`, proposition close en statut 4', async () => {
      const a = await makeImputer();
      const now = Date.now();
      const p = await newProposal(a, [draft()], { createdAt: new Date(now - 2 * 60 * MIN), expiresAt: new Date(now - 60 * MIN) });
      const err = await rejection(makeExecutor().confirm(a.identity, p.proposalId, body(p)));
      expect(err.errorCode).toBe('proposal_expired');
      expect((await dbProposal(p)).status).toBe(4);
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Atomicité de la transition finale
  // ---------------------------------------------------------------------------

  it('applicateur qui écrit puis lève : proposition en statut 5 (jamais 2), rien d’écrit', async () => {
    brouillonMode = 'writes_then_throws';
    const a = await makeImputer();
    const mailId = await newMail(a);
    const p = await newProposal(a, [imputation(mailId, recipient.userGroupId), draft(mailId)]);

    const err = await rejection(makeExecutor().confirm(a.identity, p.proposalId, body(p)));

    expect(err.errorCode).toBe('effect_failed');
    const row = await dbProposal(p);
    expect(row.status).toBe(5);
    expect(row.errorCode).toBe('effect_failed');
    expect(row.result).toBeNull();
    expect(await imputationsOf(mailId)).toHaveLength(0);
    expect(await mailNotes(mailId)).toBe(0);
    expect(await draftNotes()).toBe(0);
    expect(await auditOf(p)).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // 6. Droits et identité relus au moment de la confirmation
  // ---------------------------------------------------------------------------

  it('menu d’imputation retiré du rôle entre-temps : `effect_forbidden`, statut 5, rien d’écrit', async () => {
    const a = await makeImputer();
    const mailId = await newMail(a);
    const p = await newProposal(a, [imputation(mailId, recipient.userGroupId)]);
    await prisma.roleMenuPermission.deleteMany({ where: { roleId: a.roleId } });

    const err = await rejection(makeExecutor().confirm(a.identity, p.proposalId, body(p)));

    expect(err.errorCode).toBe('effect_forbidden');
    const row = await dbProposal(p);
    expect(row.status).toBe(5);
    expect(row.errorCode).toBe('menu_denied');
    expect(await imputationsOf(mailId)).toHaveLength(0);
    expect(await mailNotes(mailId)).toBe(0);
    expect(await auditOf(p)).toHaveLength(0);
  });

  it('compte désactivé entre-temps : `identity_refused`, proposition toujours en statut 0', async () => {
    const a = await makeImputer();
    const mailId = await newMail(a);
    const p = await newProposal(a, [imputation(mailId, recipient.userGroupId)]);
    await prisma.appUser.update({ where: { userId: a.userId }, data: { isDisabled: true } });

    const err = await rejection(makeExecutor().confirm(a.identity, p.proposalId, body(p)));

    expect(err.errorCode).toBe('identity_refused');
    const row = await dbProposal(p);
    expect(row.status).toBe(0);
    expect(row.rowVersion).toBe(0);
    expect(await imputationsOf(mailId)).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // 7. Reprise des exécutions interrompues
  // ---------------------------------------------------------------------------

  it('recoverInterrupted : proposition restée en statut 1 depuis longtemps => clôturée en 5 `execution_interrupted`', async () => {
    const a = await makeImputer();
    const p = await newProposal(a, [draft()]);
    // Transition légale 0 -> 1 avec une date de confirmation ancienne (10 minutes).
    const old = new Date(Date.now() - 10 * MIN);
    const confirmed = await store.transitionProposal({
      proposalId: p.proposalId,
      expectedRowVersion: p.rowVersion,
      expectedStatus: AsstProposalStatus.Proposed,
      to: AsstProposalStatus.Confirmed,
      now: old,
    });
    expect(confirmed?.status).toBe(AsstProposalStatus.Confirmed);

    const count = await makeExecutor().recoverInterrupted(new Date(), 100, 2 * MIN);

    expect(count).toBeGreaterThanOrEqual(1);
    const row = await dbProposal(p);
    expect(row.status).toBe(5);
    expect(row.errorCode).toBe('execution_interrupted');
    expect(row.finishedAt).not.toBeNull();
  });
});
