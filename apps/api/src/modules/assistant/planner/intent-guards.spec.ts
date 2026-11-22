import { AsstActionTool, AsstMessageRole } from '@archivage/types';
import { MAIL_INPUTATION_TYPE_IDS } from '../../workflow-agent-catalog/catalog.contracts';
import { formatClarificationContent, formatClarificationQuestion } from './clarification-format';
import {
  containsPhrase,
  decideDelay,
  decideInputationType,
  detectTypeMentions,
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
} from './intent-guards';
import { REFUSED_PHRASES } from './planner.injection-corpus';
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
    expect(intentHistory(cancelled, 'DAF Nord')).toEqual(['finalement je ne veux pas']);
    expect(liveUserTexts('DAF Nord', [DAF, 'laisse tomber', 'pour suivi'])).toEqual(['laisse tomber', 'pour suivi']);
    expect(liveUserTexts('stop', [DAF])).toEqual([]);
  });
});
