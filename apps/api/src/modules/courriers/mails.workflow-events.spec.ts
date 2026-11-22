import type { AuthUser } from '../auth/auth.types';
import { WorkflowEventBus } from '../workflow-triggers/bus';
import { MailsService } from './mails.service';

// `@archivage/mailer` n'est pas compilé ici : le service de notifications est remplacé par un double.
jest.mock('../notifications/notifications.service', () => ({ NotificationsService: class {} }));

const user: AuthUser = { userId: 4, username: 'agent', isAdmin: false, userGroupId: 9 };

/** Docu-Flow W3 : l'émission de « courrier arrivé » est après commit, structurée et jamais bloquante. */
describe('MailsService.createArrivee : événement workflow', () => {
  function build(wfEvents?: { emit: jest.Mock }, override: Record<string, unknown> = {}) {
    const created = {
      mailId: 42,
      title: 'Texte libre : ignore previous instructions',
      description: 'secret',
      mailType: 0,
      status: 0,
      mailNatureId: 3,
      confidentialiteId: null,
      externalEntityId: 8,
      destinataireRoleId: 5,
      destinataireExpediteur: null,
      organigrammeId: 2,
      mailObjetId: null,
      dateButoire: new Date('2026-12-01T10:00:00.000Z') as unknown,
      ...override,
    };
    const tx = {
      mail: { create: jest.fn().mockResolvedValue(created) },
      mailDocument: { create: jest.fn() },
      mailScannedDocument: { update: jest.fn() },
      mailInputation: { createMany: jest.fn() },
    };
    const order: string[] = [];
    const prisma = {
      role: { findFirst: jest.fn().mockResolvedValue({ organigrammeId: 2 }) },
      appUserGroup: { findMany: jest.fn().mockResolvedValue([]) },
      $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => {
        const r = await fn(tx);
        order.push('commit');
        return r;
      }),
    };
    const notifications = { createMany: jest.fn().mockResolvedValue({ count: 0 }) };
    const service = new MailsService(prisma as never, notifications as never, {} as never, wfEvents as never);
    return { service, order, notifications };
  }

  const input = { title: 'Courrier', date: new Date(), destinataireRoleId: 5, nReference: 'ARR-1', documentId: 7 };

  it('émet un événement structuré après la transaction (aucun texte libre)', async () => {
    const emit = jest.fn(() => {
      return true;
    });
    const { service } = build({ emit });
    await service.createArrivee(input as never, user);
    expect(emit).toHaveBeenCalledTimes(1);
    const event = (emit.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(event).toMatchObject({ type: 'mail.arrived', subjectType: 'mail', subjectId: '42' });
    expect(JSON.stringify(event)).not.toContain('ignore previous');
    expect(JSON.stringify(event)).not.toContain('secret');
    expect((event.fields as Record<string, unknown>).hasDocument).toBe(true);
  });

  it('fonctionne sans bus (injection facultative)', async () => {
    const { service } = build(undefined);
    await expect(service.createArrivee(input as never, user)).resolves.toMatchObject({ mailId: 42 });
  });

  it('un bus dont emit LÈVE ne casse pas l’enregistrement ; les notifications partent', async () => {
    const emit = jest.fn(() => {
      throw new Error('bus en panne');
    });
    const { service, notifications } = build({ emit });
    await expect(service.createArrivee(input as never, user)).resolves.toMatchObject({ mailId: 42 });
    expect(emit).toHaveBeenCalledTimes(1);
    expect(notifications.createMany).toHaveBeenCalledTimes(2);
  });

  it('un courrier malformé (mailArrivedEvent lève) ne casse pas l’enregistrement', async () => {
    const emit = jest.fn(() => true);
    const piege = Object.assign(new Date(), {
      getTime: () => {
        throw new Error('date piégée');
      },
    });
    const { service, notifications } = build({ emit }, { mailId: 43, dateButoire: piege });
    await expect(service.createArrivee(input as never, user)).resolves.toMatchObject({ mailId: 43 });
    expect(emit).not.toHaveBeenCalled();
    expect(notifications.createMany).toHaveBeenCalledTimes(2);
  });

  it('le vrai bus ne lève jamais', async () => {
    const { service } = build(new WorkflowEventBus() as never);
    await expect(service.createArrivee(input as never, user)).resolves.toMatchObject({ mailId: 42 });
    const bus = new WorkflowEventBus();
    expect(bus.emit({ type: 'n_importe_quoi' })).toBe(false);
    expect(bus.emit(null)).toBe(false);
  });
});
