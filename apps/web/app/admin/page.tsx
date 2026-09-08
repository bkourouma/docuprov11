import { redirect } from 'next/navigation';

// Première entrée VISIBLE de « Paramétrage Archives » (nav.ts). Pointait auparavant sur
// « Géolocalisation », désormais masquée (HIDDEN_MENU_KEYS) : /admin aurait déposé l'utilisateur
// sur un écran absent de sa barre latérale, sans moyen d'en revenir par le menu.
export default function AdminIndex() {
  redirect('/admin/classification-plans');
}
