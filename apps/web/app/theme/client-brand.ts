/**
 * Organisation cliente de cette instance (co-branding de l'écran de connexion).
 *
 * DocuPro reste la marque du produit ; ce bloc décrit la structure À QUI l'instance
 * est destinée. Mettre `null` pour une instance générique (démo produit, bac à sable) :
 * l'écran de connexion retombe alors sur la marque DocuPro seule.
 */
export interface ClientBrand {
  /** Sigle, pour les libellés courts et les textes alternatifs. */
  shortName: string;
  /** Raison sociale développée, affichée sous le formulaire. */
  longName: string;
  /**
   * Raison sociale précédée de son article élidé, pour les phrases du type
   * « l'espace de X ». Champ à part parce que l'élision dépend de la raison
   * sociale (« de l'Agence… », « du Ministère… », « de Sonatel ») et ne se
   * dérive pas de `longName`.
   */
  longNameInSentence: string;
  /** Chemin du logo servi depuis /public. */
  logoSrc: string;
  /** largeur / hauteur du fichier — évite un reflow avant chargement. */
  logoRatio: number;
  /**
   * `true` quand le fichier est opaque (fond blanc incrusté) : sur le panneau
   * « Encre » le logo doit alors être posé sur une pastille claire, sans quoi il
   * apparaît comme un rectangle blanc collé au milieu du dégradé.
   */
  logoNeedsPlate: boolean;
}

export const CLIENT_BRAND: ClientBrand | null = {
  shortName: 'AGEF',
  longName: 'Agence de Gestion Foncière',
  longNameInSentence: "l'Agence de Gestion Foncière",
  logoSrc: '/logo_AGEF.png',
  logoRatio: 322 / 160,
  logoNeedsPlate: true,
};
