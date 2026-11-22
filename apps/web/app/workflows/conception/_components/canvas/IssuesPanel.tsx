'use client';

import type { ReactNode } from 'react';
import { Button, Collapse } from 'antd';
import type { WfGraph } from '@archivage/types';
import type { WfDefinitionIssue } from '../../../../lib/workflows-api';
import { explainIssue, groupIssuesByStep, summarizeIssues } from '../../../_lib/graph-issues';

export interface IssuesPanelProps {
  graph: WfGraph | null;
  /** Problèmes locaux + serveur, déjà fusionnés par la page. */
  issues: WfDefinitionIssue[];
  /** Vrai après un « Vérifier » ou une publication refusée côté serveur. */
  serverChecked: boolean;
  onFocusStep(key: string): void;
}

function IssueItem({
  issue,
  graph,
  onFocusStep,
}: {
  issue: WfDefinitionIssue;
  graph: WfGraph | null;
  onFocusStep(key: string): void;
}) {
  const e = explainIssue(issue, graph ?? undefined);
  const stepName = e.stepKey !== undefined ? graph?.steps.find((s) => s.key === e.stepKey)?.name : undefined;
  return (
    <li className="wfc-issue">
      <h4 className="wfc-issue-title">{e.title}</h4>
      <p className="wfc-issue-text">{e.explain}</p>
      <p className="wfc-issue-text">
        <strong>Comment corriger : </strong>
        {e.fix}
      </p>
      {e.stepKey !== undefined && (
        <Button
          size="small"
          className="wfc-touch"
          onClick={() => onFocusStep(e.stepKey as string)}
          aria-label={`Aller à l’étape « ${stepName ?? e.stepKey} »`}
        >
          Aller à l’étape{stepName ? ` « ${stepName} »` : ''}
        </Button>
      )}
      {e.detail !== undefined && (
        <details className="wfc-issue-detail">
          <summary>Détail technique</summary>
          {/* Texte brut : le message vient du serveur ou du validateur, jamais interprété comme du HTML. */}
          <p>{e.detail}</p>
        </details>
      )}
    </li>
  );
}

export function IssuesPanel({ graph, issues, serverChecked, onFocusStep }: IssuesPanelProps) {
  const summary = summarizeIssues(issues);
  const empty = issues.length === 0;
  const { global, byStep } = groupIssuesByStep(issues);

  // Ordre des étapes du graphe d'abord, puis d'éventuelles clés inconnues (étape supprimée entre-temps).
  const orderedKeys = [
    ...(graph?.steps.map((s) => s.key).filter((k) => Object.hasOwn(byStep, k)) ?? []),
    ...Object.keys(byStep).filter((k) => !graph?.steps.some((s) => s.key === k)),
  ];

  const status = empty ? (
    <p className="wfc-issues-status wfc-issues-status--ok">
      <span aria-hidden="true">✓ </span>Aucun problème détecté
    </p>
  ) : null;

  const note = serverChecked
    ? 'Vérifié par le serveur.'
    : 'Vérification locale en direct — le serveur contrôle aussi, à la publication, la présence de l’exécuteur d’agent.';

  const body: ReactNode = (
    <div className="wfc-issues-body">
      {global.length > 0 && (
        <section aria-label="Problèmes généraux">
          <h3 className="wfc-issues-group">Problèmes généraux</h3>
          <ul className="wfc-issues-list">
            {global.map((issue, i) => (
              <IssueItem key={`g-${i}`} issue={issue} graph={graph} onFocusStep={onFocusStep} />
            ))}
          </ul>
        </section>
      )}
      {orderedKeys.map((key) => {
        const name = graph?.steps.find((s) => s.key === key)?.name ?? key;
        return (
          <section key={key} aria-label={`Problèmes de l’étape ${name}`}>
            <h3 className="wfc-issues-group">Étape « {name} »</h3>
            <ul className="wfc-issues-list">
              {(byStep[key] ?? []).map((issue, i) => (
                <IssueItem key={`${key}-${i}`} issue={issue} graph={graph} onFocusStep={onFocusStep} />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );

  return (
    <section className="wfc-issues" aria-label="Problèmes du workflow">
      {/* Résumé annoncé à chaque changement ; le contenu détaillé reste hors de la région pour ne pas tout relire. */}
      <p className={`wfc-issues-summary${empty ? '' : ' wfc-issues-summary--error'}`} role="status" aria-live="polite">
        {summary}
      </p>
      {status}
      <p className="wfc-issues-note">{note}</p>
      {!empty && (
        <Collapse
          ghost
          defaultActiveKey={['issues']}
          items={[{ key: 'issues', label: 'Détail des problèmes', children: body }]}
        />
      )}
    </section>
  );
}
