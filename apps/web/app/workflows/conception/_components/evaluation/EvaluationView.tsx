'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, App, Button, Card, Grid, Select } from 'antd';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import type { WfAgentConfigDetailDto, WfEvalCaseDto, WfEvalRunDto, WfEvalSetDto } from '@archivage/types';
import { PageHeader } from '../../../../components/PageHeader';
import { CardsSkeleton } from '../../../../components/skeletons';
import { workflowErrorMessage, workflowsApi } from '../../../../lib/workflows-api';
import type { WfDefinitionDetail, WfEvalStatus } from '../../../../lib/workflows-api';
import { useWorkflowAccess } from '../../../_lib/useWorkflowAccess';
import { AccessDenied } from '../../../instances/_components/AccessDenied';
import { canAddCase, evalRunVerdict, isRunInProgress } from '../../../_lib/eval-logic';
import { evaluationHref } from '../../../_lib/guardrails-links';
import { EligibilityPanel, buildChecklist } from './EligibilityPanel';
import { EvalSetsPanel } from './EvalSetsPanel';
import { EvalCasesPanel } from './EvalCasesPanel';
import { EvalSetModal } from './EvalSetModal';
import { EvalCaseModal } from './EvalCaseModal';
import { RunsList } from './RunsList';
import { useEvalRunPolling } from './useEvalRunPolling';
import {
  activeCaseCount,
  agentStepsOfDraftAgents,
  agentStepsOfGraph,
  caseLabelMap,
  hasPassedRun,
  latestVersionNumber,
  linkSetInput,
  linkedSetIdOf,
  parseDefinitionId,
  pickStepKey,
  runAnnouncement,
  runLaunchState,
  setsForStep,
  sortRunsDesc,
  upsertRun,
  type AgentStepOption,
} from './evaluation-view-logic';
import '../../../workflows.css';
import './evaluation.css';

/**
 * Écran d'évaluation d'une étape agent : éligibilité, jeux, cas, lancement et historique des runs.
 * Le serveur reste juge de tous les droits et règles ; les erreurs sont traduites par `workflowErrorMessage`.
 */
export function EvaluationView() {
  const params = useParams<{ definitionId?: string }>();
  const definitionId = parseDefinitionId(params?.definitionId);
  const searchParams = useSearchParams();
  const requestedStep = searchParams?.get('etape') ?? null;
  const router = useRouter();
  const { modal, message } = App.useApp();
  const { access } = useWorkflowAccess();
  const screens = Grid.useBreakpoint();
  const isDesktop = Boolean(screens.md);

  // Chargement de base
  const [definition, setDefinition] = useState<WfDefinitionDetail | null>(null);
  const [steps, setSteps] = useState<AgentStepOption[] | null>(null);
  const [drafts, setDrafts] = useState<WfAgentConfigDetailDto[] | null>(null);
  const [baseError, setBaseError] = useState<string | null>(null);
  const [loadingBase, setLoadingBase] = useState(true);

  // Éligibilité
  const [status, setStatus] = useState<WfEvalStatus | null | undefined>(undefined);
  const [statusLoading, setStatusLoading] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);

  // Jeux, cas, runs
  const [sets, setSets] = useState<WfEvalSetDto[] | null>(null);
  const [setsError, setSetsError] = useState<string | null>(null);
  const [selectedSetId, setSelectedSetId] = useState<number | null>(null);
  const [cases, setCases] = useState<WfEvalCaseDto[] | null>(null);
  const [casesError, setCasesError] = useState<string | null>(null);
  const [runs, setRuns] = useState<WfEvalRunDto[] | null>(null);
  const [runsError, setRunsError] = useState<string | null>(null);

  // Actions
  const [linkBusy, setLinkBusy] = useState<number | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [announce, setAnnounce] = useState('');
  const [setModal, setSetModal] = useState<{ open: boolean; editing: WfEvalSetDto | null }>({ open: false, editing: null });
  const [caseModal, setCaseModal] = useState<{ open: boolean; editing: WfEvalCaseDto | null }>({ open: false, editing: null });
  const [caseBusy, setCaseBusy] = useState<number | null>(null);
  const [caseActionError, setCaseActionError] = useState<string | null>(null);

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const canDesign = access?.canDesign ?? null;
  const stepKey = useMemo(() => pickStepKey(requestedStep, steps ?? []), [requestedStep, steps]);

  // ---- Éligibilité -------------------------------------------------------
  const statusReq = useRef(0);
  const refreshStatus = useCallback(async () => {
    if (definitionId === null) return;
    const id = ++statusReq.current;
    setStatusLoading(true);
    try {
      const s = await workflowsApi.getEvalStatus(definitionId);
      if (!alive.current || id !== statusReq.current) return;
      setStatus(s);
      setStatusError(null);
    } catch (e) {
      if (!alive.current || id !== statusReq.current) return;
      setStatusError(workflowErrorMessage(e));
      setStatus((prev) => (prev === undefined ? null : prev));
    } finally {
      if (alive.current && id === statusReq.current) setStatusLoading(false);
    }
  }, [definitionId]);

  // ---- Chargement de base ------------------------------------------------
  useEffect(() => {
    if (definitionId === null || canDesign !== true) return;
    let cancelled = false;
    setLoadingBase(true);
    setBaseError(null);
    (async () => {
      try {
        const detail = await workflowsApi.getDefinition(definitionId);
        if (cancelled) return;
        setDefinition(detail);
        let found: AgentStepOption[] = [];
        const latest = latestVersionNumber(detail.versions);
        if (latest !== null) {
          try {
            const version = await workflowsApi.getVersion(definitionId, latest);
            found = agentStepsOfGraph(version.graph);
          } catch {
            found = [];
          }
        }
        let agents: WfAgentConfigDetailDto[] | null = null;
        try {
          agents = await workflowsApi.listDraftAgents(definitionId);
        } catch {
          agents = null;
        }
        if (cancelled) return;
        if (found.length === 0 && agents) found = agentStepsOfDraftAgents(agents);
        setDrafts(agents);
        setSteps(found);
      } catch (e) {
        if (!cancelled) setBaseError(workflowErrorMessage(e));
      } finally {
        if (!cancelled) setLoadingBase(false);
      }
    })();
    void refreshStatus();
    return () => {
      cancelled = true;
    };
  }, [definitionId, canDesign, refreshStatus]);

  // ---- Jeux --------------------------------------------------------------
  const loadSets = useCallback(async () => {
    if (definitionId === null) return;
    try {
      const list = await workflowsApi.listEvalSets(definitionId);
      if (!alive.current) return;
      setSets(list);
      setSetsError(null);
    } catch (e) {
      if (!alive.current) return;
      setSets((prev) => prev ?? []);
      setSetsError(workflowErrorMessage(e));
    }
  }, [definitionId]);

  useEffect(() => {
    if (definitionId !== null && canDesign === true) void loadSets();
  }, [definitionId, canDesign, loadSets]);

  const stepStatus = useMemo(
    () => (status && stepKey ? (status.steps.find((s) => s.stepKey === stepKey) ?? null) : null),
    [status, stepKey],
  );
  const linkedSetId = useMemo(() => {
    if (drafts !== null) return linkedSetIdOf(drafts, stepKey);
    return stepStatus?.evalSetId ?? null;
  }, [drafts, stepKey, stepStatus]);

  const visibleSets = useMemo(() => setsForStep(sets, stepKey), [sets, stepKey]);
  const selectedSet = useMemo(
    () => visibleSets.find((s) => s.wfEvalSetId === selectedSetId) ?? null,
    [visibleSets, selectedSetId],
  );

  // Sélection par défaut : jeu lié, sinon premier jeu ; la sélection est rejetée si elle sort de la liste visible.
  useEffect(() => {
    if (sets === null) return;
    setSelectedSetId((cur) => {
      if (cur !== null && visibleSets.some((s) => s.wfEvalSetId === cur)) return cur;
      const linked = linkedSetId !== null ? visibleSets.find((s) => s.wfEvalSetId === linkedSetId) : undefined;
      return linked?.wfEvalSetId ?? visibleSets[0]?.wfEvalSetId ?? null;
    });
  }, [sets, visibleSets, linkedSetId]);

  // ---- Cas et runs du jeu sélectionné -------------------------------------
  const { watch, stop, running: polling, pollError } = useEvalRunPolling({
    onUpdate: (run) => {
      setRuns((prev) => upsertRun(prev ?? [], run));
      setAnnounce(runAnnouncement(run));
    },
    onSettled: (run) => {
      if (run) setAnnounce(`${runAnnouncement(run)} ${evalRunVerdict(run).detail}.`);
      void refreshStatus();
    },
  });

  const caseReq = useRef(0);
  const loadCases = useCallback(async (setId: number) => {
    const id = ++caseReq.current;
    try {
      const list = await workflowsApi.listEvalCases(setId, true);
      if (!alive.current || id !== caseReq.current) return;
      setCases(list);
      setCasesError(null);
    } catch (e) {
      if (!alive.current || id !== caseReq.current) return;
      setCases([]);
      setCasesError(workflowErrorMessage(e));
    }
  }, []);

  const runsReq = useRef(0);
  const loadRuns = useCallback(
    async (setId: number) => {
      const id = ++runsReq.current;
      try {
        const list = sortRunsDesc(await workflowsApi.listEvalRuns(setId));
        if (!alive.current || id !== runsReq.current) return;
        setRuns(list);
        setRunsError(null);
        const latest = list[0];
        if (latest && isRunInProgress(latest)) watch(latest); // run encore en cours : reprise du suivi
      } catch (e) {
        if (!alive.current || id !== runsReq.current) return;
        setRuns([]);
        setRunsError(workflowErrorMessage(e));
      }
    },
    [watch],
  );

  useEffect(() => {
    stop();
    setCases(null);
    setRuns(null);
    setCaseActionError(null);
    setLaunchError(null);
    if (selectedSetId === null) {
      caseReq.current += 1;
      runsReq.current += 1;
      return;
    }
    void loadCases(selectedSetId);
    void loadRuns(selectedSetId);
  }, [selectedSetId, loadCases, loadRuns, stop]);

  // ---- Dérivés -------------------------------------------------------------
  const activeCount = activeCaseCount(cases);
  const labels = useMemo(() => caseLabelMap(cases), [cases]);
  const launch = runLaunchState({
    hasSet: selectedSet !== null,
    setActive: selectedSet?.isActive ?? false,
    activeCases: activeCount,
    running: polling || launching,
    casesLoaded: cases !== null,
  });

  const selectedIsLinked = selectedSetId !== null && selectedSetId === linkedSetId;
  const eligible = stepStatus?.eligible === true;
  const checklist = buildChecklist({
    isLowRisk: definition?.definition.isLowRisk === true,
    evalSetLinked: linkedSetId !== null,
    activeCases: selectedIsLinked ? activeCount : eligible ? 1 : 0,
    hasPassedRun: selectedIsLinked ? hasPassedRun(runs) : eligible,
  });
  const checklistNote =
    linkedSetId !== null && !selectedIsLinked && !eligible
      ? 'Les conditions « cas » et « run réussi » se lisent sur le jeu lié : sélectionnez-le pour les voir à jour.'
      : null;

  // ---- Actions --------------------------------------------------------------
  const changeStep = (key: string) => {
    if (definitionId === null) return;
    const href = evaluationHref(definitionId, key);
    if (href) router.replace(href);
  };

  const linkSet = async (set: WfEvalSetDto | null) => {
    if (definitionId === null || stepKey === null || linkBusy !== null) return;
    setLinkBusy(set?.wfEvalSetId ?? linkedSetId ?? 0);
    setLinkError(null);
    try {
      // Relecture de la configuration du brouillon : l'étape doit y exister avant d'écrire.
      const current = await workflowsApi.listDraftAgents(definitionId);
      if (!current.some((a) => a.stepKey === stepKey)) {
        throw new Error('NOT_IN_DRAFT');
      }
      const saved = await workflowsApi.updateDraftAgent(definitionId, stepKey, linkSetInput(set ? set.wfEvalSetId : null));
      if (!alive.current) return;
      setDrafts(current.map((a) => (a.stepKey === stepKey ? saved : a)));
      message.success(set ? 'Jeu lié à l’étape.' : 'Jeu délié de l’étape.');
      void refreshStatus();
    } catch (e) {
      if (!alive.current) return;
      setLinkError(
        e instanceof Error && e.message === 'NOT_IN_DRAFT'
          ? 'Cette étape ne figure pas dans le brouillon du workflow : ouvrez l’éditeur et enregistrez-le, puis réessayez.'
          : workflowErrorMessage(e),
      );
    } finally {
      if (alive.current) setLinkBusy(null);
    }
  };

  const confirmLaunch = () => {
    if (selectedSet === null || stepKey === null || !launch.allowed) return;
    const set = selectedSet;
    modal.confirm({
      title: 'Lancer une évaluation ?',
      content: (
        <div>
          <p>
            Le jeu « {set.name} » sera exécuté sur l’étape « {stepKey} » avec le modèle IA configuré, cas par cas
            ({activeCount} cas actif{activeCount > 1 ? 's' : ''}).
          </p>
          <p>
            Cette évaluation peut avoir un coût : elle est comptée dans le budget des agents. Elle s’exécute en arrière-plan ;
            vous pouvez suivre son avancement sur cet écran.
          </p>
        </div>
      ),
      okText: 'Lancer l’évaluation',
      cancelText: 'Annuler',
      onOk: async () => {
        setLaunching(true);
        setLaunchError(null);
        try {
          const run = await workflowsApi.runEvalSet(set.wfEvalSetId, { stepKey });
          if (!alive.current) return;
          setRuns((prev) => upsertRun(prev ?? [], run));
          setAnnounce(runAnnouncement(run));
          watch(run);
        } catch (e) {
          if (alive.current) setLaunchError(workflowErrorMessage(e));
        } finally {
          if (alive.current) setLaunching(false);
        }
      },
    });
  };

  const afterCaseChange = () => {
    // Modifier un cas après un run réussi invalide l'éligibilité : on relit l'état.
    void refreshStatus();
    if (selectedSetId !== null) void loadCases(selectedSetId);
  };

  const deactivateCase = (c: WfEvalCaseDto) => {
    if (selectedSetId === null) return;
    const setId = selectedSetId;
    modal.confirm({
      title: 'Désactiver ce cas ?',
      content: `Le cas « ${c.label} » ne sera plus évalué. Si un run a déjà réussi, il faudra relancer une évaluation pour retrouver l’éligibilité. Vous pourrez le réactiver ensuite.`,
      okText: 'Désactiver le cas',
      cancelText: 'Annuler',
      okButtonProps: { danger: true },
      onOk: async () => {
        setCaseBusy(c.wfEvalCaseId);
        setCaseActionError(null);
        try {
          await workflowsApi.removeEvalCase(setId, c.wfEvalCaseId);
          if (alive.current) afterCaseChange();
        } catch (e) {
          if (alive.current) setCaseActionError(workflowErrorMessage(e));
        } finally {
          if (alive.current) setCaseBusy(null);
        }
      },
    });
  };

  const reactivateCase = async (c: WfEvalCaseDto) => {
    if (selectedSetId === null || !canAddCase(activeCount)) return;
    setCaseBusy(c.wfEvalCaseId);
    setCaseActionError(null);
    try {
      await workflowsApi.updateEvalCase(selectedSetId, c.wfEvalCaseId, { isActive: true });
      if (alive.current) afterCaseChange();
    } catch (e) {
      if (alive.current) setCaseActionError(workflowErrorMessage(e));
    } finally {
      if (alive.current) setCaseBusy(null);
    }
  };

  // ---- Rendu ----------------------------------------------------------------
  const name = definition?.definition.name ?? null;
  const editorHref = definitionId !== null ? `/workflows/conception/${definitionId}` : '/workflows/conception';
  const header = (
    <PageHeader
      title="Évaluation des agents"
      icon="tune"
      breadcrumb={[
        { label: 'Conception', href: '/workflows/conception' },
        ...(name && definitionId !== null ? [{ label: name, href: editorHref }] : []),
        { label: 'Évaluation' },
      ]}
      actions={
        <Link href={editorHref} aria-label="Retour à l’éditeur du workflow">
          <Button tabIndex={-1}>Retour à l’éditeur</Button>
        </Link>
      }
    />
  );

  if (definitionId === null) {
    return (
      <div>
        {header}
        <AccessDenied message="Ce workflow est introuvable : l’adresse est invalide." />
      </div>
    );
  }
  if (canDesign === null) {
    return (
      <div>
        {header}
        <CardsSkeleton count={2} />
      </div>
    );
  }
  if (!canDesign) {
    return (
      <div>
        {header}
        <AccessDenied message="Accès refusé. Votre rôle ne permet pas de concevoir des workflows ni d’évaluer leurs agents. Demandez l’accès à un administrateur." />
      </div>
    );
  }
  if (loadingBase) {
    return (
      <div>
        {header}
        <CardsSkeleton count={3} />
      </div>
    );
  }
  if (baseError) {
    return (
      <div>
        {header}
        <Alert type="error" showIcon message={baseError} role="alert" />
      </div>
    );
  }

  const stepOptions = (steps ?? []).map((s) => ({
    value: s.key,
    label: s.name === s.key ? s.key : `${s.name} (${s.key})`,
  }));

  return (
    <div className="wfev-root wf-touch">
      {header}

      <div className="wf-sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announce}
      </div>

      <Alert
        type="info"
        showIcon
        className="wfev-reminder"
        message="L’évaluation porte sur la dernière version enregistrée du workflow, brouillon compris."
        description="Toute modification de l’agent (objectif, outils, seuil de confiance) ou des cas après un run réussi invalide l’éligibilité à l’autonomie : il faut alors relancer une évaluation."
      />

      <div className="wf-toolbar">
        <div className="wf-field" style={{ minWidth: 280 }}>
          <label htmlFor="wfev-step">Étape agent à évaluer</label>
          <Select
            id="wfev-step"
            value={stepKey ?? undefined}
            options={stepOptions}
            onChange={(v: string) => changeStep(v)}
            placeholder="Aucune étape agent"
            disabled={stepOptions.length === 0}
          />
        </div>
        {name && <div className="wf-muted">Workflow : {name}</div>}
      </div>

      {stepKey === null ? (
        <Card>
          <div role="status">
            <p>
              <strong>Ce workflow ne contient aucune étape agent.</strong>
            </p>
            <p className="wf-muted">Ajoutez une étape de type agent depuis l’éditeur, enregistrez-la, puis revenez ici.</p>
          </div>
        </Card>
      ) : (
        <>
          <EligibilityPanel
            available={status === undefined ? undefined : status !== null}
            step={stepStatus}
            stepKey={stepKey}
            versionNumber={status ? status.versionNumber : null}
            checklist={checklist}
            checklistNote={checklistNote}
            loading={statusLoading}
            error={statusError}
            onRefresh={() => void refreshStatus()}
          />

          <EvalSetsPanel
            sets={visibleSets}
            loading={sets === null}
            error={setsError}
            stepKey={stepKey}
            selectedSetId={selectedSetId}
            linkedSetId={linkedSetId}
            linkBusy={linkBusy}
            linkError={linkError}
            onSelect={setSelectedSetId}
            onCreate={() => setSetModal({ open: true, editing: null })}
            onEdit={(s) => setSetModal({ open: true, editing: s })}
            onLink={(s) => void linkSet(s)}
            onUnlink={() => void linkSet(null)}
            onRetry={() => void loadSets()}
          />

          {selectedSet && (
            <>
              <EvalCasesPanel
                set={selectedSet}
                cases={cases}
                error={casesError}
                actionError={caseActionError}
                busyCaseId={caseBusy}
                isDesktop={isDesktop}
                onAdd={() => setCaseModal({ open: true, editing: null })}
                onEdit={(c) => setCaseModal({ open: true, editing: c })}
                onDeactivate={deactivateCase}
                onReactivate={(c) => void reactivateCase(c)}
                onRetry={() => void loadCases(selectedSet.wfEvalSetId)}
              />

              <section className="wfev-panel" aria-labelledby="wfev-runs-title">
                <div className="wfev-panel-head">
                  <h2 id="wfev-runs-title" className="wfev-h2">
                    Évaluations (runs)
                  </h2>
                  <Button
                    type="primary"
                    onClick={confirmLaunch}
                    disabled={!launch.allowed}
                    loading={launching}
                    aria-describedby="wfev-launch-help"
                  >
                    Lancer une évaluation
                  </Button>
                </div>
                <p id="wfev-launch-help" className="wf-muted">
                  {launch.reason ??
                    'L’évaluation utilise le modèle IA configuré : elle peut avoir un coût (budget des agents) et s’exécute en arrière-plan.'}
                </p>
                {polling && (
                  <Alert
                    type="info"
                    showIcon
                    message="Évaluation en cours : les résultats s’afficheront ici dès la fin du run."
                    style={{ marginBottom: 12 }}
                  />
                )}
                {pollError && <Alert type="warning" showIcon message={pollError} style={{ marginBottom: 12 }} />}
                {launchError && <Alert type="error" showIcon role="alert" message={launchError} style={{ marginBottom: 12 }} />}
                {runsError && (
                  <Alert
                    type="error"
                    showIcon
                    role="alert"
                    message={runsError}
                    style={{ marginBottom: 12 }}
                    action={
                      <Button size="small" onClick={() => void loadRuns(selectedSet.wfEvalSetId)}>
                        Réessayer
                      </Button>
                    }
                  />
                )}
                {runs === null ? (
                  <p className="wf-muted">Chargement de l’historique…</p>
                ) : (
                  <RunsList runs={runs} caseLabels={labels} layout={isDesktop ? 'table' : 'cards'} />
                )}
              </section>
            </>
          )}
        </>
      )}

      <EvalSetModal
        open={setModal.open}
        definitionId={definitionId}
        stepKey={stepKey}
        editing={setModal.editing}
        onClose={() => setSetModal({ open: false, editing: null })}
        onSaved={(saved) => {
          setSetModal({ open: false, editing: null });
          setSelectedSetId(saved.wfEvalSetId);
          void loadSets();
          void refreshStatus();
        }}
      />
      {selectedSet && (
        <EvalCaseModal
          open={caseModal.open}
          setId={selectedSet.wfEvalSetId}
          editing={caseModal.editing}
          onClose={() => setCaseModal({ open: false, editing: null })}
          onSaved={() => {
            setCaseModal({ open: false, editing: null });
            afterCaseChange();
          }}
        />
      )}
    </div>
  );
}
