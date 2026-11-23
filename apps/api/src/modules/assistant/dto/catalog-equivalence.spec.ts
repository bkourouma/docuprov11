import 'reflect-metadata';
import type { ZodTypeAny } from 'zod';
import { asstBrouillonArgsSchema, asstImputationArgsSchema, asstRelanceArgsSchema } from '@archivage/types';
import {
  brouillonReponseArgsSchema,
  imputationCourrierArgsSchema,
  relanceArgsSchema,
} from '../../workflow-agent-catalog/catalog.contracts';

// Les schémas de l'assistant (packages/types) reproduisent ceux du catalogue d'agents : ils doivent rendre
// EXACTEMENT le même verdict, et la même sortie parsée pour les entrées valides.

const rep = (c: string, n: number) => c.repeat(n);
const recipient = { userGroupId: 3, mailInputationTypeId: 10 };
const imputation = { mailId: 1, recipients: [recipient], rationale: 'Motif.' };
const relance = { mailId: 1, mailInputationId: 2, recipientUserGroupId: 3, message: 'Merci de traiter.' };
const brouillon = { templateId: 'reponse-simple', label: 'Réponse', draftHtml: '<p>Bonjour</p>' };
const INT_MAX = 2_147_483_647;

const without = (o: Record<string, unknown>, k: string) => {
  const { [k]: _omit, ...rest } = o;
  return rest;
};

const imputationCorpus: [string, unknown][] = [
  ['minimal valide', imputation],
  ['entiers aux bornes max', { ...imputation, mailId: INT_MAX, recipients: [{ ...recipient, userGroupId: INT_MAX, mailInputationTypeId: INT_MAX }] }],
  ['mailId juste au-dessus du max', { ...imputation, mailId: INT_MAX + 1 }],
  ['mailId zéro', { ...imputation, mailId: 0 }],
  ['mailId négatif', { ...imputation, mailId: -1 }],
  ['mailId décimal', { ...imputation, mailId: 1.5 }],
  ['mailId chaîne', { ...imputation, mailId: '1' }],
  ['mailId absent', without(imputation, 'mailId')],
  ['5 destinataires', { ...imputation, recipients: Array(5).fill(recipient) }],
  ['6 destinataires', { ...imputation, recipients: Array(6).fill(recipient) }],
  ['aucun destinataire', { ...imputation, recipients: [] }],
  ['destinataires non tableau', { ...imputation, recipients: recipient }],
  ['destinataire avec champ inconnu', { ...imputation, recipients: [{ ...recipient, extra: 1 }] }],
  ['destinataire sans type', { ...imputation, recipients: [{ userGroupId: 3 }] }],
  ['délai 1', { ...imputation, recipients: [{ ...recipient, delayDays: 1 }] }],
  ['délai 90', { ...imputation, recipients: [{ ...recipient, delayDays: 90 }] }],
  ['délai 0', { ...imputation, recipients: [{ ...recipient, delayDays: 0 }] }],
  ['délai 91', { ...imputation, recipients: [{ ...recipient, delayDays: 91 }] }],
  ['délai décimal', { ...imputation, recipients: [{ ...recipient, delayDays: 2.5 }] }],
  ['instructions 1000', { ...imputation, recipients: [{ ...recipient, instructions: rep('i', 1000) }] }],
  ['instructions 1001', { ...imputation, recipients: [{ ...recipient, instructions: rep('i', 1001) }] }],
  ['instructions à espaces', { ...imputation, recipients: [{ ...recipient, instructions: '   ' }] }],
  ['instructions entourées d’espaces', { ...imputation, recipients: [{ ...recipient, instructions: '  Urgent  ' }] }],
  ['instructions 1000 + espaces autour', { ...imputation, recipients: [{ ...recipient, instructions: ` ${rep('i', 1000)} ` }] }],
  ['motif 500', { ...imputation, rationale: rep('m', 500) }],
  ['motif 501', { ...imputation, rationale: rep('m', 501) }],
  ['motif vide', { ...imputation, rationale: '' }],
  ['motif espaces', { ...imputation, rationale: '    ' }],
  ['motif entouré d’espaces', { ...imputation, rationale: '  Motif  ' }],
  ['motif absent', without(imputation, 'rationale')],
  ['champ inconnu à la racine', { ...imputation, extra: true }],
  ['null', null],
  ['tableau', []],
  ['chaîne', 'x'],
  ['objet vide', {}],
];

const relanceCorpus: [string, unknown][] = [
  ['minimal valide', relance],
  ['avec escalade', { ...relance, escalateToUserGroupId: 9 }],
  ['escalade zéro', { ...relance, escalateToUserGroupId: 0 }],
  ['escalade au max', { ...relance, escalateToUserGroupId: INT_MAX }],
  ['escalade au-dessus du max', { ...relance, escalateToUserGroupId: INT_MAX + 1 }],
  ['message 500', { ...relance, message: rep('m', 500) }],
  ['message 501', { ...relance, message: rep('m', 501) }],
  ['message vide', { ...relance, message: '' }],
  ['message espaces', { ...relance, message: ' \t ' }],
  ['message entouré d’espaces', { ...relance, message: '   Merci   ' }],
  ['message 500 + espaces autour', { ...relance, message: `  ${rep('m', 500)}  ` }],
  ['message non chaîne', { ...relance, message: 12 }],
  ['mailInputationId absent', without(relance, 'mailInputationId')],
  ['mailInputationId négatif', { ...relance, mailInputationId: -2 }],
  ['recipientUserGroupId chaîne', { ...relance, recipientUserGroupId: '3' }],
  ['recipientUserGroupId décimal', { ...relance, recipientUserGroupId: 3.2 }],
  ['champ inconnu', { ...relance, extra: 1 }],
  ['envoi par courriel (champ inconnu)', { ...relance, sendEmail: true }],
  ['undefined', undefined],
  ['objet vide', {}],
];

const brouillonCorpus: [string, unknown][] = [
  ['minimal valide', brouillon],
  ['complet', { ...brouillon, mailId: 5, spaceId: 6, decisionId: '123' }],
  ['templateId 100', { ...brouillon, templateId: rep('t', 100) }],
  ['templateId 101', { ...brouillon, templateId: rep('t', 101) }],
  ['templateId vide', { ...brouillon, templateId: '' }],
  ['templateId espaces seuls (non rogné)', { ...brouillon, templateId: '   ' }],
  ['label 200', { ...brouillon, label: rep('l', 200) }],
  ['label 201', { ...brouillon, label: rep('l', 201) }],
  ['label espaces', { ...brouillon, label: '   ' }],
  ['label entouré d’espaces', { ...brouillon, label: '  Réponse  ' }],
  ['draftHtml 20000', { ...brouillon, draftHtml: rep('h', 20_000) }],
  ['draftHtml 20001', { ...brouillon, draftHtml: rep('h', 20_001) }],
  ['draftHtml vide', { ...brouillon, draftHtml: '' }],
  ['draftHtml espaces (non rogné)', { ...brouillon, draftHtml: '   ' }],
  ['mailId zéro', { ...brouillon, mailId: 0 }],
  ['spaceId au max', { ...brouillon, spaceId: INT_MAX }],
  ['spaceId au-dessus du max', { ...brouillon, spaceId: INT_MAX + 1 }],
  ['decisionId 18 chiffres', { ...brouillon, decisionId: rep('9', 18) }],
  ['decisionId 19 chiffres', { ...brouillon, decisionId: rep('9', 19) }],
  ['decisionId non numérique', { ...brouillon, decisionId: '12a' }],
  ['decisionId numérique (nombre)', { ...brouillon, decisionId: 12 }],
  ['decisionId vide', { ...brouillon, decisionId: '' }],
  ['champ inconnu', { ...brouillon, extra: 1 }],
  ['draftHtml absent', without(brouillon, 'draftHtml')],
  ['null', null],
];

const suites: { name: string; asst: ZodTypeAny; catalog: ZodTypeAny; corpus: [string, unknown][] }[] = [
  { name: 'imputation de courrier', asst: asstImputationArgsSchema, catalog: imputationCourrierArgsSchema, corpus: imputationCorpus },
  { name: 'relance', asst: asstRelanceArgsSchema, catalog: relanceArgsSchema, corpus: relanceCorpus },
  { name: 'brouillon de réponse', asst: asstBrouillonArgsSchema, catalog: brouillonReponseArgsSchema, corpus: brouillonCorpus },
];

describe('équivalence des schémas assistant et catalogue d’agents', () => {
  it('le corpus compte au moins 40 entrées au total', () => {
    expect(suites.reduce((n, s) => n + s.corpus.length, 0)).toBeGreaterThanOrEqual(40);
  });

  for (const { name, asst, catalog, corpus } of suites) {
    describe(name, () => {
      it('chaque suite contient des entrées acceptées ET refusées', () => {
        const verdicts = corpus.map(([, v]) => catalog.safeParse(v).success);
        expect(verdicts).toContain(true);
        expect(verdicts).toContain(false);
      });

      it.each(corpus)('même verdict et même sortie : %s', (_label, input) => {
        const a = asst.safeParse(input);
        const c = catalog.safeParse(input);
        expect(a.success).toBe(c.success);
        if (a.success && c.success) expect(a.data).toEqual(c.data);
      });
    });
  }
});
