'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, App, Button, Card, Grid, Input, Select, Table } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import Link from 'next/link';
import {
  WF_DEFINITION_STATUS_LABELS,
  WF_DEFINITION_STATUS_VALUES,
  WfDefinitionStatus,
  type WfDefinitionDto,
} from '@archivage/types';
import { PageHeader } from '../../../../components/PageHeader';
import { EmptyState } from '../../../../components/EmptyState';
import { CardsSkeleton, TableSkeleton } from '../../../../components/skeletons';
import { icons, iconDefaults } from '../../../../theme/icons';
import { WorkflowApiError, workflowErrorMessage, workflowsApi } from '../../../../lib/workflows-api';
import { formatDateTime } from '../../../_lib/format';
import { useWorkflowAccess } from '../../../_lib/useWorkflowAccess';
import { AccessDenied } from '../../../instances/_components/AccessDenied';
import { CreateDefinitionModal } from './CreateDefinitionModal';
import { DefinitionStatusTag } from './DefinitionStatusTags';
import '../../../workflows.css';
import './editeur.css';

const STATUS_OPTIONS = WF_DEFINITION_STATUS_VALUES.map((v) => ({ value: v, label: WF_DEFINITION_STATUS_LABELS[v] }));

/** Liste des workflows de conception : filtre par statut, recherche, création, ouverture, archivage. */
export function DefinitionsList() {
  const { access } = useWorkflowAccess();
  const { modal, message } = App.useApp();
  const screens = Grid.useBreakpoint();
  const isDesktop = Boolean(screens.md);

  const [status, setStatus] = useState<number | undefined>();
  const [search, setSearch] = useState('');
  const [items, setItems] = useState<WfDefinitionDto[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [creating, setCreating] = useState(false);
  const [archivingId, setArchivingId] = useState<number | null>(null);

  const allowed = access?.canDesign ?? null;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await workflowsApi.listDefinitions(status));
      setError(null);
    } catch (e) {
      if (e instanceof WorkflowApiError && e.forbidden) setForbidden(true);
      else setError(workflowErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    if (allowed) void load();
  }, [allowed, load]);

  const filtered = useMemo(() => {
    const q = search.trim().toLocaleLowerCase('fr');
    if (!items) return [];
    if (!q) return items;
    return items.filter((d) => `${d.name} ${d.description ?? ''}`.toLocaleLowerCase('fr').includes(q));
  }, [items, search]);

  const confirmArchive = (d: WfDefinitionDto) => {
    modal.confirm({
      title: `Archiver « ${d.name} » ?`,
      content:
        'Le workflow n’est plus proposé au lancement et devient non modifiable. Les instances en cours ne sont pas touchées.',
      okText: 'Archiver',
      cancelText: 'Annuler',
      okButtonProps: { danger: true },
      onOk: async () => {
        setArchivingId(d.wfDefinitionId);
        try {
          const updated = await workflowsApi.archive(d.wfDefinitionId);
          setItems((prev) => prev?.map((x) => (x.wfDefinitionId === updated.wfDefinitionId ? updated : x)) ?? prev);
          message.success(`Workflow « ${d.name} » archivé.`);
          // Avec un filtre de statut, la ligne n'a plus sa place : on recharge pour rester fidèle au serveur.
          if (status !== undefined) void load();
        } catch (e) {
          message.error(workflowErrorMessage(e));
          // Conflit (déjà archivé…) : l'affichage est périmé.
          if (e instanceof WorkflowApiError && e.conflict) void load();
        } finally {
          setArchivingId(null);
        }
      },
    });
  };

  const header = (
    <PageHeader
      title="Conception des workflows"
      icon="tune"
      actions={
        allowed ? (
          <Button type="primary" icon={<icons.add {...iconDefaults} size={16} />} onClick={() => setCreating(true)}>
            Nouveau workflow
          </Button>
        ) : undefined
      }
    />
  );

  if (access === null) {
    return (
      <div>
        {header}
        <CardsSkeleton count={3} />
      </div>
    );
  }
  if (!allowed || forbidden) {
    return (
      <div>
        {header}
        <AccessDenied message="Accès refusé. Votre rôle ne permet pas de concevoir des workflows. Demandez l’accès à un administrateur." />
      </div>
    );
  }

  const openLink = (d: WfDefinitionDto) => (
    <Link href={`/workflows/conception/${d.wfDefinitionId}`} aria-label={`Ouvrir le workflow ${d.name}`}>
      <Button tabIndex={-1}>Ouvrir</Button>
    </Link>
  );
  const archiveButton = (d: WfDefinitionDto) => (
    <Button
      onClick={() => confirmArchive(d)}
      disabled={d.status === WfDefinitionStatus.Archived}
      loading={archivingId === d.wfDefinitionId}
      aria-label={`Archiver le workflow ${d.name}`}
    >
      Archiver
    </Button>
  );

  const columns: ColumnsType<WfDefinitionDto> = [
    {
      title: 'Nom',
      dataIndex: 'name',
      render: (name: string, d) => (
        <Link href={`/workflows/conception/${d.wfDefinitionId}`} className="wfe-list-name">
          {name}
        </Link>
      ),
    },
    {
      title: 'Description',
      dataIndex: 'description',
      ellipsis: true,
      render: (v: string | null) => v ?? <span className="wf-muted">Aucune description</span>,
    },
    { title: 'Statut', dataIndex: 'status', render: (s: WfDefinitionStatus) => <DefinitionStatusTag status={s} /> },
    { title: 'Faible risque', dataIndex: 'isLowRisk', render: (v: boolean) => (v ? 'Oui' : 'Non') },
    { title: 'Mis à jour', dataIndex: 'updatedAt', render: (v: string) => formatDateTime(v) },
    {
      title: 'Actions',
      key: 'actions',
      render: (_: unknown, d) => (
        <div className="wfe-row-actions">
          {openLink(d)}
          {archiveButton(d)}
        </div>
      ),
    },
  ];

  const filtersActive = status !== undefined || search.trim() !== '';

  return (
    <div>
      {header}

      <div className="wf-toolbar">
        <div className="wf-field" style={{ minWidth: 240 }}>
          <label htmlFor="wfe-search">Rechercher un workflow</label>
          <Input
            id="wfe-search"
            allowClear
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Nom ou description"
          />
        </div>
        <div className="wf-field">
          <label htmlFor="wfe-status">Statut</label>
          <Select
            id="wfe-status"
            allowClear
            placeholder="Tous les statuts"
            value={status}
            onChange={(v: number | undefined) => setStatus(v)}
            options={STATUS_OPTIONS}
          />
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

      {loading && items === null ? (
        isDesktop ? (
          <TableSkeleton />
        ) : (
          <CardsSkeleton count={3} />
        )
      ) : filtered.length === 0 && !error ? (
        <Card>
          <EmptyState
            icon="tune"
            title={filtersActive ? 'Aucun workflow ne correspond à ces critères.' : 'Aucun workflow pour le moment.'}
            action={
              filtersActive ? (
                <Button
                  onClick={() => {
                    setSearch('');
                    setStatus(undefined);
                  }}
                >
                  Effacer les filtres
                </Button>
              ) : (
                <Button type="primary" onClick={() => setCreating(true)}>
                  Créer un workflow
                </Button>
              )
            }
          />
        </Card>
      ) : isDesktop ? (
        <Table<WfDefinitionDto>
          rowKey="wfDefinitionId"
          columns={columns}
          dataSource={filtered}
          loading={loading}
          pagination={filtered.length > 25 ? { pageSize: 25, showSizeChanger: false } : false}
        />
      ) : (
        <ul className="wfe-cards" aria-busy={loading}>
          {filtered.map((d) => (
            <li key={d.wfDefinitionId}>
              <article className="wf-card wfe-card" aria-label={d.name}>
                <div className="wfe-card-head">
                  <Link href={`/workflows/conception/${d.wfDefinitionId}`} className="wfe-list-name">
                    {d.name}
                  </Link>
                  <DefinitionStatusTag status={d.status} />
                </div>
                {d.description && <p className="wfe-card-desc">{d.description}</p>}
                <div className="wf-muted">
                  Faible risque : {d.isLowRisk ? 'oui' : 'non'} · Mis à jour {formatDateTime(d.updatedAt)}
                </div>
                <div className="wfe-row-actions wf-touch">
                  {openLink(d)}
                  {archiveButton(d)}
                </div>
              </article>
            </li>
          ))}
        </ul>
      )}

      <CreateDefinitionModal open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}
