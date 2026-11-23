import { MailInputationTypeId, MailStatus } from '@archivage/types';
import { MailInputationsService } from './mail-inputations.service';
import type { AuthUser } from '../auth/auth.types';

const user: AuthUser = { userId: 1, username: 'op', isAdmin: false, userGroupId: 9 };
const now = new Date('2026-07-15T10:00:00.000Z');

describe('MailInputationsService', () => {
  let prisma: {
    mailInputation: {
      findMany: jest.Mock;
      create: jest.Mock;
      findUnique: jest.Mock;
      delete: jest.Mock;
      updateMany: jest.Mock;
    };
    mail: { findUnique: jest.Mock; findFirst: jest.Mock };
    mailInputationType: { findUnique: jest.Mock };
    appUserGroup: { findUnique: jest.Mock };
    $transaction: jest.Mock;
  };
  let tx: { mailInputation: { updateMany: jest.Mock }; mail: { update: jest.Mock } };
  let notifications: { create: jest.Mock; createMany: jest.Mock };
  let mails: { autoValiderOnImputation: jest.Mock };
  let service: MailInputationsService;

  beforeEach(() => {
    tx = { mailInputation: { updateMany: jest.fn() }, mail: { update: jest.fn() } };
    prisma = {
      mailInputation: {
        findMany: jest.fn(),
        create: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn(),
        delete: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      mail: {
        findUnique: jest.fn().mockResolvedValue({ title: 'Demande de subvention' }),
        findFirst: jest.fn().mockResolvedValue({ mailId: 1 }),
      },
      mailInputationType: {
        findUnique: jest.fn().mockResolvedValue({ label: 'Pour attribution' }),
      },
      appUserGroup: {
        findUnique: jest.fn().mockResolvedValue({ user: { fullName: 'Awa Ouattara' } }),
      },
      $transaction: jest.fn().mockImplementation(async (cb: (t: typeof tx) => unknown) => cb(tx)),
    };
    notifications = {
      create: jest.fn().mockResolvedValue({}),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    };
    mails = { autoValiderOnImputation: jest.fn().mockResolvedValue(false) };
    service = new MailInputationsService(prisma as never, notifications as never, mails as never);
  });

  it('createValidation crée un type 5 (DG) avec échéance +48 h', async () => {
    await service.createValidation(1, 5, true, user, now);
    expect(prisma.mailInputation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        mailId: 1,
        userId: 5,
        mailInputationTypeId: MailInputationTypeId.ValidationDG,
        deadline: new Date(now.getTime() + 48 * 3600 * 1000),
      }),
    });
  });

  it('create notifie l’agent imputé (§03.5 ImputationAssigneeAsync)', async () => {
    await service.create({ mailId: 1, userGroupId: 7, mailInputationTypeId: 10 }, user);
    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientUserGroupId: 7,
        message: 'Courrier imputé : Demande de subvention',
        targetType: 'mail',
        targetId: 1,
        subject: 'Courrier imputé', // objet de l'e-mail (§03.5)
      }),
    );
  });

  it('createValidation notifie le valideur (§03.5 SoumissionValidationAsync)', async () => {
    await service.createValidation(1, 5, false, user, now);
    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientUserGroupId: 5,
        message: 'Soumission à validation Direction : Demande de subvention',
        targetId: 1,
      }),
    );
  });

  it('create déclenche le contrôle automatique du courrier (§06)', async () => {
    await service.create({ mailId: 1, userGroupId: 7, mailInputationTypeId: 10 }, user);
    expect(mails.autoValiderOnImputation).toHaveBeenCalledWith(1, user);
  });

  it('treatOnRead traite les imputations suivi==true et bascule en Traité si toutes traitées', async () => {
    prisma.mailInputation.findMany.mockResolvedValue([
      { mailInputationId: 1, dateTreated: null, type: { suivi: true } },
      { mailInputationId: 2, dateTreated: new Date('2026-06-01'), type: { suivi: false } },
    ]);

    const res = await service.treatOnRead(1, now);

    expect(res.inputationsToTreat).toEqual([1]);
    expect(res.allTreated).toBe(true);
    expect(tx.mailInputation.updateMany).toHaveBeenCalledWith({
      where: { mailInputationId: { in: [1] } },
      data: { dateTreated: now },
    });
    expect(tx.mail.update).toHaveBeenCalledWith({
      where: { mailId: 1 },
      data: { status: MailStatus.Traite, dateTraited: now },
    });
  });

  it('treatOnRead sans imputation à traiter n’ouvre pas de transaction', async () => {
    prisma.mailInputation.findMany.mockResolvedValue([
      { mailInputationId: 1, dateTreated: null, type: { suivi: false } },
    ]);
    const res = await service.treatOnRead(1, now);
    expect(res.inputationsToTreat).toEqual([]);
    expect(res.mailPatch).toBeNull();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  // §08 : l'e-mail doit porter ce que l'imputé doit savoir pour agir, sans ouvrir l'application.
  it('create joint type, auteur, échéance et instructions à l’e-mail', async () => {
    const deadline = new Date('2026-07-20T17:00:00.000Z');
    await service.create(
      {
        mailId: 1,
        userGroupId: 7,
        mailInputationTypeId: 10,
        instructions: 'Préparer une note de synthèse.',
        deadline,
      },
      user,
    );

    const details = notifications.create.mock.calls[0][0].extraDetails as Array<{
      label: string;
      value: string;
      strong?: boolean;
    }>;
    expect(details.map((d) => d.label)).toEqual([
      "Type d'imputation",
      'Imputé par',
      'Échéance',
      'Instructions',
    ]);
    expect(details.find((d) => d.label === "Type d'imputation")?.value).toBe('Pour attribution');
    // L'échéance engage le destinataire : elle ressort visuellement.
    expect(details.find((d) => d.label === 'Échéance')?.strong).toBe(true);
  });

  // Colonne TIMESTAMPTZ(0) : PostgreSQL ARRONDIT les fractions de seconde. La fin du jour envoyée
  // par l'écran (23:59:59.999) était stockée au lendemain 00:00:00 — l'échéance changeait de jour.
  it('create tronque l’échéance à la seconde (jamais arrondie au lendemain)', async () => {
    await service.create(
      {
        mailId: 1,
        userGroupId: 7,
        mailInputationTypeId: 10,
        deadline: new Date('2026-11-29T23:59:59.999Z'),
      },
      user,
    );
    expect(prisma.mailInputation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ deadline: new Date('2026-11-29T23:59:59.000Z') }),
    });
  });

  it('create sans échéance stocke NULL', async () => {
    await service.create({ mailId: 1, userGroupId: 7, mailInputationTypeId: 10 }, user);
    expect(prisma.mailInputation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ deadline: null }),
    });
  });

  it('create omet les lignes non renseignées (ni échéance ni instructions)', async () => {
    await service.create({ mailId: 1, userGroupId: 7, mailInputationTypeId: 10 }, user);

    const details = notifications.create.mock.calls[0][0].extraDetails as Array<{ label: string }>;
    expect(details.map((d) => d.label)).toEqual(["Type d'imputation", 'Imputé par']);
  });

  // §08 `ImputationTraiteeAsync` : celui qui délègue doit savoir que le travail est fait.
  describe('markRecipientTreated — notification de l’auteur', () => {
    it('prévient les auteurs distincts des imputations traitées', async () => {
      prisma.mailInputation.findMany.mockResolvedValue([
        { createdBy: 5, type: { label: 'Pour attribution' } },
        { createdBy: 5, type: { label: 'Pour attribution' } }, // même auteur : une seule notif
        { createdBy: 6, type: { label: 'Pour avis' } },
      ]);
      prisma.mailInputation.updateMany.mockResolvedValue({ count: 3 });

      await service.markRecipientTreated(1, 9, now);

      expect(notifications.createMany).toHaveBeenCalledTimes(1);
      const [auteurs, message, target, opts] = notifications.createMany.mock.calls[0];
      expect(auteurs).toEqual([5, 6]);
      expect(message).toContain('Awa Ouattara');
      expect(target).toEqual({ type: 'mail', id: 1 });
      expect(opts.severity).toBe('success');
    });

    // S'imputer soi-même puis traiter ne doit pas s'auto-notifier : on vient d'agir.
    it('ne notifie pas l’auteur quand il est lui-même le traiteur', async () => {
      prisma.mailInputation.findMany.mockResolvedValue([
        { createdBy: 9, type: { label: 'Pour suivi' } },
      ]);
      prisma.mailInputation.updateMany.mockResolvedValue({ count: 1 });

      await service.markRecipientTreated(1, 9, now);

      expect(notifications.createMany).not.toHaveBeenCalled();
    });

    it('ne notifie personne quand aucune imputation n’était à traiter', async () => {
      prisma.mailInputation.findMany.mockResolvedValue([]);
      prisma.mailInputation.updateMany.mockResolvedValue({ count: 0 });

      await service.markRecipientTreated(1, 9, now);

      expect(notifications.createMany).not.toHaveBeenCalled();
    });
  });

  // Une erreur de saisie (courrier, acteur ou type inexistant) violait une clé étrangère et
  // remontait en 500 « Internal server error » : elle doit être refusée proprement, sans écriture.
  describe('préconditions d’imputation — 404/400 au lieu de 500', () => {
    it('create sur un courrier inexistant ou supprimé : 404, rien n’est écrit ni notifié', async () => {
      prisma.mail.findFirst.mockResolvedValue(null);

      await expect(
        service.create({ mailId: 404, userGroupId: 7, mailInputationTypeId: 10 }, user),
      ).rejects.toThrow('Courrier introuvable');
      expect(prisma.mail.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { mailId: 404, isDeleted: false } }),
      );
      expect(prisma.mailInputation.create).not.toHaveBeenCalled();
      expect(mails.autoValiderOnImputation).not.toHaveBeenCalled();
      expect(notifications.create).not.toHaveBeenCalled();
    });

    it('create vers un acteur inexistant : 400, aucune imputation créée', async () => {
      prisma.appUserGroup.findUnique.mockResolvedValue(null);

      await expect(
        service.create({ mailId: 1, userGroupId: 999, mailInputationTypeId: 10 }, user),
      ).rejects.toThrow("Destinataire de l'imputation introuvable");
      expect(prisma.mailInputation.create).not.toHaveBeenCalled();
    });

    it('create avec un type inexistant : 400, aucune imputation créée', async () => {
      prisma.mailInputationType.findUnique.mockResolvedValue(null);

      await expect(
        service.create({ mailId: 1, userGroupId: 7, mailInputationTypeId: 999 }, user),
      ).rejects.toThrow("Type d'imputation introuvable");
      expect(prisma.mailInputation.create).not.toHaveBeenCalled();
    });

    it('createValidation sur un courrier inexistant : 404, aucun valideur notifié', async () => {
      prisma.mail.findFirst.mockResolvedValue(null);

      await expect(service.createValidation(404, 5, true, user, now)).rejects.toThrow(
        'Courrier introuvable',
      );
      expect(prisma.mailInputation.create).not.toHaveBeenCalled();
      expect(notifications.create).not.toHaveBeenCalled();
    });

    it('markTreated sur un courrier inexistant : 404, aucune transaction', async () => {
      prisma.mail.findFirst.mockResolvedValue(null);

      await expect(service.markTreated(404, now)).rejects.toThrow('Courrier introuvable');
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('markTreated sur un courrier actif traite tout et passe en Traité', async () => {
      prisma.mailInputation.findMany.mockResolvedValue([
        { mailInputationId: 3, dateTreated: null, type: { suivi: false } },
      ]);

      const res = await service.markTreated(1, now);

      expect(res.inputationsToTreat).toEqual([3]);
      expect(tx.mail.update).toHaveBeenCalledWith({
        where: { mailId: 1 },
        data: { status: MailStatus.Traite, dateTraited: now },
      });
    });
  });

  describe('remove (§08) — réservé à l’auteur de l’imputation', () => {
    it('supprime quand l’appelant est bien le créateur', async () => {
      prisma.mailInputation.findUnique.mockResolvedValue({ createdBy: 9 });

      await expect(service.remove(1, user)).resolves.toEqual({ deleted: true });
      expect(prisma.mailInputation.delete).toHaveBeenCalledWith({
        where: { mailInputationId: 1 },
      });
    });

    it('refuse quand l’appelant n’est pas le créateur', async () => {
      prisma.mailInputation.findUnique.mockResolvedValue({ createdBy: 42 });

      await expect(service.remove(1, user)).rejects.toThrow(
        "Seul l'auteur de l'imputation peut la supprimer",
      );
      expect(prisma.mailInputation.delete).not.toHaveBeenCalled();
    });

    it('refuse une imputation sans auteur connu (createdBy NULL)', async () => {
      prisma.mailInputation.findUnique.mockResolvedValue({ createdBy: null });

      await expect(service.remove(1, user)).rejects.toThrow();
      expect(prisma.mailInputation.delete).not.toHaveBeenCalled();
    });

    it('404 si l’imputation n’existe pas', async () => {
      prisma.mailInputation.findUnique.mockResolvedValue(null);

      await expect(service.remove(999, user)).rejects.toThrow('Imputation introuvable');
    });
  });
});
