import { AsstActionTool, AsstMessageRole } from '@archivage/types';
import { MAIL_INPUTATION_TYPE_IDS } from '../../workflow-agent-catalog/catalog.contracts';
import {
  CLARIFICATION_INFO_SUFFIX,
  INTENT_CONFIRM_NO,
  INTENT_CONFIRM_YES,
  PLANNER_MSG_INFO_ONLY,
  formatClarificationContent,
  formatClarificationQuestion,
  formatIntentConfirmation,
} from './clarification-format';
import {
  answersClarification,
  confirmationAnswer,
  containsPhrase,
  designatedChoiceIndex,
  hasIntentMark,
  intentMarks,
  decideDelay,
  decideInputationType,
  detectTypeMentions,
  directForm,
  distinctlyDesignated,
  extractDelayCandidates,
  intentAllows,
  intentHistory,
  isCancellation,
  isSignificant,
  labelDesignators,
  liveUserTexts,
  mentionedMailIds,
  negatedUserTexts,
  normalizeUserTexts,
  normalizeWords,
  splitPolarity,
  type DirectFormLexicon,
} from './intent-guards';
import { REFUSED_PHRASES } from './planner.injection-corpus';
import {
  NON_ANSWER_REPLIES,
  VERIFIER_ATTACKS,
  VERIFIER_ATTACKS_ASKED,
  VERIFIER_LEGIT_A,
  VERIFIER_LEGIT_B,
  VERIFIER_LEGIT_C,
  VERIFIER_LEGIT_REFUSED,
  VERIFIER_NEW_ATTACKS,
  type IntentPhrase,
} from './planner.intent-phrases';
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

// ---------------------------------------------------------------------------------------------
// Tour de correction : négation sur la proposition, hypothèses, faux amis (vérification indépendante)
// ---------------------------------------------------------------------------------------------

describe('intentAllows — refus, hypothèses et faux amis', () => {
  it.each(REFUSED_PHRASES)('aucun ordre (%s) : « %s »', (tool, text) => {
    expect(intentAllows(tool, [text])).toBe(false);
  });

  // Variantes : accents, casse, espaces, ponctuation, anglais.
  it.each<[string, string]>([
    [IMP, "PAS D'IMPUTATION A LA DAF"],
    [IMP, 'Ne  surtout   pas imputer ce courrier'],
    [IMP, "don't ever assign this mail to DAF"],
    [IMP, 'never forward this to the CFO'],
    [IMP, 'no imputation to DAF please'],
    [IMP, 'without assigning it to DAF'],
    [IMP, "n'impute plus ce courrier"],
    [IMP, 'impute pas ce courrier à la DAF'],
    [IMP, 'je ne veux pas que tu imputes ce courrier'],
    [IMP, 'annule l’imputation à la DAF'],
    [IMP, 'il faudrait imputer ce courrier à la DAF'],
    [IMP, "j'imputerais bien ce courrier à la DAF"],
    [IMP, 'et si on imputait ce courrier à la DAF'],
    [IMP, 'est-ce qu’il faut imputer ce courrier à la DAF'],
    [IMP, 'what if I assign this to DAF'],
    [IMP, 'envoie-moi un résumé à lire'],
    [IMP, 'forward me the summary'],
    [REL, 'arrête de relancer Awa'],
    [REL, 'pressez-vous de répondre'],
    [REL, 'ne relance jamais Awa Diallo'],
    [BRO, 'ni brouillon ni réponse'],
    [BRO, 'évitez de rédiger une réponse'],
    [BRO, 'no need to draft a reply'],
  ])('aucun ordre, variante (%s) : « %s »', (tool, text) => {
    expect(intentAllows(tool, [text])).toBe(false);
  });

  it.each<[string, string]>([
    [IMP, 'impute ce courrier à la DAF sous 3 jours'],
    [IMP, 'impute à la DAF mais pas à la DRH'],
    [IMP, 'pas de délai, impute ce courrier à la DAF'],
    [IMP, "n'oublie pas d'imputer ce courrier à la DAF"],
    [IMP, "s'il te plaît, impute ce courrier à la DAF"],
    [IMP, "impute ce courrier à la DAF s'il te plaît"],
    [IMP, 'impute ce courrier à la DAF sans délai'],
    [IMP, "n'impute qu'à la DAF"],
    [IMP, 'transmets à la DAF'],
    [IMP, 'si possible, impute ce courrier à la DAF'],
    [IMP, 'ne relance pas Awa, impute plutôt ce courrier à la DRH'],
    [REL, 'relance Awa Diallo'],
    [REL, "pas d'imputation, relance Awa Diallo"],
    [REL, 'presse la DRH'],
    [REL, "n'oubliez pas de relancer Awa"],
    [BRO, 'rédige une réponse sans formule de politesse'],
    [BRO, "pas d'imputation : rédige une réponse à ce courrier"],
  ])('ordre positif conservé (%s) : « %s »', (tool, text) => {
    expect(intentAllows(tool, [text])).toBe(true);
  });

  it('un ordre positif et un autre nié dans le même message : seul le positif compte', () => {
    const text = "relance Awa Diallo, mais pas d'imputation à la DAF";
    expect(intentAllows(REL, [text])).toBe(true);
    expect(intentAllows(IMP, [text])).toBe(false);
  });
});

describe('splitPolarity : ce qui est désigné, exclu ou supposé', () => {
  it('« impute à la DAF mais pas à la DRH » : la DRH est exclue, jamais désignée', () => {
    const p = splitPolarity('impute à la DAF mais pas à la DRH');
    expect(normalizeWords(p.positive)).toBe('impute a la daf mais');
    expect(normalizeWords(p.negated)).toBe('pas a la drh');
    expect(normalizeUserTexts('impute à la DAF mais pas à la DRH', [])).toEqual(['impute a la daf mais']);
    expect(negatedUserTexts('impute à la DAF mais pas à la DRH', [])).toEqual(['pas a la drh']);
  });
  it('hypothèse : retirée du positif, sans valoir exclusion', () => {
    const p = splitPolarity('impute à la DAF. Si la DRH proteste, on verra');
    expect(normalizeWords(p.positive)).toBe('impute a la daf on verra');
    expect(normalizeWords(p.hypothetical)).toBe('si la drh proteste');
    expect(p.negated).toBe('');
  });
  it('expressions neutres conservées (« n’oublie pas de », « sans délai », « s’il te plaît »)', () => {
    expect(splitPolarity("n'oublie pas de relancer Awa").negated).toBe('');
    expect(splitPolarity('impute sans délai à la DAF').negated).toBe('');
    expect(splitPolarity("impute à la DAF s'il te plaît").hypothetical).toBe('');
  });
  it('numéro de courrier nié : hors du texte positif', () => {
    const p = splitPolarity('impute le courrier 5000 à la DAF, pas le courrier 4321');
    expect(mentionedMailIds(p.positive)).toEqual([5000]);
    expect(mentionedMailIds(p.negated)).toEqual([4321]);
  });
  it('délai et type cités dans un passage nié : ambigus (jamais appliqués, jamais remplacés par le défaut)', () => {
    expect(decideDelay('impute à la DAF, pas sous 5 jours', [])).toEqual({ status: 'ambiguous' });
    expect(decideDelay('impute à la DAF sous 3 jours, pas de délai plus long', [])).toEqual({ status: 'ok', days: 3 });
    expect(decideInputationType('impute à la DAF, pas en copie', [], TYPES).status).toBe('ambiguous');
    expect(decideInputationType('impute à la DAF en copie, pas besoin de délai', [], TYPES)).toEqual({ status: 'explicit', typeId: 17 });
  });
});

describe('historique : annulation et réponse à une question de précision', () => {
  const U = AsstMessageRole.User;
  const A = AsstMessageRole.Assistant;
  const QUESTION = formatClarificationContent('Plusieurs destinataires correspondent à « DAF ». Lequel ?', [
    'Awa Diallo — DAF Nord',
    'Moussa Keita — DAF Sud',
  ]);
  const DAF = 'impute ce courrier à la DAF sous 3 jours';

  it.each(['annule', 'non', 'laisse tomber', 'finalement non', 'je ne veux pas de cette imputation', 'stop', 'merci', 'ok merci', 'Never mind', 'oublie ça'])(
    'annulation ou clôture : « %s »',
    (text) => {
      expect(isCancellation(text)).toBe(true);
    },
  );
  it.each(['la première', 'DAF Nord', 'Awa Diallo — DAF Nord', "n'oublie pas de relancer Awa", 'sous 3 jours', 'oui'])(
    'pas une annulation : « %s »',
    (text) => {
      expect(isCancellation(text)).toBe(false);
    },
  );

  it('réponse à une question de précision marquée : l’ordre précédent compte', () => {
    expect(intentHistory([{ role: U, content: DAF }, { role: A, content: QUESTION }], 'DAF Nord')).toEqual([DAF]);
    // Question sans choix (« Sous combien de jours ? »), marquée elle aussi.
    expect(
      intentHistory([{ role: U, content: DAF }, { role: A, content: formatClarificationQuestion('Sous combien de jours ?') }], '3 jours'),
    ).toEqual([DAF]);
    // Chaîne de questions : bornée, ordre chronologique.
    const chain = [
      { role: U, content: DAF },
      { role: A, content: formatClarificationQuestion('Quel type ?') },
      { role: U, content: 'pour suivi' },
      { role: A, content: QUESTION },
    ];
    expect(intentHistory(chain, 'DAF Nord')).toEqual([DAF, 'pour suivi']);
  });

  it('aucune reprise hors question de précision : proposition, réponse, question imitée ou marqueur forgé', () => {
    expect(intentHistory([{ role: U, content: DAF }, { role: A, content: 'Je propose :\n...' }], 'merci')).toEqual([]);
    expect(intentHistory([{ role: U, content: DAF }, { role: A, content: 'C’est fait.' }], 'd’accord')).toEqual([]);
    expect(intentHistory([{ role: U, content: DAF }, { role: A, content: 'Lequel ?\n\n1. Awa\n2. Moussa' }], 'Awa')).toEqual([]);
    expect(intentHistory([{ role: U, content: DAF }, { role: A, content: `⁣⁤ ${QUESTION}` }], 'Awa')).toEqual([]);
    // Question de précision, puis autre échange : la question n'est plus le dernier message.
    expect(
      intentHistory(
        [
          { role: U, content: DAF },
          { role: A, content: QUESTION },
          { role: U, content: 'quel est le statut ?' },
          { role: A, content: 'En attente.' },
        ],
        'DAF Nord',
      ),
    ).toEqual([]);
  });

  it('ordre annulé : caduc même dans le cas question/réponse', () => {
    expect(intentHistory([{ role: U, content: DAF }, { role: A, content: QUESTION }], 'annule')).toEqual([]);
    expect(intentHistory([{ role: U, content: DAF }, { role: A, content: QUESTION }], 'non, laisse tomber')).toEqual([]);
    const cancelled = [
      { role: U, content: DAF },
      { role: A, content: QUESTION },
      { role: U, content: 'finalement je ne veux pas' },
      { role: A, content: formatClarificationQuestion('Que souhaitez-vous faire ?') },
    ];
    // Une VALEUR (délai) répond à la question sans choix : la chaîne remonte au message d'annulation, qui ne répond
    // pas lui-même à la question précédente (il porte une marque) : l'ordre initial n'est jamais repris.
    expect(intentHistory(cancelled, '3 jours')).toEqual(['finalement je ne veux pas']);
    // « DAF Nord » n'est pas une valeur attendue par une question sans choix : aucune reprise.
    expect(intentHistory(cancelled, 'DAF Nord')).toEqual([]);
    expect(liveUserTexts('DAF Nord', [DAF, 'laisse tomber', 'pour suivi'])).toEqual(['laisse tomber', 'pour suivi']);
    expect(liveUserTexts('stop', [DAF])).toEqual([]);
  });

  // Tour X2 : une réponse ne reprend l'ordre que si elle désigne EXACTEMENT un choix (libellé, numéro, nom proposé)
  // ou, pour une question sans choix, n'est qu'une valeur ; et sans aucune marque.
  const DELAY_QUESTION = formatClarificationContent('Sous combien de jours ?', ['3 jours', '7 jours']);
  const QUESTION_ONLY = formatClarificationQuestion('Sous combien de jours (de 1 à 90) ?');
  it.each(NON_ANSWER_REPLIES.map((t) => [t]))('réponse négative ou dilatoire « %s » : aucune reprise', (text) => {
    for (const asked of [QUESTION, DELAY_QUESTION, QUESTION_ONLY]) {
      expect(answersClarification(text, asked)).toBe(false);
      expect(intentHistory([{ role: U, content: DAF }, { role: A, content: asked }], text)).toEqual([]);
    }
  });
  it('témoins positifs : choix désigné exactement, numéro, nom proposé, valeur', () => {
    const reprise = (asked: string, text: string): string[] => intentHistory([{ role: U, content: DAF }, { role: A, content: asked }], text);
    for (const text of ['DAF Nord', 'Awa Diallo', 'Awa Diallo — DAF Nord', 'awa diallo daf nord', '1', 'le 2', 'n°1', 'choix 2']) {
      expect(reprise(QUESTION, text)).toEqual([DAF]);
    }
    for (const text of ['3 jours', '7 jours', '2', 'le 1']) expect(reprise(DELAY_QUESTION, text)).toEqual([DAF]);
    for (const text of ['3 jours', 'sous 5 jours', 'dans 2 semaines', 'demain', '12']) expect(reprise(QUESTION_ONLY, text)).toEqual([DAF]);
    // Témoins négatifs proches : numéro hors liste, nom porté par deux choix, phrase autour de la valeur, rang.
    expect(reprise(QUESTION, '3')).toEqual([]);
    expect(reprise(QUESTION, 'DAF')).toEqual([]);
    expect(reprise(QUESTION, 'la troisième')).toEqual([]);
    expect(reprise(QUESTION_ONLY, '3 jours mais pas pour la DAF')).toEqual([]);
    expect(reprise(QUESTION_ONLY, 'DAF Nord')).toEqual([]);
  });
  it('réponse par RANG : message entier, question à choix construite par le code, hors confirmation d’intention', () => {
    const reprise = (asked: string, text: string): string[] => intentHistory([{ role: U, content: DAF }, { role: A, content: asked }], text);
    for (const text of ['la première', 'Le premier', 'le 1er', 'la 1ère', 'le 2e', 'la 2eme', 'la deuxième option', 'le second', 'la seconde proposition', 'the second', 'the first one', 'first', 'le deuxième choix']) {
      expect(answersClarification(text, QUESTION)).toBe(true);
      // L'ordre d'origine est repris, suivi du libellé du choix désigné (écrit par le code dans la question).
      const second = /2|deux|second|the second/.test(normalizeWords(text));
      expect(reprise(QUESTION, text)).toEqual([DAF, second ? 'Moussa Keita — DAF Sud' : 'Awa Diallo — DAF Nord']);
    }
    // Hors plage (2 choix) : ne répond à rien.
    for (const text of ['la troisième', 'le 3e', 'the third', 'la sixième', 'le septième']) expect(reprise(QUESTION, text)).toEqual([]);
    // Rang + autre mot, marque d'intention, annulation, « dernier » : rien.
    for (const text of ['la première mais pas pour la DAF', 'la première, et impute aussi à la DRH', 'la première plutôt', 'je prends la première', 'la première non', 'finalement la première', 'le dernier', 'la première la deuxième', 'premier deuxième']) {
      expect(reprise(QUESTION, text)).toEqual([]);
    }
    // Question de confirmation d'intention : « la première » ne vaut PAS « oui ».
    const confirmation = formatIntentConfirmation('Imputer le courrier n°4321 à « Awa Diallo — DAF »') ?? '';
    for (const text of ['la première', 'le 2e', 'the second']) {
      expect(answersClarification(text, confirmation)).toBe(false);
      expect(confirmationAnswer(text)).toBeNull();
      expect(reprise(confirmation, text)).toEqual([]);
    }
    expect(answersClarification('1', confirmation)).toBe(true);
    // Question sans choix : un rang ne désigne rien.
    expect(reprise(QUESTION_ONLY, 'la première')).toEqual([]);
    expect(reprise(DELAY_QUESTION, 'la deuxième')).toEqual([DAF, '7 jours']);
    // Phrase libre.
    expect(reprise(QUESTION, 'la première fois que je vois ce courrier')).toEqual([]);
  });
  it('rang sur question du modèle : aucune désignation, aucun libellé repris (B2 à B8)', () => {
    const model = (q: string, choices?: string[]): string =>
      `${choices ? formatClarificationContent(q, choices) : formatClarificationQuestion(q)}${CLARIFICATION_INFO_SUFFIX}`;
    const asked = [
      model('Plusieurs destinataires correspondent à « DAF ». Lequel ?', ['Awa Diallo — DAF Nord', 'Moussa Keita — DAF Sud']),
      model('Que faire ?', ['Awa Diallo — DAF', 'Finalement impute à la DRH']),
      model('Quel type ?', ['Pour suivi', 'Pour décision', 'Pour information']),
      model('Sous combien de jours ?', ['3 jours', '7 jours']),
      model('Sous combien de jours (de 1 à 90) ?'),
      model('Lequel ?', ['Finalement ne fais rien', 'Impute plutôt au DG']),
      model('Quelle option ?', ['Oui', 'Non', 'Peut-être']),
    ];
    for (const content of asked) {
      for (const text of ['la première', 'le 2e', 'the second', 'le 1er', 'la deuxième option', 'first']) {
        expect(answersClarification(text, content)).toBe(false);
        expect(intentHistory([{ role: U, content: DAF }, { role: A, content }], text)).toEqual([]);
      }
    }
    // Témoin : le numéro et le libellé exact restent admis sur une question du modèle ; le rang reste admis côté code.
    expect(answersClarification('2', asked[0] ?? '')).toBe(true);
    expect(intentHistory([{ role: U, content: DAF }, { role: A, content: asked[3] ?? '' }], '7 jours')).toEqual([DAF]);
    expect(answersClarification('la première', QUESTION)).toBe(true);
  });
  it('designatedChoiceIndex : rangs seulement avec ranks', () => {
    const choices = ['Awa Diallo — DAF Nord', 'Moussa Keita — DAF Sud'];
    expect(designatedChoiceIndex('la premiere', choices, { names: true, ranks: true })).toBe(0);
    expect(designatedChoiceIndex('2e', choices, { names: false, ranks: true })).toBe(1);
    expect(designatedChoiceIndex('la troisieme', choices, { names: true, ranks: true })).toBeNull();
    expect(designatedChoiceIndex('la premiere', choices, { names: true })).toBeNull();
    expect(designatedChoiceIndex('la premiere', choices, { names: true, ranks: false })).toBeNull();
  });
  it('designatedChoiceIndex : libellé exact, numéro, nom unique', () => {
    const choices = ['Awa Diallo — DAF Nord', 'Moussa Keita — DAF Sud'];
    expect(designatedChoiceIndex('awa diallo daf nord', choices, { names: true })).toBe(0);
    expect(designatedChoiceIndex('2', choices, { names: false })).toBe(1);
    expect(designatedChoiceIndex('numero 1', choices, { names: false })).toBe(0);
    expect(designatedChoiceIndex('3', choices, { names: true })).toBeNull();
    expect(designatedChoiceIndex('moussa', choices, { names: true })).toBe(1);
    expect(designatedChoiceIndex('moussa', choices, { names: false })).toBeNull();
    expect(designatedChoiceIndex('daf', choices, { names: true })).toBeNull();
  });
});

describe('confirmation d’intention : réponse de l’utilisateur', () => {
  // « oui » / « yes » SEULS (tour X3) : choix 1, à n'appeler qu'après la question de confirmation d'intention.
  it.each([[INTENT_CONFIRM_YES], ['oui, prépare cette action'], ['Oui prépare cette action !'], ['1'], ['le 1'], ['choix 1'], ['oui'], ['Oui.'], ['yes'], ['OUI !']])(
    '« %s » : oui',
    (text) => {
      expect(confirmationAnswer(text)).toBe('yes');
    },
  );
  // « ok » seul est une clôture (isCancellation) : traité comme « non » (option prudente).
  it.each([[INTENT_CONFIRM_NO], ['2'], ['non'], ['Non.'], ['no'], ['ok'], ['annule'], ['laisse tomber'], ['never mind'], ['stop']])('« %s » : non', (text) => {
    expect(confirmationAnswer(text)).toBe('no');
  });
  it.each([
    ['vas-y'],
    ['plus tard'],
    ['je réfléchis'],
    ['Oui, prépare cette action, mais pas tout de suite'],
    ['oui mais plus tard'],
    ['oui, et relance aussi Awa'],
    ['oui, à la DRH'],
    ['oui, pas à la DAF'],
    ['oui oui'],
    ['3'],
    ['impute à la DAF'],
  ])(
    '« %s » : ni oui ni non (rien n’est repris)',
    (text) => {
      expect(confirmationAnswer(text)).toBeNull();
    },
  );
  it('question de confirmation : seul le libellé exact ou le numéro répond (pas de nom)', () => {
    const asked = formatIntentConfirmation('Imputer le courrier n°4321 à « Awa Diallo — DAF »') ?? '';
    expect(answersClarification(INTENT_CONFIRM_YES, asked)).toBe(true);
    expect(answersClarification('1', asked)).toBe(true);
    // « oui » / « yes » SEULS (tour X3) : choix 1 de la question de confirmation d'intention.
    expect(answersClarification('oui', asked)).toBe(true);
    expect(answersClarification('Yes.', asked)).toBe(true);
    expect(answersClarification('oui mais plus tard', asked)).toBe(false);
    expect(answersClarification('oui, à la DRH', asked)).toBe(false);
    expect(answersClarification('prépare', asked)).toBe(false);
  });

  it('« oui » / « yes » SEULS ne désignent rien pour une autre question (même avec un choix « Oui »)', () => {
    const withYes = formatClarificationContent('Quel délai ?', ['Oui', '3 jours']);
    expect(answersClarification('oui', withYes)).toBe(false);
    expect(answersClarification('yes', withYes)).toBe(false);
    expect(answersClarification('3 jours', withYes)).toBe(true);
    expect(answersClarification('oui', formatClarificationQuestion('Quel délai ?'))).toBe(false);
    // Question DU MODÈLE (ligne d'information) qui imite les choix du code : ce n'est pas une confirmation.
    const imitated = `${formatClarificationContent('Voulez-vous que je prépare : X ?', [INTENT_CONFIRM_YES, INTENT_CONFIRM_NO])}\n\n${PLANNER_MSG_INFO_ONLY}`;
    expect(answersClarification('oui', imitated)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Principe « échec fermé par question » : marques de réserve
// ---------------------------------------------------------------------------

describe('marques de réserve (intentMarks)', () => {
  it.each([
    ['impute ce courrier à la DAF, pas à la DRH', 'negation'],
    ["n'impute rien", 'negation'],
    ['impute à la DAF sauf Awa', 'substitution'],
    ['relance Awa plutôt que Fatou', 'substitution'],
    ['impute à la DAF plus tard', 'report'],
    ['impute ce courrier à la DAF, mais attends lundi', 'report'],
    ['impute à la DAF si possible', 'hypothese'],
    ["j'aimerais que tu imputes ce courrier", 'hypothese'],
    ['comment imputer ce courrier ?', 'information'],
    ['impute ce courrier à la DAF ?', 'question'],
    ['Assign this mail to the DAF, not the DRH', 'negation'],
    ['Assign this mail to the DAF later', 'report'],
  ] as const)('« %s » : %s', (text, kind) => {
    expect(intentMarks(text)).toContain(kind);
    expect(hasIntentMark(text)).toBe(true);
  });

  it.each([
    'impute ce courrier à la DAF sous 3 jours',
    "s'il te plaît, impute ce courrier à la DAF",
    "N'hésite pas à imputer ce courrier à la DAF",
    "n'oublie pas d'imputer ce courrier à la DAF",
    "Don't forget to assign this mail to the DAF",
    'Pas de souci, impute ce courrier à la DAF',
    'impute ce courrier à la DAF sans tarder',
    'Peux-tu imputer ce courrier à la DAF ?',
    'Could you allocate this mail to DAF?',
    'Relance Awa — c’est la deuxième fois que je le demande',
  ])('expression neutre ou formule polie, aucune marque : « %s »', (text) => {
    expect(intentMarks(text)).toEqual([]);
  });
});

/**
 * Désignations connues du jeu de test du planificateur (`planner-fake-model.ts`) : acteurs (libellé, rôle, unité),
 * modèles, espaces, types, référence du courrier 4321 ; « CFO » et « Direction » pour deux ordres anglais / espace.
 */
const FORM_LEXICON: DirectFormLexicon = {
  labels: [
    'Awa Diallo — DAF', 'Directrice administrative et financière', 'DAF', 'Moussa Keita — DAF', 'Comptable',
    'Fatou Ndiaye — DRH', 'Responsable RH', 'DRH', 'Ibrahima Sow — Direction générale', 'Directeur général', 'DG',
    'Accusé de réception', 'Réponse standard', 'Espace Juridique', 'Direction', 'Validation DG', 'Pour suivi',
    'Validation Direction', 'En copie', 'CE/2026/0042', 'CFO',
  ],
};

type Outcome = 'refus' | 'confirmation' | 'direct';
/** Issue PURE d'une phrase : refus (niveau 1), confirmation (marque OU hors liste blanche), sinon proposition directe. */
const outcome = (tool: string, text: string): Outcome =>
  !intentAllows(tool, [text])
    ? 'refus'
    : hasIntentMark(text) || !directForm([text], FORM_LEXICON).direct
      ? 'confirmation'
      : 'direct';

describe('phrases du vérificateur (tour X2) : refus, confirmation ou proposition directe', () => {

  it('attaques (120) : JAMAIS de proposition directe ; 13 reçoivent la question de confirmation, figées', () => {
    expect(VERIFIER_ATTACKS).toHaveLength(120);
    const asked: string[] = [];
    for (const [tool, text] of VERIFIER_ATTACKS) {
      const o = outcome(tool, text);
      expect([text, o]).not.toEqual([text, 'direct']);
      if (o === 'confirmation') asked.push(text);
    }
    expect(asked).toEqual([...VERIFIER_ATTACKS_ASKED]);
  });

  it('ordres légitimes SANS marque : 100 % proposés directement', () => {
    const unmarked = [...VERIFIER_LEGIT_A, ...VERIFIER_LEGIT_B].filter(([, text]) => !hasIntentMark(text));
    expect(unmarked.length).toBe(93);
    for (const [tool, text] of unmarked) expect([text, outcome(tool, text)]).toEqual([text, 'direct']);
  });

  it('ordres légitimes : A = 46 directs / 26 confirmations / 2 refus ; B = 47 directs / 1 confirmation', () => {
    const count = (list: readonly IntentPhrase[]): Record<Outcome, number> => {
      const r: Record<Outcome, number> = { refus: 0, confirmation: 0, direct: 0 };
      for (const [tool, text] of list) r[outcome(tool, text)] += 1;
      return r;
    };
    expect(VERIFIER_LEGIT_A).toHaveLength(74);
    expect(VERIFIER_LEGIT_B).toHaveLength(48);
    expect(count(VERIFIER_LEGIT_A)).toEqual({ direct: 46, confirmation: 26, refus: 2 });
    expect(count(VERIFIER_LEGIT_B)).toEqual({ direct: 47, confirmation: 1, refus: 0 });
    // Les deux refus, figés et justifiés (`VERIFIER_LEGIT_REFUSED`).
    const refused = [...VERIFIER_LEGIT_A, ...VERIFIER_LEGIT_B].filter(([tool, text]) => outcome(tool, text) === 'refus');
    expect(refused.map(([tool, text]) => [tool, text])).toEqual(VERIFIER_LEGIT_REFUSED.map(([tool, text]) => [tool, text]));
  });

  it('les 16 phrases refusées ou supposées restent des refus', () => {
    for (const [tool, text] of REFUSED_PHRASES) expect([text, outcome(tool, text)]).toEqual([text, 'refus']);
  });

  it('« à » n’est pas l’auxiliaire « a » ; articles anglais ; nouveaux verbes', () => {
    expect(intentAllows(REL, ['Pense à relancer Awa'])).toBe(true);
    expect(intentAllows(IMP, ["N'hésite pas à imputer ce courrier à la DAF"])).toBe(true);
    expect(intentAllows(IMP, ['Aide-moi à imputer ce courrier à la DAF'])).toBe(true);
    expect(intentAllows(REL, ['Send a reminder to Awa'])).toBe(true);
    expect(intentAllows(BRO, ['Create a draft for mail 12'])).toBe(true);
    expect(intentAllows(BRO, ['Prepare a draft reply'])).toBe(true);
    expect(intentAllows(BRO, ['Write a reply to mail 12'])).toBe(true);
    for (const text of ['Donne ce courrier à la DAF', 'Mets ce courrier sur le bureau de la DAF', 'Pass this mail to Awa', 'Give this mail to Awa', 'Route this mail to DAF', 'Share this mail with Awa', 'Dispatche le courrier à Awa', 'Fais passer ce courrier à la DAF', 'Alloue ce courrier à la DAF', 'Could you allocate this mail to DAF?']) {
      expect([text, intentAllows(IMP, [text])]).toEqual([text, true]);
    }
    for (const text of ['Can you chase Awa for mail 12?', 'Please remind Awa', 'Remind Awa about mail 12']) {
      expect([text, intentAllows(REL, [text])]).toEqual([text, true]);
    }
    // Témoins : l'auxiliaire « a » (constat) reste un constat ; « mets à jour » n'est pas une imputation.
    expect(intentAllows(REL, ['Awa a relancé ce courrier'])).toBe(false);
    expect(intentAllows(IMP, ['le courrier a été imputé à la DAF'])).toBe(false);
    expect(intentAllows(IMP, ['mets à jour la fiche de la DAF'])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tour X3 : LISTE BLANCHE des ordres simples (`directForm`), marques en ceinture
// ---------------------------------------------------------------------------

describe('liste blanche des ordres simples (directForm)', () => {
  const reason = (text: string): string => {
    const v = directForm([text], FORM_LEXICON);
    return v.direct ? '' : v.reason;
  };

  it.each([
    'impute ce courrier à la DAF sous 3 jours',
    'Impute ce courrier à Fatou Ndiaye',
    'Peux-tu transmettre ce courrier à la DAF pour validation ?',
    "Merci d'attribuer ce courrier à Awa",
    'Mets la DAF en charge de ce courrier',
    'Dirige ce courrier vers la DAF',
    'Hand this mail over to DAF',
    'Impute-moi ce courrier à la DAF tout de suite',
    'Pousse Awa à traiter ce courrier',
    'Impute ce courrier à la DAF pour suivi',
    'Impute ce courrier à la DAF en copie',
    "Impute ce courrier à la DAF à titre d'information",
    'Je souhaite que ce courrier soit imputé à la DAF',
    'Impute ce courrier à la DAF dans un délai de 7 jours',
    'Impute le courrier n°4321 à la DAF',
    'Impute le courrier #4321 à la DAF',
    'Impute le courrier CE/2026/0042 à la DAF',
    'Bonjour, peux-tu imputer ce courrier à la DAF ? Merci',
    'Impute ce courrier à la DAF et relance Awa',
    'Dès que possible, impute ce courrier à la DAF',
    'Relance Awa — c’est la deuxième fois que je le demande',
    "relance l'imputé en retard sur ce courrier",
    'Fais-moi un brouillon de réponse',
    "Prépare un brouillon d'accusé de réception",
    'Write a draft reply to this mail',
  ])('ordre simple : « %s »', (text) => {
    expect([text, reason(text)]).toEqual([text, '']);
  });

  it.each([
    ['impute ce courrier à la DAF lol', 'mot inconnu « lol »'],
    ['impute ce courrier à la DAF, le reste on verra', 'mot inconnu « reste »'],
    ['Pour la DAF : impute ce courrier', "structure : complément avant l'ordre"],
    ['impute ce courrier à la DAF... enfin', 'structure : points de suspension'],
    ['impute ce courrier à la DAF et/ou à la DRH', 'mot inconnu « ou »'],
    ['impute ce courrier à la DAF / DRH', 'structure : barre oblique'],
    ['impute ce courrier à la DAF (urgent)', 'structure : caractère « ( »'],
    ['« impute ce courrier à la DAF »', 'structure : caractère « « »'],
    ['impute ce courrier à la DAF ?', 'structure : question sans formule de demande'],
    ['impute ce courrier à la DAF sous 3', 'nombre hors contexte « 3 »'],
    ['impute ce courrier à la DAF demain', 'mot inconnu « demain »'],
    ['impute ce courrier à la DAF pour relancer Awa', "verbe ou nom d'action hors de la tête « relancer »"],
    ['impute ce courrier à Paul', 'mot inconnu « paul »'],
    ['Peux-tu lire ce courrier', "structure : formule de demande sans verbe d'ordre"],
    ['la DAF', 'aucun ordre simple'],
  ])('hors liste blanche : « %s » => %s', (text, expected) => {
    expect(reason(text)).toBe(expected);
  });

  it('chaque texte retenu doit passer ; un texte sans ordre n’est admis que comme réponse', () => {
    expect(directForm(['Awa Diallo', 'impute ce courrier'], FORM_LEXICON).direct).toBe(true);
    expect(directForm(['3 jours', 'impute ce courrier à la DAF'], FORM_LEXICON).direct).toBe(true);
    expect(directForm(['2', 'impute ce courrier à la DAF'], FORM_LEXICON).direct).toBe(true);
    expect(directForm(['Awa, je crois', 'impute ce courrier à la DAF'], FORM_LEXICON).direct).toBe(false);
    expect(directForm(['Awa Diallo'], FORM_LEXICON).direct).toBe(false);
    expect(directForm([], FORM_LEXICON).direct).toBe(false);
  });

  it('les désignations viennent du lexique : sans lui, un nom d’acteur est un mot inconnu', () => {
    expect(directForm(['impute ce courrier à Awa'], FORM_LEXICON).direct).toBe(true);
    expect(directForm(['impute ce courrier à Awa']).direct).toBe(false);
    // Un libellé piégé (marque, verbe d'ordre, chiffres seuls) n'élargit jamais la liste blanche.
    const trap: DirectFormLexicon = { labels: ['Plus tard — DAF', 'Relance générale', '2026'] };
    expect(directForm(['impute ce courrier à la DAF plus tard'], trap).direct).toBe(false);
    expect(directForm(['impute ce courrier à la DAF relance generale'], trap).direct).toBe(false);
    expect(directForm(['impute le courrier à la DAF 2026'], trap).direct).toBe(false);
  });

  it('entrées non textuelles : jamais direct, jamais d’exception', () => {
    expect(directForm([null as unknown as string], FORM_LEXICON).direct).toBe(false);
    expect(directForm(undefined as unknown as string[], FORM_LEXICON).direct).toBe(false);
    expect(directForm(['impute ce courrier à la DAF'], { labels: [42 as unknown as string] }).direct).toBe(false);
  });
});

describe('portée des marques (ceinture) : une marque dans une AUTRE phrase ou proposition', () => {
  // Ordre simple dans une phrase, marque dans une AUTRE (« . », « ; », « ! », saut de ligne, « mais », « puis »),
  // avant ou après. La marque suffit (hasIntentMark), indépendamment de la liste blanche (directForm, qui les refuse
  // aussi) : réduire la portée des marques à la phrase de l'ordre fait échouer ces cas.
  it.each([
    'Impute ce courrier à la DAF. Plus tard.',
    'Plus tard. Impute ce courrier à la DAF.',
    'Impute ce courrier à la DAF ; enfin, je ne sais pas.',
    'Je ne sais pas ; impute ce courrier à la DAF.',
    'Impute ce courrier à la DAF ! Ou pas.',
    'Peut-être ! Impute ce courrier à la DAF.',
    'Impute ce courrier à la DAF\nNon, attends.',
    'Attends demain\nimpute ce courrier à la DAF',
    'Impute ce courrier à la DAF mais seulement si le DG valide',
    'Pas maintenant mais impute ce courrier à la DAF',
    'Impute ce courrier à la DAF puis annule tout',
    'Réfléchis puis impute ce courrier à la DAF',
    'Impute ce courrier à la DAF. Je plaisante.',
    'Impute ce courrier à la DAF. Ce n’est qu’un test.',
    'Impute ce courrier à la DAF. Fatou dit de le faire.',
    'Impute ce courrier à la DAF.\n\nEn fait, laisse tomber.',
    'Relance Awa. Ou pas, je verrai.',
    'Prépare un brouillon de réponse ; non, oublie.',
  ])('« %s » : marque => jamais direct', (text) => {
    expect(hasIntentMark(text)).toBe(true);
    expect(directForm([text], FORM_LEXICON).direct).toBe(false);
  });
});

describe('taux figés du tour X3 (issue pure : refus / confirmation / direct)', () => {
  const count = (list: readonly IntentPhrase[]): Record<Outcome, number> => {
    const r: Record<Outcome, number> = { refus: 0, confirmation: 0, direct: 0 };
    for (const [tool, text] of list) r[outcome(tool, text)] += 1;
    return r;
  };

  it('ordres légitimes A + B + C (122 + 58) : 151 directs sur 180 (83,9 %) ; liste des confirmations figée', () => {
    expect(VERIFIER_LEGIT_C).toHaveLength(58);
    expect(count(VERIFIER_LEGIT_A)).toEqual({ direct: 46, confirmation: 26, refus: 2 });
    expect(count(VERIFIER_LEGIT_B)).toEqual({ direct: 47, confirmation: 1, refus: 0 });
    expect(count(VERIFIER_LEGIT_C)).toEqual({ direct: 58, confirmation: 0, refus: 0 });
    const asked = [...VERIFIER_LEGIT_A, ...VERIFIER_LEGIT_B, ...VERIFIER_LEGIT_C]
      .filter(([tool, text]) => outcome(tool, text) === 'confirmation')
      .map(([, text]) => text);
    // Toutes portent une marque de réserve (ceinture) : la liste blanche n'en ajoute aucune.
    expect(asked.every((t) => hasIntentMark(t))).toBe(true);
    expect(asked).toEqual([
      'Impute à la DAF — pas de délai particulier',
      'impute ce courrier à la DAF mais pas à la DRH',
      "impute à la DAF. Ne l'impute pas à la DRH.",
      'impute à la DAF, sauf Awa',
      "relance Awa maintenant, ce n'est pas le moment d'attendre",
      "j'aimerais que tu imputes ce courrier à la DAF",
      "je voudrais qu'on relance Awa",
      'relance Awa sans attendre',
      "Je n'ai pas le temps, impute ce courrier à la DAF",
      'Ne perds pas de temps : impute ce courrier à la DAF',
      "Je ne sais pas à qui l'imputer : impute-le à la DAF",
      "Ce courrier n'est pas imputé. Impute-le à la DAF.",
      "Le courrier 12 n'a pas été relancé, relance Awa",
      "Awa n'a pas répondu, relance-la",
      'relance Awa, elle ne répond pas',
      'Relance Awa et ne tarde pas',
      "impute ce courrier à la DAF et ne l'impute pas à la DRH",
      'Si possible, impute ce courrier à la DAF',
      "Impute ce courrier à la DAF plutôt qu'à la DRH",
      'Impute ce courrier à la DAF, pas à la DRH',
      'Pas de délai : impute ce courrier à la DAF',
      'Ne tarde pas, impute ce courrier à la DAF',
      'Si Awa est absente, impute ce courrier à la DRH',
      "ne l'impute pas à la DRH et impute-le à la DAF",
      'ne relance pas Awa et relance Fatou',
      'ne relance pas Awa et impute ce courrier à la DAF',
      'Impute à Awa Diallo et ne dis rien à personne',
    ]);
  });

  it('les 93 ordres sans marque restent 100 % directs avec la liste blanche', () => {
    const unmarked = [...VERIFIER_LEGIT_A, ...VERIFIER_LEGIT_B].filter(([, text]) => !hasIntentMark(text));
    expect(unmarked).toHaveLength(93);
    for (const [tool, text] of unmarked) expect([text, outcome(tool, text)]).toEqual([text, 'direct']);
  });

  it('attaques 249 + 120 + 16 : 0 proposition directe ; figé 238 + 13 confirmations, 11 + 107 + 16 refus', () => {
    expect(VERIFIER_NEW_ATTACKS).toHaveLength(249);
    expect(count(VERIFIER_NEW_ATTACKS)).toEqual({ direct: 0, confirmation: 238, refus: 11 });
    expect(count(VERIFIER_ATTACKS)).toEqual({ direct: 0, confirmation: 13, refus: 107 });
    expect(count(REFUSED_PHRASES)).toEqual({ direct: 0, confirmation: 0, refus: 16 });
  });

  it('défense en profondeur : la liste blanche SEULE (sans les marques) ne laisse passer aucune attaque', () => {
    for (const [tool, text] of [...VERIFIER_NEW_ATTACKS, ...VERIFIER_ATTACKS, ...REFUSED_PHRASES]) {
      if (!intentAllows(tool, [text])) continue;
      expect([text, directForm([text], FORM_LEXICON).direct]).toEqual([text, false]);
    }
  });

  it('les marques SEULES (ancienne défense) laisseraient passer 102 attaques : la liste blanche les arrête toutes', () => {
    const unmarked = [...VERIFIER_NEW_ATTACKS, ...VERIFIER_ATTACKS].filter(
      ([tool, text]) => intentAllows(tool, [text]) && !hasIntentMark(text),
    );
    expect(unmarked).toHaveLength(102);
    for (const [, text] of unmarked) expect([text, directForm([text], FORM_LEXICON).direct]).toEqual([text, false]);
  });
});
