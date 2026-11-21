// Magasin Redis d'état OAuth : arguments exacts envoyés à Redis (usage unique, TTL, pas d'écrasement).
import { RedisOAuthStateStore, type OAuthStateRecord } from './oauth-state.store';

const NONCE = 'AbCdEfGhIjKlMnOpQrStUv';
const RECORD = {
  uid: 1,
  cid: 2,
  provider: 'google',
  redirectUri: 'https://ged.example.test/connecteurs/oauth/callback',
  verifierEnc: 'chiffre-factice',
  verifierKeyId: 'k1',
} as OAuthStateRecord;

function fakeRedis() {
  return {
    set: jest.fn().mockResolvedValue('OK'),
    eval: jest.fn().mockResolvedValue(JSON.stringify(RECORD)),
    disconnect: jest.fn(),
  };
}

describe('RedisOAuthStateStore', () => {
  it('put : SET clé EX ttl NX, valeur JSON', async () => {
    const redis = fakeRedis();
    await new RedisOAuthStateStore(redis as never).put(NONCE, RECORD, 600);
    expect(redis.set).toHaveBeenCalledWith(
      `ged:oauth:state:${NONCE}`,
      JSON.stringify(RECORD),
      'EX',
      600,
      'NX',
    );
  });

  it('put : nonce déjà présent (NX refusé) ⇒ erreur', async () => {
    const redis = fakeRedis();
    redis.set.mockResolvedValue(null);
    await expect(new RedisOAuthStateStore(redis as never).put(NONCE, RECORD, 600)).rejects.toThrow(
      /déjà enregistré/,
    );
  });

  it('take : script eval GET puis DEL sur la clé, enregistrement décodé', async () => {
    const redis = fakeRedis();
    const out = await new RedisOAuthStateStore(redis as never).take(NONCE);
    expect(out).toEqual(RECORD);
    const [script, nbKeys, key] = redis.eval.mock.calls[0];
    expect(script).toMatch(/GET/);
    expect(script).toMatch(/DEL/);
    expect(nbKeys).toBe(1);
    expect(key).toBe(`ged:oauth:state:${NONCE}`);
  });

  it('take : absent ou illisible ⇒ null', async () => {
    const redis = fakeRedis();
    const store = new RedisOAuthStateStore(redis as never);
    redis.eval.mockResolvedValueOnce(null);
    expect(await store.take(NONCE)).toBeNull();
    redis.eval.mockResolvedValueOnce('pas du json');
    expect(await store.take(NONCE)).toBeNull();
  });

  it('nonce de mauvaise forme refusé avant tout appel Redis', async () => {
    const redis = fakeRedis();
    const store = new RedisOAuthStateStore(redis as never);
    await expect(store.take('a b*')).rejects.toThrow();
    await expect(store.put('../x', RECORD, 1)).rejects.toThrow();
    expect(redis.eval).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('close : déconnecte', async () => {
    const redis = fakeRedis();
    await new RedisOAuthStateStore(redis as never).close();
    expect(redis.disconnect).toHaveBeenCalled();
  });
});
