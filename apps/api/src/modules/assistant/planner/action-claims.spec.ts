import { PLANNER_MSG_ACTION_CLAIM, PLANNER_MSG_INFO_ONLY, claimsActionDone } from './action-claims';

describe('claimsActionDone : un texte libre du modèle qui revendique une action', () => {
  it.each([
    "J'ai imputé ce courrier à la DAF.",
    "j'ai bien relancé Awa Diallo",
    'Je lui ai transmis le courrier.',
    'Nous avons enregistré votre demande et supprimé le doublon.',
    "Je viens d'imputer ce courrier à la DAF.",
    "C'est fait !",
    'C’EST   FAIT',
    'Imputation effectuée.',
    'Relance envoyée à Awa Diallo.',
    'Brouillon créé dans l’espace Juridique.',
    'Le courrier a été imputé à la DAF.',
    'Le brouillon a bien été déposé.',
    'Courrier imputé à la DAF.',
    'courrier 4321 impute a la daf',
    'Courrier transmis aux RH.',
    'I have assigned this mail to DAF.',
    "I've forwarded it to the CFO.",
    'The reminder was sent.',
    'Done.',
    'Mail assigned to finance.',
    'J​’ai imputé ce courrier.',
    'ＪＡＩ ＩＭＰＵＴＥ ce courrier',
  ])('revendication : « %s »', (text) => {
    expect(claimsActionDone(text)).toBe(true);
  });

  it.each([
    'Le courrier sollicite une subvention pour une bibliothèque.',
    'Voulez-vous que je propose une imputation à la DAF ?',
    "J'ai trouvé deux courriers correspondant à votre recherche.",
    "J'ai vu une relance datée du 12 novembre.",
    "J'ai lu le courrier : il demande une réponse rapide.",
    'Pour imputer ce courrier, dites « impute ce courrier à la DAF ».',
    "Rien n'est envoyé tant que vous ne confirmez pas.",
    PLANNER_MSG_ACTION_CLAIM,
    'Que faire de ce courrier ?\n\n1. Imputer à Jean Piège\n2. Ne rien faire',
    'La référence est valide.',
    '',
  ])('pas une revendication : « %s »', (text) => {
    expect(claimsActionDone(text)).toBe(false);
  });

  it('non-texte : faux', () => {
    expect(claimsActionDone(undefined)).toBe(false);
    expect(claimsActionDone(42)).toBe(false);
  });

  // Tour X2 : formes courtes et présent d'action.
  it.each([
    'Fait.',
    'OK, fait',
    'Imputé.',
    'Effectué',
    'Terminé !',
    'Réalisé.',
    "C'est imputé.",
    "J'ai procédé à l'imputation.",
    "Je procède à l'imputation du courrier.",
    "J'ai fait le nécessaire.",
    "J'impute ce courrier à la DAF.",
    'Je relance Awa Diallo.',
    'Je rédige en ce moment la réponse.',
    "I'm assigning it now.",
    'Reminder sent.',
    'Assigned.',
    'Processed.',
    'Completed.',
    'All set.',
    'Imputation en cours.',
    'Assignment in progress.',
    'Ça y est !',
    'Mission accomplie.',
  ])('revendication (forme courte ou présent) : « %s »', (text) => {
    expect(claimsActionDone(text)).toBe(true);
  });

  it.each([
    PLANNER_MSG_INFO_ONLY,
    "Voulez-vous que je prépare : Imputer le courrier n°4321 à « Awa Diallo — DAF » : type « Pour suivi », délai de 3 jours ?\n\n1. Oui, prépare cette action\n2. Non, ne fais rien",
    "Préparer un brouillon de réponse au courrier n°4321 : document brouillon, rien n'est envoyé",
    "Voulez-vous que j'impute ce courrier à la DAF ?",
    "J'ai fait une recherche : deux courriers correspondent.",
    'Si je relance Awa, elle recevra une notification.',
    'Le traitement est terminé côté expéditeur ? Je ne le sais pas.',
    'Entendu : je ne prépare rien.',
  ])('pas une revendication : « %s »', (text) => {
    expect(claimsActionDone(text)).toBe(false);
  });
});
