import { NotificationsService } from './notifications.service';

describe('NotificationsService', () => {
  let prisma: {
    notification: {
      count: jest.Mock;
      findMany: jest.Mock;
      create: jest.Mock;
      createMany: jest.Mock;
      updateMany: jest.Mock;
    };
    appUserGroup: { findMany: jest.Mock };
    mail: { findUnique: jest.Mock };
  };
  let email: { enabled: boolean; send: jest.Mock };
  let service: NotificationsService;
  const now = new Date('2026-07-15T10:00:00.000Z');

  beforeEach(() => {
    prisma = {
      notification: {
        count: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        createMany: jest.fn(),
        updateMany: jest.fn(),
      },
      appUserGroup: { findMany: jest.fn().mockResolvedValue([]) },
      // Détails du courrier joints à l'e-mail (§03.5).
      mail: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    // Canal e-mail désactivé par défaut : les cas nominaux testent l'in-app seul.
    email = { enabled: false, send: jest.fn().mockResolvedValue(true) };
    service = new NotificationsService(prisma as never, email as never);
  });

  it('unreadCount ne compte que les non lues de l’acteur', async () => {
    prisma.notification.count.mockResolvedValue(3);
    await expect(service.unreadCount(7)).resolves.toBe(3);
    expect(prisma.notification.count).toHaveBeenCalledWith({
      where: { recipientUserGroupId: 7, isRead: false },
    });
  });

  it('createMany dédoublonne et n’appelle pas la base si la liste est vide', async () => {
    await expect(service.createMany([null, undefined], 'msg')).resolves.toEqual({ count: 0 });
    expect(prisma.notification.createMany).not.toHaveBeenCalled();
  });

  it('createMany crée une notification par destinataire distinct', async () => {
    prisma.notification.createMany.mockResolvedValue({ count: 2 });
    await service.createMany([5, 5, 8], 'msg', { type: 'mail', id: 42 });
    expect(prisma.notification.createMany).toHaveBeenCalledWith({
      data: [
        { recipientUserGroupId: 5, message: 'msg', targetType: 'mail', targetId: 42 },
        { recipientUserGroupId: 8, message: 'msg', targetType: 'mail', targetId: 42 },
      ],
    });
  });

  it('markRead ne marque que la notification du propriétaire', async () => {
    prisma.notification.updateMany.mockResolvedValue({ count: 1 });
    await expect(service.markRead(99, 7, now)).resolves.toEqual({ updated: 1 });
    expect(prisma.notification.updateMany).toHaveBeenCalledWith({
      where: { notificationId: 99, recipientUserGroupId: 7, isRead: false },
      data: { isRead: true, readAt: now },
    });
  });

  it('list renvoie total, non-lus et lignes paginées', async () => {
    prisma.notification.count.mockResolvedValueOnce(10).mockResolvedValueOnce(4);
    prisma.notification.findMany.mockResolvedValue([{ notificationId: 1 }]);
    const res = await service.list(7, { page: 1, pageSize: 20 });
    expect(res).toMatchObject({ total: 10, unread: 4, page: 1, pageSize: 20 });
    expect(res.rows).toHaveLength(1);
  });

  // §03.5 : double canal. L'in-app fait foi, l'e-mail est un doublon de confort qui ne doit ni
  // ralentir ni faire échouer l'action métier.
  describe('canal e-mail', () => {
    /** Laisse tourner la micro-tâche de `dispatchEmails`, volontairement non attendue. */
    const flush = () => new Promise((r) => setImmediate(r));

    it('ne touche pas à la base des acteurs quand le canal est désactivé', async () => {
      prisma.notification.createMany.mockResolvedValue({ count: 1 });
      await service.createMany([5], 'msg', { type: 'mail', id: 42 });
      await flush();
      expect(prisma.appUserGroup.findMany).not.toHaveBeenCalled();
      expect(email.send).not.toHaveBeenCalled();
    });

    it('dédoublonne par ADRESSE : une personne multi-groupes reçoit un seul e-mail', async () => {
      email.enabled = true;
      prisma.notification.createMany.mockResolvedValue({ count: 2 });
      prisma.appUserGroup.findMany.mockResolvedValue([
        { user: { email: 'awa@example.ci' } },
        { user: { email: 'awa@example.ci' } }, // même personne, autre groupe
        { user: { email: 'bertin@example.ci' } },
      ]);

      await service.createMany([5, 8], 'msg', { type: 'mail', id: 42 });
      await flush();

      expect(email.send).toHaveBeenCalledTimes(2);
      expect(email.send.mock.calls.map((c) => c[0].to).sort()).toEqual([
        'awa@example.ci',
        'bertin@example.ci',
      ]);
    });

    it('joint le lien vers le courrier concerné', async () => {
      email.enabled = true;
      prisma.notification.createMany.mockResolvedValue({ count: 1 });
      prisma.appUserGroup.findMany.mockResolvedValue([{ user: { email: 'awa@example.ci' } }]);

      await service.createMany([5], 'msg', { type: 'mail', id: 42 });
      await flush();

      expect(email.send.mock.calls[0][0].link).toBe('/courriers/suivi/42');
    });

    it('ignore les acteurs sans adresse e-mail', async () => {
      email.enabled = true;
      prisma.notification.createMany.mockResolvedValue({ count: 1 });
      prisma.appUserGroup.findMany.mockResolvedValue([
        { user: { email: null } },
        { user: { email: '   ' } },
      ]);

      await service.createMany([5, 8], 'msg');
      await flush();

      expect(email.send).not.toHaveBeenCalled();
    });

    // Les détails du courrier ne sont qu'un enrichissement du gabarit : leur échec ne doit pas
    // priver le destinataire de l'e-mail lui-même.
    it('envoie quand même l’e-mail si les détails du courrier sont introuvables', async () => {
      email.enabled = true;
      prisma.notification.createMany.mockResolvedValue({ count: 1 });
      prisma.appUserGroup.findMany.mockResolvedValue([{ user: { email: 'awa@example.ci' } }]);
      prisma.mail.findUnique.mockRejectedValue(new Error('table injoignable'));

      await service.createMany([5], 'msg', { type: 'mail', id: 42 });
      await flush();

      expect(email.send).toHaveBeenCalledTimes(1);
      expect(email.send.mock.calls[0][0].details).toEqual([]);
    });

    // Le point le plus important : une messagerie en panne ne doit pas remonter jusqu'à l'appelant
    // métier (ni rejet, ni unhandledRejection).
    it('n’échoue pas quand la résolution des destinataires plante', async () => {
      email.enabled = true;
      prisma.notification.createMany.mockResolvedValue({ count: 1 });
      prisma.appUserGroup.findMany.mockRejectedValue(new Error('base injoignable'));

      await expect(service.createMany([5], 'msg')).resolves.toEqual({ count: 1 });
      await flush();
    });
  });
});
