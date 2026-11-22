'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Card, Checkbox, Grid, Pagination, Select, Table } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import Link from 'next/link';
import { WF_INSTANCE_STATUS_LABELS, type WfInstanceDto, type WfInstanceStatus } from '@archivage/types';
import { PageHeader } from '../../../components/PageHeader';
import { EmptyState } from '../../../components/EmptyState';
import { CardsSkeleton, TableSkeleton } from '../../../components/skeletons';
import { icons, iconDefaults } from '../../../theme/icons';
import { WorkflowApiError, workflowErrorMessage, workflowsApi } from '../../../lib/workflows-api';
import { canTrackInstances } from '../../_lib/access';
import { formatDateTime } from '../../_lib/format';
import { definitionName } from '../../_lib/instances-logic';
import { useWorkflowAccess } from '../../_lib/useWorkflowAccess';
import { DueTag, InstanceStatusTag } from '../../_components/StatusTags';
import { AccessDenied } from './AccessDenied';
import { InstanceActions } from './InstanceActions';
import '../../workflows.css';
import '../instances.css';

const PAGE_SIZE = 25;
const REFRESH_MS = 60_000;
const TERMINAL: readonly number[] = [2, 3, 4];

const STATUS_OPTIONS = (Object.keys(WF_INSTANCE_STATUS_LABELS) as string[]).map((k) => ({
  value: Number(k),
  label: WF_INSTANCE_STATUS_LABELS[Number(k) as WfInstanceStatus],
}));

/**
 * Liste des instances, partagée par « Suivi des workflows » (`scope="mine"`) et « Administration »
 * (`scope="all"`, avec case « Mes instances seulement » et actions rapides).
 */
export function InstancesView({ scope }: { scope: 'mine' | 'all' }) {
  const { access } = useWorkflowAccess();
  const screens = Grid.useBreakpoint();
  const isDesktop = Boolean(screens.md);

  const [status, setStatus] = useState<number | undefined>();
  const [definitionId, setDefinitionId] = useState<number | undefined>();
  const [mineOnly, setMineOnly] = useState(false);
  const [page, setPage] = useState(1);

  const [items, setItems] = useState<WfInstanceDto[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [names, setNames] = useState<Map<number, string>>(new Map());
  const seq = useRef(0);

  const allowed = access ? (scope === 'all' ? access.canAdminister : canTrackInstances(access)) : null;

  // Noms des workflows : l'instance ne porte que `definitionId`. Un échec (403 notamment) est toléré :
  // repli « Workflow n° X ».
  useEffect(() => {
    if (!access || !allowed) return;
    let alive = true;
    (async () => {
      const merged = new Map<number, string>();
      const sources = [workflowsApi.listLaunchable(), ...(access.canDesign ? [workflowsApi.listDefinitions()] : [])];
      const results = await Promise.allSettled(sources);
      for (const r of results) {
        if (r.status === 'fulfilled') for (const d of r.value) merged.set(d.wfDefinitionId, d.name);
      }
      if (alive) setNames(merged);
    })();
    return () => {
      alive = false;
    };
  }, [access, allowed]);

  const load = useCallback(
    async (silent = false) => {
      if (!allowed) return;
      const mine = scope === 'mine' || mineOnly;
      // Numéro de requête : seule la plus récente met à jour l'écran (filtres changés pendant un chargement).
      const mySeq = ++seq.current;
      if (!silent) setLoading(true);
      try {
        const res = await workflowsApi.listInstances({
          status,
          definitionId,
          mine: mine ? true : undefined,
          limit: PAGE_SIZE,
          offset: (page - 1) * PAGE_SIZE,
        });
        if (mySeq !== seq.current) return;
        setItems(res.items);
        setTotal(res.total);
        setError(null);
        setForbidden(false);
        setUpdatedAt(new Date());
      } catch (e) {
        if (mySeq !== seq.current) return;
        if (e instanceof WorkflowApiError && e.forbidden) setForbidden(true);
        else setError(workflowErrorMessage(e));
      } finally {
        if (mySeq === seq.current) setLoading(false);
      }
    },
    [allowed, scope, mineOnly, status, definitionId, page],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // Actualisation automatique toutes les 60 s, seulement si l'onglet est visible.
  useEffect(() => {
    if (!allowed) return;
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load(true);
    }, REFRESH_MS);
    return () => window.clearInterval(id);
  }, [allowed, load]);

  const definitionOptions = useMemo(
    () => [...names.entries()].sort((a, b) => a[1].localeCompare(b[1], 'fr')).map(([value, label]) => ({ value, label })),
    [names],
  );

  const title = scope === 'all' ? 'Administration des workflows' : 'Suivi des workflows';
  const RefreshGlyph = icons.refresh;

  if (access === null) {
    return (
      <div>
        <PageHeader title={title} icon="pending" />
        <TableSkeleton rows={5} columns={5} />
      </div>
    );
  }

  if (!allowed || forbidden) {
    return (
      <div>
        <PageHeader title={title} icon="pending" />
        <AccessDenied
          message={
            scope === 'all'
              ? 'Accès refusé. Votre rôle ne donne pas accès à l’administration des workflows. Demandez l’accès à un administrateur.'
              : 'Accès refusé. Votre rôle ne donne pas accès à Docu-Flow. Demandez l’accès à un administrateur.'
          }
        />
      </div>
    );
  }

  const actions = (
    <>
      {access.canLaunch && (
        <Link href="/workflows/lancer">
          <Button type="primary">Lancer un workflow</Button>
        </Link>
      )}
      <Button onClick={() => void load()} loading={loading} icon={<RefreshGlyph size={16} strokeWidth={iconDefaults.strokeWidth} />}>
        Actualiser
      </Button>
    </>
  );

  const nameOf = (id: number) => definitionName(names, id);
  const refreshAfterAction = () => void load(true);
  const filtered = status !== undefined || definitionId !== undefined || mineOnly;
  const detailHref = (id: string) => `/workflows/instances/${encodeURIComponent(id)}`;

  const columns: ColumnsType<WfInstanceDto> = [
    {
      title: 'N°',
      dataIndex: 'wfInstanceId',
      render: (id: string) => (
        <Link className="wfi-link" href={detailHref(id)}>
          {id}
        </Link>
      ),
    },
    { title: 'Workflow', dataIndex: 'definitionId', render: (id: number) => nameOf(id) },
    { title: 'Statut', dataIndex: 'status', render: (s: WfInstanceStatus) => <InstanceStatusTag status={s} /> },
    { title: 'Démarrée', dataIndex: 'startedAt', render: (v: string) => formatDateTime(v) },
    {
      title: 'Échéance',
      dataIndex: 'dueAt',
      render: (v: string | null, row) => (TERMINAL.includes(row.status) ? '—' : <DueTag dueAt={v} />),
    },
    { title: 'Terminée', dataIndex: 'finishedAt', render: (v: string | null) => formatDateTime(v) },
    {
      title: 'Actions',
      key: 'actions',
      render: (_: unknown, row) => (
        <div className="wfi-actions">
          <Link href={detailHref(row.wfInstanceId)}>
            <Button size="small">Détail</Button>
          </Link>
          {scope === 'all' && <InstanceActions instance={row} access={access} onChanged={refreshAfterAction} size="small" />}
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader title={title} icon="pending" actions={actions} />

      <div className="wf-toolbar wfi-toolbar" role="search" aria-label="Filtres des instances">
        <div className="wf-field">
          <label htmlFor={`wfi-status-${scope}`}>Statut</label>
          <Select
            id={`wfi-status-${scope}`}
            allowClear
            placeholder="Tous les statuts"
            value={status}
            options={STATUS_OPTIONS}
            onChange={(v: number | undefined) => {
              setStatus(v);
              setPage(1);
            }}
          />
        </div>
        <div className="wf-field">
          <label htmlFor={`wfi-def-${scope}`}>Workflow</label>
          <Select
            id={`wfi-def-${scope}`}
            allowClear
            showSearch
            optionFilterProp="label"
            placeholder="Tous les workflows"
            value={definitionId}
            options={definitionOptions}
            onChange={(v: number | undefined) => {
              setDefinitionId(v);
              setPage(1);
            }}
          />
        </div>
        {scope === 'all' && (
          <Checkbox
            checked={mineOnly}
            onChange={(e) => {
              setMineOnly(e.target.checked);
              setPage(1);
            }}
          >
            Mes instances seulement
          </Checkbox>
        )}
        <div className="wfi-toolbar-end wf-muted" aria-live="polite">
          {updatedAt ? `Actualisé à ${updatedAt.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}` : ''}
        </div>
      </div>

      <div aria-live="polite">
        {error && (
          <Alert
            type="error"
            showIcon
            style={{ marginBottom: 16 }}
            message={error}
            action={
              <Button size="small" onClick={() => void load()}>
                Réessayer
              </Button>
            }
          />
        )}
      </div>

      {loading && items.length === 0 ? (
        isDesktop ? (
          <TableSkeleton rows={5} columns={6} />
        ) : (
          <CardsSkeleton count={3} />
        )
      ) : items.length === 0 && !error ? (
        <Card>
          <EmptyState
            icon="pending"
            title={filtered ? 'Aucune instance ne correspond à ces filtres.' : 'Aucune instance pour le moment.'}
            action={
              filtered ? (
                <Button
                  onClick={() => {
                    setStatus(undefined);
                    setDefinitionId(undefined);
                    setMineOnly(false);
                    setPage(1);
                  }}
                >
                  Effacer les filtres
                </Button>
              ) : access.canLaunch ? (
                <Link href="/workflows/lancer">
                  <Button type="primary">Lancer un workflow</Button>
                </Link>
              ) : undefined
            }
          />
        </Card>
      ) : isDesktop ? (
        <Table<WfInstanceDto>
          className="wfi-table"
          rowKey="wfInstanceId"
          columns={columns}
          dataSource={items}
          pagination={false}
          loading={loading}
          size="middle"
        />
      ) : (
        <ul className="wfi-cards" style={{ listStyle: 'none', padding: 0 }}>
          {items.map((row) => (
            <li key={row.wfInstanceId}>
              <article className="wf-card wfi-card" aria-label={`Instance n° ${row.wfInstanceId}`}>
                <div className="wfi-card-head">
                  <Link className="wfi-card-title" href={detailHref(row.wfInstanceId)}>
                    {nameOf(row.definitionId)} — n° {row.wfInstanceId}
                  </Link>
                  <InstanceStatusTag status={row.status} />
                </div>
                <div className="wfi-meta">
                  <span>Démarrée : {formatDateTime(row.startedAt)}</span>
                  {TERMINAL.includes(row.status) ? (
                    <span>Terminée : {formatDateTime(row.finishedAt)}</span>
                  ) : (
                    <span>
                      Échéance : <DueTag dueAt={row.dueAt} />
                    </span>
                  )}
                </div>
                <div className="wfi-actions wf-touch">
                  <Link href={detailHref(row.wfInstanceId)}>
                    <Button>Voir le détail</Button>
                  </Link>
                  {scope === 'all' && <InstanceActions instance={row} access={access} onChanged={refreshAfterAction} />}
                </div>
              </article>
            </li>
          ))}
        </ul>
      )}

      {total > PAGE_SIZE && (
        <div className="wfi-pager">
          <Pagination
            current={page}
            pageSize={PAGE_SIZE}
            total={total}
            showSizeChanger={false}
            onChange={setPage}
            showTotal={(t) => `${t} instances`}
          />
        </div>
      )}
    </div>
  );
}
