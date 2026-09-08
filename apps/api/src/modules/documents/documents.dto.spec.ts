import { indexationSchema } from './documents.dto';

/**
 * Contrat de l'indexation. Il a DEUX appelants aux besoins opposés — l'acquisition, qui n'envoie
 * que les métadonnées (son classement vient du lot), et la consultation, qui réindexe tout — donc
 * ces tests fixent ce qui est accepté ET ce qui doit encore échouer bruyamment.
 */
describe('indexationSchema — acquisition (métadonnées seules)', () => {
  it('accepte les valeurs de métadonnées', () => {
    const parsed = indexationSchema.parse({
      metadataValues: [{ metaDataId: 3, value: 'Awa Diallo' }],
    });
    expect(parsed.metadataValues).toHaveLength(1);
  });

  it('accepte la validation seule', () => {
    expect(indexationSchema.parse({ validate: true }).validate).toBe(true);
  });

  it('refuse un corps vide', () => {
    expect(() => indexationSchema.parse({})).toThrow();
  });

  it('refuse `validate: false` seul — rien à faire', () => {
    expect(() => indexationSchema.parse({ validate: false })).toThrow();
  });
});

describe('indexationSchema — consultation (réindexation complète)', () => {
  it('accepte le classement complet', () => {
    const parsed = indexationSchema.parse({
      label: 'Arrêté n°12',
      documentTypeId: 8,
      planId: 12,
      dossierId: 4,
      documentDate: '2026-07-15',
      metadataValues: [],
    });
    expect(parsed).toMatchObject({ label: 'Arrêté n°12', documentTypeId: 8, planId: 12, dossierId: 4 });
  });

  it('accepte de VIDER un champ de classement (null explicite)', () => {
    const parsed = indexationSchema.parse({ documentTypeId: null, planId: null, dossierId: null });
    expect(parsed.documentTypeId).toBeNull();
  });

  it('refuse une date au mauvais format', () => {
    expect(() => indexationSchema.parse({ documentDate: '15/07/2026' })).toThrow();
  });

  it('refuse un libellé vide — le document doit rester nommé', () => {
    expect(() => indexationSchema.parse({ label: '   ' })).toThrow();
  });
});

describe('indexationSchema — champs hors contrat', () => {
  it.each([
    // Retiré du contrat : plus aucun écran ne saisit le n° de pièce.
    ['cote', { cote: 'FAC-001' }],
    // Jamais exposé : la validation passe par `validate`, pas par une écriture directe.
    ['isArchived', { isArchived: true }],
    ['createdAt', { createdAt: '2026-07-15' }],
  ])('refuse %s au lieu de l’ignorer en silence', (_champ, payload) => {
    expect(() => indexationSchema.parse({ validate: true, ...payload })).toThrow();
  });
});
