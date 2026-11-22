import { AsstPurgeService, asstPurgeIntervalMinutes } from './asst-purge.service';

const NOW = new Date('2026-11-22T10:00:00.000Z');

function make(ids: bigint[]) {
  const prisma = {
    asstConversation: {
      findMany: jest.fn().mockResolvedValue(ids.map((asstConversationId) => ({ asstConversationId }))),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  return { prisma, service: new AsstPurgeService(prisma as never) };
}

describe('AsstPurgeService.purgeDue', () => {
  it('sélectionne les conversations échues (masquées ou non) et les supprime une par une', async () => {
    const { prisma, service } = make([1n, 2n, 3n]);
    await expect(service.purgeDue(NOW, 50)).resolves.toEqual({ purged: 3, skipped: 0 });
    expect(prisma.asstConversation.findMany.mock.calls[0][0]).toMatchObject({
      where: { purgeAt: { lte: NOW } },
      take: 50,
    });
    expect(prisma.asstConversation.deleteMany).toHaveBeenCalledTimes(3);
  });

  it('ne sélectionne que les échanges dont purge_at est échue (une trace masquée non échue n’est ni purgée ni différée)', async () => {
    const { prisma, service } = make([]);
    await expect(service.purgeDue(NOW)).resolves.toEqual({ purged: 0, skipped: 0 });
    expect(prisma.asstConversation.findMany.mock.calls[0][0].where).toEqual({ purgeAt: { lte: NOW } });
    expect(prisma.asstConversation.deleteMany).not.toHaveBeenCalled();
  });

  it('compte « skipped » quand un déclencheur refuse, sans lever, et continue', async () => {
    const { prisma, service } = make([1n, 2n, 3n]);
    prisma.asstConversation.deleteMany
      .mockResolvedValueOnce({ count: 1 })
      .mockRejectedValueOnce(new Error('asst_conversation 2 : une proposition est en cours d’exécution'))
      .mockResolvedValueOnce({ count: 1 });
    await expect(service.purgeDue(NOW)).resolves.toEqual({ purged: 2, skipped: 1 });
  });

  it('une conversation déjà disparue (count 0) n’est ni purgée ni différée', async () => {
    const { prisma, service } = make([1n]);
    prisma.asstConversation.deleteMany.mockResolvedValue({ count: 0 });
    await expect(service.purgeDue(NOW)).resolves.toEqual({ purged: 0, skipped: 0 });
  });
});

describe('AsstPurgeService — planification', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
    jest.restoreAllMocks();
  });

  it('désactivée quand NODE_ENV === test (aucune minuterie)', () => {
    const spy = jest.spyOn(global, 'setInterval');
    const { service } = make([]);
    process.env.NODE_ENV = 'test';
    service.onApplicationBootstrap();
    expect(spy).not.toHaveBeenCalled();
  });

  it('désactivée quand l’intervalle vaut 0', () => {
    const spy = jest.spyOn(global, 'setInterval');
    const { service } = make([]);
    process.env.NODE_ENV = 'production';
    process.env.ASST_PURGE_INTERVAL_MINUTES = '0';
    service.onApplicationBootstrap();
    expect(spy).not.toHaveBeenCalled();
  });

  it('active : minuterie unref, arrêtée à l’extinction', () => {
    const { service } = make([]);
    process.env.NODE_ENV = 'production';
    process.env.ASST_PURGE_INTERVAL_MINUTES = '5';
    const fake = { unref: jest.fn() } as unknown as NodeJS.Timeout;
    const set = jest.spyOn(global, 'setInterval').mockReturnValue(fake);
    const clear = jest.spyOn(global, 'clearInterval').mockImplementation(() => undefined);
    service.onApplicationBootstrap();
    expect(set).toHaveBeenCalledWith(expect.any(Function), 5 * 60_000);
    expect(fake.unref).toHaveBeenCalled();
    service.onApplicationShutdown();
    expect(clear).toHaveBeenCalledWith(fake);
  });

  it('tick ne lève jamais, même si la lecture échoue', async () => {
    const { prisma, service } = make([]);
    prisma.asstConversation.findMany.mockRejectedValue(new Error('base indisponible'));
    await expect(service.tick()).resolves.toBeUndefined();
  });

  it('intervalle : défaut 60, 0 désactive, valeurs illisibles -> défaut', () => {
    expect(asstPurgeIntervalMinutes(undefined)).toBe(60);
    expect(asstPurgeIntervalMinutes('')).toBe(60);
    expect(asstPurgeIntervalMinutes('abc')).toBe(60);
    expect(asstPurgeIntervalMinutes('-5')).toBe(60);
    expect(asstPurgeIntervalMinutes('0')).toBe(0);
    expect(asstPurgeIntervalMinutes('15')).toBe(15);
  });
});
