'use client';

import Link from 'next/link';
import { Button } from 'antd';
import { eligibilityLabel, evalChecklist } from '../../../_lib/eval-logic';
import { evaluationHref, toolGrantsHref } from '../../../_lib/guardrails-links';
import { evalHelp, toolGrantNotice, type StepGuardrails } from './editor-guardrails';

export interface AgentGuardrailLinksProps {
  stepKey: string;
  isLowRisk: boolean;
  guardrails: StepGuardrails;
}

/** État d'éligibilité (raison de l'API, ou liste d'étapes à suivre) affiché sous le choix « Autonome ». */
export function EligibilityNote({ guardrails, isLowRisk }: { guardrails: StepGuardrails; isLowRisk: boolean }) {
  const info = guardrails.evalInfo;
  if (info === null) return null;
  if (info.eligible) {
    const l = eligibilityLabel({ eligible: true });
    return (
      <p className="wfp-hint wfp-eligibility">
        <span aria-hidden="true">✓ </span>
        {l.label}
      </p>
    );
  }
  const l = eligibilityLabel({ eligible: false, reason: info.reason });
  // « cases » n'est pas connu depuis cet écran : on ne l'affiche pas plutôt que d'affirmer à tort.
  const items = evalChecklist({
    isLowRisk,
    evalSetLinked: info.evalSetId !== null,
    activeCases: info.evalSetId !== null ? 1 : 0,
    hasPassedRun: false,
  }).items.filter((i) => i.key !== 'cases');
  return (
    <div className="wfp-eligibility">
      <p className="wfp-hint">
        <span className="wfp-tone-word">Pas encore éligible : </span>
        {l.label}
      </p>
      <details className="wfp-hint wfp-checklist">
        <summary>Étapes pour activer le niveau autonome</summary>
        <ul>
          {items.map((i) => (
            <li key={i.key}>
              <span aria-hidden="true">{i.done ? '✓' : '○'} </span>
              <span className="wfp-sr-only">{i.done ? 'Fait : ' : 'À faire : '}</span>
              {i.label}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

/** Évaluation de l'étape + outils autorisés : liens, phrases d'aide et avertissements non bloquants. */
export function AgentGuardrailLinks({ stepKey, isLowRisk, guardrails }: AgentGuardrailLinksProps) {
  const evalLink = evaluationHref(guardrails.definitionId, stepKey);
  const grantsLink = toolGrantsHref(guardrails.definitionId);
  const help = evalHelp({ dirty: guardrails.dirty, known: guardrails.evalInfo?.known ?? true });
  const notice = toolGrantNotice({
    canAdminister: guardrails.canAdminister,
    missing: guardrails.missingTools,
    issueNotGranted: guardrails.issueNotGranted,
  });

  return (
    <div className="wfp-guardrails">
      <div className="wfp-guard-block">
        <h4 className="wfp-guard-title">Évaluation de l’agent</h4>
        {evalLink !== null ? (
          <Link href={evalLink} className="wfp-link-btn">
            Évaluer cet agent
          </Link>
        ) : null}
        <p className="wfp-hint">{help.text}</p>
        {help.warning !== null ? (
          <p className="wfp-warning" role="status">
            <span aria-hidden="true">⚠ </span>
            {help.warning}
          </p>
        ) : null}
        <EligibilityNote guardrails={guardrails} isLowRisk={isLowRisk} />
        {guardrails.onRefreshEval ? (
          <Button
            type="link"
            size="small"
            className="wfp-refresh"
            loading={guardrails.evalLoading}
            onClick={guardrails.onRefreshEval}
          >
            Actualiser l’état de l’évaluation
          </Button>
        ) : null}
      </div>

      {notice !== null ? (
        <div className="wfp-guard-block">
          <p className="wfp-warning wfp-tool-notice" role="note">
            <span aria-hidden="true">⚠ </span>
            {notice.text}
          </p>
          {notice.showLink && grantsLink !== null ? (
            <Link href={grantsLink} className="wfp-link-btn">
              Outils autorisés
            </Link>
          ) : null}
        </div>
      ) : guardrails.canAdminister && grantsLink !== null ? (
        <div className="wfp-guard-block">
          <Link href={grantsLink} className="wfp-link-btn">
            Outils autorisés
          </Link>
        </div>
      ) : null}
    </div>
  );
}
