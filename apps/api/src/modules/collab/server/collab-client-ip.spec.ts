import { normalizeIp, parseTrustProxy, resolveClientIp } from './collab-client-ip';
import { resolveCollabServerOptions } from './collab-server.options';

describe('parseTrustProxy', () => {
  it.each([
    [undefined, 0],
    [null, 0],
    ['', 0],
    ['  ', 0],
    ['0', 0],
    ['1', 1],
    [' 2 ', 2],
    ['10', 10],
    [3, 3],
  ])('%p -> %p', (raw, expected) => {
    expect(parseTrustProxy(raw as string | number | null | undefined)).toBe(expected);
  });

  it.each(['-1', '1.5', 'true', 'oui', '11', '99', '1e1', '0x1'])('valeur invalide %p refusée', (raw) => {
    expect(parseTrustProxy(raw)).toBeNull();
  });
});

describe('normalizeIp', () => {
  it('normalise IPv4, IPv6 et IPv4 projetée', () => {
    expect(normalizeIp(' 10.0.0.1 ')).toBe('10.0.0.1');
    expect(normalizeIp('::ffff:10.0.0.1')).toBe('10.0.0.1');
    expect(normalizeIp('2001:DB8::1')).toBe('2001:db8::1');
  });

  it.each(['', 'pas-une-ip', '10.0.0.1:8080', '[::1]', '999.1.1.1', 'unknown'])('rejette %p', (raw) => {
    expect(normalizeIp(raw)).toBeNull();
  });
});

describe('resolveClientIp', () => {
  const socket = '::ffff:172.18.0.5';

  it('sans proxy de confiance : X-Forwarded-For ignoré', () => {
    expect(resolveClientIp(socket, '203.0.113.7', 0)).toBe('172.18.0.5');
  });

  it('un proxy de confiance : entrée la plus à droite', () => {
    expect(resolveClientIp(socket, '203.0.113.7', 1)).toBe('203.0.113.7');
    expect(resolveClientIp(socket, '6.6.6.6, 203.0.113.7', 1)).toBe('203.0.113.7');
  });

  it('deux proxys de confiance : deuxième entrée depuis la droite', () => {
    expect(resolveClientIp(socket, '6.6.6.6, 203.0.113.7, 10.0.0.2', 2)).toBe('203.0.113.7');
  });

  it('en-têtes multiples : concaténés dans l’ordre', () => {
    expect(resolveClientIp(socket, ['6.6.6.6', '203.0.113.7'], 1)).toBe('203.0.113.7');
  });

  it('chaîne plus courte que le nombre de proxys : adresse du socket', () => {
    expect(resolveClientIp(socket, '203.0.113.7', 2)).toBe('172.18.0.5');
  });

  it('entrée retenue invalide, en-tête vide ou démesuré : adresse du socket', () => {
    expect(resolveClientIp(socket, '203.0.113.7, n/a', 1)).toBe('172.18.0.5');
    expect(resolveClientIp(socket, '', 1)).toBe('172.18.0.5');
    expect(resolveClientIp(socket, `${'1.1.1.1,'.repeat(400)}203.0.113.7`, 1)).toBe('172.18.0.5');
  });

  it('sans adresse de socket ni en-tête exploitable : « inconnue »', () => {
    expect(resolveClientIp(undefined, undefined, 0)).toBe('inconnue');
  });
});

describe('options : trustProxy', () => {
  it('valeur hors bornes forcée à 0', () => {
    expect(resolveCollabServerOptions({ trustProxy: -1 }).trustProxy).toBe(0);
    expect(resolveCollabServerOptions({ trustProxy: 1.5 }).trustProxy).toBe(0);
    expect(resolveCollabServerOptions({ trustProxy: 50 }).trustProxy).toBe(0);
    expect(resolveCollabServerOptions({ trustProxy: 2 }).trustProxy).toBe(2);
    expect(resolveCollabServerOptions({}).trustProxy).toBe(0);
  });
});
