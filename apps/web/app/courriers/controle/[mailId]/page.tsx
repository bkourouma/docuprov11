'use client';

import { useParams } from 'next/navigation';
import { MailDetailPage } from '../../../components/mail/MailDetailPage';

/**
 * Détail d'un courrier au Contrôle (§06). Pas d'actions de workflow ni de bouton « Traiter » :
 * le traitement se fait depuis le menu dédié du destinataire (Parapheur, Suivi…), pas depuis
 * cette page d'arrivée. L'archivage est masqué (§03.1) — on ne clôt pas un courrier avant son
 * contrôle. Une imputation peut être supprimée, mais seulement par son auteur.
 */
export default function ControleMailPage() {
  const params = useParams<{ mailId: string }>();
  const id = Number(params.mailId);
  const mailId = Number.isFinite(id) ? id : null;

  return (
    <MailDetailPage
      mailId={mailId}
      listHref="/courriers/controle"
      listLabel="Courriers arrivés"
      allowArchive={false}
      canDeleteOwnImputations
    />
  );
}
