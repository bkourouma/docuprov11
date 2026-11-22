'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Modal, Select } from 'antd';
import Link from 'next/link';
import type { WfBudgetDto } from '@archivage/types';
import { PageHeader } from '../../../../components/PageHeader';
import { TableSkeleton } from '../../../../components/skeletons';
import {
  WorkflowApiError,
  workflowErrorMessage,
  workflowsApi,
  type WfAgentBudgetOverview,
  type WfAgentStatus,
} from '../../../../lib/workflows-api';
import { emergencyStopScopeLabel, validateStopReason, type BudgetForm } from '../../../_lib/budget-logic';
import { useWorkflowAccess } from '../../../_lib/useWorkflowAccess';
import '../../../workflows.css';
import './budget.css';
import { BudgetEditModal, editTargetFromRow, type EditTarget } from './BudgetEditModal';
import { workflowDisplayName, workflowsWithoutBudget } from './budget-view-logic';
import { ConsumptionCard } from './ConsumptionCard';
import { EmergencyStopConfirm } from './EmergencyStopConfirm';
import { StatusBanner } from './StatusBanner';

interface StopTarget {
  definitionId: number | null;
  name: string | null;
  active: boolean;
}

export function BudgetView() {
  const { access } = useWorkflowAccess();
  const allowed = access ? access.canAdminister : null;

  const [status, setStatus] = useState<WfAgentStatus | null>(null);
  const [overview, setOverview] = useState<WfAgentBudgetOverview | null>(null);
  const [definitions, setDefinitions] = useState<Array<{ wfDefinitionId: number; name: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);
  const [stopTarget, setStopTarget] = useState<StopTarget | null>(null);
  const [typed, setTyped] = useState('');
  const [reason, setReason] = useState('');
  const [stopBusy, setStopBusy] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const [newWorkflow, setNewWorkflow] = useState<number | undefined>();
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mySeq = ++seq.current;
    try {
      const [st, ov] = await Promise.all([workflowsApi.getAgentStatus(), workflowsApi.getAgentBudget()]);
      if (mySeq !== seq.current) return;
      setStatus(st);
      setOverview(ov);
      setError(null);
      setForbidden(false);
    } catch (e) {
      if (mySeq !== seq.current) return;
      if (e instanceof WorkflowApiError && e.forbidden) setForbidden(true);
      else setError(workflowErrorMessage(e));
    } finally {
      if (mySeq === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!allowed) return;
    void load();
  }, [allowed, load]);

  // Noms des workflows : un échec est toléré (repli « Workflow n° X », sélecteur vide).
  useEffect(() => {
    if (!allowed) return;
    let alive = true;
    workflowsApi
      .listDefinitions()
      .then((list) => {
        if (alive) setDefinitions(list.map((d) => ({ wfDefinitionId: d.wfDefinitionId, name: d.name })));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [allowed]);

  const names = useMemo(() => new Map(definitions.map((d) => [d.wfDefinitionId, d.name] as const)), [definitions]);
  const options = useMemo(
    () => workflowsWithoutBudget(definitions, overview ? [overview.global, ...overview.workflows] : []),
    [definitions, overview],
  );

  if (access === null) {
    return (
      <div>
        <PageHeader title="Plafonds et arrêt d’urgence" icon="lock" />
        <TableSkeleton rows={4} columns={3} />
      </div>
    );
  }

  if (!allowed || forbidden) {
    return (
      <div>
        <PageHeader title="Plafonds et arrêt d’urgence" icon="lock" />
        <div role="alert" className="wfp-denied">
          <p>
            Accès refusé. Votre rôle ne donne pas accès à l’administration des workflows : les plafonds et l’arrêt
            d’urgence des agents lui sont réservés.
          </p>
          <Link href="/workflows">Retour à Docu-Flow</Link>
        </div>
      </div>
    );
  }

  const openStop = (t: StopTarget) => {
    setTyped('');
    setReason('');
    setStopError(null);
    setStopTarget(t);
  };

  const closeStop = () => {
    if (!stopBusy) setStopTarget(null);
  };

  const confirmStop = async () => {
    if (!stopTarget) return;
    const reasonCheck = validateStopReason(reason, stopTarget.active);
    if (!reasonCheck.ok) return;
    setStopBusy(true);
    setStopError(null);
    try {
      await workflowsApi.setEmergencyStop({
        definitionId: stopTarget.definitionId,
        active: stopTarget.active,
        ...(stopTarget.active && reasonCheck.value !== '' ? { reason: reasonCheck.value } : {}),
      });
      const scope = emergencyStopScopeLabel(stopTarget.definitionId, stopTarget.name);
      setStopTarget(null);
      setNotice(
        stopTarget.active
          ? `Arrêt d’urgence activé. Portée : ${scope}.`
          : `Arrêt d’urgence levé. Portée : ${scope}. Les agents reprennent.`,
      );
      await load();
    } catch (e) {
      setStopError(workflowErrorMessage(e));
    } finally {
      setStopBusy(false);
    }
  };

  const startNewCap = () => {
    if (newWorkflow === undefined || !overview) return;
    const g = overview.global;
    const initial: BudgetForm = {
      definitionId: newWorkflow,
      capRaw: '',
      periodKind: g.periodKind,
      thresholdRaw: String(Math.round(Number(g.alertThreshold) * 100) || 80),
      currencyRaw: g.currency,
    };
    setEditTarget({ definitionId: newWorkflow, title: workflowDisplayName(newWorkflow, names), row: null, initial });
  };

  const rowActions = (row: WfBudgetDto, title: string) => (
    <>
      <Button onClick={() => setEditTarget(editTargetFromRow(row, title))}>Modifier le plafond</Button>
      <div className="wfp-danger-zone">
        <span className="wfp-danger-label">Zone sensible</span>
        {row.emergencyStop ? (
          <Button onClick={() => openStop({ definitionId: row.definitionId, name: row.definitionId === null ? null : (names.get(row.definitionId) ?? null), active: false })}>
            Lever l’arrêt d’urgence
          </Button>
        ) : (
          <Button danger onClick={() => openStop({ definitionId: row.definitionId, name: row.definitionId === null ? null : (names.get(row.definitionId) ?? null), active: true })}>
            Arrêt d’urgence
          </Button>
        )}
      </div>
    </>
  );

  return (
    <div className="wfp-page wf-touch">
      <PageHeader
        title="Plafonds et arrêt d’urgence"
        icon="lock"
        breadcrumb={[{ label: 'Administration des workflows', href: '/workflows/administration' }, { label: 'Plafonds et arrêt d’urgence' }]}
        actions={
          <Button onClick={() => void load()} loading={loading}>
            Actualiser
          </Button>
        }
      />

      <div role="status" aria-live="polite" className="wfp-live">
        {notice && <Alert type="success" showIcon closable onClose={() => setNotice(null)} message={notice} />}
      </div>
      {error && <Alert type="error" showIcon role="alert" message={error} className="wfp-gap" />}

      {loading && !overview ? (
        <TableSkeleton rows={4} columns={3} />
      ) : (
        overview && (
          <>
            <StatusBanner status={status} overview={overview} />

            <section className="wfp-section" aria-labelledby="wfp-global-title">
              <h2 id="wfp-global-title" className="wfp-h2">
                Plafond global
              </h2>
              <p className="wf-muted">S’applique à l’ensemble des agents, en plus des plafonds par workflow.</p>
              <ConsumptionCard
                budget={overview.global}
                title="Plafond global"
                headingId="wfp-card-global"
                actions={rowActions(overview.global, 'Plafond global')}
              />
            </section>

            <section className="wfp-section" aria-labelledby="wfp-wf-title">
              <h2 id="wfp-wf-title" className="wfp-h2">
                Plafonds par workflow
              </h2>
              {overview.workflows.length === 0 ? (
                <p className="wf-muted">Aucun plafond par workflow n’est défini : seul le plafond global s’applique.</p>
              ) : (
                <div className="wfp-grid">
                  {overview.workflows.map((row) => {
                    const title = workflowDisplayName(row.definitionId, names);
                    return (
                      <ConsumptionCard
                        key={row.wfBudgetId}
                        budget={row}
                        title={title}
                        headingId={`wfp-card-${row.wfBudgetId}`}
                        actions={rowActions(row, title)}
                      />
                    );
                  })}
                </div>
              )}

              <div className="wfp-new">
                <h3 className="wfp-h3">Définir un plafond pour un workflow</h3>
                <div className="wfp-new-row">
                  <div className="wfp-field">
                    <label htmlFor="wfp-new-wf">Workflow</label>
                    <Select
                      id="wfp-new-wf"
                      value={newWorkflow}
                      onChange={setNewWorkflow}
                      options={options}
                      showSearch
                      optionFilterProp="label"
                      placeholder={options.length === 0 ? 'Aucun workflow disponible' : 'Choisir un workflow'}
                      disabled={options.length === 0}
                      notFoundContent="Aucun workflow"
                    />
                  </div>
                  <Button type="primary" disabled={newWorkflow === undefined} onClick={startNewCap}>
                    Définir un plafond
                  </Button>
                </div>
              </div>
            </section>

            <p className="wfp-note">
              Le seuil d’alerte est indicatif : il colore et décrit la consommation à l’écran, mais aucune alerte n’est
              encore émise lorsqu’il est atteint (limite connue, docs/workflow-agents.md, section 12).
            </p>
          </>
        )
      )}

      <footer className="wfp-footer">
        <p>
          Les appels au modèle consommés sont comptés en temps réel. Le tarif par 1 000 jetons est configuré côté
          serveur (variables d’environnement) et n’est pas modifiable ici ; voir la procédure d’exploitation
          docs/workflow-deploiement.md.
        </p>
      </footer>

      <BudgetEditModal
        target={editTarget}
        onClose={() => setEditTarget(null)}
        onSaved={(message) => {
          setEditTarget(null);
          setNotice(message);
          void load();
        }}
      />

      <Modal
        open={stopTarget !== null}
        title={
          stopTarget?.active
            ? 'Activer l’arrêt d’urgence'
            : 'Lever l’arrêt d’urgence'
        }
        footer={null}
        onCancel={closeStop}
        keyboard
        maskClosable={false}
        destroyOnHidden
      >
        {stopTarget && (
          <EmergencyStopConfirm
            active={stopTarget.active}
            definitionId={stopTarget.definitionId}
            workflowName={stopTarget.name}
            typed={typed}
            reason={reason}
            busy={stopBusy}
            error={stopError}
            onTypedChange={setTyped}
            onReasonChange={setReason}
            onConfirm={() => void confirmStop()}
            onCancel={closeStop}
          />
        )}
      </Modal>
    </div>
  );
}
