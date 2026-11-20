import * as encoding from 'lib0/encoding';
import {
  CLIENT_MESSAGE_TYPES,
  CollabMessageType,
  isHeartbeat,
  parseRoomName,
  readMessageHeader,
  urlCarriesToken,
} from './collab-protocol';
import { ConnectionRateLimiter, TokenBucket } from './collab-rate-limiter';

function header(key: string, type: number): Uint8Array {
  const e = encoding.createEncoder();
  encoding.writeVarString(e, key);
  encoding.writeVarUint(e, type);
  return encoding.toUint8Array(e);
}

describe('parseRoomName', () => {
  it.each([
    ['1', 1],
    ['42', 42],
    ['2147483647', 2147483647],
  ])('%s -> %d', (name, id) => expect(parseRoomName(name)).toBe(id));

  it.each(['', '0', '007', '-1', '+1', ' 1', '1 ', '1.0', '1e3', '0x10', 'abc', '2147483648', '99999999999', '١'])(
    'refuse %p',
    (name) => expect(parseRoomName(name)).toBeNull(),
  );

  it('refuse un non-texte', () => {
    expect(parseRoomName(12)).toBeNull();
    expect(parseRoomName(null)).toBeNull();
  });
});

describe('readMessageHeader', () => {
  it('lit nom, session et type', () => {
    expect(readMessageHeader(header('12', 0))).toEqual({
      rawKey: '12',
      documentName: '12',
      sessionId: null,
      type: 0,
    });
    expect(readMessageHeader(header('12\0abc_9', 1))).toMatchObject({
      documentName: '12',
      sessionId: 'abc_9',
      type: 1,
    });
  });

  it.each([
    ['vide', new Uint8Array()],
    ['sans type', (() => { const e = encoding.createEncoder(); encoding.writeVarString(e, '12'); return encoding.toUint8Array(e); })()],
    ['longueur hors bornes', Uint8Array.from([200, 200, 200, 200, 1])],
    ['nom vide', header('', 0)],
    ['nom trop long', header('1'.repeat(200), 0)],
    ['session invalide', header('12\0<script>', 0)],
  ])('renvoie null pour un message %s (sans jeter)', (_l, bytes) => {
    expect(readMessageHeader(bytes)).toBeNull();
  });

  it('n’autorise que les types émis par un client', () => {
    expect(CLIENT_MESSAGE_TYPES.has(CollabMessageType.Sync)).toBe(true);
    expect(CLIENT_MESSAGE_TYPES.has(CollabMessageType.BroadcastStateless)).toBe(false);
    expect(CLIENT_MESSAGE_TYPES.has(CollabMessageType.SyncStatus)).toBe(false);
    expect(CLIENT_MESSAGE_TYPES.has(99)).toBe(false);
  });

  it('reconnaît le pong applicatif du provider', () => {
    expect(isHeartbeat(Uint8Array.from([CollabMessageType.Pong]))).toBe(true);
    expect(isHeartbeat(Uint8Array.from([CollabMessageType.Pong, 0]))).toBe(false);
  });
});

describe('urlCarriesToken', () => {
  it.each(['token=x', 'access_token=x', 'JWT=x', 'Authorization=x'])('détecte %s', (q) => {
    expect(urlCarriesToken(new URLSearchParams(q))).toBe(true);
  });
  it('laisse passer les autres paramètres', () => {
    expect(urlCarriesToken(new URLSearchParams('v=2'))).toBe(false);
  });
});

describe('limiteur de débit', () => {
  it('seau à jetons : rafale puis recharge', () => {
    const bucket = new TokenBucket(3, 1, 0);
    expect([1, 2, 3, 4].map(() => bucket.take(1, 0))).toEqual([true, true, true, false]);
    expect(bucket.take(1, 999)).toBe(false);
    expect(bucket.take(1, 1000)).toBe(true);
  });

  it('coupe sur les messages/s OU les octets/s', () => {
    const limits = { messagesPerSecond: 10, messageBurst: 10, bytesPerSecond: 100, byteBurst: 100 };
    const byCount = new ConnectionRateLimiter(limits, 0);
    let ok = 0;
    while (byCount.allow(1, 0)) ok += 1;
    expect(ok).toBe(10);

    const byBytes = new ConnectionRateLimiter(limits, 0);
    expect(byBytes.allow(60, 0)).toBe(true);
    expect(byBytes.allow(60, 0)).toBe(false);
    expect(byBytes.allow(60, 1000)).toBe(true);
  });
});
