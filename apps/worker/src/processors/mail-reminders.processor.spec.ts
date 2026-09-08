import { runDateButoireReminders, runInputationReminders } from './mail-reminders.processor';

const now = new Date('2026-07-16T13:10:00.000Z');
const env = { delaisAlerteHours: 48, delaisAlerteIntervalHours: 6 };

/** Mailer factice — `enabled` pilote le canal, `send` enregistre les envois. */
const fakeMailer = (enabled = true) => ({
  enabled,
  send: jest.fn().mockResolvedValue(true),
  close: jest.fn(),
});

describe('runDateButoireReminders (§03.5)', () => {
  let prisma: {
    mail: { findMany: jest.Mock };
    notification: { createMany: jest.Mock };
    appUserGroup: { findMany: jest.Mock };
  };

  beforeEach(() => {
    prisma = {
      mail: { findMany: jest.fn() },
      notification: { createMany: jest.fn().mockResolvedValue({ count: 0 }) },
      appUserGroup: { findMany: jest.fn().mockResolvedValue([]) },
    };
  });

  it('ne cible que les courriers validés, non traités, avec une date butoir', async () => {
    prisma.mail.findMany.mockResolvedValue([]);
    await runDateButoireReminders(prisma as never, now);
    expect(prisma.mail.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          isDeleted: false,
          valider: true,
          dateTraited: null,
          dateButoire: { not: null },
        },
      }),
    );
  });

  it('notifie le destinataire au palier, et ignore les courriers hors palier', async () => {
    prisma.mail.findMany.mockResolvedValue([
      // J-7 => PREMIÈRE_ALERTE
      {
        mailId: 1,
        title: 'À sept jours',
        dateButoire: new Date('2026-07-23T08:00:00.000Z'),
        destinataireExpediteur: 10,
      },
      // J-5 => rien
      {
        mailId: 2,
        title: 'À cinq jours',
        dateButoire: new Date('2026-07-21T08:00:00.000Z'),
        destinataireExpediteur: 11,
      },
      // J+0 => URGENCE
      {
        mailId: 3,
        title: "Pour aujourd'hui",
        dateButoire: new Date('2026-07-16T23:00:00.000Z'),
        destinataireExpediteur: 12,
      },
    ]);

    const res = await runDateButoireReminders(prisma as never, now);

    expect(res).toEqual({ scanned: 3, notified: 2 });
    const rows = prisma.notification.createMany.mock.calls[0][0].data;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ recipientUserGroupId: 10, targetType: 'mail', targetId: 1 });
    expect(rows[0].message).toContain('À sept jours');
    expect(rows[1]).toMatchObject({ recipientUserGroupId: 12, targetId: 3 });
    // Le courrier à J-5 n'a produit aucune notification.
    expect(rows.some((r: { targetId: number }) => r.targetId === 2)).toBe(false);
  });

  it("n'écrit rien quand aucun courrier n'est au palier", async () => {
    prisma.mail.findMany.mockResolvedValue([
      {
        mailId: 9,
        title: 'Loin',
        dateButoire: new Date('2026-08-30T08:00:00.000Z'),
        destinataireExpediteur: 10,
      },
    ]);
    const res = await runDateButoireReminders(prisma as never, now);
    expect(res.notified).toBe(0);
    expect(prisma.notification.createMany).not.toHaveBeenCalled();
  });

  // §03.5 : double canal. L'in-app fait foi, l'e-mail le double.
  describe('canal e-mail', () => {
    const atRisk = [
      {
        mailId: 1,
        title: 'Sept jours',
        dateButoire: new Date('2026-07-23T08:00:00.000Z'), // J-7 => info
        destinataireExpediteur: 10,
      },
      {
        mailId: 3,
        title: "Aujourd'hui",
        dateButoire: new Date('2026-07-16T23:00:00.000Z'), // J0 => URGENCE => warn
        destinataireExpediteur: 12,
      },
    ];

    it('envoie un e-mail par destinataire, avec lien et sévérité selon le palier', async () => {
      prisma.mail.findMany.mockResolvedValue(atRisk);
      prisma.appUserGroup.findMany.mockResolvedValue([
        { userGroupId: 10, user: { email: 'a@ex.ci' } },
        { userGroupId: 12, user: { email: 'b@ex.ci' } },
      ]);
      const mailer = fakeMailer();

      await runDateButoireReminders(prisma as never, now, mailer as never);

      expect(mailer.send).toHaveBeenCalledTimes(2);
      const sent = mailer.send.mock.calls.map((c) => c[0]);
      expect(sent.find((s) => s.to === 'a@ex.ci')).toMatchObject({
        severity: 'info',
        link: '/courriers/suivi/1',
      });
      // Échéance du jour : bannière rouge.
      expect(sent.find((s) => s.to === 'b@ex.ci')).toMatchObject({ severity: 'warn' });
    });

    it('ne résout aucune adresse quand le canal est désactivé', async () => {
      prisma.mail.findMany.mockResolvedValue(atRisk);
      const mailer = fakeMailer(false);

      await runDateButoireReminders(prisma as never, now, mailer as never);

      expect(prisma.appUserGroup.findMany).not.toHaveBeenCalled();
      expect(mailer.send).not.toHaveBeenCalled();
    });

    // Le point critique : un e-mail en échec ne doit pas faire échouer le job — un retry BullMQ
    // réécrirait les notifications in-app en double.
    it('le job aboutit même si la résolution des adresses plante', async () => {
      prisma.mail.findMany.mockResolvedValue(atRisk);
      prisma.appUserGroup.findMany.mockRejectedValue(new Error('base injoignable'));

      await expect(
        runDateButoireReminders(prisma as never, now, fakeMailer() as never),
      ).resolves.toEqual({ scanned: 2, notified: 2 });
    });
  });
});

describe('runInputationReminders (§03.5)', () => {
  let prisma: {
    mailInputation: { findMany: jest.Mock; updateMany: jest.Mock };
    notification: { createMany: jest.Mock };
    $transaction: jest.Mock;
  };

  beforeEach(() => {
    prisma = {
      mailInputation: { findMany: jest.fn(), updateMany: jest.fn().mockReturnValue('upd') },
      notification: { createMany: jest.fn().mockReturnValue('notif') },
      $transaction: jest.fn().mockResolvedValue([]),
    };
  });

  it('notifie l’agent imputé ET le créateur, puis horodate lastReminderSent', async () => {
    prisma.mailInputation.findMany.mockResolvedValue([
      {
        mailInputationId: 5,
        deadline: new Date('2026-07-17T10:00:00.000Z'),
        lastReminderSent: null,
        userId: 20,
        createdBy: 21,
        mail: { mailId: 3, title: 'Dossier X' },
      },
    ]);

    const res = await runInputationReminders(prisma as never, now, env);

    expect(res).toEqual({ scanned: 1, notified: 2 });
    const rows = prisma.notification.createMany.mock.calls[0][0].data;
    expect(rows.map((r: { recipientUserGroupId: number }) => r.recipientUserGroupId)).toEqual([
      20, 21,
    ]);
    expect(rows[0].message).toContain('Dossier X');
    expect(prisma.mailInputation.updateMany).toHaveBeenCalledWith({
      where: { mailInputationId: { in: [5] } },
      data: { lastReminderSent: now },
    });
    // Notifications et horodatage doivent être atomiques : sinon un crash entre les deux
    // re-notifierait en boucle à chaque minute.
    expect(prisma.$transaction).toHaveBeenCalledWith(['notif', 'upd']);
  });

  it('dédoublonne quand l’agent est aussi le créateur (auto-imputation)', async () => {
    prisma.mailInputation.findMany.mockResolvedValue([
      {
        mailInputationId: 6,
        deadline: new Date('2026-07-17T10:00:00.000Z'),
        lastReminderSent: null,
        userId: 30,
        createdBy: 30,
        mail: { mailId: 4, title: 'Auto' },
      },
    ]);

    const res = await runInputationReminders(prisma as never, now, env);

    expect(res.notified).toBe(1);
    expect(prisma.notification.createMany.mock.calls[0][0].data).toHaveLength(1);
  });

  it('respecte l’intervalle : une imputation relancée il y a 4 h est ignorée', async () => {
    prisma.mailInputation.findMany.mockResolvedValue([
      {
        mailInputationId: 7,
        deadline: new Date('2026-07-17T10:00:00.000Z'),
        lastReminderSent: new Date('2026-07-16T09:10:00.000Z'), // il y a 4 h
        userId: 40,
        createdBy: 41,
        mail: { mailId: 5, title: 'Trop tôt' },
      },
    ]);

    const res = await runInputationReminders(prisma as never, now, env);

    expect(res).toEqual({ scanned: 1, notified: 0 });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
