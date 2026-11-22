import { TEMPLATE_KEYS } from '../../catalog.contracts';
import type { WorkflowTemplate } from '../template.types';

/**
 * Demande avec vérification par liste de contrôle. La décision est MANUELLE (accord / refus) : les pièces
 * à vérifier sont cochées par la personne, puis la décision est prise en connaissance de cause.
 */
export const demandeAvecChecklistTemplate: WorkflowTemplate = {
  key: TEMPLATE_KEYS.demandeAvecChecklist,
  name: 'Demande avec liste de vérification',
  description:
    "Circuit sans IA : saisie d'une demande, vérification par liste de contrôle, décision (accord ou refus), puis enregistrement de l'issue. " +
    "La liste de vérification fournie est un exemple à adapter. Toutes les étapes sont confiées au lanceur à la création : " +
    "le concepteur doit affecter la vérification et la décision à la bonne personne, au bon groupe ou au bon rôle avant la publication. " +
    "Lancement manuel.",
  agentKey: null,
  tags: ['demande', 'checklist', 'decision', 'sans-ia'],
  schemaVersion: 1,
  suggestedTrigger: 'Lancement manuel.',
  graph: {
    schemaVersion: 1,
    start: 'saisie_demande',
    steps: [
      {
        key: 'saisie_demande',
        name: 'Saisir la demande',
        type: 'formulaire',
        description: "Décrire la demande : objet, demandeur et justification.",
        assignee: { kind: 'initiator' },
        dueInHours: 72,
        reminderAfterHours: 48,
        config: {
          fields: [
            { key: 'objet', required: true },
            { key: 'demandeur', required: true },
            { key: 'justification', required: false },
          ],
        },
        next: [{ to: 'verification' }],
      },
      {
        key: 'verification',
        name: 'Vérifier la demande',
        type: 'checklist',
        description: 'Cocher chaque point vérifié. Les points obligatoires doivent tous être cochés.',
        assignee: { kind: 'initiator' },
        dueInHours: 72,
        reminderAfterHours: 48,
        config: {
          items: [
            { key: 'identite_demandeur', required: true },
            { key: 'pieces_completes', required: true },
            { key: 'conforme_aux_regles', required: true },
            { key: 'budget_disponible', required: false },
          ],
        },
        next: [{ to: 'decision' }],
      },
      {
        key: 'decision',
        name: 'Décider de la demande',
        type: 'decision',
        description: "Décider : accord ou refus de la demande.",
        assignee: { kind: 'initiator' },
        dueInHours: 72,
        reminderAfterHours: 48,
        config: { manual: true, choices: ['accord', 'refus'] },
        next: [
          { to: 'accord', label: 'Accord', condition: { field: 'last.choice', op: 'eq', value: 'accord' } },
          { to: 'refus', label: 'Refus', condition: { field: 'last.choice', op: 'eq', value: 'refus' } },
        ],
      },
      {
        key: 'accord',
        name: "Enregistrer l'accord",
        type: 'formulaire',
        description: "Consigner les modalités de l'accord (observation facultative).",
        assignee: { kind: 'initiator' },
        dueInHours: 72,
        config: { fields: [{ key: 'observation', required: false }] },
        next: [],
      },
      {
        key: 'refus',
        name: 'Enregistrer le refus',
        type: 'formulaire',
        description: 'Consigner le motif du refus.',
        assignee: { kind: 'initiator' },
        dueInHours: 72,
        config: { fields: [{ key: 'motif', required: true }] },
        next: [],
      },
    ],
  },
  agentSteps: {},
};
