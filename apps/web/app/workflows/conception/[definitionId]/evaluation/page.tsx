import { Suspense } from 'react';
import { EvaluationView } from '../../_components/evaluation/EvaluationView';

/** Docu-Flow : évaluation des étapes agent d'un workflow (menu conception). L'identifiant est lu côté client. */
export default function WorkflowEvaluationPage() {
  return (
    <Suspense fallback={null}>
      <EvaluationView />
    </Suspense>
  );
}
