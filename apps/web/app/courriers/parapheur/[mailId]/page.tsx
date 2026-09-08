'use client';

import { useParams } from 'next/navigation';
import { MailDetailPage } from '../../../components/mail/MailDetailPage';

/**
 * Détail d'un courrier au Parapheur (§08), même présentation à onglets que le Contrôle.
 * L'ouverture traite automatiquement les imputations de type « suivi » (§03.1), comme le
 * faisait le `MailViewer` popup ; les actions de workflow (§03.2) et le traitement par
 * imputation (§10) restent disponibles.
 *
 * Le destinataire d'une imputation peut lui-même ré-imputer le courrier (§08) : la chaîne
 * d'imputations n'est pas limitée au bureau d'ordre — A impute à B, B impute à C, etc.
 *
 * Chacun n'y voit que SA branche de la chaîne (`onlyMyImputations`) : ses propres imputations et
 * celles qu'il a créées. Seul le destinataire principal, qui pilote le courrier, voit tout.
 */
export default function ParapheurMailPage() {
  const params = useParams<{ mailId: string }>();
  const id = Number(params.mailId);
  const mailId = Number.isFinite(id) ? id : null;

  return (
    <MailDetailPage
      mailId={mailId}
      listHref="/courriers/parapheur"
      listLabel="Courriers Imputés"
      autoTreatOnOpen
      onlyMyImputations
    />
  );
}
