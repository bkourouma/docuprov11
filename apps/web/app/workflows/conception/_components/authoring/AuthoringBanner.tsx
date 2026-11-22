'use client';

import { useEffect, useRef, useState } from 'react';
import { Button, Collapse } from 'antd';
import { workflowsApi } from '../../../../lib/workflows-api';
import type { WfGraph } from '@archivage/types';
import {
  authoringErrorMessage,
  buildBannerModel,
  clearBannerState,
  loadBannerState,
  normalizeExplanation,
  type BannerModel,
  type BannerState,
  type ExplanationView,
  type ProblemLine,
} from '../../../_lib/authoring-logic';
import { safeSessionStorage } from './DescribeNeedModal';

export type ExplainState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; explanation: ExplanationView };

function ProblemList({
  lines,
  label,
  onSelectStep,
  knownSteps,
}: {
  lines: ProblemLine[];
  label: string;
  onSelectStep?: (stepKey: string) => void;
  knownSteps?: ReadonlySet<string>;
}) {
  return (
    <ul className="wfa-list" aria-label={label}>
      {lines.map((l, i) => (
        <li key={`${i}-${l.text}`}>
          {/* Le texte vient de l'API ou du stockage : texte brut uniquement. */}
          <span>{l.text}</span>
          {l.stepKey && onSelectStep && knownSteps?.has(l.stepKey) && (
            <Button type="link" size="small" className="wfa-link" onClick={() => onSelectStep(l.stepKey as string)}>
              Aller à l’étape
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Bandeau de relecture d'un brouillon généré (rendu seul : testable sans réseau ni stockage). */
export function AuthoringBannerView({
  model,
  explain,
  onExplain,
  onHide,
  onSelectStep,
  knownSteps,
}: {
  model: BannerModel;
  explain: ExplainState;
  onExplain: () => void;
  onHide: () => void;
  onSelectStep?: (stepKey: string) => void;
  knownSteps?: ReadonlySet<string>;
}) {
  const items = [];
  if (model.assumptions.length > 0) {
    items.push({
      key: 'assumptions',
      label: `Hypothèses à relire (${model.assumptions.length})`,
      forceRender: true,
      children: (
        <ul className="wfa-list" aria-label="Hypothèses du générateur">
          {model.assumptions.map((a, i) => (
            <li key={`${i}-${a}`}>{a}</li>
          ))}
        </ul>
      ),
    });
  }
  return (
    <section className="wfa-banner" aria-label="Relecture du brouillon généré">
      <h2 className="wfa-banner-title">{model.title}</h2>
      <p className="wfa-hint">
        <strong>{model.countLabel}.</strong> Rien n’est publié : vérifiez les étapes, les responsables et les seuils avant de publier.
      </p>

      {items.length > 0 && <Collapse size="small" items={items} />}

      {model.toComplete.length > 0 && (
        <div className="wfa-block">
          <h3 className="wfa-block-title">À compléter ({model.toComplete.length})</h3>
          <ProblemList lines={model.toComplete} label="Éléments à compléter" onSelectStep={onSelectStep} knownSteps={knownSteps} />
        </div>
      )}

      {model.problems.length > 0 && (
        <div className="wfa-block">
          <h3 className="wfa-block-title">Problèmes signalés ({model.problems.length})</h3>
          <ProblemList lines={model.problems} label="Problèmes signalés" onSelectStep={onSelectStep} knownSteps={knownSteps} />
        </div>
      )}

      {model.triggerText && <p className="wfa-trigger">{model.triggerText}</p>}

      <div className="wfa-actions">
        <Button onClick={onExplain} loading={explain.kind === 'loading'} disabled={explain.kind === 'loading'}>
          Expliquer ce workflow
        </Button>
        <Button onClick={onHide}>Masquer</Button>
      </div>

      <div className="wfa-explain" role="region" aria-label="Explication du workflow" aria-live="polite" aria-busy={explain.kind === 'loading'}>
        {explain.kind === 'loading' && <p className="wfa-hint">Explication en cours…</p>}
        {explain.kind === 'error' && (
          <p className="wfa-error" role="alert">
            {explain.message}
          </p>
        )}
        {explain.kind === 'ready' && (
          <div>
            <p className="wfa-hint">
              Explication de la dernière version enregistrée
              {explain.explanation.versionNumber !== null ? ` (version n° ${explain.explanation.versionNumber})` : ''}.
            </p>
            <p className="wfa-explain-summary">{explain.explanation.summary}</p>
            {explain.explanation.steps.length > 0 && (
              <ol className="wfa-list wfa-list--ordered" aria-label="Étapes expliquées">
                {explain.explanation.steps.map((s, i) => (
                  <li key={`${i}-${s.key}`}>
                    {s.name ? <strong>{s.name} : </strong> : null}
                    {s.text}
                  </li>
                ))}
              </ol>
            )}
            {explain.explanation.toComplete.length > 0 && (
              <ul className="wfa-list" aria-label="Restant à compléter">
                {explain.explanation.toComplete.map((t, i) => (
                  <li key={`${i}-${t}`}>{t}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * Bandeau en tête de l'éditeur : visible si l'état de relecture existe en sessionStorage pour ce workflow
 * ou si le graphe contient des marqueurs « à compléter ». « Masquer » efface l'état enregistré.
 */
export function AuthoringBanner({
  definitionId,
  graph,
  onSelectStep,
  explainFn = workflowsApi.authoringExplain,
}: {
  definitionId: number;
  graph: WfGraph;
  onSelectStep?: (stepKey: string) => void;
  explainFn?: (definitionId: number) => Promise<unknown>;
}) {
  const [stored, setStored] = useState<BannerState | null>(null);
  const [hidden, setHidden] = useState(false);
  const [explain, setExplain] = useState<ExplainState>({ kind: 'idle' });
  const seq = useRef(0);

  // Lecture au montage (pas au rendu serveur) : le stockage du navigateur n'existe pas côté serveur.
  useEffect(() => {
    setStored(loadBannerState(safeSessionStorage(), definitionId));
    setHidden(false);
    setExplain({ kind: 'idle' });
  }, [definitionId]);

  const model = hidden ? null : buildBannerModel({ state: stored, graph });
  if (!model) return null;

  const knownSteps = new Set(graph.steps.map((s) => s.key));

  const run = async () => {
    const my = ++seq.current;
    setExplain({ kind: 'loading' });
    try {
      const view = normalizeExplanation(await explainFn(definitionId));
      if (my !== seq.current) return;
      setExplain(
        view
          ? { kind: 'ready', explanation: view }
          : { kind: 'error', message: 'L’explication reçue est inutilisable. Réessayez dans un instant.' },
      );
    } catch (e) {
      if (my === seq.current) setExplain({ kind: 'error', message: authoringErrorMessage(e) });
    }
  };

  return (
    <AuthoringBannerView
      model={model}
      explain={explain}
      onExplain={() => void run()}
      onHide={() => {
        seq.current += 1;
        clearBannerState(safeSessionStorage(), definitionId);
        setStored(null);
        setHidden(true);
      }}
      onSelectStep={onSelectStep}
      knownSteps={knownSteps}
    />
  );
}
