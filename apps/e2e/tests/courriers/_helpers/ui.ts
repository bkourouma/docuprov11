import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Pilotage des composants Ant Design v5 utilisés par les écrans courrier.
 *
 * Hypothèses à vérifier en phase B :
 *  - Les options visibles d'un Select sont des `.ant-select-item-option` portant `title=<libellé>`
 *    (rc-select le pose pour un libellé texte) ; la liste d'accessibilité cachée (`role=option`,
 *    hauteur nulle) n'est volontairement PAS ciblée.
 *  - Un Select `showSearch` accepte la saisie dans son `input[role=combobox]` pour filtrer : on tape
 *    le libellé avant de cliquer, pour que l'option soit dans la fenêtre virtualisée.
 *  - Les toasts `App.useApp().message` sont rendus sous `.ant-message`.
 */

/** Liste déroulante AntD actuellement ouverte. */
export function openDropdown(page: Page): Locator {
  return page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)');
}

/**
 * Choisit `optionLabel` dans le Select dont `combobox` est l'input (`getByLabel(...)` ou `#id`).
 * Pour un Select multiple, la liste reste ouverte : on la ferme par Échap.
 */
export async function selectOption(
  page: Page,
  combobox: Locator,
  optionLabel: string,
  opts: { multiple?: boolean; search?: boolean } = {},
): Promise<void> {
  await combobox.click();
  if (opts.search !== false) await combobox.fill(optionLabel);
  const option = openDropdown(page).getByTitle(optionLabel, { exact: true });
  await expect(option).toBeVisible();
  await option.click();
  if (opts.multiple) await combobox.press('Escape');
}

/** Saisit une date `JJ/MM/AAAA` dans un DatePicker AntD (format de l'application). */
export async function fillDate(input: Locator, ddmmyyyy: string): Promise<void> {
  await input.click();
  await input.fill(ddmmyyyy);
  await input.press('Enter');
}

/** Toast AntD (`message.success/error/warning`) contenant `text`. */
export function toast(page: Page, text: string | RegExp): Locator {
  return page.locator('.ant-message').getByText(text);
}

/** Message d'erreur de validation d'un champ de formulaire AntD. */
export function fieldError(page: Page, text: string): Locator {
  return page.locator('.ant-form-item-explain-error').filter({ hasText: text });
}

/** Message de refus du `MenuPermissionGuard` (403), relayé tel quel par `apiJson` du web. */
export const FORBIDDEN_MESSAGE = "Vous n'avez pas accès à cette section.";

/**
 * Entrée de la barre latérale (menu AntD inline). Le nom accessible commence par le libellé et
 * peut être suivi du compteur (`Badge` dans `extra`), d'où l'ancrage en tête seulement.
 * N'est fiable que si la section est OUVERTE : AuthShell ouvre celle de la route courante, il faut
 * donc être sur un écran de la même section (ex. un écran Docu-Courriers autorisé).
 */
export function sidebarItem(page: Page, label: string): Locator {
  return page.getByRole('menuitem', { name: new RegExp(`^${escapeRegExp(label)}`) });
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Convertit `AAAA-MM-JJ` en `JJ/MM/AAAA` (format des DatePicker de l'application). */
export function isoToFr(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}
