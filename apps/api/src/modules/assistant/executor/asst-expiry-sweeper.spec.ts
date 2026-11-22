import { AsstExpirySweeper } from './asst-expiry-sweeper';
import type { AsstExecutorService } from './asst-executor.service';

function make() {
  const executor = { expireDue: jest.fn().mockResolvedValue(2), recoverInterrupted: jest.fn().mockResolvedValue(1) };
  const sweeper = new AsstExpirySweeper(executor as unknown as AsstExecutorService);
  return { executor, sweeper };
}

describe('AsstExpirySweeper', () => {
  const env = { ...process.env };
  beforeEach(() => {
    jest.useFakeTimers();
    delete process.env.ASST_EXPIRY_SWEEP_MS;
    process.env.NODE_ENV = 'development';
  });
  afterEach(() => {
    jest.useRealTimers();
    process.env = { ...env };
  });

  it('est désactivé en environnement de test', () => {
    process.env.NODE_ENV = 'test';
    const { executor, sweeper } = make();
    sweeper.onModuleInit();
    jest.advanceTimersByTime(300_000);
    expect(executor.expireDue).not.toHaveBeenCalled();
    sweeper.onModuleDestroy();
  });

  it('est désactivé si la période vaut 0 ou est invalide', () => {
    for (const v of ['0', 'abc', '-5']) {
      process.env.ASST_EXPIRY_SWEEP_MS = v;
      const { executor, sweeper } = make();
      sweeper.onModuleInit();
      jest.advanceTimersByTime(300_000);
      expect(executor.expireDue).not.toHaveBeenCalled();
      sweeper.onModuleDestroy();
    }
  });

  it('respecte la période (défaut 60 s puis valeur configurée)', async () => {
    const a = make();
    a.sweeper.onModuleInit();
    await jest.advanceTimersByTimeAsync(59_999);
    expect(a.executor.expireDue).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(a.executor.expireDue).toHaveBeenCalledTimes(1);
    expect(a.executor.expireDue).toHaveBeenCalledWith(expect.any(Date), 200);
    expect(a.executor.recoverInterrupted).toHaveBeenCalledWith(expect.any(Date), 200);
    a.sweeper.onModuleDestroy();

    process.env.ASST_EXPIRY_SWEEP_MS = '1000';
    const b = make();
    b.sweeper.onModuleInit();
    await jest.advanceTimersByTimeAsync(3000);
    expect(b.executor.expireDue).toHaveBeenCalledTimes(3);
    b.sweeper.onModuleDestroy();
  });

  it('tick retourne les comptes', async () => {
    const { sweeper } = make();
    await expect(sweeper.tick()).resolves.toEqual({ expired: 2, interrupted: 1 });
  });

  it('ne se chevauche pas', async () => {
    const { executor, sweeper } = make();
    let release!: (n: number) => void;
    executor.expireDue.mockReturnValueOnce(new Promise<number>((r) => (release = r)));
    const first = sweeper.tick();
    await expect(sweeper.tick()).resolves.toEqual({ expired: 0, interrupted: 0 });
    expect(executor.expireDue).toHaveBeenCalledTimes(1);
    release(5);
    await expect(first).resolves.toEqual({ expired: 5, interrupted: 1 });
    await sweeper.tick();
    expect(executor.expireDue).toHaveBeenCalledTimes(2);
  });

  it('isole les erreurs de chaque appel', async () => {
    const { executor, sweeper } = make();
    executor.expireDue.mockRejectedValueOnce(new Error('boom'));
    await expect(sweeper.tick()).resolves.toEqual({ expired: 0, interrupted: 1 });
    executor.recoverInterrupted.mockRejectedValueOnce(new Error('boom'));
    await expect(sweeper.tick()).resolves.toEqual({ expired: 2, interrupted: 0 });
  });

  it("s'arrête proprement", async () => {
    process.env.ASST_EXPIRY_SWEEP_MS = '1000';
    const { executor, sweeper } = make();
    sweeper.onModuleInit();
    sweeper.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(5000);
    expect(executor.expireDue).not.toHaveBeenCalled();
  });
});
