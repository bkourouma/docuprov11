import type { WfTriggerEventType } from '@archivage/types';
import type { AuthoringModelOutput } from './authoring.contracts';
import type { AuthoringEvalExpectation } from './authoring.eval.check';

export { checkStructure, checkAssumptions } from './authoring.eval.check';
export type { AuthoringEvalExpectation } from './authoring.eval.check';

// Docu-Flow W5 — jeu d'essai d'ÉVALUATION de la qualité de génération (PAS le gate d'autonomie des agents).
// Chaque cas porte la description d'un utilisateur, ce qu'on attend du brouillon, et la réponse JSON simulée d'un
// bon modèle. Les graphes ne contiennent que de l'autonomie « suggere », aucun identifiant d'utilisateur et des
// outils du catalogue ; les destinataires humains sont des `assigneeHint` (champ brut, transformé par les
// garde-fous en marqueur « à compléter »).

export interface AuthoringEvalCase {
  id: string;
  titre: string;
  description: string;
  triggerHint?: WfTriggerEventType;
  attendu: AuthoringEvalExpectation;
  /** Réponse simulée d'un bon modèle, au format brut de `AuthoringModelOutput` (avant garde-fous). */
  modelOutput: AuthoringModelOutput;
}

type Json = Record<string, unknown>;

const accepted = { field: 'last.approved', op: 'eq', value: true };

/** Arêtes d'une validation : accepté vers `ok`, tout autre cas vers `ko`. */
function approvalEdges(ok: string, ko: string): Json[] {
  return [
    { to: ok, label: 'Accepté', condition: accepted },
    { to: ko, label: 'Refusé', isDefault: true },
  ];
}

const FIGURE_SUFFIX = '— à vérifier avant publication.';

export const AUTHORING_EVAL_CASES: readonly AuthoringEvalCase[] = [
  // 1) Facture fournisseur --------------------------------------------------------------------------------------
  {
    id: 'facture-fournisseur',
    titre: 'Traitement d’une facture fournisseur',
    description:
      "Quand une facture fournisseur arrive, extraire le montant et le fournisseur, vérifier qu'il existe un bon de commande correspondant, puis router vers le DAF si le montant est au-dessus de 5 M FCFA. En dessous, le chef de service valide. Après validation, transmettre à la comptabilité pour paiement.",
    attendu: {
      minSteps: 6,
      maxSteps: 9,
      stepTypes: ['agent', 'decision', 'validation'],
      agentToolsAllowed: ['lire_document', 'rechercher_documents'],
      needsDecision: true,
      needsApproval: true,
      humanSteps: ['DAF', 'Chef de service'],
      triggerEvent: 'document.deposited',
      assumptionsMention: ['5 000 000'],
    },
    modelOutput: {
      name: 'Traitement des factures fournisseurs',
      description: 'Extraction du montant, vérification du bon de commande et validation selon le montant.',
      graph: {
        schemaVersion: 1,
        start: 'extraction',
        steps: [
          {
            key: 'extraction',
            name: 'Extraire le montant et le fournisseur',
            type: 'agent',
            agent: {
              objective: 'Extraire le montant, le fournisseur et la date de la facture à partir du document.',
              tools: ['lire_document'],
              autonomy: 'suggere',
            },
            next: [{ to: 'verification_bc' }],
          },
          {
            key: 'verification_bc',
            name: 'Vérifier le bon de commande',
            type: 'agent',
            agent: {
              objective: 'Rechercher le bon de commande correspondant et comparer les montants.',
              tools: ['rechercher_documents', 'lire_document'],
              autonomy: 'suggere',
            },
            next: [{ to: 'seuil_montant' }],
          },
          {
            key: 'seuil_montant',
            name: 'Montant au-dessus du seuil ?',
            type: 'decision',
            next: [
              {
                to: 'validation_daf',
                label: 'Au-dessus de 5 M FCFA',
                condition: { field: 'steps.extraction.montant', op: 'gt', value: 5000000 },
              },
              { to: 'validation_chef', label: 'Sinon', isDefault: true },
            ],
          },
          {
            key: 'validation_daf',
            name: 'Validation du DAF',
            type: 'validation',
            assigneeHint: 'DAF',
            dueInHours: 48,
            next: approvalEdges('transmission_paiement', 'rejet'),
          },
          {
            key: 'validation_chef',
            name: 'Validation du chef de service',
            type: 'validation',
            assigneeHint: 'Chef de service',
            dueInHours: 48,
            next: approvalEdges('transmission_paiement', 'rejet'),
          },
          {
            key: 'transmission_paiement',
            name: 'Transmettre à la comptabilité pour paiement',
            type: 'affectation',
            assigneeHint: 'Comptabilité',
            next: [],
          },
          { key: 'rejet', name: 'Notifier le rejet au fournisseur', type: 'formulaire', next: [] },
        ],
      },
      assumptions: [
        `Seuil lu dans la description : « 5 M FCFA » soit 5 000 000 FCFA ${FIGURE_SUFFIX}`,
        'Les montants inférieurs ou égaux au seuil sont validés par le chef de service.',
      ],
      trigger: {
        eventType: 'document.deposited',
        conditions: {},
        reason: "La description évoque l'arrivée d'une facture, c'est-à-dire le dépôt d'un document.",
      },
    },
  },

  // 2) Demande de congé -----------------------------------------------------------------------------------------
  {
    id: 'demande-conge',
    titre: 'Demande de congé',
    description:
      "Un agent fait une demande de congé en indiquant les dates et le motif. Son chef de service donne un avis, puis les RH valident et mettent à jour le solde de congés. En cas de refus, l'agent est informé.",
    attendu: {
      minSteps: 5,
      maxSteps: 7,
      stepTypes: ['formulaire', 'validation', 'checklist'],
      agentToolsAllowed: [],
      needsDecision: false,
      needsApproval: true,
      humanSteps: ['Chef de service', 'RH'],
      triggerEvent: null,
      assumptionsMention: [],
    },
    modelOutput: {
      name: 'Demande de congé',
      description: "Circuit de validation d'une demande de congé : chef de service puis RH.",
      graph: {
        schemaVersion: 1,
        start: 'demande',
        steps: [
          {
            key: 'demande',
            name: 'Saisir la demande de congé',
            type: 'formulaire',
            config: {
              fields: [
                { key: 'date_debut', required: true },
                { key: 'date_fin', required: true },
                { key: 'motif' },
              ],
            },
            next: [{ to: 'avis_chef' }],
          },
          {
            key: 'avis_chef',
            name: 'Avis du chef de service',
            type: 'validation',
            assigneeHint: 'Chef de service',
            dueInHours: 72,
            next: approvalEdges('validation_rh', 'notification_refus'),
          },
          {
            key: 'validation_rh',
            name: 'Validation des RH',
            type: 'validation',
            assigneeHint: 'RH',
            next: approvalEdges('mise_a_jour_solde', 'notification_refus'),
          },
          {
            key: 'mise_a_jour_solde',
            name: 'Mettre à jour le solde de congés',
            type: 'checklist',
            config: { items: [{ key: 'solde_mis_a_jour', required: true }] },
            next: [],
          },
          { key: 'notification_refus', name: "Informer l'agent du refus", type: 'formulaire', next: [] },
        ],
      },
      assumptions: ["Le refus du chef de service ou des RH informe directement l'agent."],
      trigger: null,
    },
  },

  // 3) Courrier arrivé + accusé de réception sous 48 h ----------------------------------------------------------
  {
    id: 'courrier-accuse-reception',
    titre: 'Courrier arrivé avec accusé de réception',
    description:
      "Quand un courrier arrive, le lire et résumer son objet, puis envoyer un accusé de réception sous 48 heures. Le secrétariat rédige l'accusé de réception.",
    triggerHint: 'mail.arrived',
    attendu: {
      minSteps: 3,
      maxSteps: 5,
      stepTypes: ['agent', 'generation', 'checklist'],
      agentToolsAllowed: ['lire_courrier'],
      needsDecision: false,
      needsApproval: false,
      humanSteps: ['Secrétariat'],
      triggerEvent: 'mail.arrived',
      assumptionsMention: ['48 heures'],
    },
    modelOutput: {
      name: 'Accusé de réception de courrier',
      description: "Lecture du courrier arrivé et envoi d'un accusé de réception sous 48 heures.",
      graph: {
        schemaVersion: 1,
        start: 'lecture_courrier',
        steps: [
          {
            key: 'lecture_courrier',
            name: 'Lire et résumer le courrier',
            type: 'agent',
            agent: {
              objective: "Lire le courrier arrivé et résumer son objet en deux phrases.",
              tools: ['lire_courrier'],
              autonomy: 'suggere',
            },
            next: [{ to: 'redaction_accuse' }],
          },
          {
            key: 'redaction_accuse',
            name: "Rédiger l'accusé de réception",
            type: 'generation',
            assigneeHint: 'Secrétariat',
            dueInHours: 48,
            reminderAfterHours: 24,
            next: [{ to: 'envoi_accuse' }],
          },
          {
            key: 'envoi_accuse',
            name: "Envoyer l'accusé et classer",
            type: 'checklist',
            assigneeHint: 'Secrétariat',
            config: { items: [{ key: 'accuse_envoye', required: true }, { key: 'courrier_classe' }] },
            next: [],
          },
        ],
      },
      assumptions: [`Délai lu dans la description : « 48 heures » ${FIGURE_SUFFIX}`],
      trigger: {
        eventType: 'mail.arrived',
        conditions: {},
        reason: "La description évoque l'arrivée d'un courrier.",
      },
    },
  },

  // 4) Dossier d'agrément ---------------------------------------------------------------------------------------
  {
    id: 'dossier-agrement',
    titre: 'Instruction d’un dossier d’agrément',
    description:
      "Pour un dossier d'agrément : le demandeur dépose les pièces, l'agent coche la liste des pièces obligatoires, le service instructeur instruit le dossier, la commission rend un avis, puis le directeur décide d'accorder ou de refuser l'agrément.",
    attendu: {
      minSteps: 6,
      maxSteps: 8,
      stepTypes: ['checklist', 'formulaire', 'validation', 'decision'],
      agentToolsAllowed: [],
      needsDecision: true,
      needsApproval: true,
      humanSteps: ['Service instructeur', 'Commission', 'Directeur'],
      triggerEvent: null,
      assumptionsMention: [],
    },
    modelOutput: {
      name: "Instruction d'un dossier d'agrément",
      description: "Contrôle des pièces, instruction, avis de la commission et décision du directeur.",
      graph: {
        schemaVersion: 1,
        start: 'pieces',
        steps: [
          {
            key: 'pieces',
            name: 'Cocher les pièces obligatoires',
            type: 'checklist',
            config: {
              items: [
                { key: 'formulaire_demande', required: true },
                { key: 'piece_identite', required: true },
                { key: 'statuts', required: true },
                { key: 'justificatif_domicile' },
              ],
            },
            next: [{ to: 'instruction' }],
          },
          {
            key: 'instruction',
            name: 'Instruire le dossier',
            type: 'formulaire',
            assigneeHint: 'Service instructeur',
            dueInHours: 240,
            config: { fields: [{ key: 'rapport_instruction', required: true }] },
            next: [{ to: 'avis_commission' }],
          },
          {
            key: 'avis_commission',
            name: 'Avis de la commission',
            type: 'validation',
            assigneeHint: 'Commission',
            next: [{ to: 'decision_directeur' }],
          },
          {
            key: 'decision_directeur',
            name: "Décision du directeur",
            type: 'decision',
            assigneeHint: 'Directeur',
            config: { manual: true, choices: ['Agrément accordé', 'Agrément refusé'] },
            next: [
              {
                to: 'notification_accord',
                label: 'Agrément accordé',
                condition: { field: 'last.choice', op: 'eq', value: 'Agrément accordé' },
              },
              { to: 'notification_refus', label: 'Agrément refusé', isDefault: true },
            ],
          },
          { key: 'notification_accord', name: "Notifier l'accord d'agrément", type: 'generation', next: [] },
          { key: 'notification_refus', name: 'Notifier le refus motivé', type: 'generation', next: [] },
        ],
      },
      assumptions: ["La liste des pièces obligatoires est à adapter au type d'agrément."],
      trigger: null,
    },
  },

  // 5) Demande d'achat, trois devis au-dessus de 1 million --------------------------------------------------------
  {
    id: 'demande-achat',
    titre: 'Demande d’achat avec trois devis',
    description:
      "Pour une demande d'achat : l'agent remplit la demande avec le montant. Si le montant dépasse 1 million de FCFA, trois devis sont exigés et le directeur valide ; sinon le chef de service valide. Une fois validée, la commande est passée.",
    attendu: {
      minSteps: 6,
      maxSteps: 9,
      stepTypes: ['formulaire', 'decision', 'checklist', 'validation'],
      agentToolsAllowed: [],
      needsDecision: true,
      needsApproval: true,
      humanSteps: ['Directeur', 'Chef de service'],
      triggerEvent: null,
      assumptionsMention: ['1 000 000'],
    },
    modelOutput: {
      name: "Demande d'achat",
      description: 'Trois devis exigés au-dessus de 1 million de FCFA, validation selon le montant.',
      graph: {
        schemaVersion: 1,
        start: 'demande',
        steps: [
          {
            key: 'demande',
            name: "Remplir la demande d'achat",
            type: 'formulaire',
            config: { fields: [{ key: 'montant', required: true }, { key: 'objet', required: true }, { key: 'fournisseur' }] },
            next: [{ to: 'controle_montant' }],
          },
          {
            key: 'controle_montant',
            name: 'Montant supérieur à 1 million ?',
            type: 'decision',
            next: [
              {
                to: 'collecte_devis',
                label: 'Plus de 1 million',
                condition: { field: 'steps.demande.values.montant', op: 'gt', value: 1000000 },
              },
              { to: 'validation_chef', label: 'Sinon', isDefault: true },
            ],
          },
          {
            key: 'collecte_devis',
            name: 'Joindre les trois devis',
            type: 'checklist',
            config: {
              items: [
                { key: 'devis_1', required: true },
                { key: 'devis_2', required: true },
                { key: 'devis_3', required: true },
              ],
            },
            next: [{ to: 'validation_directeur' }],
          },
          {
            key: 'validation_directeur',
            name: 'Validation du directeur',
            type: 'validation',
            assigneeHint: 'Directeur',
            next: approvalEdges('commande', 'rejet'),
          },
          {
            key: 'validation_chef',
            name: 'Validation du chef de service',
            type: 'validation',
            assigneeHint: 'Chef de service',
            next: approvalEdges('commande', 'rejet'),
          },
          { key: 'commande', name: 'Passer la commande', type: 'formulaire', next: [] },
          { key: 'rejet', name: 'Informer du rejet de la demande', type: 'formulaire', next: [] },
        ],
      },
      assumptions: [`Seuil lu dans la description : « 1 million de FCFA » soit 1 000 000 FCFA ${FIGURE_SUFFIX}`],
      trigger: null,
    },
  },

  // 6) Nouvel agent ---------------------------------------------------------------------------------------------
  {
    id: 'nouvel-agent',
    titre: 'Accueil d’un nouvel agent',
    description:
      "Accueil d'un nouvel agent : préparer le poste de travail, accueillir l'agent, lui remettre le livret, faire la checklist d'arrivée (badge, accès informatique, présentation à l'équipe), puis les RH confirment la fin de l'accueil.",
    attendu: {
      minSteps: 5,
      maxSteps: 7,
      stepTypes: ['checklist', 'formulaire', 'validation'],
      agentToolsAllowed: [],
      needsDecision: false,
      needsApproval: true,
      humanSteps: ['RH', 'Moyens généraux'],
      triggerEvent: null,
      assumptionsMention: [],
    },
    modelOutput: {
      name: "Accueil d'un nouvel agent",
      description: "Préparation du poste, accueil et checklist d'arrivée d'un nouvel agent.",
      graph: {
        schemaVersion: 1,
        start: 'preparation_poste',
        steps: [
          {
            key: 'preparation_poste',
            name: 'Préparer le poste de travail',
            type: 'checklist',
            assigneeHint: 'Moyens généraux',
            config: {
              items: [{ key: 'bureau', required: true }, { key: 'poste_informatique', required: true }, { key: 'badge' }],
            },
            next: [{ to: 'accueil' }],
          },
          {
            key: 'accueil',
            name: "Accueillir l'agent et remettre le livret",
            type: 'formulaire',
            assigneeHint: 'RH',
            config: { fields: [{ key: 'date_arrivee', required: true }, { key: 'service' }] },
            next: [{ to: 'checklist_arrivee' }],
          },
          {
            key: 'checklist_arrivee',
            name: "Checklist d'arrivée",
            type: 'checklist',
            assigneeHint: 'Chef de service',
            config: {
              items: [
                { key: 'badge_remis', required: true },
                { key: 'acces_informatique', required: true },
                { key: 'presentation_equipe', required: true },
                { key: 'livret_remis' },
              ],
            },
            next: [{ to: 'confirmation_rh' }],
          },
          {
            key: 'confirmation_rh',
            name: "Confirmer la fin de l'accueil",
            type: 'validation',
            assigneeHint: 'RH',
            next: approvalEdges('cloture', 'checklist_arrivee'),
          },
          { key: 'cloture', name: "Clôturer l'accueil", type: 'formulaire', next: [] },
        ],
      },
      assumptions: ["Si les RH refusent la clôture, la checklist d'arrivée est reprise."],
      trigger: null,
    },
  },

  // 7) Réponse à une demande d'information ----------------------------------------------------------------------
  {
    id: 'reponse-demande-information',
    titre: 'Réponse à une demande d’information',
    description:
      "Répondre à une demande d'information : l'IA prépare un projet de réponse à partir des documents et du courrier concerné, le rédacteur le relit et le complète, puis le chef de service valide avant l'envoi.",
    attendu: {
      minSteps: 4,
      maxSteps: 6,
      stepTypes: ['agent', 'generation', 'validation'],
      agentToolsAllowed: ['lire_courrier', 'rechercher_documents', 'proposer_reponse'],
      needsDecision: false,
      needsApproval: true,
      humanSteps: ['Rédacteur', 'Chef de service'],
      triggerEvent: null,
      assumptionsMention: [],
    },
    modelOutput: {
      name: "Réponse à une demande d'information",
      description: "Rédaction assistée d'une réponse, relue par un rédacteur et validée par le chef de service.",
      graph: {
        schemaVersion: 1,
        start: 'projet_reponse',
        steps: [
          {
            key: 'projet_reponse',
            name: 'Préparer un projet de réponse',
            type: 'agent',
            agent: {
              objective: 'Proposer un projet de réponse à partir du courrier et des documents pertinents.',
              tools: ['lire_courrier', 'rechercher_documents', 'proposer_reponse'],
              autonomy: 'suggere',
            },
            next: [{ to: 'redaction' }],
          },
          {
            key: 'redaction',
            name: 'Relire et compléter la réponse',
            type: 'generation',
            assigneeHint: 'Rédacteur',
            next: [{ to: 'validation_chef' }],
          },
          {
            key: 'validation_chef',
            name: 'Validation du chef de service',
            type: 'validation',
            assigneeHint: 'Chef de service',
            next: approvalEdges('envoi', 'redaction'),
          },
          {
            key: 'envoi',
            name: 'Envoyer la réponse',
            type: 'checklist',
            config: { items: [{ key: 'reponse_envoyee', required: true }] },
            next: [],
          },
        ],
      },
      assumptions: ["L'agent IA ne fait que suggérer un projet : le rédacteur et le chef de service décident."],
      trigger: null,
    },
  },

  // 8) Archivage d'un dossier arrivé à échéance -----------------------------------------------------------------
  {
    id: 'archivage-echeance',
    titre: 'Archivage d’un dossier arrivé à échéance',
    description:
      "Quand un dossier arrive à échéance (date butoir atteinte), l'IA contrôle le dossier et propose son classement d'archivage, puis l'archiviste valide et le dossier est archivé. Prévenir 7 jours avant l'échéance.",
    attendu: {
      minSteps: 4,
      maxSteps: 6,
      stepTypes: ['agent', 'validation', 'checklist'],
      agentToolsAllowed: ['lire_document', 'rechercher_documents', 'proposer_imputation'],
      needsDecision: false,
      needsApproval: true,
      humanSteps: ['Archiviste'],
      triggerEvent: 'deadline.reached',
      assumptionsMention: ['7 jours'],
    },
    modelOutput: {
      name: "Archivage d'un dossier arrivé à échéance",
      description: "Contrôle assisté, validation par l'archiviste puis archivage du dossier.",
      graph: {
        schemaVersion: 1,
        start: 'controle_dossier',
        steps: [
          {
            key: 'controle_dossier',
            name: 'Contrôler le dossier',
            type: 'agent',
            agent: {
              objective: "Contrôler la complétude du dossier et proposer son classement d'archivage.",
              tools: ['lire_document', 'rechercher_documents', 'proposer_imputation'],
              autonomy: 'suggere',
            },
            next: [{ to: 'validation_archiviste' }],
          },
          {
            key: 'validation_archiviste',
            name: "Validation de l'archiviste",
            type: 'validation',
            assigneeHint: 'Archiviste',
            dueInHours: 72,
            next: approvalEdges('archivage', 'complement'),
          },
          {
            key: 'complement',
            name: 'Compléter le dossier',
            type: 'formulaire',
            next: [{ to: 'validation_archiviste' }],
          },
          {
            key: 'archivage',
            name: 'Archiver le dossier',
            type: 'checklist',
            config: { items: [{ key: 'dossier_classe', required: true }, { key: 'localisation_notee' }] },
            next: [],
          },
        ],
      },
      assumptions: [`Délai lu dans la description : « 7 jours » ${FIGURE_SUFFIX}`],
      trigger: {
        eventType: 'deadline.reached',
        conditions: { deadline: { leadHours: 168 } },
        reason: "Le dossier est traité lorsqu'il arrive à échéance.",
      },
    },
  },
];
