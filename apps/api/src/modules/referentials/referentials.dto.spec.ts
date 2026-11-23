import {
  createDocumentTypeSchema,
  createDossierSchema,
  grantTypePermissionSchema,
  isoDaySchema,
} from './referentials.dto';

describe('isoDaySchema', () => {
  it('accepte un jour réel AAAA-MM-JJ', () => {
    expect(isoDaySchema.parse('2026-02-28')).toBe('2026-02-28');
    expect(isoDaySchema.parse('2028-02-29')).toBe('2028-02-29');
  });

  it.each(['2026-13-01', '2026-02-31', '2027-02-29', '01/02/2026', 'demain', '2026-1-1', ''])(
    'refuse « %s »',
    (s) => {
      expect(isoDaySchema.safeParse(s).success).toBe(false);
    },
  );
});

describe('grantTypePermissionSchema', () => {
  const base = { documentTypeId: 4, permissionLevelId: 2, roleId: 5 };

  it('accepte un octroi sans période', () => {
    expect(grantTypePermissionSchema.safeParse(base).success).toBe(true);
  });

  it('accepte une période d’un jour (début = fin)', () => {
    expect(
      grantTypePermissionSchema.safeParse({ ...base, startDate: '2026-05-01', endDate: '2026-05-01' })
        .success,
    ).toBe(true);
  });

  it('refuse une fin antérieure au début', () => {
    const r = grantTypePermissionSchema.safeParse({
      ...base,
      startDate: '2026-05-02',
      endDate: '2026-05-01',
    });
    expect(r.success).toBe(false);
  });

  it('refuse une date illisible (devenait une date invalide → 500)', () => {
    expect(grantTypePermissionSchema.safeParse({ ...base, startDate: 'n’importe quoi' }).success).toBe(
      false,
    );
  });

  it('refuse zéro ou deux bénéficiaires', () => {
    const { roleId: _omit, ...none } = base;
    expect(grantTypePermissionSchema.safeParse(none).success).toBe(false);
    expect(grantTypePermissionSchema.safeParse({ ...base, userGroupId: 3 }).success).toBe(false);
  });
});

describe('libellés obligatoires', () => {
  it('un libellé fait d’espaces est refusé à la création d’un type', () => {
    expect(createDocumentTypeSchema.safeParse({ label: '   ' }).success).toBe(false);
  });

  it('un libellé fait d’espaces est refusé à la création d’un dossier', () => {
    expect(createDossierSchema.safeParse({ label: '   ' }).success).toBe(false);
  });

  it('le libellé est rendu sans espaces de bordure', () => {
    expect(createDocumentTypeSchema.parse({ label: '  Facture ' }).label).toBe('Facture');
  });
});
