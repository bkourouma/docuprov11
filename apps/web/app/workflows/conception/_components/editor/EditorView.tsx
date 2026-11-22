'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, App, Button, Collapse, Drawer, Grid } from 'antd';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import {
  WfDefinitionStatus,
  WfDefinitionVersionStatus,
  type WfDefinitionDto,
  type WfDefinitionVersionDto,
  type WfGraph,
  type WfStep,
  type WfTaskTypeKey,
} from '@archivage/types';
import { PageHeader } from '../../../../components/PageHeader';
import { EmptyState } from '../../../../components/EmptyState';
import { CardsSkeleton } from '../../../../components/skeletons';
import {
  WorkflowApiError,
  workflowErrorMessage,
  workflowsApi,
  type WfDefinitionVersionSummary,
  type WfToolCatalogEntry,
} from '../../../../lib/workflows-api';
import { canMarkLowRisk } from '../../../_lib/access';
import {
  applyGraph,
  canPublish,
  initEditor,
  isDirty,
  isReadOnly,
  loadLayout,
  markSaved,
  parseDefinitionId,
  describeSaveBlockers,
  normalizeChangeNote,
  parseRequestedVersion,
  pickVersionToOpen,
  publishBlockedReason,
  saveBlockers,
  saveLayout,
  select,
  setDescription,
  setLiveIssues,
  setName,
  setPositions,
  setServerIssues,
  setView,
  type EditorState,
  type EditorViewMode,
  type StorageLike,
} from '../../../_lib/editor-state';
import {
  addEdge,
  addStep,
  layoutGraph,
  moveEdge,
  removeEdge,
  removeStep,
  renameStepKey,
  setStart,
  updateEdge,
  updateStep,
  type Position,
  type PositionMap,
} from '../../../_lib/graph-model';
import { mergeIssues, summarizeIssues, validateLive } from '../../../_lib/graph-issues';
import { useWorkflowAccess } from '../../../_lib/useWorkflowAccess';
import { AccessDenied } from '../../../instances/_components/AccessDenied';
import { AuthoringBanner } from '../authoring/AuthoringBanner';
import { IssuesPanel } from '../canvas/IssuesPanel';
import { StepOutline } from '../canvas/StepOutline';
import { StepPalette } from '../canvas/StepPalette';
import type { EditorSelection } from '../canvas/types';
import { DefinitionStatusTag, VersionStatusTag } from './DefinitionStatusTags';
import { EditorToolbar, type ToolbarBusy } from './EditorToolbar';
import { PropertiesPane } from './PropertiesPane';
import { PublishModal } from './PublishModal';
import { useLeaveGuard } from './useLeaveGuard';
import { DESCRIPTION_MAX, NAME_MAX } from './WorkflowInfoPanel';
import '../../../workflows.css';
import '../panels/panels.css';
import '../authoring/authoring.css';
import './editeur.css';

// Le canevas (React Flow) mesure le DOM : on ne le rend pas côté serveur.
const FlowCanvas = dynamic(() => import('../canvas/FlowCanvas').then((m) => m.FlowCanvas), {
  ssr: false,
  loading: () => (
    <div className="wfe-canvas-loading" role="status">
      Chargement du canevas…
    </div>
  ),
});

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'invalid' }
  | { kind: 'forbidden' }
  | { kind: 'notfound'; message: string }
  | { kind: 'error'; message: string };

type SaveStatus = { kind: 'idle' | 'saving' | 'saved' | 'error'; text: string };

/** `localStorage` peut lever (navigation privée, stockage bloqué) : on le traite comme absent. */
function safeStorage(): StorageLike | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function setUrlVersion(versionNumber: number): void {
  try {
    const url = new URL(window.location.href);
    url.searchParams.set('version', String(versionNumber));
    window.history.replaceState(window.history.state, '', url);
  } catch {
    /* sans importance : l'URL ne sert qu'à partager le lien */
  }
}

function hhmm(): string {
  return new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

/** Éditeur d'un workflow : chargement, état, enregistrement, vérification, publication, versions, archivage. */
export function EditorView() {
  const params = useParams<{ definitionId?: string }>();
  const definitionId = parseDefinitionId(params?.definitionId);
  const router = useRouter();
  const { message, modal } = App.useApp();
  const { access } = useWorkflowAccess();
  const bp = Grid.useBreakpoint();
  const isDesktop = Boolean(bp.lg);
  const isMobile = !bp.md;

  const [load, setLoad] = useState<LoadState>({ kind: 'loading' });
  const [definition, setDefinition] = useState<WfDefinitionDto | null>(null);
  const [versions, setVersions] = useState<WfDefinitionVersionSummary[]>([]);
  const [version, setVersion] = useState<WfDefinitionVersionDto | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [liveFor, setLiveFor] = useState<WfGraph | null>(null);
  const [tools, setTools] = useState<WfToolCatalogEntry[] | null>(null);
  const [hasPassedEval, setHasPassedEval] = useState<boolean | null>(null);

  const [busy, setBusy] = useState<ToolbarBusy>(null);
  const [versionsBusy, setVersionsBusy] = useState(false);
  const [lowRiskBusy, setLowRiskBusy] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>({ kind: 'idle', text: '' });
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishNote, setPublishNote] = useState('');
  const [panelOpen, setPanelOpen] = useState(false);
  const [issuesKey, setIssuesKey] = useState<string[]>(['issues']);
  const [focusTick, setFocusTick] = useState(0);

  const propsRef = useRef<HTMLElement | null>(null);
  // Copies « dernière valeur » pour les gestionnaires asynchrones (évite les fermetures périmées).
  const editorRef = useRef<EditorState | null>(null);
  const versionRef = useRef<WfDefinitionVersionDto | null>(null);
  const definitionRef = useRef<WfDefinitionDto | null>(null);
  const versionsRef = useRef<WfDefinitionVersionSummary[]>([]);
  const readOnlyRef = useRef(true);
  const auxLoaded = useRef(false);
  const loadSeq = useRef(0);

  const canDesign = access?.canDesign ?? null;

  /** Applique une transformation pure à l'état de l'éditeur ; la ref est à jour AVANT le rendu suivant. */
  const update = useCallback((fn: (s: EditorState) => EditorState) => {
    const current = editorRef.current;
    if (!current) return;
    const next = fn(current);
    if (next === current) return;
    editorRef.current = next;
    setEditor(next);
  }, []);

  /** Installe une version à l'écran : état propre, positions enregistrées, problèmes locaux calculés d'emblée. */
  const adopt = useCallback(
    (def: WfDefinitionDto, list: WfDefinitionVersionSummary[], ver: WfDefinitionVersionDto, view?: EditorViewMode) => {
      const initialView: EditorViewMode =
        view ?? (typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches ? 'list' : 'graph');
      const base = initEditor({
        graph: ver.graph,
        name: def.name,
        description: def.description,
        positions: loadLayout(safeStorage(), def.wfDefinitionId),
        view: initialView,
      });
      const next = setLiveIssues(base, validateLive(ver.graph, { isLowRisk: def.isLowRisk }).issues);
      definitionRef.current = def;
      versionRef.current = ver;
      versionsRef.current = list;
      editorRef.current = next;
      setDefinition(def);
      setVersions(list);
      setVersion(ver);
      setEditor(next);
      setLiveFor(next.graph);
      setSaveStatus({ kind: 'idle', text: '' });
    },
    [],
  );

  const loadAll = useCallback(
    async (requested?: number) => {
      if (definitionId === null) return;
      const seq = ++loadSeq.current;
      setLoad({ kind: 'loading' });
      try {
        const detail = await workflowsApi.getDefinition(definitionId);
        const number = pickVersionToOpen(detail.versions, requested);
        if (number === null) {
          throw new WorkflowApiError(404, 'Ce workflow ne contient aucune version.');
        }
        const [ver, toolList, evalStatus] = await Promise.all([
          workflowsApi.getVersion(definitionId, number),
          // Chargés une seule fois ; `null` (API absente ou refusée) est un état normal, jamais une erreur.
          auxLoaded.current ? Promise.resolve(undefined) : workflowsApi.listAgentTools().catch(() => null),
          auxLoaded.current ? Promise.resolve(undefined) : workflowsApi.getEvaluationStatus(definitionId).catch(() => null),
        ]);
        if (seq !== loadSeq.current) return;
        if (!auxLoaded.current) {
          auxLoaded.current = true;
          setTools(toolList ?? null);
          setHasPassedEval(evalStatus ? evalStatus.hasPassedEvalRun : null);
        }
        adopt(detail.definition, detail.versions, ver);
        setUrlVersion(number);
        setLoad({ kind: 'ready' });
      } catch (e) {
        if (seq !== loadSeq.current) return;
        if (e instanceof WorkflowApiError && e.forbidden) setLoad({ kind: 'forbidden' });
        else if (e instanceof WorkflowApiError && e.notFound) setLoad({ kind: 'notfound', message: workflowErrorMessage(e) });
        else setLoad({ kind: 'error', message: workflowErrorMessage(e) });
      }
    },
    [adopt, definitionId],
  );

  // Chargement initial : `?version=n` est lu dans l'URL au moment du chargement uniquement.
  useEffect(() => {
    if (definitionId === null) {
      setLoad({ kind: 'invalid' });
      return;
    }
    if (!canDesign) return;
    let requested: number | undefined;
    try {
      requested = parseRequestedVersion(new URLSearchParams(window.location.search).get('version'));
    } catch {
      requested = undefined;
    }
    void loadAll(requested);
  }, [definitionId, canDesign, loadAll]);

  const refreshDetail = useCallback(async () => {
    if (definitionId === null) return;
    try {
      const detail = await workflowsApi.getDefinition(definitionId);
      definitionRef.current = detail.definition;
      versionsRef.current = detail.versions;
      setDefinition(detail.definition);
      setVersions(detail.versions);
    } catch (e) {
      message.warning(`La liste des versions n’a pas pu être actualisée. ${workflowErrorMessage(e)}`);
    }
  }, [definitionId, message]);

  // ----- Dérivés -----
  const readOnly = version && definition ? isReadOnly(version.status, definition.status) : true;
  readOnlyRef.current = readOnly;
  const dirty = editor ? isDirty(editor) : false;
  const isLowRisk = definition?.isLowRisk ?? false;

  // Vérification en direct (debounce 250 ms) : l'état « problèmes locaux » suit le graphe affiché.
  const graph = editor?.graph;
  useEffect(() => {
    if (!graph) return;
    const timer = window.setTimeout(() => {
      const result = validateLive(graph, { isLowRisk });
      update((s) => (s.graph === graph ? setLiveIssues(s, result.issues) : s));
      setLiveFor(graph);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [graph, isLowRisk, update]);

  // Positions : conservées localement (le serveur ne stocke aucune position).
  const positions = editor?.positions;
  useEffect(() => {
    if (!positions || definitionId === null) return;
    const timer = window.setTimeout(() => saveLayout(safeStorage(), definitionId, positions), 400);
    return () => window.clearTimeout(timer);
  }, [positions, definitionId]);

  const allIssues = useMemo(
    () => (editor ? mergeIssues(editor.liveIssues, editor.serverIssues) : []),
    [editor],
  );

  // ----- Confirmations -----
  const confirmDiscard = useCallback(
    () =>
      new Promise<boolean>((resolve) => {
        modal.confirm({
          title: 'Quitter sans enregistrer ?',
          content: 'Vos modifications non enregistrées seront perdues.',
          okText: 'Quitter sans enregistrer',
          cancelText: 'Rester',
          okButtonProps: { danger: true },
          onOk: () => resolve(true),
          onCancel: () => resolve(false),
        });
      }),
    [modal],
  );
  useLeaveGuard(dirty, confirmDiscard, (href) => router.push(href));

  const confirmAsk = useCallback(
    (title: string, content: string, okText: string, danger = false) =>
      new Promise<boolean>((resolve) => {
        modal.confirm({
          title,
          content,
          okText,
          cancelText: 'Annuler',
          okButtonProps: { danger },
          onOk: () => resolve(true),
          onCancel: () => resolve(false),
        });
      }),
    [modal],
  );

  // ----- Modifications du graphe (toujours par les opérations pures de graph-model) -----
  const mutate = useCallback(
    (
      op: (g: WfGraph) => { graph: WfGraph; error?: string },
      opts: { toast?: boolean; apply?: Parameters<typeof applyGraph>[2] } = {},
    ): string | undefined => {
      const current = editorRef.current;
      if (!current || readOnlyRef.current) return undefined;
      const result = op(current.graph);
      if (result.error) {
        if (opts.toast !== false) message.warning(result.error);
        return result.error;
      }
      update((s) => applyGraph(s, result.graph, opts.apply));
      return undefined;
    },
    [message, update],
  );

  const handleSelect = useCallback(
    (selection: EditorSelection) => {
      update((s) => select(s, selection));
      if (selection && !isDesktop) setPanelOpen(true);
    },
    [isDesktop, update],
  );

  const handleAddStep = useCallback(
    (type: WfTaskTypeKey, afterKey?: string) => {
      const current = editorRef.current;
      if (!current || readOnlyRef.current) return;
      const result = addStep(current.graph, type, afterKey !== undefined ? { afterKey } : {});
      update((s) => select(applyGraph(s, result.graph), { kind: 'step', key: result.key }));
      if (!isDesktop) setPanelOpen(true);
    },
    [isDesktop, update],
  );

  const handleDropStep = useCallback(
    (type: WfTaskTypeKey, position: Position) => {
      const current = editorRef.current;
      if (!current || readOnlyRef.current) return;
      const result = addStep(current.graph, type);
      update((s) =>
        select(
          applyGraph(s, result.graph, { positions: { ...s.positions, [result.key]: position } }),
          { kind: 'step', key: result.key },
        ),
      );
    },
    [update],
  );

  const handleDeleteSteps = useCallback(
    (keys: string[]) => {
      const current = editorRef.current;
      if (!current || readOnlyRef.current) return;
      let next = current.graph;
      for (const key of keys) next = removeStep(next, key);
      if (next === current.graph) {
        message.warning('La dernière étape ne peut pas être supprimée : un workflow en a toujours au moins une.');
        return;
      }
      if (keys.includes(current.graph.start) && next.start !== current.graph.start) {
        const first = next.steps.find((s) => s.key === next.start);
        message.info(`L’étape de départ a été supprimée : « ${first?.name ?? next.start} » devient l’étape de départ.`);
      }
      update((s) => applyGraph(s, next));
    },
    [message, update],
  );

  const handleDeleteEdges = useCallback(
    (edges: Array<{ from: string; to: string }>) => {
      const current = editorRef.current;
      if (!current || readOnlyRef.current) return;
      let next = current.graph;
      for (const e of edges) next = removeEdge(next, e.from, e.to);
      update((s) => applyGraph(s, next));
    },
    [update],
  );

  const handleStepChange = useCallback(
    (key: string, patch: Partial<Omit<WfStep, 'key' | 'next'>>) => {
      mutate((g) => ({ graph: updateStep(g, key, patch) }));
    },
    [mutate],
  );

  const handleRenameKey = useCallback(
    (oldKey: string, newKey: string): string | undefined =>
      // Le message d'erreur est affiché par le panneau, sous le champ : pas de notification en plus.
      mutate((g) => renameStepKey(g, oldKey, newKey), {
        toast: false,
        apply: { renamedKey: { from: oldKey, to: newKey } },
      }),
    [mutate],
  );

  const handleAutoLayout = useCallback(() => {
    update((s) => setPositions(s, layoutGraph(s.graph)));
    message.success('Étapes réorganisées automatiquement.');
  }, [message, update]);

  // ----- Enregistrement -----
  const save = useCallback(async (): Promise<boolean> => {
    const s = editorRef.current;
    const def = definitionRef.current;
    const ver = versionRef.current;
    if (!s || !def || !ver || readOnlyRef.current) return false;
    const name = s.name.trim();
    if (name.length < 1 || name.length > NAME_MAX) {
      message.warning(`Le nom du workflow est obligatoire (1 à ${NAME_MAX} caractères).`);
      return false;
    }
    if (s.description.length > DESCRIPTION_MAX) {
      message.warning(`La description ne peut pas dépasser ${DESCRIPTION_MAX} caractères.`);
      return false;
    }
    // Forme invalide (objectif d'agent vide, nom d'étape vide…) : l'API refuserait tout en 400, on explique avant.
    const blockers = saveBlockers(s.graph, def.isLowRisk);
    if (blockers.length > 0) {
      const text = describeSaveBlockers(blockers);
      setSaveStatus({ kind: 'error', text });
      message.warning(text);
      const first = blockers.find((b) => b.stepKey);
      if (first?.stepKey) update((cur) => select(cur, { kind: 'step', key: first.stepKey as string }));
      return false;
    }
    setBusy('save');
    setSaveStatus({ kind: 'saving', text: 'Enregistrement en cours…' });
    // Instantané ENVOYÉ : ce qui change pendant l'appel reste « non enregistré ».
    const snapshot = { graph: s.graph, name: s.name, description: s.description };
    try {
      const res = await workflowsApi.updateDraft(def.wfDefinitionId, {
        graph: s.graph,
        name,
        description: s.description.trim() === '' ? null : s.description,
      });
      definitionRef.current = res.definition;
      setDefinition(res.definition);
      if (res.version.versionNumber !== ver.versionNumber) {
        // Dernière version publiée : l'API a ouvert un NOUVEAU brouillon (numéro suivant).
        versionRef.current = res.version;
        setVersion(res.version);
        setUrlVersion(res.version.versionNumber);
        message.info(`Un nouveau brouillon (version n° ${res.version.versionNumber}) a été créé et ouvert.`);
        void refreshDetail();
      } else {
        versionRef.current = res.version;
        setVersion(res.version);
      }
      update((cur) => markSaved(cur, snapshot));
      setSaveStatus({ kind: 'saved', text: `Brouillon enregistré à ${hhmm()}.` });
      return true;
    } catch (e) {
      const text = workflowErrorMessage(e);
      setSaveStatus({ kind: 'error', text: 'Échec de l’enregistrement : vos modifications sont conservées à l’écran.' });
      message.error(text);
      if (e instanceof WorkflowApiError && e.conflict) void refreshDetail();
      return false;
    } finally {
      setBusy(null);
    }
  }, [message, refreshDetail, update]);

  const verify = useCallback(async () => {
    const s = editorRef.current;
    const def = definitionRef.current;
    if (!s || !def || readOnlyRef.current) return;
    if (isDirty(s)) {
      // Le serveur vérifie le brouillon ENREGISTRÉ : on l'enregistre d'abord, avec l'accord de l'utilisateur.
      const ok = await confirmAsk(
        'Enregistrer avant de vérifier ?',
        'La vérification porte sur le brouillon enregistré. Vos modifications vont d’abord être enregistrées.',
        'Enregistrer et vérifier',
      );
      if (!ok || !(await save())) return;
    }
    setBusy('verify');
    try {
      const res = await workflowsApi.validateDraft(def.wfDefinitionId);
      update((cur) => setServerIssues(cur, res.issues, true));
      if (res.issues.length === 0) message.success('Vérification réussie : aucun problème, le workflow peut être publié.');
      else message.warning(`Vérification terminée : ${summarizeIssues(res.issues).toLowerCase()}.`);
    } catch (e) {
      message.error(workflowErrorMessage(e));
    } finally {
      setBusy(null);
    }
  }, [confirmAsk, message, save, update]);

  const publish = useCallback(async () => {
    const def = definitionRef.current;
    const ver = versionRef.current;
    if (!def || !ver) return;
    setBusy('publish');
    try {
      const note = normalizeChangeNote(publishNote);
      // La note part AVANT la publication : une fois publiée, la version est immuable.
      if (note) await workflowsApi.updateDraft(def.wfDefinitionId, { changeNote: note });
      const res = await workflowsApi.publish(def.wfDefinitionId);
      definitionRef.current = res.definition;
      versionRef.current = res.version;
      setDefinition(res.definition);
      setVersion(res.version);
      setUrlVersion(res.version.versionNumber);
      setPublishOpen(false);
      setPublishNote('');
      update((cur) => setServerIssues(cur, [], false));
      message.success(`Version n° ${res.version.versionNumber} publiée. Elle est désormais immuable.`);
      void refreshDetail();
    } catch (e) {
      setPublishOpen(false);
      if (e instanceof WorkflowApiError && e.status === 422 && e.issues) {
        update((cur) => setServerIssues(cur, e.issues ?? [], true));
        message.error('Publication refusée : le workflow comporte des problèmes. Ils sont listés sous l’éditeur.');
      } else {
        message.error(workflowErrorMessage(e));
        if (e instanceof WorkflowApiError && e.conflict) void refreshDetail();
      }
    } finally {
      setBusy(null);
    }
  }, [message, publishNote, refreshDetail, update]);

  const archiveWorkflow = useCallback(async () => {
    const def = definitionRef.current;
    const s = editorRef.current;
    if (!def) return;
    const ok = await confirmAsk(
      `Archiver « ${def.name} » ?`,
      `Le workflow n’est plus proposé au lancement et devient non modifiable. Les instances en cours ne sont pas touchées.${
        s && isDirty(s) ? ' Les modifications non enregistrées seront perdues.' : ''
      }`,
      'Archiver',
      true,
    );
    if (!ok) return;
    setBusy('archive');
    try {
      const updated = await workflowsApi.archive(def.wfDefinitionId);
      definitionRef.current = updated;
      setDefinition(updated);
      message.success('Workflow archivé : il est maintenant en lecture seule.');
      void refreshDetail();
    } catch (e) {
      message.error(workflowErrorMessage(e));
      if (e instanceof WorkflowApiError && e.conflict) void refreshDetail();
    } finally {
      setBusy(null);
    }
  }, [confirmAsk, message, refreshDetail]);

  /**
   * Nouveau brouillon à partir d'une version figée : `updateDraft` avec le graphe de cette version.
   * S'il existe déjà un brouillon, l'API le met à jour : il est donc ÉCRASÉ, d'où la confirmation.
   */
  const createDraftFrom = useCallback(
    async (versionNumber: number) => {
      const def = definitionRef.current;
      const s = editorRef.current;
      if (!def || def.status === WfDefinitionStatus.Archived) return;
      const existing = versionsRef.current.find((v) => v.status === WfDefinitionVersionStatus.Draft);
      if (existing) {
        const ok = await confirmAsk(
          'Remplacer le brouillon existant ?',
          `Le brouillon actuel (version n° ${existing.versionNumber}) sera écrasé par le contenu de la version n° ${versionNumber}.${
            versionRef.current?.versionNumber === existing.versionNumber && s && isDirty(s)
              ? ' Ses modifications non enregistrées seront aussi perdues.'
              : ''
          } Cette action est irréversible.`,
          'Écraser le brouillon',
          true,
        );
        if (!ok) return;
      } else if (s && isDirty(s)) {
        // Cas limite : brouillon ouvert avec des modifications mais absent de la liste (liste périmée).
        if (!(await confirmDiscard())) return;
      }
      setBusy('draft');
      setVersionsBusy(true);
      try {
        const current = versionRef.current;
        const source =
          current && current.versionNumber === versionNumber
            ? current
            : await workflowsApi.getVersion(def.wfDefinitionId, versionNumber);
        const res = await workflowsApi.updateDraft(def.wfDefinitionId, {
          graph: source.graph,
          changeNote: `Copie de la version ${versionNumber}`,
        });
        const detail = await workflowsApi.getDefinition(def.wfDefinitionId);
        adopt(detail.definition, detail.versions, res.version, editorRef.current?.view);
        setUrlVersion(res.version.versionNumber);
        message.success(`Brouillon (version n° ${res.version.versionNumber}) créé à partir de la version n° ${versionNumber}.`);
      } catch (e) {
        message.error(workflowErrorMessage(e));
        if (e instanceof WorkflowApiError && e.conflict) void refreshDetail();
      } finally {
        setBusy(null);
        setVersionsBusy(false);
      }
    },
    [adopt, confirmAsk, confirmDiscard, message, refreshDetail],
  );

  const openVersion = useCallback(
    async (versionNumber: number) => {
      const def = definitionRef.current;
      const s = editorRef.current;
      if (!def) return;
      if (s && isDirty(s) && !readOnlyRef.current && !(await confirmDiscard())) return;
      setVersionsBusy(true);
      try {
        const ver = await workflowsApi.getVersion(def.wfDefinitionId, versionNumber);
        adopt(def, versionsRef.current, ver, editorRef.current?.view);
        setUrlVersion(versionNumber);
      } catch (e) {
        message.error(workflowErrorMessage(e));
      } finally {
        setVersionsBusy(false);
      }
    },
    [adopt, confirmDiscard, message],
  );

  const changeLowRisk = useCallback(
    async (next: boolean) => {
      const def = definitionRef.current;
      if (!def) return;
      setLowRiskBusy(true);
      try {
        const updated = await workflowsApi.setLowRisk(def.wfDefinitionId, next);
        definitionRef.current = updated;
        setDefinition(updated);
        message.success(next ? 'Workflow marqué à faible risque.' : 'Le marquage « faible risque » a été retiré.');
      } catch (e) {
        // 409 : une étape agent autonome existe encore ; 403 : réservé aux administrateurs.
        message.error(workflowErrorMessage(e));
      } finally {
        setLowRiskBusy(false);
      }
    },
    [message],
  );

  // Ctrl/Cmd + S : enregistrer (confort ; le bouton reste la voie principale).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        const s = editorRef.current;
        if (s && isDirty(s) && !readOnlyRef.current) void save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save]);

  // « Voir le problème » : sélectionne l'étape puis amène le focus sur son panneau.
  const handleFocusStep = useCallback(
    (key: string) => {
      handleSelect({ kind: 'step', key });
      setFocusTick((t) => t + 1);
    },
    [handleSelect],
  );
  useEffect(() => {
    if (focusTick === 0 || !isDesktop) return;
    const el = propsRef.current;
    if (!el) return;
    el.focus();
    el.scrollIntoView({ block: 'nearest' });
  }, [focusTick, isDesktop]);

  // ----- Rendu -----
  if (access === null) {
    return (
      <div>
        <PageHeader title="Conception du workflow" icon="tune" />
        <CardsSkeleton count={2} />
      </div>
    );
  }
  if (!canDesign || load.kind === 'forbidden') {
    return (
      <div>
        <PageHeader title="Conception du workflow" icon="tune" />
        <AccessDenied message="Accès refusé. Votre rôle ne permet pas de concevoir des workflows. Demandez l’accès à un administrateur." />
      </div>
    );
  }
  if (load.kind === 'invalid' || load.kind === 'notfound') {
    return (
      <div>
        <PageHeader title="Conception du workflow" icon="tune" />
        <div role="alert">
          <EmptyState
            icon="alert"
            title={
              load.kind === 'invalid'
                ? 'Ce lien ne correspond à aucun workflow.'
                : 'Ce workflow est introuvable ou n’est plus accessible.'
            }
            action={
              <Link href="/workflows/conception">
                <Button type="primary" tabIndex={-1}>
                  Retour à la liste des workflows
                </Button>
              </Link>
            }
          />
        </div>
      </div>
    );
  }
  if (load.kind === 'error') {
    return (
      <div>
        <PageHeader title="Conception du workflow" icon="tune" />
        <Alert
          type="error"
          showIcon
          message={load.message}
          action={
            <Button size="small" onClick={() => void loadAll()}>
              Réessayer
            </Button>
          }
        />
      </div>
    );
  }
  if (load.kind === 'loading' || !editor || !definition || !version) {
    return (
      <div aria-busy="true">
        <PageHeader title="Conception du workflow" icon="tune" />
        <CardsSkeleton count={2} />
      </div>
    );
  }

  const ctx = { versionStatus: version.status, definitionStatus: definition.status };
  const isDraftVersion = version.status === WfDefinitionVersionStatus.Draft;
  const definitionArchived = definition.status === WfDefinitionStatus.Archived;
  const livePending = liveFor !== editor.graph;
  const publishAllowed = canPublish(editor, ctx) && !livePending;
  const blockedReason = publishAllowed
    ? null
    : (publishBlockedReason(editor, ctx) ?? (livePending ? 'Vérification en cours…' : null));
  const hasAutonomousStep = editor.graph.steps.some((s) => s.agent?.autonomy === 'autonome');
  const displayName = editor.name.trim() === '' ? 'Workflow sans nom' : editor.name;

  const banner = (() => {
    if (definitionArchived) {
      return {
        text: 'Ce workflow est archivé : il est en lecture seule.',
        draft: false,
      };
    }
    if (version.status === WfDefinitionVersionStatus.Published) {
      return {
        text: `Version n° ${version.versionNumber} publiée — immuable. Pour la modifier, créez un brouillon.`,
        draft: true,
      };
    }
    if (version.status === WfDefinitionVersionStatus.Archived) {
      return {
        text: `Version n° ${version.versionNumber} archivée — immuable. Pour la reprendre, créez un brouillon à partir de cette version.`,
        draft: true,
      };
    }
    return null;
  })();

  const propsNode = (
    <PropertiesPane
      graph={editor.graph}
      selection={editor.selection}
      readOnly={readOnly}
      isLowRisk={isLowRisk}
      hasPassedEval={hasPassedEval}
      tools={tools}
      issues={allIssues}
      info={{
        definitionId: definition.wfDefinitionId,
        name: editor.name,
        description: editor.description,
        readOnly,
        isLowRisk,
        canMarkLowRisk: access ? canMarkLowRisk(access) : false,
        lowRiskBusy,
        hasAutonomousStep,
        versions,
        openedVersion: version.versionNumber,
        definitionArchived,
        versionsBusy: versionsBusy || busy !== null,
        onName: (v) => update((s) => setName(s, v)),
        onDescription: (v) => update((s) => setDescription(s, v)),
        onLowRisk: (next) => void changeLowRisk(next),
        onOpenVersion: (n) => void openVersion(n),
        onCreateDraftFrom: (n) => void createDraftFrom(n),
      }}
      onStepChange={handleStepChange}
      onRenameKey={handleRenameKey}
      onSetStart={(key) => mutate((g) => ({ graph: setStart(g, key) }))}
      onRemoveStep={(key) => handleDeleteSteps([key])}
      onEdgeChange={(from, to, patch) => mutate((g) => updateEdge(g, from, to, patch))}
      onMoveEdge={(from, to, delta) => mutate((g) => ({ graph: moveEdge(g, from, to, delta) }))}
      onRemoveEdge={(from, to) => handleDeleteEdges([{ from, to }])}
      onShowInfo={() => handleSelect(null)}
    />
  );

  const drawerTitle =
    editor.selection?.kind === 'step'
      ? 'Propriétés de l’étape'
      : editor.selection?.kind === 'edge'
        ? 'Propriétés de la transition'
        : 'Fiche du workflow';

  const showGraph = editor.view === 'graph';

  const center = showGraph ? (
    <div className="wfe-canvas-box">
      <FlowCanvas
        graph={editor.graph}
        positions={editor.positions}
        issues={allIssues}
        readOnly={readOnly}
        selection={editor.selection}
        onSelect={handleSelect}
        onPositionsChange={(next: PositionMap) => update((s) => setPositions(s, next))}
        onConnect={(from, to) => void mutate((g) => addEdge(g, from, to))}
        onDeleteSteps={handleDeleteSteps}
        onDeleteEdges={handleDeleteEdges}
        onDropStep={handleDropStep}
      />
    </div>
  ) : (
    <StepOutline
      graph={editor.graph}
      issues={allIssues}
      selection={editor.selection}
      readOnly={readOnly}
      onSelect={handleSelect}
      onAddStep={handleAddStep}
      onAddEdge={(from, to) => mutate((g) => addEdge(g, from, to), { toast: false })}
      onRemoveStep={(key) => handleDeleteSteps([key])}
      onRemoveEdge={(from, to) => handleDeleteEdges([{ from, to }])}
    />
  );

  const palette = <StepPalette disabled={readOnly} onAdd={(type) => handleAddStep(type)} />;

  return (
    <div className="wfe-root">
      <PageHeader
        title={displayName}
        icon="tune"
        breadcrumb={[{ label: 'Conception des workflows', href: '/workflows/conception' }, { label: displayName }]}
      />

      <div className="wfe-status-row">
        <DefinitionStatusTag status={definition.status} />
        <span>Version n° {version.versionNumber}</span>
        <VersionStatusTag status={version.status} />
        {dirty && <strong className="wfe-dirty">Modifications non enregistrées</strong>}
        <span className="wfe-save-status" role="status" aria-live="polite">
          {saveStatus.kind === 'saved' && dirty ? '' : saveStatus.text}
        </span>
      </div>

      {banner && (
        <Alert
          className="wfe-banner"
          type={definitionArchived ? 'warning' : 'info'}
          showIcon
          message={banner.text}
          action={
            banner.draft && !definitionArchived ? (
              <Button size="small" disabled={busy !== null} onClick={() => void createDraftFrom(version.versionNumber)}>
                Créer un brouillon
              </Button>
            ) : undefined
          }
        />
      )}

      <AuthoringBanner
        definitionId={definition.wfDefinitionId}
        graph={editor.graph}
        onSelectStep={(key) => handleSelect({ kind: 'step', key })}
      />

      <EditorToolbar
        compact={isMobile}
        readOnly={readOnly}
        isDraftVersion={isDraftVersion}
        definitionArchived={definitionArchived}
        dirty={dirty}
        busy={busy}
        canPublish={publishAllowed}
        publishBlockedReason={blockedReason}
        view={editor.view}
        onView={(v) => update((s) => setView(s, v))}
        onSave={() => void save()}
        onVerify={() => void verify()}
        onPublish={() => setPublishOpen(true)}
        onCreateDraft={() => void createDraftFrom(version.versionNumber)}
        onArchive={() => void archiveWorkflow()}
        onAutoLayout={handleAutoLayout}
      />

      {isMobile && showGraph && (
        <p className="wfe-hint">
          La vue graphique est peu pratique sur un petit écran : la vue liste permet de tout modifier plus facilement.
        </p>
      )}

      {isDesktop ? (
        <div className={`wfe-main${showGraph ? '' : ' wfe-main--list'}`}>
          {showGraph && <aside className="wfe-palette" aria-label="Types d’étape">{palette}</aside>}
          <section className="wfe-center" aria-label={showGraph ? 'Graphique du workflow' : 'Liste des étapes'}>
            {center}
          </section>
          <aside
            className="wfe-props"
            aria-label="Propriétés"
            tabIndex={-1}
            ref={(el) => {
              propsRef.current = el;
            }}
          >
            {propsNode}
          </aside>
        </div>
      ) : (
        <div className="wfe-main wfe-main--stacked">
          {showGraph && (
            <Collapse
              size="small"
              items={[{ key: 'palette', label: 'Ajouter une étape', children: palette }]}
            />
          )}
          <div className="wfe-subbar">
            <Button onClick={() => setPanelOpen(true)}>Propriétés</Button>
          </div>
          <section className="wfe-center" aria-label={showGraph ? 'Graphique du workflow' : 'Liste des étapes'}>
            {center}
          </section>
        </div>
      )}

      <Collapse
        className="wfe-issues"
        activeKey={issuesKey}
        onChange={(k) => setIssuesKey(Array.isArray(k) ? k : [k])}
        items={[
          {
            key: 'issues',
            label: `Problèmes du workflow (${allIssues.length})`,
            children: (
              <IssuesPanel
                graph={editor.graph}
                issues={allIssues}
                serverChecked={editor.serverChecked}
                onFocusStep={handleFocusStep}
              />
            ),
          },
        ]}
      />

      {!isDesktop && (
        <Drawer
          open={panelOpen}
          onClose={() => setPanelOpen(false)}
          title={drawerTitle}
          placement={isMobile ? 'bottom' : 'right'}
          height={isMobile ? '88%' : undefined}
          width={isMobile ? '100%' : 440}
          destroyOnHidden
        >
          {propsNode}
        </Drawer>
      )}

      <PublishModal
        open={publishOpen}
        versionNumber={version.versionNumber}
        note={publishNote}
        busy={busy === 'publish'}
        onNote={setPublishNote}
        onConfirm={() => void publish()}
        onCancel={() => setPublishOpen(false)}
      />
    </div>
  );
}
