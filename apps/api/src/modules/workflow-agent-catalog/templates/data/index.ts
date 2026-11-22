import type { WorkflowTemplate } from '../template.types';
import { agentAiguilleurTemplate } from './agent-aiguilleur.template';
import { agentControleurTemplate } from './agent-controleur.template';
import { agentRedacteurTemplate } from './agent-redacteur.template';
import { agentRelanceurTemplate } from './agent-relanceur.template';
import { circuitVisaDocumentTemplate } from './circuit-visa-document.template';
import { demandeAvecChecklistTemplate } from './demande-avec-checklist.template';
import { validationHierarchiqueCourrierTemplate } from './validation-hierarchique-courrier.template';

/** Tous les modèles prêts à l'emploi (données versionnées). Ordre d'affichage : agents d'abord. */
export const ALL_TEMPLATES: readonly WorkflowTemplate[] = [
  agentAiguilleurTemplate,
  agentRedacteurTemplate,
  agentControleurTemplate,
  agentRelanceurTemplate,
  validationHierarchiqueCourrierTemplate,
  circuitVisaDocumentTemplate,
  demandeAvecChecklistTemplate,
];
