'use client';

import { useParams } from 'next/navigation';
import { MailDetailPage } from '../../../components/mail/MailDetailPage';

/**
 * Détail d'un courrier au Suivi (§09) : écran de SUIVI, pas de traitement. On y consulte l'état
 * d'avancement du courrier — ni nouvelle imputation, ni traitement d'imputation (§10), qui se font
 * depuis le parapheur du destinataire concerné. Les actions de workflow (§03.2) restent
 * disponibles ; l'archivage est masqué (§03.1) et la fiche d'imputation se génère depuis chaque
 * ligne de la file Suivi.
 */
export default function SuiviMailPage() {
  const params = useParams<{ mailId: string }>();
  const id = Number(params.mailId);
  const mailId = Number.isFinite(id) ? id : null;

  return (
    <MailDetailPage
      mailId={mailId}
      listHref="/courriers/suivi"
      listLabel="Suivi des courriers"
      showWorkflowActions
      canAddImputations={false}
      allowArchive={false}
    />
  );
}
