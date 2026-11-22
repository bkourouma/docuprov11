import {
  ASST_MESSAGES_PER_MINUTE_DEFAULT,
  AsstMessageRateLimiter,
  readMessagesPerMinute,
} from './asst-message-rate-limiter';

function make(over: { limit?: number; windowMs?: number; maxUsers?: number } = {}) {
  const clock = { t: 1_000_000 };
  const limiter = new AsstMessageRateLimiter({ ...over, now: () => clock.t });
  return { clock, limiter };
}

describe('AsstMessageRateLimiter', () => {
  it('autorise jusqu’à la limite puis refuse avec un délai d’attente', () => {
    const { limiter } = make({ limit: 3 });
    expect(limiter.tryConsume(1)).toEqual({ allowed: true });
    expect(limiter.tryConsume(1)).toEqual({ allowed: true });
    expect(limiter.tryConsume(1)).toEqual({ allowed: true });
    expect(limiter.tryConsume(1)).toEqual({ allowed: false, retryAfterSeconds: 60 });
  });

  it('défaut : 10 messages par 60 secondes', () => {
    const { limiter } = make();
    for (let i = 0; i < ASST_MESSAGES_PER_MINUTE_DEFAULT; i++) expect(limiter.tryConsume(1).allowed).toBe(true);
    expect(limiter.tryConsume(1).allowed).toBe(false);
  });

  it('fenêtre glissante : le plus ancien message libère une place au bout de la fenêtre', () => {
    const { limiter, clock } = make({ limit: 2 });
    limiter.tryConsume(1);
    clock.t += 30_000;
    limiter.tryConsume(1);
    clock.t += 10_000;
    expect(limiter.tryConsume(1)).toEqual({ allowed: false, retryAfterSeconds: 20 });
    clock.t += 20_000; // le premier message a 60 s
    expect(limiter.tryConsume(1)).toEqual({ allowed: true });
    expect(limiter.tryConsume(1)).toEqual({ allowed: false, retryAfterSeconds: 30 });
  });

  it('un refus ne consomme pas de place', () => {
    const { limiter, clock } = make({ limit: 1 });
    limiter.tryConsume(1);
    clock.t += 10_000;
    for (let i = 0; i < 5; i++) limiter.tryConsume(1);
    clock.t += 50_000;
    expect(limiter.tryConsume(1)).toEqual({ allowed: true });
  });

  it('les utilisateurs sont indépendants', () => {
    const { limiter } = make({ limit: 1 });
    expect(limiter.tryConsume(1).allowed).toBe(true);
    expect(limiter.tryConsume(1).allowed).toBe(false);
    expect(limiter.tryConsume(2).allowed).toBe(true);
  });

  it('purge les utilisateurs inactifs (mémoire bornée)', () => {
    const { limiter, clock } = make({ limit: 5 });
    for (let u = 1; u <= 50; u++) limiter.tryConsume(u);
    expect(limiter.trackedUsers).toBe(50);
    clock.t += 61_000;
    limiter.tryConsume(999);
    expect(limiter.trackedUsers).toBe(1);
  });

  it('borne dure : jamais plus de maxUsers utilisateurs suivis, même tous actifs', () => {
    const { limiter } = make({ limit: 5, maxUsers: 20 });
    for (let u = 1; u <= 100; u++) limiter.tryConsume(u);
    expect(limiter.trackedUsers).toBeLessThanOrEqual(20);
  });

  it('une limite invalide dans les options retombe sur le défaut', () => {
    const { limiter } = make({ limit: 0 });
    for (let i = 0; i < ASST_MESSAGES_PER_MINUTE_DEFAULT; i++) expect(limiter.tryConsume(1).allowed).toBe(true);
    expect(limiter.tryConsume(1).allowed).toBe(false);
  });
});

describe('readMessagesPerMinute (ASST_MESSAGES_PER_MINUTE)', () => {
  it.each([
    ['5', 5],
    [' 30 ', 30],
    ['1', 1],
    [undefined, 10],
    ['', 10],
    ['0', 10],
    ['-3', 10],
    ['2.5', 10],
    ['abc', 10],
    ['1e3', 10],
  ])('« %s » -> %s', (raw, expected) => {
    expect(readMessagesPerMinute(raw === undefined ? {} : { ASST_MESSAGES_PER_MINUTE: raw })).toBe(expected);
  });

  it('le constructeur lit la variable d’environnement par défaut', () => {
    const before = process.env.ASST_MESSAGES_PER_MINUTE;
    process.env.ASST_MESSAGES_PER_MINUTE = '2';
    try {
      const limiter = new AsstMessageRateLimiter();
      expect(limiter.tryConsume(1).allowed).toBe(true);
      expect(limiter.tryConsume(1).allowed).toBe(true);
      expect(limiter.tryConsume(1).allowed).toBe(false);
    } finally {
      if (before === undefined) delete process.env.ASST_MESSAGES_PER_MINUTE;
      else process.env.ASST_MESSAGES_PER_MINUTE = before;
    }
  });
});
