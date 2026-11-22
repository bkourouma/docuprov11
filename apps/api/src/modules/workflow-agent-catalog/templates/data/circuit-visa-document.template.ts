import { TEMPLATE_KEYS } from '../../catalog.contracts';
import type { WfStep } from '@archivage/types';
import type { WorkflowTemplate } from '../template.types';

/** Une étape de visa : approuvée, elle passe à la suivante ; refusée, retour à la préparation pour correction. */
function visa(key: string, name: string, description: string, onApproved: string, dueInHours: number): WfStep {
  return {
    key,
    name,
    type: 'validation',
    description,
    assignee: { kind: 'initiator' },
    dueInHours,
    reminderAfterHours: Math.floor(dueInHours / 2),
    next: [
      { to: onApproved, label: 'Approuvé', condition: { field: 'last.approved', op: 'eq', value: true } },
      { to: 'preparation', label: 'Retour à la préparation', condition: { field: 'last.approved', op: 'eq', value: false } },
    ],
  };
}

export const circuitVisaDocumentTemplate: WorkflowTemplate = {
  key: TEMPLATE_KEYS.circuitVisaDocument,
  name: 'Circuit de visa et signature de document',
  description:
    "Circuit sans IA : préparation du document, premier visa, second visa, puis signature. Un refus à n'importe quel visa renvoie le document à la préparation. " +
    "Toutes les étapes sont confiées au lanceur à la création : le concepteur doit affecter chaque visa et la signature à la bonne personne, au bon groupe " +
    "ou au bon rôle avant la publication. Lancement manuel depuis le document concerné.",
  agentKey: null,
  tags: ['document', 'visa', 'signature', 'sans-ia'],
  schemaVersion: 1,
  suggestedTrigger: 'Lancement manuel depuis le document à faire viser.',
  graph: {
    schemaVersion: 1,
    start: 'preparation',
    steps: [
      {
        key: 'preparation',
        name: 'Préparer le document',
        type: 'formulaire',
        description: 'Renseigner la référence et une note de présentation avant de soumettre le document aux visas.',
        assignee: { kind: 'initiator' },
        dueInHours: 72,
        reminderAfterHours: 48,
        config: {
          maxAttempts: 10,
          fields: [
            { key: 'reference', required: true },
            { key: 'note', required: false },
          ],
        },
        next: [{ to: 'visa_1' }],
      },
      visa('visa_1', 'Premier visa', 'Relire le document et apposer le premier visa, ou le refuser avec un commentaire.', 'visa_2', 48),
      visa('visa_2', 'Second visa', 'Relire le document et apposer le second visa, ou le refuser avec un commentaire.', 'signature', 48),
      visa('signature', 'Signature', 'Signer le document, ou le refuser avec un commentaire.', 'cloture', 72),
      {
        key: 'cloture',
        name: 'Clôturer le circuit',
        type: 'formulaire',
        description: 'Confirmer la signature et consigner une observation facultative.',
        assignee: { kind: 'initiator' },
        dueInHours: 72,
        config: { fields: [{ key: 'observation', required: false }] },
        next: [],
      },
    ],
  },
  agentSteps: {},
};
