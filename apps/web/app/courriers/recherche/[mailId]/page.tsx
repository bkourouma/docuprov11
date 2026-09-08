'use client';

import { useParams } from 'next/navigation';
import { MailDetailPage } from '../../../components/mail/MailDetailPage';

/**
 * Détail d'un courrier trouvé par la recherche (§11) : écran de CONSULTATION PURE, en page
 * complète. AUCUNE action ne mute le courrier ici — pas d'action de workflow (§03.2), pas de
 * traitement d'imputation (§10), pas de nouvelle imputation, pas d'archivage. On ne fait que lire :
 * l'onglet Imputations restitue l'historique complet, l'onglet Fichiers toutes les pièces
 * rattachées (le courrier, la réponse de départ §12, la décharge signée §13).
 *
 * Le statut d'une imputation reste lisible : sa frise indique « Traitée le … » le cas échéant.
 */
export default function RechercheMailPage() {
  const params = useParams<{ mailId: string }>();
  const id = Number(params.mailId);
  const mailId = Number.isFinite(id) ? id : null;

  return (
    <MailDetailPage
      mailId={mailId}
      listHref="/courriers/recherche"
      listLabel="Recherche courrier"
      canAddImputations={false}
      showFilesTab
      allowArchive={false}
    />
  );
}
