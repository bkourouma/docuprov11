'use client';

import { useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { PageHeader } from '../../components/PageHeader';
import { MailWorklist } from '../../components/mail/MailWorklist';
import { listParapheur } from '../../lib/courriers';

export default function ParapheurPage() {
  const router = useRouter();
  const load = useCallback(
    (page: number, pageSize: number) => listParapheur({ page, pageSize }),
    [],
  );

  return (
    <div>
      <PageHeader icon="validated" title="Courriers Imputés" />
      {/* Consultation en page complète (onglets), comme le Contrôle — plus de popup. */}
      <MailWorklist
        load={load}
        onOpen={(m) => router.push(`/courriers/parapheur/${m.mailId}`)}
        emptyTitle="Aucun courrier imputé"
        // Le statut est constant dans cette file (tout y est imputé) : le montrer
        // n'apprendrait rien. L'échéance, elle, reste affichée — c'est la boîte de
        // travail où l'on priorise, et sans elle l'urgence ne se voyait qu'une fois
        // la fiche ouverte.
        hideStatusColumn
      />
    </div>
  );
}
