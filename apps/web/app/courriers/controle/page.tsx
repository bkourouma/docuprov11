'use client';

import { useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { PageHeader } from '../../components/PageHeader';
import { MailWorklist } from '../../components/mail/MailWorklist';
import { listControle } from '../../lib/courriers';

/**
 * File Contrôle (§06) : la boîte de réception du destinataire PRINCIPAL désigné à l'enregistrement
 * (acteur nommé, ou porteur du rôle destinataire §05) — pas une file commune. Un courrier n'y
 * apparaît que pour ce destinataire, et seulement tant qu'il n'est pas validé. Le contrôle n'a plus
 * d'action manuelle : le back valide le courrier de lui-même dès que ce destinataire l'impute
 * (`autoValiderOnImputation`), ce qui le retire de cette file — il n'y revient jamais.
 *
 * Chaque ligne ouvre sa propre page (`controle/[mailId]`) plutôt qu'une popup : plus d'espace pour
 * les onglets Courrier/Imputations.
 */
export default function ControlePage() {
  const router = useRouter();

  const load = useCallback(
    (page: number, pageSize: number) => listControle({ page, pageSize }),
    [],
  );

  return (
    <div>
      <PageHeader icon="mail" title="Courriers arrivés" />
      <MailWorklist
        load={load}
        onOpen={(m) => router.push(`/courriers/controle/${m.mailId}`)}
        emptyTitle="Aucun courrier à contrôler"
        // Statut constant dans la file (tout y est en attente de validation) ;
        // l'échéance reste visible pour donner le repère d'urgence dès la liste.
        hideStatusColumn
      />
    </div>
  );
}
