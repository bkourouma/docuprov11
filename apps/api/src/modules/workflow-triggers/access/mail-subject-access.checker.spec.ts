import { MailStatus, MailType } from '@archivage/types';
import type { MailsService } from '../../courriers/mails.service';
import type { PrismaService } from '../../prisma/prisma.service';
import { MailSubjectAccessChecker } from './mail-subject-access.checker';

const ACTOR = { userGroupId: 50, userId: 5 };

function makeCtx(overrides: { actor?: unknown; mail?: unknown; scope?: string; imputations?: number } = {}) {
  const prisma = {
    appUserGroup: {
      findUnique: jest.fn().mockResolvedValue(
        'actor' in overrides
          ? overrides.actor
          : {
              userId: 5,
              user: { userId: 5, username: 'u', isAdmin: false, isDisabled: false, roleId: 9, role: { isActive: true } },
            },
      ),
    },
    mail: {
      findUnique: jest.fn().mockResolvedValue(
        'mail' in overrides
          ? overrides.mail
          : {
              isDeleted: false,
              status: MailStatus.Redige,
              mailType: MailType.Depart,
              destinataireExpediteur: 77,
              destinataireRoleId: null,
              createdBy: 88,
            },
      ),
    },
    mailInputation: { count: jest.fn().mockResolvedValue(overrides.imputations ?? 0) },
  };
  const mails = { mailScope: jest.fn().mockResolvedValue(overrides.scope ?? 'none') };
  const checker = new MailSubjectAccessChecker(
    prisma as unknown as PrismaService,
    mails as unknown as MailsService,
  );
  return { prisma, mails, checker };
}

const actorRow = (user: Record<string, unknown> = {}) => ({
  userId: 5,
  user: { userId: 5, username: 'u', isAdmin: false, isDisabled: false, roleId: 9, role: { isActive: true }, ...user },
});
const mailRow = (m: Record<string, unknown> = {}) => ({
  isDeleted: false,
  status: MailStatus.Redige,
  mailType: MailType.Depart,
  destinataireExpediteur: 77,
  destinataireRoleId: null,
  createdBy: 88,
  ...m,
});

describe('MailSubjectAccessChecker.canAccess', () => {
  it('a le type « mail »', () => {
    expect(makeCtx().checker.subjectType).toBe('mail');
  });

  it.each(['abc', '0', '-1', '', '1234567890', '1.5', ' 12', '12 '])('refuse un identifiant invalide (%j)', async (id) => {
    const { checker, prisma } = makeCtx();
    await expect(checker.canAccess(ACTOR, id)).resolves.toBe(false);
    expect(prisma.appUserGroup.findUnique).not.toHaveBeenCalled();
  });

  it('refuse si l\'acteur est inexistant', async () => {
    const { checker } = makeCtx({ actor: null });
    await expect(checker.canAccess(ACTOR, '10')).resolves.toBe(false);
  });

  it('refuse si le compte est désactivé', async () => {
    const { checker } = makeCtx({ actor: actorRow({ isDisabled: true, isAdmin: true }) });
    await expect(checker.canAccess(ACTOR, '10')).resolves.toBe(false);
  });

  it('refuse si le userId fourni est incohérent', async () => {
    const { checker } = makeCtx({ actor: actorRow() });
    await expect(checker.canAccess({ userGroupId: 50, userId: 6 }, '10')).resolves.toBe(false);
  });

  it('refuse un courrier inexistant ou supprimé', async () => {
    await expect(makeCtx({ mail: null }).checker.canAccess(ACTOR, '10')).resolves.toBe(false);
    await expect(
      makeCtx({ mail: mailRow({ isDeleted: true, destinataireExpediteur: 50 }) }).checker.canAccess(ACTOR, '10'),
    ).resolves.toBe(false);
  });

  it('refuse un courrier en rédaction non-arrivée, même pour son destinataire ou un administrateur', async () => {
    const mail = mailRow({ status: MailStatus.Redaction, mailType: MailType.Interne, destinataireExpediteur: 50 });
    await expect(makeCtx({ mail }).checker.canAccess(ACTOR, '10')).resolves.toBe(false);
    await expect(
      makeCtx({ mail, actor: actorRow({ isAdmin: true }) }).checker.canAccess(ACTOR, '10'),
    ).resolves.toBe(false);
  });

  it('accepte un courrier Arrivée en rédaction pour son destinataire', async () => {
    const mail = mailRow({ status: MailStatus.Redaction, mailType: MailType.Arrivee, destinataireExpediteur: 50 });
    await expect(makeCtx({ mail }).checker.canAccess(ACTOR, '10')).resolves.toBe(true);
  });

  it('refuse un utilisateur sans lien ni périmètre', async () => {
    const { checker, prisma } = makeCtx();
    await expect(checker.canAccess(ACTOR, '10')).resolves.toBe(false);
    expect(prisma.mailInputation.count).toHaveBeenCalledWith({ where: { mailId: 10, userId: 50 } });
  });

  it('accorde l\'accès à un administrateur (isAdmin lu en base)', async () => {
    const { checker } = makeCtx({ actor: actorRow({ isAdmin: true }) });
    await expect(checker.canAccess(ACTOR, '10')).resolves.toBe(true);
  });

  it('accorde l\'accès avec le périmètre « all »', async () => {
    const { checker, mails } = makeCtx({ scope: 'all' });
    await expect(checker.canAccess(ACTOR, '10')).resolves.toBe(true);
    expect(mails.mailScope).toHaveBeenCalledWith({ userId: 5, username: 'u', isAdmin: false, userGroupId: 50 });
  });

  it('refuse avec le périmètre « imputed » ou « none » sans autre lien', async () => {
    await expect(makeCtx({ scope: 'imputed' }).checker.canAccess(ACTOR, '10')).resolves.toBe(false);
    await expect(makeCtx({ scope: 'none' }).checker.canAccess(ACTOR, '10')).resolves.toBe(false);
  });

  it('accorde l\'accès au destinataire nommé', async () => {
    const { checker } = makeCtx({ mail: mailRow({ destinataireExpediteur: 50 }) });
    await expect(checker.canAccess(ACTOR, '10')).resolves.toBe(true);
  });

  it('accorde l\'accès au destinataire par rôle actif', async () => {
    const { checker } = makeCtx({ mail: mailRow({ destinataireExpediteur: null, destinataireRoleId: 9 }) });
    await expect(checker.canAccess(ACTOR, '10')).resolves.toBe(true);
  });

  it('un rôle INACTIF ne donne pas l\'accès', async () => {
    const { checker } = makeCtx({
      actor: actorRow({ role: { isActive: false } }),
      mail: mailRow({ destinataireExpediteur: null, destinataireRoleId: 9 }),
    });
    await expect(checker.canAccess(ACTOR, '10')).resolves.toBe(false);
  });

  it('un autre rôle ne donne pas l\'accès', async () => {
    const { checker } = makeCtx({ mail: mailRow({ destinataireExpediteur: null, destinataireRoleId: 4 }) });
    await expect(checker.canAccess(ACTOR, '10')).resolves.toBe(false);
  });

  it('accorde l\'accès à la personne imputée', async () => {
    const { checker } = makeCtx({ imputations: 1 });
    await expect(checker.canAccess(ACTOR, '10')).resolves.toBe(true);
  });

  it('accorde l\'accès au créateur', async () => {
    const { checker } = makeCtx({ mail: mailRow({ createdBy: 50 }) });
    await expect(checker.canAccess(ACTOR, '10')).resolves.toBe(true);
  });

  it('une exception interne donne un refus (fail-closed)', async () => {
    const { checker, prisma } = makeCtx({ scope: 'all' });
    prisma.mail.findUnique.mockRejectedValue(new Error('base indisponible'));
    jest.spyOn(checker['logger'], 'warn').mockImplementation(() => undefined);
    await expect(checker.canAccess(ACTOR, '10')).resolves.toBe(false);
  });

  it('une exception de mailScope donne un refus', async () => {
    const { checker, mails } = makeCtx();
    mails.mailScope.mockRejectedValue(new Error('boom'));
    jest.spyOn(checker['logger'], 'warn').mockImplementation(() => undefined);
    await expect(checker.canAccess(ACTOR, '10')).resolves.toBe(false);
  });
});

describe('MailSubjectAccessChecker.resolveOwner', () => {
  function withOwnerCtx(mail: unknown, ownerRow: unknown) {
    const ctx = makeCtx({ mail });
    ctx.prisma.appUserGroup.findUnique.mockResolvedValue(ownerRow);
    return ctx;
  }
  const active = { user: { isDisabled: false } };

  it('renvoie le destinataire nominatif actif', async () => {
    const { checker } = withOwnerCtx(mailRow(), active);
    await expect(checker.resolveOwner('10')).resolves.toBe(77);
  });

  it('retombe sur le créateur pour un courrier destiné à un rôle', async () => {
    const { checker } = withOwnerCtx(mailRow({ destinataireExpediteur: null, destinataireRoleId: 9 }), active);
    await expect(checker.resolveOwner('10')).resolves.toBe(88);
  });

  it('renvoie null si le courrier est absent, supprimé ou l\'identifiant invalide', async () => {
    await expect(withOwnerCtx(null, active).checker.resolveOwner('10')).resolves.toBeNull();
    await expect(withOwnerCtx(mailRow({ isDeleted: true }), active).checker.resolveOwner('10')).resolves.toBeNull();
    await expect(withOwnerCtx(mailRow(), active).checker.resolveOwner('x')).resolves.toBeNull();
  });

  it('renvoie null si le compte est désactivé ou absent', async () => {
    await expect(
      withOwnerCtx(mailRow(), { user: { isDisabled: true } }).checker.resolveOwner('10'),
    ).resolves.toBeNull();
    await expect(withOwnerCtx(mailRow(), null).checker.resolveOwner('10')).resolves.toBeNull();
  });

  it('renvoie null sans destinataire ni créateur', async () => {
    const { checker } = withOwnerCtx(mailRow({ destinataireExpediteur: null, createdBy: null }), active);
    await expect(checker.resolveOwner('10')).resolves.toBeNull();
  });

  it('renvoie null sur exception interne', async () => {
    const { checker, prisma } = makeCtx();
    prisma.mail.findUnique.mockRejectedValue(new Error('boom'));
    jest.spyOn(checker['logger'], 'warn').mockImplementation(() => undefined);
    await expect(checker.resolveOwner('10')).resolves.toBeNull();
  });
});
