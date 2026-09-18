'use client';

import { useCallback, useEffect, useState } from 'react';
import { App, Button, Card, Input, Popconfirm, Space, Table, Tag, Tooltip, Typography } from 'antd';
import type { TableColumnsType, TablePaginationConfig } from 'antd';
import type { SorterResult } from 'antd/es/table/interface';
import Link from 'next/link';
import dayjs from 'dayjs';
import { PageHeader } from '../PageHeader';
import { EmptyState } from '../EmptyState';
import { icons, type IconName } from '../../theme/icons';
import { colors } from '../../theme/tokens';
import {
  lendingsApi,
  type LendingResult,
  type LendingRow,
  type ListQuery,
} from '../../lib/archives';

const fmt = (iso: string | null) => (iso ? dayjs(iso).format('DD/MM/YYYY') : '—');
const fmtDt = (iso: string | null) => (iso ? dayjs(iso).format('DD/MM/YYYY HH:mm') : '—');

/**
 * Badge plein AA : le fond porte le dérivé FORT de la sémantique (jamais la teinte vive, qui
 * ne passe pas le contraste sous du texte) et AntD pose le blanc via `ant-tag-has-color`.
 * La taille 11 px vient du thème (`Tag.fontSizeSM`) : seule la graisse est à forcer ici.
 */
const badgeStyle = { fontWeight: 600 } as const;

/**
 * Patron des trois listes de communications : « Documents communiqués » (tous), « Mes documents
 * communiqués » (bénéficiaire = utilisateur courant) et « Historique » (prêts rendus).
 *
 * Les trois affichent les mêmes colonnes sur les mêmes données, à trois périmètres près — le
 * périmètre est décidé par le SERVEUR (`fetch`), pas par un filtre côté client : un utilisateur
 * ne doit pas pouvoir élargir sa vue en modifiant une requête.
 *
 * `canReturn` distingue les écrans opérationnels de l'historique, où le prêt est déjà clos.
 *
 * `density` suit l'arbitrage de densité du relook : les deux listes de travail restent en
 * production (lignes courtes, plus de prêts à l'écran), l'historique — consultation seule —
 * passe en `consultation`. Le défaut vaut « production » pour ne rien changer aux appelants
 * qui ne la précisent pas.
 */
export function LendingListPage({
  icon,
  title,
  canReturn,
  density = 'production',
  hideBeneficiary = false,
  fetch,
}: {
  icon: IconName;
  title: string;
  canReturn: boolean;
  density?: 'production' | 'consultation';
  /** Masque la colonne « Bénéficiaire » quand elle vaut toujours l'utilisateur connecté. */
  hideBeneficiary?: boolean;
  fetch: (query: ListQuery) => Promise<LendingResult>;
}) {
  const { message } = App.useApp();
  const [data, setData] = useState<LendingResult>({ total: 0, page: 1, pageSize: 25, rows: [] });
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState<ListQuery>({
    page: 1,
    pageSize: 25,
    sorting: 'startDate',
    sortDirection: 'desc',
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await fetch(query));
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Erreur de chargement');
    } finally {
      setLoading(false);
    }
    // `fetch` est une méthode d'un objet de module (`lendingsApi.out`…), donc d'identité stable :
    // la citer en dépendance est exact et ne provoque pas de rechargement en boucle.
  }, [fetch, query, message]);

  useEffect(() => {
    void load();
  }, [load]);

  const doReturn = async (row: LendingRow) => {
    try {
      const r = await lendingsApi.returnDetail(row.lendingDocumentDetailId);
      await load();
      message.success(
        r.lendingClosed ? 'Document retourné — la communication est close' : 'Document retourné',
      );
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Retour impossible');
    }
  };

  const onTableChange = (
    pagination: TablePaginationConfig,
    _filters: unknown,
    sorter: SorterResult<LendingRow> | SorterResult<LendingRow>[],
  ) => {
    const s = Array.isArray(sorter) ? sorter[0] : sorter;
    setQuery((q) => ({
      ...q,
      page: pagination.current ?? 1,
      pageSize: pagination.pageSize ?? 25,
      ...(s?.columnKey
        ? { sorting: String(s.columnKey), sortDirection: s.order === 'descend' ? 'desc' : 'asc' }
        : {}),
    }));
  };

  const columns: TableColumnsType<LendingRow> = [
    {
      title: 'N°',
      key: 'documentId',
      width: 80,
      sorter: true,
      render: (_, r) => <Typography.Text className="da-mono">{r.documentId}</Typography.Text>,
    },
    {
      title: 'Document',
      key: 'document',
      sorter: true,
      // Le libellé ouvre la fiche du document (`/documents/:id`), d'où part la visionneuse —
      // même geste que sur l'écran de recherche : une URL partageable plutôt qu'une popup, et
      // la place d'afficher les métadonnées du type. L'accès reste vérifié par le serveur.
      //
      // Largeur bornée + retour à la ligne : `scroll: max-content` laisserait sinon ces libellés
      // (type — îlot/lot — localité) tenir sur une seule ligne et repousser hors écran les
      // colonnes suivantes.
      //
      // Bornés à DEUX lignes, comme « DUA expirés » et « Documents épurés » : au-delà, la hauteur
      // des lignes variait du simple au triple selon la longueur du libellé et la liste devenait
      // pénible à parcourir. Le `title` rend le libellé complet au survol — ce que la version
      // sans troncature cherchait justement à garantir.
      render: (_, r) => (
        <Link
          href={`/documents/${r.documentId}`}
          title={r.documentLabel}
          className="line-clamp-2"
          style={{ maxWidth: 360 }}
        >
          {r.documentLabel}
        </Link>
      ),
    },
    // Masquable : sur « Mes documents communiqués », le bénéficiaire est toujours
    // l'utilisateur connecté — la colonne consommerait de la largeur sans rien dire.
    ...(hideBeneficiary
      ? []
      : [
          {
            title: 'Bénéficiaire',
            key: 'beneficiary',
            sorter: true,
            render: (_: unknown, r: LendingRow) => r.fullName,
          },
        ]),
    {
      title: 'Motif',
      key: 'motive',
      sorter: true,
      render: (_, r) =>
        r.lendingMotiveName ?? <Typography.Text type="secondary">—</Typography.Text>,
    },
    {
      title: 'Début',
      key: 'startDate',
      width: 120,
      sorter: true,
      render: (_, r) => fmt(r.startDate),
    },
    {
      title: 'Retour prévu',
      key: 'projectedReturnDate',
      width: 165,
      sorter: true,
      // Le retard est le SEUL état discriminant de ces listes : lui seul mérite un badge, et
      // l'icône double le signal pour ne pas le confier à la couleur seule (WCAG 1.4.1).
      render: (_, r) =>
        r.isOverdue ? (
          <Tooltip title="Date de retour prévue dépassée">
            <Tag color={colors.danger} style={badgeStyle}>
              <icons.alert
                size={12}
                strokeWidth={2.4}
                style={{ verticalAlign: '-2px', marginInlineEnd: 4 }}
              />
              {fmt(r.projectedReturnDate)}
            </Tag>
          </Tooltip>
        ) : (
          fmt(r.projectedReturnDate)
        ),
    },
    {
      title: 'Retour effectif',
      key: 'returnedDate',
      width: 160,
      sorter: true,
      // Le serveur borne chaque écran à un seul cas (rendu pour l'historique, en cours pour les
      // deux listes de travail) : un badge y serait constant, donc muet — la date suffit.
      render: (_, r) =>
        r.returnedDate ? (
          fmtDt(r.returnedDate)
        ) : (
          <Typography.Text type="secondary">en cours</Typography.Text>
        ),
    },
    ...(canReturn
      ? ([
          {
            title: '',
            key: 'actions',
            width: 120,
            align: 'center',
            render: (_, r: LendingRow) => (
              <Popconfirm
                title="Enregistrer le retour de ce document ?"
                description="Il réintègre l'archive et redevient communicable."
                okText="Enregistrer le retour"
                cancelText="Annuler"
                onConfirm={() => void doReturn(r)}
              >
                <Button size="small" icon={<icons.check size={14} />}>
                  Retour
                </Button>
              </Popconfirm>
            ),
          },
        ] as TableColumnsType<LendingRow>)
      : []),
  ];

  return (
    <div>
      <PageHeader
        icon={icon}
        title={title}
        actions={
          <Button icon={<icons.refresh size={16} />} onClick={() => void load()}>
            Actualiser
          </Button>
        }
      />
      <Card>
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Input.Search
            allowClear
            style={{ maxWidth: 420 }}
            placeholder="Rechercher un document, un bénéficiaire, un motif…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onSearch={(v) => setQuery((q) => ({ ...q, search: v.trim() || undefined, page: 1 }))}
          />
          <Table<LendingRow>
            rowKey="lendingDocumentDetailId"
            dataSource={data.rows}
            columns={columns}
            loading={loading}
            size={density === 'consultation' ? 'middle' : 'small'}
            scroll={{ x: 'max-content' }}
            onChange={onTableChange}
            locale={{
              emptyText: (
                <EmptyState
                  compact
                  icon={icon}
                  title={
                    canReturn ? 'Aucune communication en cours' : 'Aucune communication terminée'
                  }
                />
              ),
            }}
            pagination={{
              current: data.page,
              pageSize: data.pageSize,
              total: data.total,
              showSizeChanger: true,
              pageSizeOptions: ['10', '25', '50', '100'],
              // « document(s) » comme partout ailleurs : une ligne = un document communiqué.
              showTotal: (t) => `${t} document(s)`,
            }}
          />
        </Space>
      </Card>
    </div>
  );
}
