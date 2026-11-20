import { CONSULTATION_LEVEL, RightsWideningError } from './rights';
import type { RightsConfig } from './rights-config';
import { ConnectorConfigError } from './registry';
import { whatsappConfigSchema, type WhatsappConfigParsed } from './whatsapp-config';
import {
  parseWhatsappStoredConfig,
  resolveWhatsappGrants,
  resolveWhatsappSender,
} from './whatsapp-senders';

const AWA = '221771234567';
const MOUSSA = '221781112233';

const settingsWith = (...senders: Array<{ phone: string; label?: string }>): WhatsappConfigParsed =>
  whatsappConfigSchema.parse({ phoneNumberId: '106540352242922', senders });

const rights = (principalMap: Record<string, number>, fallbackUserGroupIds: number[] = [99]): RightsConfig => ({
  principalMap,
  fallbackUserGroupIds,
});

describe('resolveWhatsappSender — liste blanche', () => {
  const settings = settingsWith({ phone: '+221 77 123 45 67', label: 'Awa' }, { phone: MOUSSA });

  it('expéditeur enregistré accepté, avec principal et libellé', () => {
    expect(resolveWhatsappSender(settings, AWA)).toEqual({
      allowed: true,
      phone: AWA,
      principal: `wa:${AWA}`,
      label: 'Awa',
    });
  });

  it('sans libellé : pas de clé label', () => {
    expect(resolveWhatsappSender(settings, MOUSSA)).toEqual({
      allowed: true,
      phone: MOUSSA,
      principal: `wa:${MOUSSA}`,
    });
  });

  it('forme + / espaces acceptée après normalisation', () => {
    expect(resolveWhatsappSender(settings, '+221 77 123 45 67')).toMatchObject({ allowed: true, phone: AWA });
  });

  it('inconnu refusé', () => {
    expect(resolveWhatsappSender(settings, '33612345678')).toEqual({ allowed: false });
  });

  it.each([
    ['dernier chiffre voisin', '221771234568'],
    ['un chiffre en moins', '22177123456'],
    ['un chiffre en plus', '2217712345670'],
    ['suffixe seul (sans indicatif)', '771234567'],
    ['préfixe 00', '00221771234567'],
  ])('numéro voisin refusé : %s', (_l, from) => {
    expect(resolveWhatsappSender(settings, from)).toEqual({ allowed: false });
  });

  it('liste vide : tout refusé', () => {
    const empty = settingsWith();
    expect(resolveWhatsappSender(empty, AWA)).toEqual({ allowed: false });
    expect(resolveWhatsappSender(empty, MOUSSA)).toEqual({ allowed: false });
  });

  it('entrée invalide refusée', () => {
    for (const v of ['', 'abc', 'wa:221771234567', '0771234567', null, undefined, 221771234567]) {
      expect(resolveWhatsappSender(settings, v as unknown as string)).toEqual({ allowed: false });
    }
  });

  it('configuration absente ou mal formée : refus (jamais d’exception)', () => {
    for (const s of [null, undefined, {}, { senders: null }, { senders: 'x' }, { senders: [null, 1, {}] }]) {
      expect(resolveWhatsappSender(s as unknown as WhatsappConfigParsed, AWA)).toEqual({ allowed: false });
    }
  });

  it('configuration non canonique (non passée par le schéma) : renormalisée, correspondance exacte', () => {
    const raw = { senders: [{ phone: '+221 77 123 45 67' }] } as unknown as WhatsappConfigParsed;
    expect(resolveWhatsappSender(raw, AWA)).toMatchObject({ allowed: true, phone: AWA });
    expect(resolveWhatsappSender(raw, '221771234560')).toEqual({ allowed: false });
  });
});

describe('resolveWhatsappGrants — droits du document', () => {
  it('expéditeur mappé vers le groupe 7 : uniquement le groupe 7, sans repli', () => {
    const r = resolveWhatsappGrants({ phone: AWA, rights: rights({ [`wa:${AWA}`]: 7 }, [99]) });
    expect(r.grants).toEqual([{ userGroupId: 7, permissionLevelId: 2 }]);
    expect(r.usedFallback).toBe(false);
    expect(r.reason).not.toContain(AWA);
  });

  it('expéditeur non mappé : groupes de repli, en Consultation', () => {
    const r = resolveWhatsappGrants({ phone: AWA, rights: rights({}, [99, 42]) });
    expect(r.grants).toEqual([
      { userGroupId: 42, permissionLevelId: CONSULTATION_LEVEL },
      { userGroupId: 99, permissionLevelId: CONSULTATION_LEVEL },
    ]);
    expect(r.usedFallback).toBe(true);
    expect(r.reason).not.toContain(AWA);
  });

  it('numéro passé sous forme + / espaces : même résultat', () => {
    const r = resolveWhatsappGrants({ phone: '+221 77 123 45 67', rights: rights({ [`wa:${AWA}`]: 7 }) });
    expect(r.grants).toEqual([{ userGroupId: 7, permissionLevelId: 2 }]);
  });

  it.each([`WA:${AWA}`, `  wa:${AWA}  `, ` Wa:${AWA}\t`])(
    'clé %j : insensible à la casse et aux espaces de bord (règle existante)',
    (key) => {
      const r = resolveWhatsappGrants({ phone: AWA, rights: rights({ [key]: 7 }) });
      expect(r.grants).toEqual([{ userGroupId: 7, permissionLevelId: 2 }]);
      expect(r.usedFallback).toBe(false);
    },
  );

  it('clé avec espaces INTERNES ou + : pas de correspondance (règle existante) → repli', () => {
    for (const key of [`wa:+${AWA}`, 'wa:221 77 123 45 67', `wa: ${AWA}`, AWA]) {
      const r = resolveWhatsappGrants({ phone: AWA, rights: rights({ [key]: 7 }, [99]) });
      expect(r.grants).toEqual([{ userGroupId: 99, permissionLevelId: 2 }]);
      expect(r.usedFallback).toBe(true);
    }
  });

  it('la clé d’un AUTRE expéditeur ne fuit pas', () => {
    const map = { [`wa:${MOUSSA}`]: 8, 'wa:221771234568': 9 };
    const awa = resolveWhatsappGrants({ phone: AWA, rights: rights(map, [99]) });
    expect(awa.grants).toEqual([{ userGroupId: 99, permissionLevelId: 2 }]);
    expect(awa.grants.map((g) => g.userGroupId)).not.toContain(8);
    expect(awa.grants.map((g) => g.userGroupId)).not.toContain(9);
    const moussa = resolveWhatsappGrants({ phone: MOUSSA, rights: rights({ ...map, [`wa:${AWA}`]: 7 }, [99]) });
    expect(moussa.grants).toEqual([{ userGroupId: 8, permissionLevelId: 2 }]);
  });

  it('carte ambiguë (deux clés confondues vers deux groupes) : ni l’une ni l’autre → document non créé', () => {
    // mapOriginRights se replierait sur 99, mais assertNeverWider refuse ce repli (il voit 7 et 8
    // comme mappés) : on échoue explicitement, aucun droit n'est rendu.
    const map = { [`wa:${AWA}`]: 7, [`WA:${AWA} `]: 8 };
    let error: unknown;
    try {
      resolveWhatsappGrants({ phone: AWA, rights: rights(map, [99]) });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(RightsWideningError);
    expect((error as Error).message).toMatch(/ambiguë.*document non créé/);
    expect((error as Error).message).not.toContain(AWA);
  });

  it('carte ambiguë pour un AUTRE expéditeur : sans effet sur celui-ci', () => {
    const map = { [`wa:${MOUSSA}`]: 7, [`WA:${MOUSSA}`]: 8, [`wa:${AWA}`]: 5 };
    expect(resolveWhatsappGrants({ phone: AWA, rights: rights(map, [99]) }).grants).toEqual([
      { userGroupId: 5, permissionLevelId: 2 },
    ]);
    expect(() => resolveWhatsappGrants({ phone: MOUSSA, rights: rights(map, [99]) })).toThrow(
      /document non créé/,
    );
  });

  it('carte ambiguë sans repli : document non créé', () => {
    const map = { [`wa:${AWA}`]: 7, [`WA:${AWA}`]: 8 };
    expect(() => resolveWhatsappGrants({ phone: AWA, rights: rights(map, []) })).toThrow(
      /document non créé/,
    );
  });

  it('deux clés confondues vers le MÊME groupe : non ambiguë, groupe retenu', () => {
    const map = { [`wa:${AWA}`]: 7, [`WA:${AWA}`]: 7 };
    const r = resolveWhatsappGrants({ phone: AWA, rights: rights(map) });
    expect(r.grants).toEqual([{ userGroupId: 7, permissionLevelId: 2 }]);
  });

  it('aucun groupe (ni mappé, ni repli) : lève « document non créé », jamais de liste vide', () => {
    let error: unknown;
    try {
      resolveWhatsappGrants({ phone: AWA, rights: rights({}, []) });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(RightsWideningError);
    expect((error as Error).message).toMatch(/document non créé/);
    expect((error as Error).message).not.toContain(AWA);
  });

  it('droits absents ou malformés : traités comme vides → document non créé', () => {
    for (const r of [undefined, null, {}, { principalMap: null, fallbackUserGroupIds: null }]) {
      expect(() =>
        resolveWhatsappGrants({ phone: AWA, rights: r as unknown as RightsConfig }),
      ).toThrow(/document non créé/);
    }
  });

  it('valeurs de groupe invalides dans la carte ou le repli : ignorées, jamais accordées', () => {
    const map = { [`wa:${AWA}`]: -7 } as Record<string, number>;
    const r = resolveWhatsappGrants({
      phone: AWA,
      rights: { principalMap: map, fallbackUserGroupIds: [0, 1.5, 99] },
    });
    expect(r.grants).toEqual([{ userGroupId: 99, permissionLevelId: 2 }]);
  });

  it('numéro illisible : lève « document non créé »', () => {
    for (const phone of ['', 'abc', '0771234567', null, undefined]) {
      expect(() =>
        resolveWhatsappGrants({ phone: phone as unknown as string, rights: rights({}, [99]) }),
      ).toThrow(/document non créé/);
    }
  });

  it('jamais « public », jamais au-delà de la Consultation, jamais de doublon', () => {
    const cases: RightsConfig[] = [
      rights({ [`wa:${AWA}`]: 7, '*': 1, public: 2, everyone: 3 }, [99, 99]),
      rights({ '*': 1, public: 2 }, [99, 99, 100]),
    ];
    for (const rc of cases) {
      const r = resolveWhatsappGrants({ phone: AWA, rights: rc });
      expect(r.grants.length).toBeGreaterThan(0);
      for (const g of r.grants) expect(g.permissionLevelId).toBe(CONSULTATION_LEVEL);
      const ids = r.grants.map((g) => g.userGroupId);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).not.toContain(1);
      expect(ids).not.toContain(2);
      expect(ids).not.toContain(3);
    }
  });

  it('principal hérité d’Object.prototype : aucune correspondance fantôme', () => {
    const r = resolveWhatsappGrants({ phone: AWA, rights: rights(Object.create({ [`wa:${AWA}`]: 7 }), [99]) });
    expect(r.grants).toEqual([{ userGroupId: 99, permissionLevelId: 2 }]);
  });
});

describe('parseWhatsappStoredConfig', () => {
  const stored = {
    phoneNumberId: '106540352242922',
    senders: [{ phone: '+221 77 123 45 67' }],
    rights: { principalMap: { [`wa:${AWA}`]: 7 }, fallbackUserGroupIds: [99] },
  };

  it('sépare et valide réglages et droits', () => {
    const { settings, rights: r } = parseWhatsappStoredConfig(stored);
    expect(settings.senders).toEqual([{ phone: AWA }]);
    expect(settings.ackEnabled).toBe(true);
    expect(r).toEqual({ principalMap: { [`wa:${AWA}`]: 7 }, fallbackUserGroupIds: [99] });
  });

  it('droits absents : défauts vides', () => {
    const { rights: r } = parseWhatsappStoredConfig({ phoneNumberId: '12345', senders: [] });
    expect(r).toEqual({ principalMap: {}, fallbackUserGroupIds: [] });
  });

  it('chaîne complète : config stockée → expéditeur → droits', () => {
    const { settings, rights: r } = parseWhatsappStoredConfig(stored);
    const sender = resolveWhatsappSender(settings, AWA);
    if (!sender.allowed) throw new Error('attendu autorisé');
    expect(resolveWhatsappGrants({ phone: sender.phone, rights: r }).grants).toEqual([
      { userGroupId: 7, permissionLevelId: 2 },
    ]);
  });

  const expectGeneric = (raw: unknown, secretish: string[]) => {
    let error: unknown;
    try {
      parseWhatsappStoredConfig(raw);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConnectorConfigError);
    const err = error as ConnectorConfigError;
    expect(err.message).toBe('Configuration du connecteur WhatsApp invalide.');
    const dump = `${err.message}${JSON.stringify(err.problems)}`;
    for (const s of secretish) expect(dump).not.toContain(s);
    return err;
  };

  it('numéro invalide : erreur générique sans le numéro', () => {
    const err = expectGeneric({ phoneNumberId: '12345', senders: [{ phone: '0771234567' }] }, ['0771234567']);
    expect(err.problems).toEqual(['réglage senders : custom']);
  });

  it('droits invalides : erreur générique sans la clé (numéro) de principalMap', () => {
    expectGeneric(
      { phoneNumberId: '12345', senders: [], rights: { principalMap: { [`wa:${AWA}`]: -1 } } },
      [AWA],
    );
  });

  it('champ inconnu et non-objet refusés', () => {
    expectGeneric({ ...stored, host: 'evil.example.org' }, ['evil.example.org']);
    expectGeneric('texte', ['texte']);
    expectGeneric([1, 2], []);
  });

  it('null / undefined : réglages vides → phoneNumberId manquant', () => {
    expectGeneric(null, []);
    expectGeneric(undefined, []);
  });
});
