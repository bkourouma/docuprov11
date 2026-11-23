import { MENU_KEYS } from '../../roles/menu-catalog';
import { ARCHIVES_MENUS } from '../archives.menus';
import { lendingAccess, type LendingAction } from './lending-scope';

const ACTIONS: LendingAction[] = ['read', 'comment', 'return'];
const M = ARCHIVES_MENUS;

describe('lendingAccess (ANO-ARC-T3-05)', () => {
  it('le seul menu « Mes documents communiqués » limite chaque geste aux prêts de l’appelant', () => {
    for (const action of ACTIONS) {
      expect(lendingAccess(['/', M.myLentDocuments], action)).toBe('own');
    }
  });

  it('« Documents communiqués » ouvre chaque geste sur tout prêt, cumulé ou non avec « Mes documents »', () => {
    for (const action of ACTIONS) {
      expect(lendingAccess([M.lentDocuments], action)).toBe('all');
      expect(lendingAccess([M.myLentDocuments, M.lentDocuments], action)).toBe('all');
    }
  });

  it('l’administrateur et le rôle système (tous les menus effectifs) gardent tout le périmètre', () => {
    for (const action of ACTIONS) expect(lendingAccess(MENU_KEYS, action)).toBe('all');
  });

  it('« Historique » ouvre la lecture de tout prêt, pas son retour ni son commentaire', () => {
    expect(lendingAccess([M.lendingHistory], 'read')).toBe('all');
    expect(lendingAccess([M.lendingHistory, M.myLentDocuments], 'read')).toBe('all');
    // Cumulé avec « Mes documents » : le retour et le commentaire restent limités aux siens.
    expect(lendingAccess([M.lendingHistory, M.myLentDocuments], 'return')).toBe('own');
    expect(lendingAccess([M.lendingHistory, M.myLentDocuments], 'comment')).toBe('own');
    expect(lendingAccess([M.lendingHistory], 'return')).toBe('none');
  });

  it('« Communiquer » n’ouvre aucun de ces gestes et n’élargit pas « Mes documents »', () => {
    for (const action of ACTIONS) {
      expect(lendingAccess([M.communicate], action)).toBe('none');
      expect(lendingAccess([M.communicate, M.myLentDocuments], action)).toBe('own');
    }
  });

  it('sans aucun menu de communication : aucun périmètre', () => {
    for (const action of ACTIONS) expect(lendingAccess(['/', '/search'], action)).toBe('none');
  });
});
