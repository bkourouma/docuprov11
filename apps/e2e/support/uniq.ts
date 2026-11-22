/**
 * Identifiant unique par appel, pour que chaque test crée ses propres données sans dépendre de
 * celles d'un autre test (ni d'un lancement précédent sur une pile gardée montée).
 *
 * Forme : `<prefix>-<base36 horodatage>-<pid base36>-<compteur>`, ASCII, sans espace, court
 * (≈ prefix + 16 caractères). Ex. `uniq('COU')` → `COU-mh3k2x1a-4f2-1`.
 */
let counter = 0;

export function uniq(prefix = 'e2e'): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${process.pid.toString(36)}-${counter}`;
}
