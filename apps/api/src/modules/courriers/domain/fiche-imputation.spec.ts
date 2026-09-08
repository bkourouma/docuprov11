import {
  buildFiche,
  buildHistoriqueGrid,
  frDate,
  frDateTime,
  type FicheInputs,
} from './fiche-imputation';

const now = new Date(2026, 6, 16, 14, 30); // 16/07/2026 14:30 (heure locale, comme le source)

const base: FicheInputs = {
  dateEnregistrementCourrier: new Date(2026, 6, 16, 8, 0),
  date: new Date(2026, 6, 10),
  nReference: '00042',
  reference: 'REF-88',
  externalEntityName: 'Ministère des Finances',
  destinataireFullName: 'Admin Système',
  title: 'Demande de subvention 2026',
  attachedFileName: 'courrier-scanne',
  imputations: [],
  userCreated: 'Agent BO',
  historique: [],
  allRoleNames: ['Directeur', 'Secrétaire'],
  allInputationTypeNames: ['Pour Suivi', 'Pour Avis'],
  now,
};

const imputation = {
  typeName: 'Pour Suivi',
  userFullName: 'Jean Agent',
  instructions: 'Traiter sous 48h',
  deadline: new Date(2026, 6, 18),
};
const copie = {
  typeName: 'En Copie',
  userFullName: 'Paul Copie',
  instructions: null,
  deadline: null,
};

describe('Formats de date (§09)', () => {
  it('frDate rend dd/MM/yyyy et vide si absent', () => {
    expect(frDate(new Date(2026, 6, 5))).toBe('05/07/2026');
    expect(frDate(null)).toBe('');
  });

  it('frDateTime rend dd/MM/yyyy HH:mm', () => {
    expect(frDateTime(new Date(2026, 6, 5, 9, 7))).toBe('05/07/2026 09:07');
  });
});

describe('buildFiche — informations générales', () => {
  it('mappe les champs du gabarit', () => {
    const { replacements: r } = buildFiche({ ...base, imputations: [imputation] });
    expect(r['%date_arrivee%']).toBe('16/07/2026');
    expect(r['%date_courrier%']).toBe('10/07/2026');
    expect(r['%numero_enregistrement%']).toBe('00042');
    expect(r['%numero_origine%']).toBe('REF-88');
    expect(r['%correspondant%']).toBe('Ministère des Finances');
    expect(r['%destinataire%']).toBe('Admin Système');
    expect(r['%objet%']).toBe('Demande de subvention 2026');
    expect(r['%name_stamp%']).toBe('Agent BO');
    expect(r['%date_now%']).toBe('16/07/2026');
    expect(r['%date_traitement%']).toBe('16/07/2026 14:30');
  });

  it('RÈGLE 1 : %description% porte le nom du fichier joint, PAS la description du courrier', () => {
    const { replacements } = buildFiche({ ...base, imputations: [imputation] });
    expect(replacements['%description%']).toBe('courrier-scanne');
  });

  it('rend une chaîne vide (jamais « null ») pour les champs absents', () => {
    const { replacements: r } = buildFiche({
      ...base,
      imputations: [imputation],
      nReference: null,
      reference: null,
      externalEntityName: null,
      destinataireFullName: null,
      date: null,
      dateEnregistrementCourrier: null,
      userCreated: null,
    });
    for (const k of [
      '%numero_enregistrement%',
      '%numero_origine%',
      '%correspondant%',
      '%destinataire%',
      '%date_courrier%',
      '%date_arrivee%',
      '%name_stamp%',
    ]) {
      expect(r[k]).toBe('');
    }
  });
});

describe('buildFiche — RÈGLE 2 : choix du gabarit', () => {
  it('sans aucune imputation réelle, bascule sur le formulaire vierge', () => {
    const { template, replacements } = buildFiche({ ...base, imputations: [] });
    expect(template).toBe('FICHE_IMPUTATION - Copie.docx');
    // Le gabarit alternatif ne porte pas ces champs : ils ne doivent PAS être injectés.
    expect(replacements['%imputations%']).toBeUndefined();
    expect(replacements['%instructions%']).toBeUndefined();
    expect(replacements['%datebutoire%']).toBeUndefined();
    expect(replacements['%copies%']).toBeUndefined();
  });

  it('avec seulement des « En Copie », bascule aussi sur le formulaire vierge', () => {
    const { template } = buildFiche({ ...base, imputations: [copie] });
    expect(template).toBe('FICHE_IMPUTATION - Copie.docx');
  });

  it('avec une imputation réelle, utilise le gabarit normal', () => {
    const { template } = buildFiche({ ...base, imputations: [imputation, copie] });
    expect(template).toBe('FICHE_IMPUTATION.docx');
  });

  it('une imputation sans agent mais avec un type suffit à garder le gabarit normal', () => {
    // instructionsOriginal (= le type) est non vide => pas de bascule.
    const { template, replacements } = buildFiche({
      ...base,
      imputations: [{ ...imputation, userFullName: null }],
    });
    expect(template).toBe('FICHE_IMPUTATION.docx');
    // …et %imputations% vide déclenche le repli en cases à cocher (règle 3).
    expect(replacements['%imputations%']).toBe('☐ Directeur\n☐ Secrétaire');
  });
});

describe('buildFiche — RÈGLE 3 : replis en cases à cocher', () => {
  it('%instructions% vide est remplacé par tous les types d’imputation', () => {
    // Un type blanc => instructionsOriginal vide, mais un agent présent => pas de bascule.
    const { template, replacements } = buildFiche({
      ...base,
      imputations: [{ ...imputation, typeName: '   ' }],
    });
    expect(template).toBe('FICHE_IMPUTATION.docx');
    expect(replacements['%instructions%']).toBe('- ☐ Pour Suivi\n- ☐ Pour Avis');
  });

  it('renseignés, les champs priment sur le repli', () => {
    const { replacements: r } = buildFiche({ ...base, imputations: [imputation] });
    expect(r['%imputations%']).toBe('Jean Agent');
    expect(r['%instructions%']).toBe('Pour Suivi');
  });
});

describe('buildFiche — imputations et copies', () => {
  it('sépare imputations et copies, et formate chaque bloc', () => {
    const { replacements: r } = buildFiche({ ...base, imputations: [imputation, copie] });
    expect(r['%imputations_principales%']).toBe('- Jean Agent (Pour Suivi): Traiter sous 48h');
    expect(r['%destinataires%']).toBe(r['%imputations_principales%']);
    expect(r['%instruction%']).toBe('- Jean Agent: Traiter sous 48h');
    expect(r['%copies%']).toBe('- Paul Copie');
    expect(r['%copie_a%']).toBe('Paul Copie');
  });

  it('%datebutoire% vient de la PREMIÈRE imputation réelle', () => {
    const { replacements: r } = buildFiche({
      ...base,
      imputations: [imputation, { ...imputation, deadline: new Date(2026, 6, 25) }],
    });
    expect(r['%datebutoire%']).toBe('18/07/2026');
    expect(r['%date_butoire%']).toBe('18/07/2026');
  });
});

describe('buildHistoriqueGrid (§09 IV)', () => {
  it('rend un texte tabulé avec en-tête (et non un vrai tableau Word)', () => {
    const grid = buildHistoriqueGrid([
      {
        date: new Date(2026, 6, 16, 9, 5),
        userName: 'Agent BO',
        actionName: 'Contrôle',
        details: 'Courrier contrôlé',
      },
    ]);
    const lines = grid.split('\n');
    expect(lines[0]).toBe('Date/Heure\t\tUtilisateur\t\tAction\t\tDétails');
    expect(lines[1]).toBe('16/07/2026 09:05\t\tAgent BO\t\tContrôle\t\tCourrier contrôlé');
  });

  it('affiche un repli explicite quand il n’y a pas d’historique', () => {
    expect(buildHistoriqueGrid([])).toBe('Aucun historique disponible');
  });

  it('tolère des champs nuls sans écrire « null » dans la fiche', () => {
    const grid = buildHistoriqueGrid([
      { date: new Date(2026, 6, 16, 9, 5), userName: null, actionName: null, details: null },
    ]);
    expect(grid).not.toContain('null');
  });
});
