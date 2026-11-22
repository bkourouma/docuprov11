'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, Input } from 'antd';
import type { WfDefinitionDto } from '@archivage/types';
import { PageHeader } from '../../components/PageHeader';
import { EmptyState } from '../../components/EmptyState';
import { CardsSkeleton } from '../../components/skeletons';
import { WorkflowApiError, workflowErrorMessage, workflowsApi } from '../../lib/workflows-api';
import { useWorkflowAccess } from '../_lib/useWorkflowAccess';
import { AccessDenied } from '../instances/_components/AccessDenied';
import { LaunchModal } from './_components/LaunchModal';
import '../workflows.css';
import '../instances/instances.css';

/** Docu-Flow : liste des workflows lançables et lancement manuel (réservé au menu « Lancer »). */
export default function LaunchPage() {
  const { access } = useWorkflowAccess();
  const [items, setItems] = useState<WfDefinitionDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<WfDefinitionDto | null>(null);

  const allowed = access?.canLaunch ?? null;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await workflowsApi.listLaunchable());
      setError(null);
    } catch (e) {
      if (e instanceof WorkflowApiError && e.forbidden) setForbidden(true);
      else setError(workflowErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (allowed) void load();
  }, [allowed, load]);

  const filtered = useMemo(() => {
    const q = search.trim().toLocaleLowerCase('fr');
    if (!items) return [];
    if (!q) return items;
    return items.filter((d) => `${d.name} ${d.description ?? ''}`.toLocaleLowerCase('fr').includes(q));
  }, [items, search]);

  if (access === null) {
    return (
      <div>
        <PageHeader title="Lancer un workflow" icon="send" />
        <CardsSkeleton count={3} />
      </div>
    );
  }
  if (!allowed || forbidden) {
    return (
      <div>
        <PageHeader title="Lancer un workflow" icon="send" />
        <AccessDenied message="Accès refusé. Votre rôle ne permet pas de lancer des workflows. Demandez l’accès à un administrateur." />
      </div>
    );
  }

  return (
    <div>
      <PageHeader title="Lancer un workflow" icon="send" />

      <div className="wf-toolbar">
        <div className="wf-field" style={{ minWidth: 260 }}>
          <label htmlFor="wfi-search">Rechercher un workflow</label>
          <Input
            id="wfi-search"
            allowClear
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Nom ou description"
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
        <CardsSkeleton count={3} />
      ) : filtered.length === 0 && !error ? (
        <Card>
          <EmptyState
            icon="send"
            title={
              search.trim()
                ? 'Aucun workflow ne correspond à cette recherche.'
                : 'Aucun workflow publié n’est disponible pour le moment.'
            }
            action={search.trim() ? <Button onClick={() => setSearch('')}>Effacer la recherche</Button> : undefined}
          />
        </Card>
      ) : (
        <ul className="wfi-launch-grid" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {filtered.map((d) => (
            <li key={d.wfDefinitionId}>
              <article className="wf-card wfi-launch-card" aria-label={d.name}>
                <span className="wfi-launch-name">{d.name}</span>
                {d.description && <p className="wfi-launch-desc">{d.description}</p>}
                <div className="wf-touch">
                  <Button type="primary" onClick={() => setSelected(d)} aria-label={`Lancer le workflow ${d.name}`}>
                    Lancer
                  </Button>
                </div>
              </article>
            </li>
          ))}
        </ul>
      )}

      <LaunchModal definition={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
