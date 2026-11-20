import {
  createConnectorSchema,
  listItemsQuerySchema,
  listRunsQuerySchema,
  updateConnectorSchema,
} from './connectors.dto';

const minimal = { label: 'Dossier réseau', connectorType: 'filesystem', mode: 0 };

describe('createConnectorSchema', () => {
  it('accepte le minimum et pose config = {}', () => {
    const r = createConnectorSchema.parse(minimal);
    expect(r.config).toEqual({});
    expect(r.credentials).toBeUndefined();
  });

  it('accepte un corps complet', () => {
    const r = createConnectorSchema.parse({
      ...minimal,
      connectorType: 'imap',
      mode: 2,
      config: { host: 'imap.example.org' },
      credentials: { user: 'a', password: 'b' },
      credentialsExpiresAt: '2027-01-01T00:00:00Z',
      syncIntervalMinutes: 60,
      targetDossierId: 12,
    });
    expect(r.syncIntervalMinutes).toBe(60);
  });

  it('refuse un champ inconnu (strict)', () => {
    expect(createConnectorSchema.safeParse({ ...minimal, inconnu: 1 }).success).toBe(false);
    // `credentialsEnc` ne doit jamais être posable par l'API.
    expect(createConnectorSchema.safeParse({ ...minimal, credentialsEnc: 'x' }).success).toBe(
      false,
    );
    expect(createConnectorSchema.safeParse({ ...minimal, status: 1 }).success).toBe(false);
  });

  it.each(['Imap', 'a-b', '', 'a b', 'é', 'a'.repeat(41)])('refuse le type %j', (connectorType) => {
    expect(createConnectorSchema.safeParse({ ...minimal, connectorType }).success).toBe(false);
  });

  it.each([3, -1, 1.5, '0', null])('refuse le mode %p', (mode) => {
    expect(createConnectorSchema.safeParse({ ...minimal, mode }).success).toBe(false);
  });

  it('refuse credentials et credentialsRef ensemble', () => {
    const r = createConnectorSchema.safeParse({
      ...minimal,
      credentials: { password: 'x' },
      credentialsRef: 'GED_CONNECTOR_SECRET_IMAP',
    });
    expect(r.success).toBe(false);
  });

  it.each(['JWT_SECRET', 'DATABASE_URL', 'ged_connector_secret_x', 'GED_CONNECTOR_SECRET_'])(
    'refuse la référence %j hors liste blanche',
    (credentialsRef) => {
      expect(createConnectorSchema.safeParse({ ...minimal, credentialsRef }).success).toBe(false);
    },
  );

  it('accepte une référence de la liste blanche', () => {
    expect(
      createConnectorSchema.safeParse({ ...minimal, credentialsRef: 'GED_CONNECTOR_SECRET_IMAP1' })
        .success,
    ).toBe(true);
  });

  it.each([4, 10081, 0, -5, 5.5, '60'])('refuse l’intervalle %p', (syncIntervalMinutes) => {
    expect(createConnectorSchema.safeParse({ ...minimal, syncIntervalMinutes }).success).toBe(
      false,
    );
  });

  it.each([5, 10080, null])('accepte l’intervalle %p', (syncIntervalMinutes) => {
    expect(createConnectorSchema.safeParse({ ...minimal, syncIntervalMinutes }).success).toBe(true);
  });

  it.each([0, -1, 1.5, 2147483648])('refuse le dossier cible %p', (targetDossierId) => {
    expect(createConnectorSchema.safeParse({ ...minimal, targetDossierId }).success).toBe(false);
  });

  it('refuse un libellé vide ou trop long, une date non ISO, une config non objet', () => {
    expect(createConnectorSchema.safeParse({ ...minimal, label: '   ' }).success).toBe(false);
    expect(createConnectorSchema.safeParse({ ...minimal, label: 'a'.repeat(201) }).success).toBe(
      false,
    );
    expect(
      createConnectorSchema.safeParse({ ...minimal, credentialsExpiresAt: 'demain' }).success,
    ).toBe(false);
    expect(createConnectorSchema.safeParse({ ...minimal, config: [] }).success).toBe(false);
    expect(createConnectorSchema.safeParse({ ...minimal, config: 'x' }).success).toBe(false);
  });

  it('refuse des identifiants qui ne sont pas des chaînes', () => {
    expect(
      createConnectorSchema.safeParse({ ...minimal, credentials: { port: 993 } }).success,
    ).toBe(false);
  });
});

describe('updateConnectorSchema', () => {
  it('accepte un corps vide et des champs partiels', () => {
    expect(updateConnectorSchema.safeParse({}).success).toBe(true);
    expect(updateConnectorSchema.safeParse({ label: 'Nouveau' }).success).toBe(true);
  });

  it('refuse connectorType (non modifiable) et tout champ inconnu', () => {
    expect(updateConnectorSchema.safeParse({ connectorType: 'imap' }).success).toBe(false);
    expect(updateConnectorSchema.safeParse({ changeToken: null }).success).toBe(false);
  });

  it('credentials : null (effacement) accepté, objet accepté', () => {
    expect(updateConnectorSchema.safeParse({ credentials: null }).success).toBe(true);
    expect(updateConnectorSchema.safeParse({ credentials: { password: 'x' } }).success).toBe(true);
  });

  it('refuse credentials et credentialsRef non nuls ensemble ; accepte null + référence', () => {
    expect(
      updateConnectorSchema.safeParse({
        credentials: { password: 'x' },
        credentialsRef: 'GED_CONNECTOR_SECRET_A',
      }).success,
    ).toBe(false);
    expect(
      updateConnectorSchema.safeParse({
        credentials: null,
        credentialsRef: 'GED_CONNECTOR_SECRET_A',
      }).success,
    ).toBe(true);
  });

  it('mêmes bornes que la création (intervalle, mode)', () => {
    expect(updateConnectorSchema.safeParse({ syncIntervalMinutes: 4 }).success).toBe(false);
    expect(updateConnectorSchema.safeParse({ syncIntervalMinutes: null }).success).toBe(true);
    expect(updateConnectorSchema.safeParse({ mode: 5 }).success).toBe(false);
  });
});

describe('requêtes de liste', () => {
  it('éléments : chaînes coercées, bornes tenues', () => {
    const r = listItemsQuerySchema.parse({ state: '3', page: '2', pageSize: '100', q: ' abc ' });
    expect(r).toEqual({ state: 3, page: 2, pageSize: 100, q: 'abc' });
  });

  it.each([
    { pageSize: '101' },
    { pageSize: '0' },
    { page: '0' },
    { state: '7' },
    { state: '' },
    { q: '' },
  ])('éléments : %j refusé', (query) => {
    expect(listItemsQuerySchema.safeParse(query).success).toBe(false);
  });

  it('éléments : paramètre inconnu refusé (strict), requête vide acceptée', () => {
    expect(listItemsQuerySchema.safeParse({ inconnu: '1' }).success).toBe(false);
    expect(listItemsQuerySchema.safeParse({}).success).toBe(true);
  });

  it('passes : limite 1..100', () => {
    expect(listRunsQuerySchema.parse({ limit: '100' }).limit).toBe(100);
    expect(listRunsQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
    expect(listRunsQuerySchema.safeParse({ limit: '' }).success).toBe(false);
  });
});
