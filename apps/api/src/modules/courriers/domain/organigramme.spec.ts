import { resolveOrganigrammeId } from './organigramme';

describe('organigramme (dérivation à la création)', () => {
  it('retourne l’organigramme du rôle du destinataire', () => {
    expect(resolveOrganigrammeId(57)).toBe(57);
  });

  it('retourne null si le destinataire n’a pas de rôle/organigramme', () => {
    expect(resolveOrganigrammeId(null)).toBeNull();
    expect(resolveOrganigrammeId(undefined)).toBeNull();
  });
});
