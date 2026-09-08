import { MENU_SUIVI, MENU_SUIVI_DC } from '../../roles/menu-catalog';
import { mailScopeFromMenuKeys } from './mail-scope';

describe('mailScopeFromMenuKeys (§09/§10)', () => {
  it('« Suivi permanent » ⟹ tous les courriers', () => {
    expect(mailScopeFromMenuKeys([MENU_SUIVI])).toBe('all');
  });

  it('« Suivi des Courriers DC » seul ⟹ périmètre restreint aux imputations de l’utilisateur', () => {
    expect(mailScopeFromMenuKeys([MENU_SUIVI_DC])).toBe('imputed');
  });

  // Les deux permissions sont alternatives : cumulées, la plus large gagne — restreindre un
  // utilisateur parce qu'on lui a AJOUTÉ un droit serait un retrait déguisé.
  it('les deux ⟹ le périmètre le plus large', () => {
    expect(mailScopeFromMenuKeys([MENU_SUIVI_DC, MENU_SUIVI])).toBe('all');
  });

  it('aucune des deux ⟹ liste vide', () => {
    expect(mailScopeFromMenuKeys(['/courriers/validation', '/'])).toBe('none');
    expect(mailScopeFromMenuKeys([])).toBe('none');
  });
});
