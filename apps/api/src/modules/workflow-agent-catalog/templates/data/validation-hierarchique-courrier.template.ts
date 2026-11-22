import { TEMPLATE_KEYS } from '../../catalog.contracts';
import type { WorkflowTemplate } from '../template.types';

/**
 * Validation hiérarchique d'un courrier, sans IA. Routage :
 *  - le contrôle du bureau approuvé passe au responsable ; refusé, le courrier est refusé ;
 *  - le responsable approuve (vers la décision finale) ou renvoie au bureau pour correction ;
 *  - la décision finale est manuelle (accepté / refusé) : chaque issue est une étape finale.
 * Les arêtes d'une validation portent toutes une condition, car un refus (`rejectTask`) ne suit jamais l'arête de repli.
 */
export const validationHierarchiqueCourrierTemplate: WorkflowTemplate = {
  key: TEMPLATE_KEYS.validationHierarchiqueCourrier,
  name: 'Validation hiérarchique de courrier',
  description:
    "Circuit sans IA : contrôle par le bureau, validation par le responsable, puis décision finale (accepté ou refusé). " +
    "Le responsable peut renvoyer le courrier au bureau pour correction. Toutes les étapes sont confiées au lanceur à la création : " +
    "le concepteur doit affecter chaque étape à la bonne personne, au bon groupe ou au bon rôle avant la publication. " +
    "Déclencheur conseillé : lancement manuel ou arrivée d'un courrier (mail.arrived).",
  agentKey: null,
  tags: ['courrier', 'validation', 'sans-ia'],
  schemaVersion: 1,
  suggestedTrigger: "Lancement manuel, ou mail.arrived (arrivée d'un courrier) à créer par le concepteur.",
  graph: {
    schemaVersion: 1,
    start: 'controle_bureau',
    steps: [
      {
        key: 'controle_bureau',
        name: 'Contrôle du bureau',
        type: 'validation',
        description: 'Vérifier que le courrier est complet et correctement renseigné, puis approuver ou refuser.',
        assignee: { kind: 'initiator' },
        dueInHours: 48,
        reminderAfterHours: 24,
        next: [
          {
            to: 'validation_responsable',
            label: 'Contrôle approuvé',
            condition: { field: 'last.approved', op: 'eq', value: true },
          },
          {
            to: 'courrier_refuse',
            label: 'Contrôle refusé',
            condition: { field: 'last.approved', op: 'eq', value: false },
          },
        ],
      },
      {
        key: 'validation_responsable',
        name: 'Validation du responsable',
        type: 'validation',
        description: 'Approuver pour passer à la décision finale, ou refuser pour renvoyer le courrier au bureau avec un commentaire.',
        assignee: { kind: 'initiator' },
        dueInHours: 72,
        reminderAfterHours: 48,
        config: { maxAttempts: 5 },
        next: [
          {
            to: 'decision',
            label: 'Validé',
            condition: { field: 'last.approved', op: 'eq', value: true },
          },
          {
            to: 'controle_bureau',
            label: 'Renvoyé au bureau',
            condition: { field: 'last.approved', op: 'eq', value: false },
          },
        ],
      },
      {
        key: 'decision',
        name: 'Décision finale',
        type: 'decision',
        description: 'Prendre la décision finale sur le courrier : accepté ou refusé.',
        assignee: { kind: 'initiator' },
        dueInHours: 72,
        reminderAfterHours: 48,
        config: { manual: true, choices: ['accepté', 'refusé'] },
        next: [
          { to: 'courrier_accepte', label: 'Accepté', condition: { field: 'last.choice', op: 'eq', value: 'accepté' } },
          { to: 'courrier_refuse', label: 'Refusé', condition: { field: 'last.choice', op: 'eq', value: 'refusé' } },
        ],
      },
      {
        key: 'courrier_accepte',
        name: 'Enregistrer l\'acceptation',
        type: 'formulaire',
        description: "Consigner l'acceptation du courrier (observation facultative).",
        assignee: { kind: 'initiator' },
        dueInHours: 72,
        config: { fields: [{ key: 'observation', required: false }] },
        next: [],
      },
      {
        key: 'courrier_refuse',
        name: 'Enregistrer le refus',
        type: 'formulaire',
        description: 'Consigner le motif du refus du courrier.',
        assignee: { kind: 'initiator' },
        dueInHours: 72,
        config: { fields: [{ key: 'motif', required: true }] },
        next: [],
      },
    ],
  },
  agentSteps: {},
};
