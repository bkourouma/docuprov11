import { redirect } from 'next/navigation';

/** `/workflows` n'a pas de contenu propre : on arrive sur la boîte de tâches. */
export default function WorkflowsIndexPage() {
  redirect('/workflows/boite');
}
