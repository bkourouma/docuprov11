'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, App, Button, Card } from 'antd';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import type { WfGraph } from '@archivage/types';
import { PageHeader } from '../../../../components/PageHeader';
import { CardsSkeleton } from '../../../../components/skeletons';
import { workflowErrorMessage, workflowsApi, type WfToolCatalogEntry } from '../../../../lib/workflows-api';
import { parseDefinitionId, pickVersionToOpen } from '../../../_lib/editor-state';
import {
  buildGrantRows,
  describeGrantsDiff,
  grantsExplanation,
  usedToolsByStep,
} from '../../../_lib/guardrails-logic';
import { useWorkflowAccess } from '../../../_lib/useWorkflowAccess';
import { AccessDenied } from '../../../instances/_components/AccessDenied';
import { useLeaveGuard } from '../editor/useLeaveGuard';
import { ToolsList } from './ToolsList';
import {
  diffAgainst,
  grantUsedTools,
  hasBlockingErrors,
  isDirty,
  missingForRows,
  payloadOf,
  toEditRows,
  usedByIndex,
  type AutoGrantResult,
  type EditRow,
} from './tools-logic';
import '../../../workflows.css';
import './tools.css';

type Load =
  | { kind: 'loading' }
  | { kind: 'invalid' }
  | { kind: 'forbidden' }
  | { kind: 'error'; message: string }
  | { kind: 'ready' };

type Auto = Pick<AutoGrantResult, 'added' | 'irreversibleAdded' | 'disabled' | 'unknown'>;

/** Écran « Outils autorisés » : autorisation des outils d'agent d'un workflow, avant publication. */
export function ToolGrantsView() {
  const params = useParams<{ definitionId?: string }>();
  const definitionId = parseDefinitionId(params?.definitionId);
  const router = useRouter();
  const { modal } = App.useApp();
  const { access, loading: accessLoading } = useWorkflowAccess();

  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [name, setName] = useState<string>('');
  const [graph, setGraph] = useState<WfGraph | null>(null);
  const [graphNote, setGraphNote] = useState<string | null>(null);
  const [baseline, setBaseline] = useState<EditRow[]>([]);
  const [rows, setRows] = useState<EditRow[]>([]);
  const [catalog, setCatalog] = useState<WfToolCatalogEntry[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [success, setSuccess] = useState('');
  const [auto, setAuto] = useState<Auto | null>(null);

  const canAdminister = access?.canAdminister === true;
  const editorHref = definitionId === null ? '/workflows/conception' : `/workflows/conception/${definitionId}`;

  const loadAll = useCallback(async () => {
    if (definitionId === null) return;
    setLoad({ kind: 'loading' });
    try {
      const [cat, grants, detail] = await Promise.all([
        workflowsApi.getAgentToolCatalog(),
        workflowsApi.getToolGrants(definitionId),
        workflowsApi.getDefinition(definitionId),
      ]);
      setName(detail.definition.name);
      const merged = toEditRows(buildGrantRows(cat, grants));
      setCatalog(cat);
      setBaseline(merged);
      setRows(merged);
      // Le graphe sert seulement à repérer les outils utilisés : sa lecture est facultative.
      const number = pickVersionToOpen(detail.versions);
      if (number === null) {
        setGraph(null);
        setGraphNote("Ce workflow ne contient aucune version : les outils utilisés par les étapes ne peuvent pas être repérés.");
      } else {
        try {
          const ver = await workflowsApi.getVersion(definitionId, number);
          setGraph(ver.graph);
          setGraphNote(null);
        } catch (e) {
          setGraph(null);
          setGraphNote(`Les étapes du workflow n'ont pas pu être lues, les outils utilisés ne sont pas repérés. ${workflowErrorMessage(e)}`);
        }
      }
      setLoad({ kind: 'ready' });
    } catch (e) {
      const status = (e as { status?: number } | null)?.status;
      if (status === 403) setLoad({ kind: 'forbidden' });
      else setLoad({ kind: 'error', message: workflowErrorMessage(e) });
    }
  }, [definitionId]);

  useEffect(() => {
    if (definitionId === null) {
      setLoad({ kind: 'invalid' });
      return;
    }
    if (!canAdminister) return;
    void loadAll();
  }, [definitionId, canAdminister, loadAll]);

  const usedBy = useMemo(() => usedByIndex(graph), [graph]);
  const usedSteps = useMemo(() => usedToolsByStep(graph), [graph]);
  const missing = useMemo(() => missingForRows(graph, rows), [graph, rows]);
  const dirty = isDirty(baseline, rows);
  const blocked = hasBlockingErrors(rows);

  const confirmDiscard = useCallback(
    () =>
      new Promise<boolean>((resolve) => {
        modal.confirm({
          title: 'Quitter sans enregistrer ?',
          content: 'Vos modifications des autorisations ne sont pas enregistrées : elles seront perdues.',
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

  const onToggle = (toolKey: string, granted: boolean) => {
    setSuccess('');
    setRows((cur) => cur.map((r) => (r.toolKey === toolKey ? { ...r, granted } : r)));
  };
  const onMaxCalls = (toolKey: string, text: string) => {
    setSuccess('');
    setRows((cur) => cur.map((r) => (r.toolKey === toolKey ? { ...r, maxCallsText: text } : r)));
  };

  const onGrantUsed = () => {
    const res = grantUsedTools(rows, graph);
    setSuccess('');
    setRows(res.rows);
    setAuto({ added: res.added, irreversibleAdded: res.irreversibleAdded, disabled: res.disabled, unknown: res.unknown });
  };

  const onCancel = () => {
    setRows(baseline);
    setAuto(null);
    setSaveError(null);
    setSuccess('');
  };

  const doSave = useCallback(async () => {
    if (definitionId === null) return;
    setSaving(true);
    setSaveError(null);
    setSuccess('');
    try {
      const res = await workflowsApi.replaceToolGrants(definitionId, payloadOf(rows));
      const merged = toEditRows(buildGrantRows(catalog, res.grants));
      setBaseline(merged);
      setRows(merged);
      setWarnings(Array.isArray(res.warnings) ? res.warnings : []);
      setAuto(null);
      setSuccess(
        `Autorisations enregistrées : ${res.grants.length === 0 ? 'aucun outil autorisé' : `${res.grants.length} outil(s) autorisé(s)`}.`,
      );
    } catch (e) {
      setSaveError(workflowErrorMessage(e));
    } finally {
      setSaving(false);
    }
  }, [definitionId, rows, catalog]);

  const onSave = () => {
    const summary = describeGrantsDiff(diffAgainst(baseline, rows));
    modal.confirm({
      title: 'Enregistrer les autorisations ?',
      content: (
        <div>
          <p>{summary}</p>
          <p>
            L&apos;ensemble des autorisations de ce workflow est remplacé par la sélection affichée. Un outil retiré
            devient indisponible à l&apos;exécution, y compris pour les versions déjà publiées.
          </p>
        </div>
      ),
      okText: 'Enregistrer',
      cancelText: 'Revenir',
      onOk: doSave,
    });
  };

  if (definitionId === null || load.kind === 'invalid') {
    return (
      <AccessDenied message="Ce workflow est introuvable : l'adresse ne désigne pas un workflow valide." />
    );
  }
  if (accessLoading || access === null) return <CardsSkeleton />;
  if (!canAdminister || load.kind === 'forbidden') {
    return (
      <Card>
        <div role="alert" className="wft-section">
          <h1 style={{ margin: 0, fontSize: 18 }}>Outils autorisés</h1>
          <p style={{ margin: 0 }}>
            Cet écran est réservé aux administrateurs des workflows. Demandez l&apos;accès à un administrateur.
          </p>
          <Link href={editorHref}>Retour à l&apos;éditeur du workflow</Link>
        </div>
      </Card>
    );
  }
  if (load.kind === 'loading') return <CardsSkeleton />;
  if (load.kind === 'error') {
    return (
      <div className="wft-root wf-touch">
        <Alert
          type="error"
          showIcon
          message="Impossible de charger les outils autorisés"
          description={load.message}
          action={
            <Button onClick={() => void loadAll()} size="small">
              Réessayer
            </Button>
          }
        />
        <Link href={editorHref}>Retour à l&apos;éditeur du workflow</Link>
      </div>
    );
  }

  const nothingToGrant =
    usedSteps.length === 0 || grantUsedToolsPreview(rows, graph) === 0;

  return (
    <div className="wft-root wf-touch">
      <PageHeader
        title={name ? `Outils autorisés : ${name}` : 'Outils autorisés'}
        breadcrumb={[
          { label: 'Conception', href: '/workflows/conception' },
          { label: name || 'Workflow', href: editorHref },
          { label: 'Outils autorisés' },
        ]}
        actions={<Link href={editorHref}>Retour à l&apos;éditeur</Link>}
      />

      <Alert
        type="info"
        showIcon
        message="À quoi servent les outils autorisés ?"
        description={
          <div className="wft-help">
            <p>{grantsExplanation()}</p>
            <p>
              Le code AGENT_TOOL_NOT_GRANTED signifie qu&apos;un outil figure dans une étape agent mais n&apos;est pas
              autorisé pour ce workflow : la publication est alors refusée. L&apos;autorisation est une règle de
              sécurité propre à chaque workflow.
            </p>
            <p>
              Retirer une autorisation après la publication rend l&apos;outil indisponible à l&apos;exécution des
              instances de ce workflow.
            </p>
          </div>
        }
      />

      {graphNote ? <Alert type="warning" showIcon message={graphNote} /> : null}

      <section className="wft-section" aria-labelledby="wft-used-title">
        <h2 id="wft-used-title">Outils utilisés par ce workflow</h2>
        {usedSteps.length === 0 ? (
          <p className="wf-muted" style={{ margin: 0 }}>
            Aucune étape agent de la dernière version n&apos;utilise d&apos;outil pour le moment.
          </p>
        ) : (
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            {usedSteps.map((s) => (
              <li key={s.stepKey}>
                Étape « {s.stepName} » : {s.toolKeys.length === 0 ? 'aucun outil' : s.toolKeys.join(', ')}
              </li>
            ))}
          </ul>
        )}
        {missing.length > 0 ? (
          <Alert
            type="warning"
            showIcon
            message="Des outils utilisés ne sont pas autorisés : la publication sera refusée avec AGENT_TOOL_NOT_GRANTED"
            description={
              <ul className="wft-missing-list">
                {missing.map((m) => (
                  <li key={`${m.stepKey}:${m.toolKey}`}>
                    {m.toolKey} : utilisé par l&apos;étape « {m.stepName} »
                  </li>
                ))}
              </ul>
            }
          />
        ) : null}
        <div className="wft-actions">
          <Button onClick={onGrantUsed} disabled={saving || nothingToGrant}>
            Autoriser les outils utilisés par ce workflow
          </Button>
        </div>
        {auto ? <AutoNotice auto={auto} /> : null}
      </section>

      <section className="wft-section" aria-labelledby="wft-list-title">
        <h2 id="wft-list-title">Outils du catalogue</h2>
        {rows.length === 0 ? (
          <p className="wf-muted" style={{ margin: 0 }}>
            Le catalogue d&apos;outils est vide : aucun outil ne peut être autorisé.
          </p>
        ) : (
          <ToolsList rows={rows} usedBy={usedBy} busy={saving} onToggle={onToggle} onMaxCalls={onMaxCalls} />
        )}
      </section>

      <section className="wft-section" aria-labelledby="wft-save-title">
        <h2 id="wft-save-title">Enregistrement</h2>
        {dirty ? <span className="wft-dirty">Modifications non enregistrées</span> : <span className="wf-muted">Aucune modification en attente.</span>}
        {blocked ? (
          <Alert
            type="error"
            showIcon
            message="Corrigez les lignes signalées avant d'enregistrer (plafond invalide, outil désactivé ou absent du catalogue)."
          />
        ) : null}
        {saveError ? <Alert type="error" showIcon message={saveError} /> : null}
        {warnings.length > 0 ? (
          <Alert
            type="warning"
            showIcon
            message="Enregistré avec des avertissements"
            description={
              <ul className="wft-missing-list">
                {warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            }
            closable
            onClose={() => setWarnings([])}
          />
        ) : null}
        <div role="status" aria-live="polite" className={success ? undefined : 'wf-sr-only'}>
          {success ? <Alert type="success" showIcon message={success} /> : null}
        </div>
        <div className="wft-actions">
          <Button type="primary" onClick={onSave} disabled={!dirty || blocked} loading={saving}>
            Enregistrer les autorisations
          </Button>
          <Button onClick={onCancel} disabled={!dirty || saving}>
            Annuler les modifications
          </Button>
        </div>
      </section>

      <div className="wft-footer">
        <Link href={editorHref}>Retour à l&apos;éditeur pour publier</Link>
      </div>
    </div>
  );
}

/** Nombre d'outils que le bouton « Autoriser les outils utilisés » cocherait. */
function grantUsedToolsPreview(rows: readonly EditRow[], graph: WfGraph | null): number {
  return grantUsedTools(rows, graph).added.length;
}

function AutoNotice({ auto }: { auto: Auto }) {
  return (
    <div className="wft-section">
      {auto.added.length > 0 ? (
        <Alert type="info" showIcon message={`Outils cochés : ${auto.added.join(', ')}. Pensez à enregistrer.`} />
      ) : (
        <Alert type="info" showIcon message="Aucun outil à cocher : tous les outils utilisables sont déjà autorisés." />
      )}
      {auto.irreversibleAdded.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          message={`Attention, outil irréversible autorisé : ${auto.irreversibleAdded.join(', ')}`}
          description="Cet outil a des effets externes ou irréversibles : une validation humaine reste obligatoire à l'exécution. Vérifiez ce choix avant d'enregistrer."
        />
      ) : null}
      {auto.disabled.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          message={`Non autorisables car désactivés dans le catalogue : ${auto.disabled.join(', ')}`}
          description="Retirez ces outils des étapes concernées, ou demandez leur réactivation, sinon la publication sera refusée."
        />
      ) : null}
      {auto.unknown.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          message={`Outils inconnus du catalogue : ${auto.unknown.join(', ')}`}
          description="Retirez ces outils des étapes concernées dans l'éditeur."
        />
      ) : null}
    </div>
  );
}
