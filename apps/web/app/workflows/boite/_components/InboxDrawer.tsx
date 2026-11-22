'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Drawer, Grid, Skeleton } from 'antd';
import { workflowsApi, workflowErrorMessage } from '../../../lib/workflows-api';
import type { WfInboxEntry, WfInstanceDetail } from '../../../lib/workflows-api';
import { icons, iconDefaults } from '../../../theme/icons';
import type { WfAccess } from '../../_lib/access';
import { formatDateTime } from '../../_lib/format';
import { allowedActions, entryDueAt, isOpenEntry, noActionReason, proposalAsResult } from '../../_lib/inbox-logic';
import { stepTypeLabel } from '../../_lib/labels';
import { DueTag, InboxStatusTag, PriorityTag } from '../../_components/StatusTags';
import { WF_TASK_TYPE_KEYS } from '@archivage/types';
import { DelegateModal, RejectModal } from './ActionModals';
import { AgentProposalPanel } from './AgentProposalPanel';
import { NatureTag } from './NatureTag';
import { TaskForm } from './TaskForm';

/** Action en cours (un seul appel à la fois : pas de double envoi). */
export type PendingAction = 'claim' | 'complete' | 'accept' | 'reject' | 'delegate';

/** Chaque rappel renvoie un message d'erreur affichable, ou null en cas de succès. */
export interface DrawerActions {
  onClaim: () => Promise<string | null>;
  onComplete: (result: Record<string, unknown>, rowVersion: number, accepted: boolean) => Promise<string | null>;
  onReject: (comment: string | undefined) => Promise<string | null>;
  onDelegate: (toUserGroupId: number, comment: string | undefined) => Promise<string | null>;
}

type FormMode = 'closed' | 'complete' | 'modify';

/**
 * Détail d'un élément de boîte (Drawer antd : focus piégé, Échap, titre). À l'ouverture :
 * - l'instance est lue pour obtenir `rowVersion` (envoyé en `expectedRowVersion` à la clôture) ;
 * - si l'utilisateur a le menu de conception, la configuration de l'étape est lue dans la version publiée
 *   de la définition. L'API de boîte ne l'expose pas : sans ce menu, un formulaire générique est utilisé.
 */
export function InboxDrawer({
  entry,
  open,
  access,
  pending,
  actions,
  onClose,
  onAfterClose,
}: {
  entry: WfInboxEntry | null;
  open: boolean;
  access: WfAccess | null;
  pending: PendingAction | null;
  actions: DrawerActions;
  onClose: () => void;
  onAfterClose: () => void;
}) {
  const screens = Grid.useBreakpoint();
  const wide = screens.md === true;
  const canDesign = access?.canDesign === true;

  const itemId = entry?.item.wfInboxItemId ?? null;
  const updatedAt = entry?.item.updatedAt ?? null;
  const instanceId = entry?.item.instanceId ?? null;
  const stepKey = entry?.task.stepKey ?? null;

  const [detail, setDetail] = useState<WfInstanceDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [config, setConfig] = useState<unknown>(null);
  const [configKnown, setConfigKnown] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [mode, setMode] = useState<FormMode>('closed');
  const [formError, setFormError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [modal, setModal] = useState<'reject' | 'delegate' | null>(null);

  // Configuration d'étape déjà lue (clé : définition + version) : évite de relire à chaque actualisation.
  const versionCache = useRef(new Map<string, unknown>());
  const loadedFor = useRef<string | null>(null);

  // Nouvel élément : on repart d'un tiroir propre.
  useEffect(() => {
    setMode('closed');
    setFormError(null);
    setActionError(null);
    setModal(null);
    setDetail(null);
    setDetailError(null);
    setConfig(null);
    setConfigKnown(false);
    loadedFor.current = null;
  }, [itemId]);

  // Fermeture du tiroir : la saisie en cours est abandonnée (le contenu du tiroir est détruit).
  useEffect(() => {
    if (open) return;
    setMode('closed');
    setFormError(null);
    setActionError(null);
  }, [open]);

  // Lecture de l'instance (et de la configuration de l'étape). Relue quand l'élément change côté serveur
  // (`updatedAt`) : la version de ligne peut avoir bougé (prise en charge, escalade…).
  useEffect(() => {
    if (!open || !itemId || !instanceId || !stepKey) return;
    let alive = true;
    void (async () => {
      let d: WfInstanceDetail;
      try {
        d = await workflowsApi.getInstance(instanceId);
      } catch (e) {
        // Une actualisation qui échoue ne retire pas un détail déjà affiché (la clôture reste possible,
        // le serveur arbitrera avec expectedRowVersion).
        if (alive && loadedFor.current !== itemId) setDetailError(workflowErrorMessage(e));
        return;
      }
      if (!alive) return;
      loadedFor.current = itemId;
      setDetail(d);
      setDetailError(null);
      if (!canDesign) {
        setConfig(null);
        setConfigKnown(false);
        return;
      }
      // La configuration est un plus : si seule sa lecture échoue, le formulaire générique prend le relais.
      try {
        const cacheKey = `${d.instance.definitionId}:${d.versionNumber}:${stepKey}`;
        let graphConfig = versionCache.current.get(cacheKey);
        if (graphConfig === undefined) {
          const version = await workflowsApi.getVersion(d.instance.definitionId, d.versionNumber);
          graphConfig = version.graph.steps.find((s) => s.key === stepKey)?.config ?? null;
          versionCache.current.set(cacheKey, graphConfig);
        }
        if (!alive) return;
        setConfig(graphConfig);
        setConfigKnown(true);
      } catch {
        if (!alive) return;
        setConfig(null);
        setConfigKnown(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [open, itemId, instanceId, stepKey, updatedAt, canDesign, reloadKey]);

  const run = useCallback(
    async (fn: () => Promise<string | null>, onError: (m: string) => void): Promise<string | null> => {
      const failure = await fn();
      if (failure) onError(failure);
      return failure;
    },
    [],
  );

  if (!entry) return null;

  const { item, task } = entry;
  const allowed = allowedActions(entry);
  const reason = noActionReason(entry);
  const rowVersion = detail?.instance.rowVersion ?? null;
  const taskInput = detail?.tasks.find((t) => t.wfTaskId === task.wfTaskId)?.input ?? null;
  const isAgent = item.kind === 1;
  const proposalObject = proposalAsResult(entry);
  const busy = pending !== null;
  const stepType = WF_TASK_TYPE_KEYS[task.taskType] ?? 'agent';
  const genericConfigNote = !configKnown && (task.taskType === 0 || task.taskType === 2 || task.taskType === 5);
  const completeBlocked = rowVersion === null;

  const submitForm = async (result: Record<string, unknown>) => {
    if (rowVersion === null) return;
    setFormError(null);
    await run(() => actions.onComplete(result, rowVersion, false), setFormError);
  };

  return (
    <>
      <Drawer
        open={open}
        onClose={busy ? undefined : onClose}
        afterOpenChange={(isOpen) => {
          if (!isOpen) onAfterClose();
        }}
        title={item.title}
        width={wide ? 560 : '100%'}
        destroyOnHidden
        maskClosable={!busy}
        keyboard={!busy}
        footer={
          reason ? (
            <p className="wf-muted wfb-footer-note">{reason}</p>
          ) : (
            <div className="wfb-actions wf-touch">
              {allowed.claim && (
                <Button
                  icon={<icons.lock {...iconDefaults} />}
                  loading={pending === 'claim'}
                  disabled={busy && pending !== 'claim'}
                  onClick={() => void run(actions.onClaim, setActionError)}
                >
                  Prendre en charge
                </Button>
              )}
              {allowed.complete && isAgent && proposalObject && (
                <Button
                  type="primary"
                  icon={<icons.check {...iconDefaults} />}
                  loading={pending === 'accept'}
                  disabled={(busy && pending !== 'accept') || completeBlocked}
                  onClick={() => {
                    if (rowVersion === null) return;
                    setActionError(null);
                    void run(() => actions.onComplete(proposalObject, rowVersion, true), setActionError);
                  }}
                >
                  Accepter la proposition
                </Button>
              )}
              {allowed.complete && (
                <Button
                  type={isAgent && proposalObject ? 'default' : 'primary'}
                  icon={<icons.edit {...iconDefaults} />}
                  disabled={busy || completeBlocked || mode !== 'closed'}
                  onClick={() => {
                    setFormError(null);
                    setActionError(null);
                    setMode(isAgent ? 'modify' : 'complete');
                  }}
                >
                  {isAgent ? 'Modifier puis valider' : 'Terminer'}
                </Button>
              )}
              {allowed.delegate && (
                <Button icon={<icons.users {...iconDefaults} />} disabled={busy} onClick={() => setModal('delegate')}>
                  Déléguer
                </Button>
              )}
              {allowed.reject && (
                <Button danger icon={<icons.close {...iconDefaults} />} disabled={busy} onClick={() => setModal('reject')}>
                  Rejeter
                </Button>
              )}
            </div>
          )
        }
      >
        <div className="wfb-drawer">
          <div className="wfb-tags">
            <NatureTag kind={item.kind} />
            <InboxStatusTag status={item.status} />
            <PriorityTag priority={item.priority} />
          </div>

          <dl className="wfb-meta">
            <div>
              <dt>Workflow</dt>
              <dd>{entry.definitionName}</dd>
            </div>
            <div>
              <dt>Étape</dt>
              <dd>
                {task.stepKey} <span className="wf-muted">({stepTypeLabel(stepType)})</span>
              </dd>
            </div>
            <div>
              <dt>Tentative</dt>
              <dd>n° {task.attempt}</dd>
            </div>
            <div>
              <dt>Échéance</dt>
              <dd>
                {formatDateTime(entryDueAt(entry))}{' '}
                {isOpenEntry(entry) && entryDueAt(entry) && <DueTag dueAt={entryDueAt(entry)} />}
              </dd>
            </div>
          </dl>

          <section aria-labelledby="wfb-instr-title" className="wfb-section">
            <h3 id="wfb-instr-title" className="wfb-sub">
              Consigne
            </h3>
            {task.instructions && task.instructions.trim() !== '' ? (
              <p className="wfb-text">{task.instructions}</p>
            ) : (
              <p className="wf-muted">Aucune consigne n’a été fournie pour cette étape.</p>
            )}
          </section>

          {isAgent && <AgentProposalPanel item={item} />}

          {detailError && (
            <Alert
              type="warning"
              showIcon
              message="Le détail du workflow n’a pas pu être lu"
              description={`${detailError} La clôture n’est possible qu’une fois ce détail chargé.`}
              action={
                <Button size="small" onClick={() => setReloadKey((k) => k + 1)}>
                  Réessayer
                </Button>
              }
            />
          )}
          {!detail && !detailError && allowed.complete && <Skeleton active paragraph={{ rows: 1 }} title={false} />}

          {actionError && <Alert type="error" showIcon message={actionError} />}

          {mode !== 'closed' && allowed.complete && (
            <section aria-labelledby="wfb-form-title" className="wfb-section wf-card">
              <h3 id="wfb-form-title" className="wfb-sub">
                {mode === 'modify' ? 'Modifier puis valider' : 'Terminer la tâche'}
              </h3>
              {genericConfigNote && (
                <p className="wf-muted">
                  La configuration de l’étape n’est pas accessible avec votre profil : un formulaire générique est utilisé.
                </p>
              )}
              <TaskForm
                key={itemId ?? 'none'}
                entry={entry}
                config={config}
                taskInput={taskInput}
                submitting={pending === 'complete'}
                disabled={busy}
                serverError={formError}
                submitLabel={mode === 'modify' ? 'Valider ma version' : 'Terminer la tâche'}
                onSubmit={(r) => void submitForm(r)}
                onCancel={() => {
                  setMode('closed');
                  setFormError(null);
                }}
              />
            </section>
          )}
        </div>
      </Drawer>

      <RejectModal
        open={modal === 'reject'}
        busy={pending === 'reject'}
        title={item.title}
        onCancel={() => setModal(null)}
        onConfirm={async (comment) => {
          const failure = await actions.onReject(comment);
          if (!failure) setModal(null);
          return failure;
        }}
      />
      <DelegateModal
        open={modal === 'delegate'}
        busy={pending === 'delegate'}
        title={item.title}
        selfUserGroupId={access?.userGroupId ?? null}
        onCancel={() => setModal(null)}
        onConfirm={async (to, comment) => {
          const failure = await actions.onDelegate(to, comment);
          if (!failure) setModal(null);
          return failure;
        }}
      />
    </>
  );
}
