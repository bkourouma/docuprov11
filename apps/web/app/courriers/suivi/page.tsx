'use client';

import { useCallback, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Tooltip } from 'antd';
import type { TableColumnsType } from 'antd';
import { PageHeader } from '../../components/PageHeader';
import { MailWorklist } from '../../components/mail/MailWorklist';
import { FicheImputationModal } from '../../components/mail/FicheImputationModal';
import { icons } from '../../theme/icons';
import { listSuivi, type MailSummary } from '../../lib/courriers';

export default function SuiviPage() {
  const router = useRouter();
  const [ficheId, setFicheId] = useState<number | null>(null);
  const load = useCallback((page: number, pageSize: number) => listSuivi({ page, pageSize }), []);

  // §09 : la fiche d'imputation se génère depuis chaque ligne de cette file.
  const ficheColumn: TableColumnsType<MailSummary> = useMemo(
    () => [
      {
        title: '',
        key: 'fiche',
        width: 56,
        align: 'center',
        render: (_, r) => (
          <Tooltip title="Fiche d'imputation">
            {/* Cible tactile ≥ 40 px portée par le bouton (l'icône reste à 16 px) ; l'icône est
                celle d'un document, pas d'un téléchargement : le clic OUVRE la fiche. */}
            <Button
              type="text"
              icon={<icons.document size={16} />}
              style={{ width: 40, height: 40 }}
              aria-label={`Fiche d'imputation du courrier ${r.nReference ?? r.mailId}`}
              onClick={() => setFicheId(r.mailId)}
            />
          </Tooltip>
        ),
      },
    ],
    [],
  );

  return (
    <div>
      <PageHeader icon="pending" title="Suivi des courriers" />
      {/* Consultation en page complète (onglets), comme le Contrôle — plus de popup. */}
      <MailWorklist
        load={load}
        extraColumns={ficheColumn}
        onOpen={(m) => router.push(`/courriers/suivi/${m.mailId}`)}
        emptyTitle="Aucun courrier en cours"
        hideStatusColumn
      />
      <FicheImputationModal mailId={ficheId} onClose={() => setFicheId(null)} />
    </div>
  );
}
