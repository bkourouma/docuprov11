import { GED_CONNECTOR_LIMITS, GED_WHATSAPP_CREDENTIAL_KEYS } from '@archivage/types';
import type { ConnectorDefinition } from './types';
import {
  WHATSAPP_CONFIG_FIELDS,
  WHATSAPP_CREDENTIAL_FIELDS,
  WHATSAPP_MAX_SENDERS,
  assertWhatsappConfigSafe,
  whatsappConfigSchema,
  whatsappCredentialsSchema,
} from './whatsapp-config';

// Vérification de type à la compilation : les schémas se branchent tels quels sur une ConnectorDefinition.
const _configSchemaFits: ConnectorDefinition['configSchema'] = whatsappConfigSchema;
const _credsSchemaFits: ConnectorDefinition['credentialsSchema'] = whatsappCredentialsSchema;
void _configSchemaFits;
void _credsSchemaFits;

const validConfig = () => ({
  phoneNumberId: '106540352242922',
  graphApiVersion: 'v21.0',
  senders: [{ phone: '+221 77 123 45 67', label: 'Awa Diop' }, { phone: '33612345678' }],
});

const CREDS = {
  accessToken: 'EAAGm0PX4ZCpsBAKZCtestAccessToken0123456789',
  appSecret: 'f0e1d2c3b4a5968778695a4b3c2d1e0f',
  verifyToken: 'verif-Token_42',
};

/** Phone formé de i (pour générer des numéros distincts et valides). */
const phoneN = (i: number) => `2217${String(i).padStart(8, '0')}`;

describe('whatsappConfigSchema — acceptation et normalisation', () => {
  it('accepte une configuration valide et applique les défauts', () => {
    const r = whatsappConfigSchema.parse(validConfig());
    expect(r).toEqual({
      phoneNumberId: '106540352242922',
      graphApiVersion: 'v21.0',
      senders: [{ phone: '221771234567', label: 'Awa Diop' }, { phone: '33612345678' }],
      ackEnabled: true,
      refuseUnknownSenders: false,
    });
  });

  it('réécrit « +221 77 123 45 67 » en 221771234567', () => {
    const r = whatsappConfigSchema.parse({
      phoneNumberId: '12345',
      senders: [{ phone: '+221 77 123 45 67' }],
    });
    expect(r.senders[0]?.phone).toBe('221771234567');
  });

  it('graphApiVersion facultatif, sans défaut posé par le schéma', () => {
    const r = whatsappConfigSchema.parse({ phoneNumberId: '12345', senders: [] });
    expect(r.graphApiVersion).toBeUndefined();
    expect('graphApiVersion' in r).toBe(false);
  });

  it('senders absent = liste vide (personne ne dépose)', () => {
    expect(whatsappConfigSchema.parse({ phoneNumberId: '12345' }).senders).toEqual([]);
  });

  it('booléens explicites conservés', () => {
    const r = whatsappConfigSchema.parse({
      ...validConfig(),
      ackEnabled: false,
      refuseUnknownSenders: true,
    });
    expect(r.ackEnabled).toBe(false);
    expect(r.refuseUnknownSenders).toBe(true);
  });

  it('libellé blanc = pas de libellé ; libellé rogné', () => {
    const r = whatsappConfigSchema.parse({
      phoneNumberId: '12345',
      senders: [{ phone: '221771234567', label: '   ' }, { phone: '221771234568', label: ' Moussa ' }],
    });
    expect(r.senders[0]).toEqual({ phone: '221771234567' });
    expect(r.senders[1]).toEqual({ phone: '221771234568', label: 'Moussa' });
  });

  it('maxFileBytes au plafond exact accepté', () => {
    const r = whatsappConfigSchema.parse({
      ...validConfig(),
      maxFileBytes: GED_CONNECTOR_LIMITS.maxFileBytes,
    });
    expect(r.maxFileBytes).toBe(GED_CONNECTOR_LIMITS.maxFileBytes);
  });

  it(`${WHATSAPP_MAX_SENDERS} expéditeurs acceptés`, () => {
    const senders = Array.from({ length: WHATSAPP_MAX_SENDERS }, (_, i) => ({ phone: phoneN(i) }));
    expect(whatsappConfigSchema.safeParse({ phoneNumberId: '12345', senders }).success).toBe(true);
  });
});

describe('whatsappConfigSchema — refus', () => {
  const rejects = (cfg: unknown) => {
    const r = whatsappConfigSchema.safeParse(cfg);
    expect(r.success).toBe(false);
    return r.success ? [] : r.error.issues;
  };

  it('doublon de numéro, même sous deux écritures différentes', () => {
    const issues = rejects({
      phoneNumberId: '12345',
      senders: [{ phone: '+221 77 123 45 67' }, { phone: '221771234567' }],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toEqual(['senders', 1, 'phone']);
    // Le message ne cite pas le numéro.
    expect(issues[0]?.message).not.toContain('221771234567');
    expect(issues[0]?.message).not.toContain('77 123');
  });

  it.each([
    ['numéro national', '0771234567'],
    ['trop court', '1234567'],
    ['lettres', '22177abc4567'],
    ['vide', ''],
  ])('numéro invalide (%s), sans le reprendre dans le message', (_l, phone) => {
    const issues = rejects({ phoneNumberId: '12345', senders: [{ phone }] });
    expect(issues[0]?.path).toEqual(['senders', 0, 'phone']);
    if (phone !== '') expect(JSON.stringify(issues)).not.toContain(phone);
  });

  it('numéro non-chaîne', () => {
    rejects({ phoneNumberId: '12345', senders: [{ phone: 221771234567 }] });
  });

  it.each(['host', 'url', 'baseUrl', 'apiUrl', 'accessToken', 'rights'])(
    'champ inconnu « %s » refusé (strict)',
    (key) => {
      const issues = rejects({ ...validConfig(), [key]: 'https://graph.example.org' });
      expect(issues.some((i) => i.code === 'unrecognized_keys')).toBe(true);
    },
  );

  it('champ inconnu dans un expéditeur refusé (strict)', () => {
    rejects({ phoneNumberId: '12345', senders: [{ phone: '221771234567', groupId: 7 }] });
  });

  it('maxFileBytes au-delà du plafond, nul, négatif, décimal', () => {
    for (const maxFileBytes of [GED_CONNECTOR_LIMITS.maxFileBytes + 1, 0, -1, 1.5]) {
      rejects({ ...validConfig(), maxFileBytes });
    }
  });

  it(`${WHATSAPP_MAX_SENDERS + 1} expéditeurs refusés`, () => {
    const senders = Array.from({ length: WHATSAPP_MAX_SENDERS + 1 }, (_, i) => ({ phone: phoneN(i) }));
    rejects({ phoneNumberId: '12345', senders });
  });

  it('libellé trop long ou avec caractères de contrôle', () => {
    rejects({ phoneNumberId: '12345', senders: [{ phone: '221771234567', label: 'x'.repeat(101) }] });
    const ctrl = [0x0a, 0x00, 0x1f, 0x7f, 0x85, 0x9f, 0x202e, 0x2028, 0x2066].map((c) => String.fromCharCode(c));
    for (const label of ctrl.map((c) => `a${c}b`)) {
      rejects({ phoneNumberId: '12345', senders: [{ phone: '221771234567', label }] });
    }
  });

  it.each(['1234', 'abc12345', '12345-678', '1'.repeat(31), ''])(
    'phoneNumberId invalide : %j',
    (phoneNumberId) => {
      rejects({ ...validConfig(), phoneNumberId });
    },
  );

  it('phoneNumberId manquant', () => {
    rejects({ senders: [] });
  });

  it.each(['21.0', 'v21', 'v21.00', 'v123.0', 'v21.0/../x', 'latest'])(
    'graphApiVersion invalide : %j',
    (graphApiVersion) => {
      rejects({ ...validConfig(), graphApiVersion });
    },
  );

  it('booléens non booléens', () => {
    rejects({ ...validConfig(), ackEnabled: 'true' });
    rejects({ ...validConfig(), refuseUnknownSenders: 1 });
  });

  it('non-objet', () => {
    for (const v of [null, undefined, 'x', 42, []]) rejects(v);
  });
});

describe('whatsappCredentialsSchema', () => {
  const rejectsCreds = (c: unknown) => {
    const r = whatsappCredentialsSchema.safeParse(c);
    expect(r.success).toBe(false);
    return r.success ? null : r.error;
  };

  it('accepte des identifiants valides', () => {
    expect(whatsappCredentialsSchema.parse(CREDS)).toEqual(CREDS);
  });

  it('couvre exactement les clés du contrat', () => {
    expect(Object.keys(whatsappCredentialsSchema.parse(CREDS)).sort()).toEqual(
      [...GED_WHATSAPP_CREDENTIAL_KEYS].sort(),
    );
  });

  it.each(GED_WHATSAPP_CREDENTIAL_KEYS)('« %s » manquant', (key) => {
    const c: Record<string, string> = { ...CREDS };
    delete c[key];
    rejectsCreds(c);
  });

  it('trop courts', () => {
    rejectsCreds({ ...CREDS, accessToken: 'a'.repeat(19) });
    rejectsCreds({ ...CREDS, appSecret: 'b'.repeat(15) });
    rejectsCreds({ ...CREDS, verifyToken: 'c'.repeat(7) });
  });

  it('trop longs', () => {
    rejectsCreds({ ...CREDS, accessToken: 'a'.repeat(1001) });
    rejectsCreds({ ...CREDS, appSecret: 'b'.repeat(201) });
    rejectsCreds({ ...CREDS, verifyToken: 'c'.repeat(201) });
  });

  it('bornes exactes acceptées', () => {
    expect(
      whatsappCredentialsSchema.safeParse({
        accessToken: 'a'.repeat(20),
        appSecret: 'b'.repeat(16),
        verifyToken: 'c'.repeat(8),
      }).success,
    ).toBe(true);
  });

  it.each([
    ['espace', 'secret avec espace'],
    ['tabulation', 'secret\tavec-tab0'],
    ['saut de ligne', 'secret-ligne\n0123'],
    ['NUL', 'secret-nul\u00000123'],
    ['DEL', 'secret-del\u007f0123'],
    ['accent', 'secret-accentué-01'],
  ])('caractère refusé : %s', (_l, value) => {
    for (const key of GED_WHATSAPP_CREDENTIAL_KEYS) {
      const v = key === 'accessToken' ? `${value}${'x'.repeat(20)}` : value;
      rejectsCreds({ ...CREDS, [key]: v });
    }
  });

  it('appSecret == verifyToken refusé', () => {
    const err = rejectsCreds({ ...CREDS, verifyToken: CREDS.appSecret });
    expect(err?.issues.map((i) => i.path)).toEqual([['verifyToken']]);
  });

  it('verifyToken == accessToken refusé', () => {
    const same = 'z'.repeat(30);
    const err = rejectsCreds({ ...CREDS, accessToken: same, verifyToken: same });
    expect(err?.issues.map((i) => i.path)).toEqual([['verifyToken']]);
  });

  it('champ inconnu refusé (strict)', () => {
    rejectsCreds({ ...CREDS, password: 'whatever-password' });
  });

  it('les messages d’erreur ne contiennent jamais la valeur d’un identifiant', () => {
    const cases: Record<string, unknown>[] = [
      { ...CREDS, verifyToken: CREDS.appSecret },
      { ...CREDS, accessToken: 'tropcourt-SECRET1' },
      { ...CREDS, appSecret: 'secret avec espace X' },
      { ...CREDS, verifyToken: 'v'.repeat(250) },
      { accessToken: CREDS.accessToken },
    ];
    for (const c of cases) {
      const err = rejectsCreds(c);
      const dump = `${err?.message ?? ''}${JSON.stringify(err?.issues ?? [])}${JSON.stringify(err?.format() ?? {})}`;
      for (const v of Object.values(c)) {
        expect(dump).not.toContain(String(v));
      }
    }
  });
});

describe('descripteurs de formulaire', () => {
  it('champs de configuration attendus, en français, avec aide', () => {
    expect(WHATSAPP_CONFIG_FIELDS.map((f) => f.name)).toEqual([
      'phoneNumberId',
      'graphApiVersion',
      'maxFileBytes',
      'ackEnabled',
      'refuseUnknownSenders',
    ]);
    for (const f of WHATSAPP_CONFIG_FIELDS) {
      expect(f.help?.length ?? 0).toBeGreaterThan(20);
      expect(f.kind).not.toBe('password');
    }
    expect(WHATSAPP_CONFIG_FIELDS.find((f) => f.name === 'phoneNumberId')?.required).toBe(true);
  });

  it('chaque champ de configuration est une clé du schéma', () => {
    const keys = Object.keys(whatsappConfigSchema.shape);
    for (const f of WHATSAPP_CONFIG_FIELDS) expect(keys).toContain(f.name);
  });

  it('identifiants : trois champs masqués et obligatoires', () => {
    expect(WHATSAPP_CREDENTIAL_FIELDS.map((f) => f.name)).toEqual([...GED_WHATSAPP_CREDENTIAL_KEYS]);
    for (const f of WHATSAPP_CREDENTIAL_FIELDS) {
      expect(f.kind).toBe('password');
      expect(f.required).toBe(true);
      expect(f.help).toMatch(/Meta/);
    }
  });
});

describe('assertWhatsappConfigSafe', () => {
  it('passe sur une configuration valide', () => {
    expect(() => assertWhatsappConfigSafe(validConfig())).not.toThrow();
  });

  it('lève sur un hôte ajouté ou un numéro invalide, sans citer le numéro', () => {
    expect(() => assertWhatsappConfigSafe({ ...validConfig(), host: '169.254.169.254' })).toThrow(
      /Configuration WhatsApp invalide/,
    );
    let message = '';
    try {
      assertWhatsappConfigSafe({ phoneNumberId: '12345', senders: [{ phone: '0771234567' }] });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/senders\.0\.phone/);
    expect(message).not.toContain('0771234567');
  });

  it('lève sur un non-objet', () => {
    expect(() => assertWhatsappConfigSafe(null)).toThrow();
  });
});
