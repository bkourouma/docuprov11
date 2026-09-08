import { AuthorizationError, ScanApiClient, UploadError } from './api-client';

const BASE = 'http://api.test/api';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Client en mode compte applicatif (repli). */
function client(fetchImpl: typeof fetch): ScanApiClient {
  return new ScanApiClient({
    baseUrl: `${BASE}/`, // slash final volontaire : il doit être normalisé
    credentials: { kind: 'password', username: 'svc.scan', password: 'secret' },
    fetchImpl,
  });
}

/** Client en mode clé de service (mode normal). */
function keyClient(fetchImpl: typeof fetch): ScanApiClient {
  return new ScanApiClient({
    baseUrl: BASE,
    credentials: { kind: 'apiKey', apiKey: 'k'.repeat(48) },
    fetchImpl,
  });
}

describe('ScanApiClient — clé de service', () => {
  it('présente la clé en en-tête et ne se connecte jamais', async () => {
    const calls: string[] = [];
    let seenKey: string | null = null;
    const fetchImpl = jest.fn(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push(String(url));
      seenKey = new Headers(init?.headers).get('X-Api-Key');
      return json({ mailScannedDocumentId: 5, fileName: 'a.pdf' });
    }) as unknown as typeof fetch;

    const res = await keyClient(fetchImpl).upload('a.pdf', Buffer.from('%PDF-1.4'), 'POSTE-01');

    expect(res.mailScannedDocumentId).toBe(5);
    expect(seenKey).toBe('k'.repeat(48));
    expect(calls.some((u) => u.endsWith('/auth/login'))).toBe(false);
  });

  it('ne rejoue pas un 401 : une clé fausse le reste', async () => {
    const fetchImpl = jest.fn(async () =>
      json({ message: 'Unauthorized' }, 401),
    ) as unknown as typeof fetch;

    await expect(keyClient(fetchImpl).upload('a.pdf', Buffer.from('x'), 'P')).rejects.toMatchObject(
      {
        name: 'AuthorizationError',
        status: 401,
      },
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('vérifie l’accès au démarrage avec la clé', async () => {
    const fetchImpl = jest.fn(async () =>
      json({ total: 0, page: 1, pageSize: 1, rows: [] }),
    ) as unknown as typeof fetch;

    await expect(keyClient(fetchImpl).checkAccess()).resolves.toBeUndefined();
  });
});

describe('ScanApiClient.upload', () => {
  it('se connecte une seule fois puis réutilise le jeton', async () => {
    const calls: string[] = [];
    const fetchImpl = jest.fn(async (url: Parameters<typeof fetch>[0]) => {
      calls.push(String(url));
      return String(url).endsWith('/auth/login')
        ? json({ accessToken: 'jwt-1' })
        : json({ mailScannedDocumentId: 7, fileName: 'a.pdf' });
    }) as unknown as typeof fetch;

    const api = client(fetchImpl);
    await api.upload('a.pdf', Buffer.from('%PDF-1.4'), 'POSTE-01');
    await api.upload('b.pdf', Buffer.from('%PDF-1.4'), 'POSTE-01');

    expect(calls.filter((u) => u.endsWith('/auth/login'))).toHaveLength(1);
    expect(calls).toContain(`${BASE}/courriers/documents-scannes`);
  });

  it('envoie le fichier et le poste en multipart, avec le jeton en en-tête', async () => {
    let seen: { body: FormData; auth: string } | null = null;
    const fetchImpl = jest.fn(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(url).endsWith('/auth/login')) return json({ accessToken: 'jwt-1' });
      const headers = new Headers(init?.headers);
      seen = { body: init?.body as FormData, auth: headers.get('Authorization') ?? '' };
      return json({ mailScannedDocumentId: 12, fileName: 'scan.pdf' });
    }) as unknown as typeof fetch;

    const res = await client(fetchImpl).upload('scan.pdf', Buffer.from('%PDF-1.4'), 'POSTE-01');

    expect(res.mailScannedDocumentId).toBe(12);
    expect(seen!.auth).toBe('Bearer jwt-1');
    expect(seen!.body.get('machineName')).toBe('POSTE-01');
    const file = seen!.body.get('file') as File;
    expect(file.name).toBe('scan.pdf');
    expect(file.type).toBe('application/pdf');
    expect(await file.text()).toBe('%PDF-1.4');
  });

  it('renouvelle le jeton expiré et rejoue la requête', async () => {
    let tokenNumber = 0;
    const fetchImpl = jest.fn(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(url).endsWith('/auth/login')) {
        tokenNumber += 1;
        return json({ accessToken: `jwt-${tokenNumber}` });
      }
      const auth = new Headers(init?.headers).get('Authorization');
      return auth === 'Bearer jwt-1'
        ? json({ message: 'Unauthorized' }, 401)
        : json({ mailScannedDocumentId: 3, fileName: 'a.pdf' });
    }) as unknown as typeof fetch;

    const res = await client(fetchImpl).upload('a.pdf', Buffer.from('x'), 'POSTE-01');
    expect(res.mailScannedDocumentId).toBe(3);
    expect(tokenNumber).toBe(2);
  });

  it('classe un refus 400 comme non rejouable (quarantaine directe)', async () => {
    const fetchImpl = jest.fn(async (url: Parameters<typeof fetch>[0]) =>
      String(url).endsWith('/auth/login')
        ? json({ accessToken: 'jwt-1' })
        : json({ message: 'Extension non acceptée (.bmp)' }, 400),
    ) as unknown as typeof fetch;

    await expect(client(fetchImpl).upload('a.bmp', Buffer.from('x'), 'P')).rejects.toMatchObject({
      name: 'UploadError',
      retryable: false,
      status: 400,
    });
  });

  it('classe un 500 comme rejouable', async () => {
    const fetchImpl = jest.fn(async (url: Parameters<typeof fetch>[0]) =>
      String(url).endsWith('/auth/login') ? json({ accessToken: 'jwt-1' }) : json({}, 503),
    ) as unknown as typeof fetch;

    const err = await client(fetchImpl)
      .upload('a.pdf', Buffer.from('x'), 'P')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UploadError);
    expect((err as UploadError).retryable).toBe(true);
  });

  it('remonte une AuthorizationError sur 403 (permission de menu manquante)', async () => {
    const fetchImpl = jest.fn(async (url: Parameters<typeof fetch>[0]) =>
      String(url).endsWith('/auth/login') ? json({ accessToken: 'jwt-1' }) : json({}, 403),
    ) as unknown as typeof fetch;

    // Le statut est conservé : c'est lui qui décide du message d'exploitation (rôle vs mot de passe).
    await expect(client(fetchImpl).upload('a.pdf', Buffer.from('x'), 'P')).rejects.toMatchObject({
      name: 'AuthorizationError',
      status: 403,
    });
  });

  it('remonte une AuthorizationError 401 sur identifiants refusés', async () => {
    const fetchImpl = jest.fn(async () =>
      json({ message: 'Identifiants invalides' }, 401),
    ) as unknown as typeof fetch;
    await expect(client(fetchImpl).upload('a.pdf', Buffer.from('x'), 'P')).rejects.toMatchObject({
      name: 'AuthorizationError',
      status: 401,
    });
  });

  it('traite une API injoignable comme rejouable', async () => {
    const fetchImpl = jest.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    const err = await client(fetchImpl)
      .upload('a.pdf', Buffer.from('x'), 'P')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UploadError);
    expect((err as UploadError).retryable).toBe(true);
  });
});

describe('ScanApiClient.checkAccess', () => {
  it('échoue explicitement si le compte n’a pas le menu', async () => {
    const fetchImpl = jest.fn(async (url: Parameters<typeof fetch>[0]) =>
      String(url).endsWith('/auth/login') ? json({ accessToken: 'jwt-1' }) : json({}, 403),
    ) as unknown as typeof fetch;

    await expect(client(fetchImpl).checkAccess()).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('passe quand la file répond', async () => {
    const fetchImpl = jest.fn(async (url: Parameters<typeof fetch>[0]) =>
      String(url).endsWith('/auth/login')
        ? json({ accessToken: 'jwt-1' })
        : json({ total: 0, page: 1, pageSize: 1, rows: [] }),
    ) as unknown as typeof fetch;

    await expect(client(fetchImpl).checkAccess()).resolves.toBeUndefined();
  });
});
