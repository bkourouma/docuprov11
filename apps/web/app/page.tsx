import { redirect } from 'next/navigation';

/** La page d'accueil de l'application est le tableau de bord. */
export default function HomePage() {
  redirect('/dashboards');
}
