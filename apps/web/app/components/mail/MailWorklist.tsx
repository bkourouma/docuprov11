'use client';

import { useCallback, useEffect, useState } from 'react';
import { App, Card, Table } from 'antd';
import type { TableColumnsType, TablePaginationConfig } from 'antd';
import type { TableRowSelection } from 'antd/es/table/interface';
import dayjs from 'dayjs';
import { destinataireLabel, type MailListResult, type MailSummary } from '../../lib/courriers';
import { CountBadge } from '../CountBadge';
import { EmptyState } from '../EmptyState';
import { TableSkeleton } from '../skeletons';
import { MailStatusTag, MailTypeTag } from './tags';

const fmt = (iso: string | null) => (iso ? dayjs(iso).format('DD/MM/YYYY') : '—');

/** Formulation unique du comptage : le titre de carte et le pied de pagination ne divergent plus. */
const courriersLabel = (n: number) => `courrier${n > 1 ? 's' : ''}`;

/**
 * Cible tactile ≥ 40 px sur les boutons d'action de ligne. Contrainte : ces boutons sont
 * fournis par les pages appelantes via `extraColumns`, ils ne peuvent donc être agrandis que
 * par une règle descendante portée par le tableau lui-même — l'agrandissement passe par la
 * boîte du bouton, jamais par la taille de l'icône. Le padding vertical de leur cellule leur
 * est rendu, sinon la ligne passerait de 36 à 54 px et perdrait la densité de production.
 */
const ROW_ACTION_HIT_AREA = [
  '[&_.ant-table-tbody_.ant-btn]:h-[40px]',
  '[&_.ant-table-tbody_.ant-btn]:min-w-[40px]',
  '[&_.ant-table-tbody_td:has(.ant-btn)]:py-0',
  '[&_.ant-table-tbody_td:has(.ant-btn)]:align-middle',
].join(' ');

/**
 * Indicateur visuel « en retard / bientôt échu » dans la colonne Date butoir. Volontairement
 * DISTINCT du système de paliers exacts de `dateButoireAlert` (7/3/1/0/-1/-2/-3, réservé aux
 * rappels planifiés e-mail + `DeadlineAlert`) : ici on veut un signal continu, visible d'un coup
 * d'œil sur toute ligne en retard ou proche de l'échéance — pas seulement les jours pile.
 *
 * Les deux teintes passent par les variables de thème, qui portent les dérivés FORTS AA de la
 * palette (`colorError` = danger, `colorWarning` = warning) : lisibles en texte sur les deux
 * fonds de carte, alors que les vifs correspondants (`#ff0854`/`#ff5730`) ne le seraient pas.
 */
function DateButoireCell({ iso, treated }: { iso: string | null; treated: boolean }) {
  if (!iso) return <>—</>;
  const deadline = dayjs(iso);
  if (!deadline.isValid()) return <>{fmt(iso)}</>;
  if (treated) return <>{fmt(iso)}</>;

  const days = deadline.startOf('day').diff(dayjs().startOf('day'), 'day');
  if (days < 0) {
    return (
      <span style={{ color: 'var(--ant-color-error)', fontWeight: 600 }}>
        {fmt(iso)} · {Math.abs(days)} j de retard
      </span>
    );
  }
  if (days <= 3) {
    return <span style={{ color: 'var(--ant-color-warning)', fontWeight: 600 }}>{fmt(iso)}</span>;
  }
  return <>{fmt(iso)}</>;
}

/**
 * Grille de worklist courrier réutilisable (files Contrôle/Suivi/Validation/Départ). Pagination
 * serveur ; pas de tri d'en-tête (les endpoints de file ne trient pas — évite le tri cassé §06).
 *
 * Table de PRODUCTION : `size="small"` (lignes ≈ 32-36 px via `cellPaddingBlockSM` du thème).
 * `hideStatusColumn`/`hideDeadlineColumn` restent à `false` par défaut ; ce sont les pages qui
 * masquent ces colonnes, choix conservé tel quel.
 */
export function MailWorklist({
  load,
  refreshSignal = 0,
  extraColumns,
  rowSelection,
  onOpen,
  emptyTitle = 'Aucun courrier',
  hideStatusColumn = false,
  hideDeadlineColumn = false,
}: {
  load: (page: number, pageSize: number) => Promise<MailListResult>;
  refreshSignal?: number;
  extraColumns?: TableColumnsType<MailSummary>;
  rowSelection?: TableRowSelection<MailSummary>;
  onOpen?: (mail: MailSummary) => void;
  emptyTitle?: string;
  hideStatusColumn?: boolean;
  hideDeadlineColumn?: boolean;
}) {
  const { message } = App.useApp();
  const [rows, setRows] = useState<MailSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [loading, setLoading] = useState(true);
  const [firstLoad, setFirstLoad] = useState(true);

  const fetchPage = useCallback(async () => {
    setLoading(true);
    try {
      const res = await load(page, pageSize);
      setRows(res.rows);
      setTotal(res.total);
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Erreur de chargement');
    } finally {
      setLoading(false);
      setFirstLoad(false);
    }
  }, [load, page, pageSize, message]);

  useEffect(() => {
    void fetchPage();
  }, [fetchPage, refreshSignal]);

  const columns: TableColumnsType<MailSummary> = [
    {
      title: 'N° enregistrement',
      dataIndex: 'nReference',
      key: 'nReference',
      width: 150,
      render: (v: string | null) => (v ? <span className="da-mono">{v}</span> : '—'),
    },
    {
      title: 'Objet',
      dataIndex: 'title',
      key: 'title',
      ellipsis: true,
      render: (v: string, r) => (onOpen ? <a onClick={() => onOpen(r)}>{v}</a> : v),
    },
    {
      title: 'Sens',
      dataIndex: 'mailType',
      key: 'mailType',
      width: 100,
      render: (v: number) => <MailTypeTag mailType={v} />,
    },
    {
      title: 'Correspondant',
      key: 'externalEntity',
      width: 190,
      ellipsis: true,
      render: (_, r) => r.externalEntity?.label || '—',
    },
    {
      title: 'Destinataire',
      key: 'destinataire',
      width: 190,
      ellipsis: true,
      render: (_, r) => destinataireLabel(r),
    },
    ...(hideStatusColumn
      ? []
      : [
          {
            title: 'Statut',
            dataIndex: 'status',
            key: 'status',
            width: 120,
            render: (v: number) => <MailStatusTag status={v} />,
          },
        ]),
    ...(hideDeadlineColumn
      ? []
      : [
          {
            title: 'Date butoir',
            dataIndex: 'dateButoire',
            key: 'dateButoire',
            width: 150,
            render: (v: string | null, r: MailSummary) => (
              <DateButoireCell iso={v} treated={r.dateTraited != null} />
            ),
          },
        ]),
    ...(extraColumns ?? []),
  ];

  const onChange = (pagination: TablePaginationConfig) => {
    setPage(pagination.current ?? 1);
    setPageSize(pagination.pageSize ?? 25);
  };

  return (
    <Card
      title={
        // Le compteur garde sa place pendant le chargement : plus de titre « Chargement… »
        // brut, donc plus de saut de l'en-tête de carte à l'arrivée des données.
        firstLoad && loading ? (
          <CountBadge value="…" label="courriers" />
        ) : (
          <CountBadge value={total} label={courriersLabel(total)} />
        )
      }
    >
      {firstLoad && loading ? (
        <TableSkeleton rows={8} columns={columns.length} />
      ) : total === 0 && !loading ? (
        <EmptyState icon="mail" title={emptyTitle} />
      ) : (
        <Table<MailSummary>
          rowKey="mailId"
          className={ROW_ACTION_HIT_AREA}
          columns={columns}
          dataSource={rows}
          loading={loading && !firstLoad}
          size="small"
          scroll={{ x: 'max-content' }}
          rowSelection={rowSelection}
          pagination={{
            current: page,
            pageSize,
            total,
            showSizeChanger: true,
            pageSizeOptions: [10, 25, 50, 100],
            showTotal: (t) => `${t} ${courriersLabel(t)}`,
          }}
          onChange={onChange}
        />
      )}
    </Card>
  );
}
