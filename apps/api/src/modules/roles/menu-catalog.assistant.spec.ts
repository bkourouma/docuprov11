import { ASST_ROUTE_MENU } from '@archivage/types';
import { ASSISTANT_MENU } from '../assistant/assistant.menus';
import { ASSIGNABLE_MENU_KEYS, HIDDEN_MENU_KEYS, MENU_CATALOG, MENU_KEYS } from './menu-catalog';

describe('menu-catalog : assistant', () => {
  it("la clé est celle du contrat partagé (@archivage/types)", () => {
    expect(ASSISTANT_MENU).toBe('/assistant');
    expect(ASSISTANT_MENU).toBe(ASST_ROUTE_MENU);
  });

  it('figure une seule fois, libellé « Assistant », section « Docu-Flow »', () => {
    const entries = MENU_CATALOG.filter((m) => m.key === ASSISTANT_MENU);
    expect(entries).toEqual([{ key: '/assistant', label: 'Assistant', section: 'Docu-Flow' }]);
    expect(MENU_KEYS.filter((k) => k === ASSISTANT_MENU)).toHaveLength(1);
  });

  it('les clés du catalogue sont uniques', () => {
    expect(new Set(MENU_CATALOG.map((m) => m.key)).size).toBe(MENU_CATALOG.length);
  });

  it('est assignable à un rôle (non masquée)', () => {
    expect(HIDDEN_MENU_KEYS).not.toContain(ASSISTANT_MENU);
    expect(ASSIGNABLE_MENU_KEYS).toContain(ASSISTANT_MENU);
  });
});
