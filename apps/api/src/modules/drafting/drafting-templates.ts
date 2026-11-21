// Catalogue VERSIONNÉ des modèles de rédaction (lot 4c). Pas de base de données : le catalogue vit dans
// le dépôt, avec les tests qui le vérifient. Chaque squelette est du HTML limité aux balises de
// l'éditeur, sans donnée réelle, sans lien, sans script ; les repères entre crochets sont à compléter.
// Le catalogue est gelé : le service ne peut ni l'altérer ni l'étendre à l'exécution.

export interface DraftTemplate {
  /** Respecte GED_DRAFT_TEMPLATE_ID_REGEX de `@archivage/types`. */
  id: string;
  label: string;
  /** Une phrase. */
  description: string;
  /** 'Courrier' | 'Réunion' | 'Note' | 'Rapport' | 'Attestation' | 'Général'. */
  category: string;
  /** Consigne interne de structure et de ton pour l'IA : texte de confiance, sans HTML, 2 à 4 phrases. */
  guidance: string;
  /** Structure du document : balises p, br, h1, h2, h3, ul, ol, li, blockquote, strong, em, u, table, thead, tbody, tr, th, td. */
  skeletonHtml: string;
}

const DRAFT_TEMPLATE_LIST: ReadonlyArray<DraftTemplate> = [
  {
    id: 'vide',
    label: 'Document vide',
    description: 'Document sans structure imposée, à rédiger librement.',
    category: 'Général',
    guidance:
      "Ne propose aucune structure imposée : rédige le contenu demandé librement, dans un français clair et neutre. Reste factuel et concis, et n'invente aucune donnée absente de l'instruction.",
    skeletonHtml: '<p></p>',
  },
  {
    id: 'courrier-officiel',
    label: 'Courrier officiel',
    description: "Courrier administratif structuré : objet, référence, corps et formules d'usage.",
    category: 'Courrier',
    guidance:
      "Adopte un ton officiel, courtois et sobre, avec une formule d'appel et une formule de politesse adaptées au destinataire. Présente l'objet et la référence en tête, puis expose les faits et la demande de façon ordonnée. Ne mentionne aucune donnée d'identité ou de montant qui ne figure pas dans l'instruction.",
    skeletonHtml: [
      '<p><strong>[Expéditeur]</strong></p>',
      "<p>[Adresse de l'expéditeur]</p>",
      '<p>[Lieu], le [Date]</p>',
      '<p>[Destinataire]</p>',
      "<p>[Adresse du destinataire]</p>",
      '<p><strong>Objet :</strong> [À compléter]</p>',
      '<p><strong>Référence :</strong> [À compléter]</p>',
      "<p>[Formule d'appel]</p>",
      '<p>[Corps du courrier : exposé des faits, demande ou information à transmettre]</p>',
      '<p>[Formule de politesse]</p>',
      '<p>[Signature et qualité du signataire]</p>',
    ].join(''),
  },
  {
    id: 'lettre-reponse',
    label: 'Lettre de réponse',
    description: "Réponse structurée à un courrier reçu, qui rappelle sa date et son objet.",
    category: 'Courrier',
    guidance:
      "Rappelle d'emblée le courrier auquel tu réponds, sa date et son objet, puis réponds point par point, sans détour. Garde un ton courtois, précis et neutre, sans promesse que l'instruction ne prévoit pas. Termine par une formule de politesse et une disponibilité pour un complément d'information.",
    skeletonHtml: [
      '<p>[Expéditeur : nom et adresse]</p>',
      '<p>[Destinataire : nom et adresse]</p>',
      '<p>[Lieu], le [Date]</p>',
      '<p><strong>Objet :</strong> Réponse à votre courrier du [Date du courrier]</p>',
      '<p><strong>Référence :</strong> [À compléter]</p>',
      "<p>[Formule d'appel]</p>",
      '<p>En réponse à votre courrier du [Date] concernant [Objet de la demande], nous vous informons que [À compléter].</p>',
      '<p>[Développement : éléments de réponse, justificatifs, délais éventuels]</p>',
      '<p>Nous restons à votre disposition pour tout complément d’information.</p>',
      '<p>[Formule de politesse]</p>',
      '<p>[Signature et qualité du signataire]</p>',
    ].join(''),
  },
  {
    id: 'compte-rendu-reunion',
    label: 'Compte rendu de réunion',
    description: 'Compte rendu de réunion : participants, ordre du jour, décisions et actions attribuées.',
    category: 'Réunion',
    guidance:
      "Rédige un compte rendu factuel et synthétique, au présent ou au passé composé, sans reprendre les échanges mot à mot. Donne les décisions de façon explicite et range les actions dans le tableau avec leur responsable et leur échéance. Ne complète que les éléments présents dans l'instruction et laisse les autres en repère.",
    skeletonHtml: [
      '<h1>Compte rendu de réunion</h1>',
      '<p><strong>Objet de la réunion :</strong> [À compléter]</p>',
      '<p><strong>Date :</strong> [Date]</p>',
      '<p><strong>Heure et lieu :</strong> [Heure], [Lieu]</p>',
      '<h2>Participants</h2>',
      '<ul><li>[Nom et fonction du participant]</li></ul>',
      '<h2>Ordre du jour</h2>',
      "<ol><li>[Point de l'ordre du jour]</li></ol>",
      '<h2>Décisions</h2>',
      '<ul><li>[Décision prise, avec le point concerné]</li></ul>',
      '<h2>Actions à mener</h2>',
      '<table><thead><tr><th>Action</th><th>Responsable</th><th>Échéance</th></tr></thead>',
      '<tbody><tr><td>[Action à mener]</td><td>[Responsable]</td><td>[Échéance]</td></tr></tbody></table>',
    ].join(''),
  },
  {
    id: 'proces-verbal',
    label: 'Procès-verbal',
    description: "Procès-verbal de séance ou d'assemblée : présence, quorum, délibérations et résolutions.",
    category: 'Réunion',
    guidance:
      "Rédige un procès-verbal fidèle et impersonnel, qui constate les faits sans les commenter. Présente les résolutions dans l'ordre des délibérations, avec leur texte exact et le résultat du vote lorsqu'il est fourni. Ne constate ni quorum, ni vote, ni présence que l'instruction ne mentionne pas.",
    skeletonHtml: [
      '<h1>Procès-verbal</h1>',
      "<p><strong>Nature de la séance :</strong> [À compléter]</p>",
      '<p><strong>Date et lieu :</strong> [Date], [Lieu]</p>',
      '<p><strong>Présidence :</strong> [Nom et qualité du président de séance]</p>',
      '<p><strong>Secrétariat :</strong> [Nom et qualité du secrétaire de séance]</p>',
      '<h2>Présents, représentés, excusés et absents</h2>',
      '<ul><li>[Nom, qualité et statut de présence]</li></ul>',
      '<h2>Vérification du quorum</h2>',
      '<p>[Constat du quorum et des pouvoirs éventuels]</p>',
      '<h2>Délibérations</h2>',
      '<p>[Compte rendu des débats, point par point]</p>',
      '<h2>Résolutions adoptées</h2>',
      '<ol><li>[Texte de la résolution] : [Résultat du vote : pour, contre, abstention]</li></ol>',
      "<p>L'ordre du jour étant épuisé, la séance est levée à [Heure].</p>",
      '<p>[Lieu], le [Date]</p>',
      '<p>[Signature du président]</p>',
      '<p>[Signature du secrétaire]</p>',
    ].join(''),
  },
  {
    id: 'note-de-service',
    label: 'Note de service',
    description: 'Note interne qui énonce des dispositions applicables à des services ou à des personnes.',
    category: 'Note',
    guidance:
      "Rédige une note brève et directive, à l'impératif ou au présent de l'indicatif, dans un ton sobre et sans formule de politesse superflue. Énonce chaque disposition de façon distincte, avec sa date d'entrée en vigueur lorsqu'elle est fournie. Indique les modalités de mise en œuvre et les personnes ressources uniquement si l'instruction les donne.",
    skeletonHtml: [
      '<h1>Note de service</h1>',
      '<p><strong>De :</strong> [Émetteur, fonction]</p>',
      '<p><strong>À :</strong> [Destinataires ou services concernés]</p>',
      '<p><strong>Date :</strong> [Date]</p>',
      '<p><strong>Objet :</strong> [À compléter]</p>',
      '<p>[Contexte et motif de la note, en quelques phrases]</p>',
      '<h2>Dispositions</h2>',
      "<ol><li>[Disposition applicable, avec date d'entrée en vigueur]</li></ol>",
      '<p>[Modalités de mise en œuvre et personnes ressources]</p>',
      "<p>[Signature et fonction de l'émetteur]</p>",
    ].join(''),
  },
  {
    id: 'rapport-synthese',
    label: 'Rapport de synthèse',
    description: 'Rapport de synthèse en quatre parties : contexte, constats, recommandations et conclusion.',
    category: 'Rapport',
    guidance:
      "Rédige un rapport structuré et argumenté : chaque constat doit s'appuyer sur un fait ou une source mentionnés dans l'instruction. Formule les recommandations de façon concrète, en les distinguant des constats. Ne présente aucune statistique ni aucun chiffre qui ne figure pas dans l'instruction.",
    skeletonHtml: [
      '<h1>Rapport de synthèse</h1>',
      '<p><strong>Titre :</strong> [À compléter]</p>',
      '<p><strong>Date :</strong> [Date]</p>',
      '<p><strong>Auteur :</strong> [Nom et fonction]</p>',
      '<h2>Contexte</h2>',
      "<p>[Rappel du cadre, de la commande et du périmètre de l'étude]</p>",
      '<h2>Constats</h2>',
      '<ul><li>[Constat principal, appuyé sur une source]</li></ul>',
      '<h2>Recommandations</h2>',
      '<ol><li>[Recommandation, avec responsable et échéance indicatifs]</li></ol>',
      '<h2>Conclusion</h2>',
      '<p>[Synthèse des enseignements et suites à donner]</p>',
    ].join(''),
  },
  {
    id: 'attestation',
    label: 'Attestation',
    description: 'Attestation écrite par une personne qui certifie des faits, avec formule de validité.',
    category: 'Attestation',
    guidance:
      "Rédige une attestation courte, à la première personne, qui énonce uniquement les faits certifiés dans l'instruction, sans les interpréter. Conserve la formule consacrée « servir et valoir ce que de droit » et la date ainsi que le lieu d'établissement. N'ajoute aucun nom, aucune date ou aucun numéro qui ne figure pas dans l'instruction.",
    skeletonHtml: [
      '<h1>Attestation</h1>',
      '<p>Je soussigné(e) [Nom et prénom], [Fonction], atteste que :</p>',
      '<p>[Énoncé des faits attestés]</p>',
      '<p>La présente attestation est établie pour servir et valoir ce que de droit.</p>',
      '<p>Fait à [Lieu], le [Date].</p>',
      '<p>[Signature]</p>',
    ].join(''),
  },
];

// Catalogue gelé en profondeur (liste et chaque entrée) : le service ne peut pas le muter.
export const DRAFT_TEMPLATES: ReadonlyArray<DraftTemplate> = Object.freeze(
  DRAFT_TEMPLATE_LIST.map((template) => Object.freeze({ ...template })),
);

/**
 * Renvoie le modèle d'identifiant donné, ou undefined. Recherche linéaire sur le catalogue :
 * aucun accès par clé à un objet, donc pas de faux positif sur 'constructor' ou '__proto__'.
 */
export function findDraftTemplate(id: string): DraftTemplate | undefined {
  return DRAFT_TEMPLATES.find((template) => template.id === id);
}
