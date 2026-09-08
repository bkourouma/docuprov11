import { DEFAULT_WATCH_DIR, loadEnv, resolveCredentials, resolveWatchDir } from './env';

const KEY = 'k'.repeat(48);
const BASE = {
  SCAN_AGENT_API_URL: 'http://localhost:3001/api',
  SCAN_AGENT_API_KEY: KEY,
};

describe('loadEnv', () => {
  it('applique le dossier surveillé par défaut', () => {
    const env = loadEnv({ ...BASE } as NodeJS.ProcessEnv);
    expect(env.SCAN_AGENT_WATCH_DIR).toBe('D:/scans-entrants');
    expect(env.SCAN_AGENT_POLL_MS).toBe(5_000);
  });

  it('refuse une URL d’API absente', () => {
    expect(() => loadEnv({ SCAN_AGENT_API_KEY: KEY })).toThrow(/SCAN_AGENT_API_URL/);
  });
});

describe('resolveCredentials', () => {
  it('retient la clé de service quand elle est présente', () => {
    expect(resolveCredentials(loadEnv({ ...BASE } as NodeJS.ProcessEnv))).toEqual({
      kind: 'apiKey',
      apiKey: KEY,
    });
  });

  it('donne la priorité à la clé sur un compte encore configuré', () => {
    const env = loadEnv({
      ...BASE,
      SCAN_AGENT_USERNAME: 'svc.scan',
      SCAN_AGENT_PASSWORD: 'secret',
    } as NodeJS.ProcessEnv);
    expect(resolveCredentials(env).kind).toBe('apiKey');
  });

  it('retombe sur le compte applicatif sans clé', () => {
    const env = loadEnv({
      SCAN_AGENT_API_URL: BASE.SCAN_AGENT_API_URL,
      SCAN_AGENT_USERNAME: 'svc.scan',
      SCAN_AGENT_PASSWORD: 'secret',
    } as NodeJS.ProcessEnv);
    expect(resolveCredentials(env)).toEqual({
      kind: 'password',
      username: 'svc.scan',
      password: 'secret',
    });
  });

  it('échoue au démarrage si rien n’est configuré', () => {
    const env = loadEnv({ SCAN_AGENT_API_URL: BASE.SCAN_AGENT_API_URL } as NodeJS.ProcessEnv);
    expect(() => resolveCredentials(env)).toThrow(/SCAN_AGENT_API_KEY/);
  });

  it('échoue si le compte est à moitié renseigné', () => {
    const env = loadEnv({
      SCAN_AGENT_API_URL: BASE.SCAN_AGENT_API_URL,
      SCAN_AGENT_USERNAME: 'svc.scan',
    } as NodeJS.ProcessEnv);
    expect(() => resolveCredentials(env)).toThrow(/SCAN_AGENT_API_KEY/);
  });
});

describe('resolveWatchDir', () => {
  it('surveille D:/scans-entrants par défaut', () => {
    expect(
      resolveWatchDir({ SCAN_AGENT_WATCH_DIR: DEFAULT_WATCH_DIR, ARCHIVES_PATH: 'D:/ARCHIVES' }),
    ).toBe('D:/scans-entrants');
  });

  it('laisse la main à un chemin explicite', () => {
    expect(
      resolveWatchDir({ SCAN_AGENT_WATCH_DIR: 'E:/scans', ARCHIVES_PATH: 'D:/ARCHIVES' }),
    ).toBe('E:/scans');
  });

  it('accepte un dossier situé sous le coffre sans être sa racine', () => {
    expect(
      resolveWatchDir({
        SCAN_AGENT_WATCH_DIR: 'D:/ARCHIVES/_scans-entrants',
        ARCHIVES_PATH: 'D:/ARCHIVES',
      }),
    ).toBe('D:/ARCHIVES/_scans-entrants');
  });

  it('refuse la racine du coffre — les binaires de la GED y sont stockés à plat', () => {
    expect(() =>
      resolveWatchDir({ SCAN_AGENT_WATCH_DIR: 'D:/ARCHIVES', ARCHIVES_PATH: 'D:/ARCHIVES' }),
    ).toThrow(/racine du coffre/);
  });

  it('refuse aussi la racine écrite différemment (séparateurs, slash final)', () => {
    expect(() =>
      resolveWatchDir({ SCAN_AGENT_WATCH_DIR: 'D:\\ARCHIVES\\', ARCHIVES_PATH: 'D:/ARCHIVES' }),
    ).toThrow(/racine du coffre/);
  });
});
