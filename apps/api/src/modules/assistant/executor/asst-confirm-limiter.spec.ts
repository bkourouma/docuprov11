import { AsstError } from '../assistant.contracts';
import { ASST_CONFIRM_MAX_PER_MINUTE, AsstConfirmLimiter } from './asst-confirm-limiter';

const T0 = new Date('2026-11-22T10:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);

describe('AsstConfirmLimiter', () => {
  it("accepte jusqu'à la limite", () => {
    const l = new AsstConfirmLimiter();
    for (let i = 0; i < ASST_CONFIRM_MAX_PER_MINUTE; i++) expect(() => l.consume(1, at(i))).not.toThrow();
  });

  it('refuse la tentative suivante avec budget_exceeded', () => {
    const l = new AsstConfirmLimiter();
    for (let i = 0; i < ASST_CONFIRM_MAX_PER_MINUTE; i++) l.consume(1, at(i));
    let err: unknown;
    try {
      l.consume(1, at(100));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AsstError);
    expect(err).toMatchObject({
      errorCode: 'budget_exceeded',
      message: 'Trop de confirmations en peu de temps : réessayez dans une minute.',
    });
  });

  it('fait glisser la fenêtre et ne la rallonge pas sur refus', () => {
    const l = new AsstConfirmLimiter();
    for (let i = 0; i < ASST_CONFIRM_MAX_PER_MINUTE; i++) l.consume(1, at(0));
    expect(() => l.consume(1, at(30_000))).toThrow(AsstError);
    expect(() => l.consume(1, at(59_999))).toThrow(AsstError);
    // les 10 premiers sont échus à 60 s : les refus n'ont rien décalé
    expect(() => l.consume(1, at(60_000))).not.toThrow();
  });

  it('isole les utilisateurs', () => {
    const l = new AsstConfirmLimiter();
    for (let i = 0; i < ASST_CONFIRM_MAX_PER_MINUTE; i++) l.consume(1, at(0));
    expect(() => l.consume(1, at(1))).toThrow(AsstError);
    expect(() => l.consume(2, at(1))).not.toThrow();
  });

  it('purge les utilisateurs échus au-delà de 10 000 entrées', () => {
    const l = new AsstConfirmLimiter();
    for (let u = 0; u < 10_000; u++) l.consume(u, at(0));
    expect(l.trackedUsers).toBe(10_000);
    l.consume(20_000, at(120_000));
    expect(l.trackedUsers).toBe(1);
  });
});
