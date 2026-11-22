import { AsstActionTool } from '@archivage/types';
import { MAIL_INPUTATION_TYPE_IDS } from '../../workflow-agent-catalog/catalog.contracts';
import {
  containsPhrase,
  decideDelay,
  decideInputationType,
  detectTypeMentions,
  distinctlyDesignated,
  extractDelayCandidates,
  intentAllows,
  isSignificant,
  labelDesignators,
  mentionedMailIds,
  normalizeWords,
} from './intent-guards';
import type { PlannerInputationTypeView } from './planner.types';

const IMP = AsstActionTool.ImputationCourrier;
const REL = AsstActionTool.Relance;
const BRO = AsstActionTool.BrouillonReponse;

const TYPES: PlannerInputationTypeView[] = [
  { id: MAIL_INPUTATION_TYPE_IDS.validationDG, label: 'Validation DG', suivi: false },
  { id: MAIL_INPUTATION_TYPE_IDS.pourSuivi, label: 'Pour Suivi', suivi: true },
  { id: MAIL_INPUTATION_TYPE_IDS.validationDirection, label: 'Validation Direction', suivi: false },
  { id: MAIL_INPUTATION_TYPE_IDS.enCopie, label: 'En copie', suivi: false },
];

describe('normalisation', () => {
  it('retire accents, casse, apostrophes typographiques et ponctuation', () => {
    expect(normalizeWords("  Rédige l’Ébauche, s'il-te-plaît !  ")).toBe('redige l ebauche s il te plait');
  });
  it('retire les invisibles et ramène la pleine chasse (NFKC)', () => {
    expect(normalizeWords('IM\u200BPUTE ＤＡＦ')).toBe('impute daf');
  });
  it('containsPhrase travaille en mots entiers', () => {
    expect(containsPhrase('impute a la daf', 'daf')).toBe(true);
    expect(containsPhrase('impute a la dafa', 'daf')).toBe(false);
    expect(containsPhrase('impute a la daf', '')).toBe(false);
  });
  it('isSignificant ignore les mots vides', () => {
    expect(isSignificant('la')).toBe(false);
    expect(isSignificant('a la')).toBe(false);
    expect(isSignificant('daf')).toBe(true);
    expect(isSignificant('x')).toBe(false);
  });
});

describe('intentAllows', () => {
  it.each([
    'impute ce courrier à la DAF',
    'Imputez-le au DRH',
    'imputer à la DAF stp',
    "fais l'imputation à la DAF",
    'Affecte ce courrier à Awa',
    'attribue-le au service juridique',
    'assigne ce courrier à la DAF',
    'transmets à la DAF',
    'confie ce dossier à la DRH',
    'envoie-le à la DAF',
    'fais passer ce courrier à la DAF',
    'Assign this mail to finance',
    'forward it to the CFO',
    'send it to legal',
  ])('imputation : « %s »', (text) => {
    expect(intentAllows(IMP, [text])).toBe(true);
  });

  it.each([
    'Quel est le statut de ce courrier ?',
    'lis ce courrier confidentiel',
    'résume le courrier',
    "n'impute pas ce courrier",
    'ne pas imputer ce courrier',
    "don't assign this mail",
    'Qui a reçu ce courrier ?',
  ])('pas d’ordre d’imputation : « %s »', (text) => {
    expect(intentAllows(IMP, [text])).toBe(false);
  });

  it.each(['relance la DAF', 'Relancez Awa', 'fais un rappel à la DAF', 'rappelle-lui ce courrier', 'presse la DRH', 'remind finance', 'chase the late ones', 'follow up with legal'])(
    'relance : « %s »',
    (text) => {
      expect(intentAllows(REL, [text])).toBe(true);
    },
  );

  it.each(['prépare un brouillon', 'rédige une réponse', 'Réponds à ce courrier', 'projet de réponse stp', 'draft a reply', 'write an answer'])(
    'brouillon : « %s »',
    (text) => {
      expect(intentAllows(BRO, [text])).toBe(true);
    },
  );

  it('ne confond pas les outils', () => {
    expect(intentAllows(REL, ['impute ce courrier à la DAF'])).toBe(false);
    expect(intentAllows(BRO, ['relance la DAF'])).toBe(false);
    expect(intentAllows(IMP, ['rédige une réponse'])).toBe(false);
  });

  it('accepte un ordre donné dans un message précédent de l’échange', () => {
    expect(intentAllows(IMP, ['Awa Diallo', 'impute ce courrier à la DAF'])).toBe(true);
  });

  // Durcissement (corpus d'attaque du planificateur) : constat, question ou remerciement ne sont pas des ordres.
  it.each<[string, string]>([
    [IMP, 'Est-ce que ce courrier est déjà imputé à la DAF ?'],
    [IMP, 'Ce courrier a été transmis à la DAF hier.'],
    [IMP, 'Qui a envoyé ce courrier à la mairie ?'],
    [IMP, "J'ai affecté ce courrier à Awa."],
    [REL, "rappelle-moi l'objet de ce courrier"],
    [REL, 'pour rappel, ce courrier est important'],
    [REL, 'Ce courrier a été repris par la presse.'],
    [BRO, 'Réponds-moi : que contient ce courrier ?'],
    [BRO, 'Réponds en une phrase.'],
    [BRO, 'merci pour ta réponse'],
    [BRO, "quelle réponse attend l'expéditeur ?"],
    [BRO, 'réponds à ma question'],
  ])('pas un ordre (%s) : « %s »', (tool, text) => {
    expect(intentAllows(tool, [text])).toBe(false);
  });

  it.each<[string, string]>([
    [IMP, 'Peux-tu imputer ce courrier à la DAF sous 3 jours ?'],
    [IMP, 'Pourriez-vous transmettre ce courrier à la DRH ?'],
    [IMP, "C'est urgent, impute ce courrier à la DAF sous 3 jours"],
    [REL, 'rappelle-lui ce courrier'],
    [BRO, 'Réponds-lui poliment.'],
    [BRO, 'réponds à la mairie'],
    [BRO, 'prépare une réponse à ce courrier'],
    [BRO, 'une réponse à ce courrier stp'],
  ])('ordre (%s) : « %s »', (tool, text) => {
    expect(intentAllows(tool, [text])).toBe(true);
  });

  it('refuse toujours la délégation et les outils inconnus', () => {
    expect(intentAllows('proposer_delegation', ['délègue et impute ce courrier'])).toBe(false);
    expect(intentAllows('supprimer_tout', ['impute'])).toBe(false);
  });
});

describe('extractDelayCandidates', () => {
  it.each<[string, number[], boolean]>([
    ['impute sous 3 jours', [3], false],
    ['dans 5 jours', [5], false],
    ['délai 3j', [3], false],
    ['sous une semaine', [7], false],
    ['deux semaines', [14], false],
    ['un mois', [30], false],
    ['pour demain', [1], false],
    ['après-demain', [2], false],
    ['sous 48h', [2], false],
    ['sous 36 h', [], true],
    ['sous dix-sept jours', [17], false],
    ['sous quinze jours', [15], false],
    ["d'ici 3 jours", [3], false],
    ["d'ici vendredi", [], true],
    ['avant le 12 mai', [], true],
    ['pour le 12/05/2026', [], true],
    ['sous 3 jours ouvrés', [3], true],
    ['2 à 3 jours', [2, 3], false],
    ['2-3 jours', [3], true],
    ['sous 1,5 jour', [5], true],
    ['sous 3 jours, enfin 5 jours', [3, 5], false],
    ['c’est urgent', [], true],
    ['urgent, sous 2 jours', [2], false],
    ['impute à la DAF', [], false],
    ['fais la mise à jour', [], false],
    ['courrier 4321', [], false],
    ['within a week', [7], false],
    ['sous 4 mois', [120], false],
  ])('« %s »', (text, days, vague) => {
    expect(extractDelayCandidates(text)).toEqual({ days, vague });
  });
});

describe('decideDelay', () => {
  it('impose le délai unique du message courant', () => {
    expect(decideDelay('impute à la DAF sous 3 jours', [])).toEqual({ status: 'ok', days: 3 });
  });
  it('à défaut, prend le délai unique de l’historique', () => {
    expect(decideDelay('Awa Diallo', ['impute à la DAF sous 4 jours'])).toEqual({ status: 'ok', days: 4 });
  });
  it('le message courant l’emporte sur l’historique', () => {
    expect(decideDelay('plutôt 2 jours', ['sous 4 jours'])).toEqual({ status: 'ok', days: 2 });
  });
  it('plusieurs délais distincts, date ou hors bornes : ambigu', () => {
    expect(decideDelay('sous 3 ou 5 jours', [])).toEqual({ status: 'ambiguous' });
    expect(decideDelay("d'ici vendredi", [])).toEqual({ status: 'ambiguous' });
    expect(decideDelay('sous 4 mois', [])).toEqual({ status: 'ambiguous' });
    expect(decideDelay('Awa', ['sous 3 jours', 'non, 5 jours'])).toEqual({ status: 'ambiguous' });
  });
  it('aucun délai évoqué : pas de délai', () => {
    expect(decideDelay('impute à la DAF', ['bonjour'])).toEqual({ status: 'none' });
  });
});

describe('mentionedMailIds', () => {
  it.each<[string, number[]]>([
    ['impute le courrier 4321', [4321]],
    ['courrier n°4321 et courrier n° 55', [4321, 55]],
    ['le n°4321 stp', [4321]],
    ['voir #4321', [4321]],
    ['numéro 4321', [4321]],
    ['mail 77', [77]],
    ["relance l'imputation n°55", []],
    ['sous 3 jours', []],
    ['courrier 99999999999', []],
  ])('« %s »', (text, ids) => {
    expect(mentionedMailIds(text)).toEqual(ids);
  });
});

describe('type d’imputation', () => {
  it('reconnaît les libellés actifs et les alias, la phrase la plus longue d’abord', () => {
    expect(detectTypeMentions('impute pour suivi', TYPES)).toEqual({ strong: [10], weak: [] });
    expect(detectTypeMentions('pour validation de la direction générale', TYPES)).toEqual({ strong: [5], weak: [] });
    expect(detectTypeMentions('validation direction', TYPES)).toEqual({ strong: [14], weak: [] });
    expect(detectTypeMentions('mets la DRH en copie', TYPES)).toEqual({ strong: [17], weak: [] });
    expect(detectTypeMentions('pour validation', TYPES)).toEqual({ strong: [], weak: [5, 14] });
    expect(detectTypeMentions('impute au DG', TYPES)).toEqual({ strong: [], weak: [5] });
  });

  it('décide : explicite, défaut « Pour suivi », ambigu, indisponible', () => {
    expect(decideInputationType('impute à la DAF en copie', [], TYPES)).toEqual({ status: 'explicit', typeId: 17 });
    expect(decideInputationType('impute à la DAF', [], TYPES)).toEqual({ status: 'default', typeId: 10 });
    expect(decideInputationType('pour suivi et en copie', [], TYPES)).toEqual({ status: 'ambiguous', candidates: [10, 17] });
    expect(decideInputationType('impute au DG', [], TYPES).status).toBe('ambiguous');
    expect(decideInputationType('impute au DG pour suivi', [], TYPES)).toEqual({ status: 'explicit', typeId: 10 });
    const noSuivi = TYPES.filter((t) => t.id !== 10);
    expect(decideInputationType('impute à la DAF', [], noSuivi)).toEqual({ status: 'unavailable' });
    expect(decideInputationType('impute pour suivi', [], noSuivi).status).toBe('ambiguous');
  });

  it('à défaut de mention dans le message courant, lit l’historique', () => {
    expect(decideInputationType('Awa Diallo', ['impute à la DAF en copie'], TYPES)).toEqual({ status: 'explicit', typeId: 17 });
  });
});

describe('désignation d’un libellé', () => {
  it('désignateurs : libellé complet, segments, mots du nom', () => {
    const d = labelDesignators('Awa Diallo — DAF');
    expect(d).toEqual(expect.arrayContaining(['awa diallo daf', 'awa diallo', 'daf', 'awa', 'diallo']));
  });
  it('un candidat n’est désigné que par une partie qu’il est seul à porter', () => {
    const c = [
      { id: 1, label: 'Awa Diallo — DAF' },
      { id: 2, label: 'Moussa Keita — DAF' },
    ];
    const ids = (texts: string[]): number[] => distinctlyDesignated(c, (x) => x.label, texts.map((t) => normalizeWords(t))).map((x) => x.id);
    expect(ids(['impute à la DAF'])).toEqual([]);
    expect(ids(['impute à Awa Diallo de la DAF'])).toEqual([1]);
    expect(ids(['plutôt Keita'])).toEqual([2]);
    expect(ids(['Awa et Moussa'])).toEqual([1, 2]);
  });
});
