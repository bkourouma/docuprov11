// Normalisation des libellés de référentiel (§16) — logique pure, testée.
//
// Écart source corrigé (décision « corriger les écarts documentés ») :
//  - Le source dédoublonne sur `ToLowerInvariant().Replace(" ", "")` (§16/§17/§18/§19) mais ses
//    contrôles unitaires (`CreateOrEdit`) comparaient le libellé brut : « Officiel » et
//    « officiel » pouvaient donc coexister selon la porte d'entrée. On applique désormais la clé
//    normalisée à TOUTES les écritures, pas seulement à la création multiple.
//  - Le source « capitalise » aussi le libellé de façon conditionnelle (majuscule initiale +
//    reste en minuscules UNIQUEMENT si la 1re lettre est minuscule, §16 l.3599), ce qui rend
//    « ministère des FINANCES » → « Ministère des finances » mais laisse
//    « MINISTÈRE des Finances » intact. Cette réécriture incohérente n'est PAS reprise : le
//    libellé est stocké tel que saisi (espaces compactés). C'est l'utilisateur qui décide de sa
//    casse ; seule l'unicité est insensible à la casse.

/**
 * Libellé tel qu'il sera stocké : espaces de bordure retirés et suites d'espaces internes
 * compactées. Ne touche NI à la casse NI aux accents (« Ministère » reste « Ministère »).
 */
export function normaliseLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ');
}

/**
 * Clé de comparaison d'unicité (§16) : insensible à la casse ET aux espaces, comme le
 * dédoublonnage du source (`ToLowerInvariant().Replace(" ", "")`). « Officiel », « officiel » et
 * « OFFICIEL » collisionnent ; « Note de service » et « Notedeservice » aussi — c'est voulu,
 * c'est la sémantique du source.
 *
 * Doit rester le miroir exact de l'index SQL `lower(replace(label, ' ', ''))` : toute divergence
 * ferait remonter une violation de contrainte en 500 au lieu d'un 409 lisible.
 */
export function labelDedupKey(label: string): string {
  return label.trim().replace(/\s+/g, '').toLowerCase();
}

/**
 * Le libellé candidat entre-t-il en collision avec un libellé existant ? `excludeId` écarte
 * l'élément en cours d'édition (se renommer « Officiel » → « OFFICIEL » reste permis).
 */
export function findLabelConflict<T extends { label: string }>(
  candidate: string,
  existing: readonly (T & { id: number })[],
  excludeId: number | null,
): (T & { id: number }) | null {
  const key = labelDedupKey(candidate);
  return existing.find((e) => e.id !== excludeId && labelDedupKey(e.label) === key) ?? null;
}
