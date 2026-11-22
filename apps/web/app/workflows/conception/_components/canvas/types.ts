// Docu-Flow — types partagés entre le canevas, la liste alternative et la page de l'éditeur.

/** Ce qui est sélectionné dans l'éditeur : une étape, une transition, ou rien. */
export type EditorSelection =
  | { kind: 'step'; key: string }
  | { kind: 'edge'; from: string; to: string }
  | null;

/** Type MIME du glisser-déposer palette -> canevas (la valeur transportée est la clé du type d'étape). */
export const STEP_DRAG_MIME = 'application/x-docuflow-step-type';
