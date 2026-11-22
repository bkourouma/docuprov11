'use client';

import { useId, useState } from 'react';
import { Alert, Collapse, Input, InputNumber, Radio, Select, Slider, Tag } from 'antd';
import {
  WF_KEY_PATTERN,
  WF_TOOL_SIDE_EFFECT_LABELS,
  type WfAgentStepSpec,
} from '@archivage/types';
import type { WfToolCatalogEntry } from '../../../../lib/workflows-api';
import { AUTONOMY_OPTIONS, autonomyAvailability } from '../../../_lib/autonomy';
import { PanelField } from './PanelField';

export interface AgentSpecFieldsProps {
  spec: WfAgentStepSpec;
  readOnly: boolean;
  isLowRisk: boolean;
  hasPassedEval: boolean | null;
  tools: WfToolCatalogEntry[] | null;
  onChange(next: WfAgentStepSpec): void;
}

interface ToolOption {
  value: string;
  label: string;
  disabled: boolean;
  tool?: WfToolCatalogEntry;
}

const toPercent = (v: number) => Math.round(v * 100);

export function AgentSpecFields({ spec, readOnly, isLowRisk, hasPassedEval, tools, onChange }: AgentSpecFieldsProps) {
  const uid = useId();
  const [toolError, setToolError] = useState<string | null>(null);
  const availability = autonomyAvailability({ isLowRisk, hasPassedEval });
  const reasonId = `${uid}-autonomy-reason`;
  const staleAutonomous = spec.autonomy === 'autonome' && !availability.allowed;

  /** Pose ou retire (valeur undefined) un champ facultatif. */
  const setOptional = <K extends 'model' | 'maxSteps' | 'maxCostPerRun'>(key: K, value: WfAgentStepSpec[K]) => {
    const next: WfAgentStepSpec = { ...spec };
    if (value === undefined) delete next[key];
    else next[key] = value;
    onChange(next);
  };

  const catalogKeys = new Set((tools ?? []).map((t) => t.toolKey));
  const toolOptions: ToolOption[] = (tools ?? []).map((t) => ({
    value: t.toolKey,
    label: t.label,
    disabled: !t.isEnabled && !spec.tools.includes(t.toolKey),
    tool: t,
  }));
  // Clés déjà présentes dans le graphe mais absentes du catalogue : on les garde visibles.
  for (const key of spec.tools) {
    if (tools && !catalogKeys.has(key)) toolOptions.push({ value: key, label: `${key} (hors catalogue)`, disabled: false });
  }

  return (
    <fieldset className="wfp-section" aria-disabled={readOnly || undefined} disabled={readOnly}>
      <legend className="wfp-legend">Agent</legend>

      <PanelField label="Objectif de l'agent">
        {({ controlId, describedBy }) => (
          <Input.TextArea
            id={controlId}
            aria-describedby={describedBy}
            rows={4}
            maxLength={4000}
            showCount
            value={spec.objective}
            disabled={readOnly}
            status={spec.objective.trim() === '' ? 'error' : undefined}
            placeholder="Décrivez ce que l'agent doit accomplir."
            onChange={(e) => onChange({ ...spec, objective: e.target.value })}
          />
        )}
      </PanelField>

      {tools === null ? (
        <PanelField
          label="Outils autorisés"
          hint="Le catalogue d'outils n'est pas encore disponible : saisissez les clés d'outil."
          error={toolError}
        >
          {({ controlId, describedBy }) => (
            <Select
              id={controlId}
              aria-describedby={describedBy}
              mode="tags"
              style={{ width: '100%' }}
              tokenSeparators={[',', ' ']}
              open={false}
              value={spec.tools}
              disabled={readOnly}
              placeholder="Clé d'outil puis Entrée"
              onChange={(values: string[]) => {
                const clean: string[] = [];
                let error: string | null = null;
                for (const raw of values) {
                  const v = raw.trim();
                  if (v === '') continue;
                  if (v.length > 100 || !WF_KEY_PATTERN.test(v)) {
                    error = `« ${v} » n'est pas une clé d'outil valide (minuscules, chiffres, _ et ., 100 caractères au plus).`;
                  } else if (clean.includes(v)) {
                    error = `« ${v} » est déjà dans la liste.`;
                  } else clean.push(v);
                }
                setToolError(error);
                onChange({ ...spec, tools: clean });
              }}
            />
          )}
        </PanelField>
      ) : (
        <PanelField label="Outils autorisés" hint="Les outils grisés sont désactivés par l'administration.">
          {({ controlId, describedBy }) => (
            <Select
              id={controlId}
              aria-describedby={describedBy}
              mode="multiple"
              style={{ width: '100%' }}
              optionFilterProp="label"
              value={spec.tools}
              disabled={readOnly}
              options={toolOptions}
              placeholder="Choisir des outils"
              optionRender={(option) => {
                const tool = (option.data as { tool?: WfToolCatalogEntry }).tool;
                if (!tool) return <span>{option.label}</span>;
                return (
                  <div className={`wfp-tool${tool.isEnabled ? '' : ' wfp-tool-off'}`}>
                    <span>
                      {tool.label} <span className="wfp-hint">({tool.toolKey})</span>
                    </span>
                    <Tag>{WF_TOOL_SIDE_EFFECT_LABELS[tool.sideEffect] ?? 'Effet inconnu'}</Tag>
                    {tool.isEnabled ? null : <Tag>Désactivé</Tag>}
                  </div>
                );
              }}
              onChange={(values: string[]) => onChange({ ...spec, tools: values })}
            />
          )}
        </PanelField>
      )}

      <PanelField
        label="Seuil de confiance"
        hint="En dessous de ce seuil, une validation humaine est toujours demandée."
      >
        {({ controlId, describedBy }) => (
          <div className="wfp-inline">
            <Slider
              style={{ flex: 1, minWidth: 120 }}
              min={0}
              max={1}
              step={0.05}
              value={spec.confidenceThreshold}
              disabled={readOnly}
              tooltip={{ formatter: (v) => `${toPercent(v ?? 0)} %` }}
              aria-label="Seuil de confiance (curseur)"
              onChange={(v) => onChange({ ...spec, confidenceThreshold: v })}
            />
            <InputNumber
              id={controlId}
              aria-describedby={describedBy}
              min={0}
              max={100}
              step={5}
              precision={0}
              value={toPercent(spec.confidenceThreshold)}
              disabled={readOnly}
              suffix="%"
              style={{ width: 110 }}
              onChange={(v) => {
                if (typeof v === 'number') onChange({ ...spec, confidenceThreshold: Math.min(100, Math.max(0, v)) / 100 });
              }}
            />
          </div>
        )}
      </PanelField>

      <div className="wfp-field" role="radiogroup" aria-labelledby={`${uid}-autonomy`}>
        <span id={`${uid}-autonomy`} className="wfp-label">
          Niveau d&apos;autonomie
        </span>
        <Radio.Group
          value={spec.autonomy}
          disabled={readOnly}
          className="wfp-radios"
          onChange={(e) => onChange({ ...spec, autonomy: e.target.value as WfAgentStepSpec['autonomy'] })}
        >
          {AUTONOMY_OPTIONS.map((o) => {
            const locked = o.key === 'autonome' && !availability.allowed;
            return (
              <div key={o.key} className="wfp-radio">
                <Radio
                  value={o.key}
                  disabled={locked}
                  aria-describedby={locked ? `${reasonId} ${uid}-d-${o.key}` : `${uid}-d-${o.key}`}
                >
                  {o.label}
                </Radio>
                <div id={`${uid}-d-${o.key}`} className="wfp-hint wfp-radio-desc">
                  {o.description}
                </div>
              </div>
            );
          })}
        </Radio.Group>
        {!availability.allowed ? (
          <div id={reasonId} className="wfp-hint">
            {availability.reason}
          </div>
        ) : null}
        {staleAutonomous ? (
          <Alert
            type="warning"
            showIcon
            message="Cette étape est réglée sur « Autonome » alors que ce n'est plus permis : la publication sera refusée tant qu'un autre niveau n'est pas choisi."
          />
        ) : null}
      </div>

      <Collapse
        ghost
        items={[
          {
            key: 'advanced',
            label: 'Réglages avancés',
            children: (
              <div className="wfp-stack">
                <PanelField label="Modèle" hint="Laissez vide pour utiliser le modèle par défaut.">
                  {({ controlId, describedBy }) => (
                    <Input
                      id={controlId}
                      aria-describedby={describedBy}
                      maxLength={200}
                      value={spec.model ?? ''}
                      disabled={readOnly}
                      onChange={(e) => setOptional('model', e.target.value === '' ? undefined : e.target.value)}
                    />
                  )}
                </PanelField>
                <PanelField label="Nombre maximal d'étapes de l'agent" hint="Entre 1 et 50.">
                  {({ controlId, describedBy }) => (
                    <InputNumber
                      id={controlId}
                      aria-describedby={describedBy}
                      style={{ width: '100%' }}
                      min={1}
                      max={50}
                      precision={0}
                      value={spec.maxSteps ?? null}
                      disabled={readOnly}
                      onChange={(v) =>
                        setOptional('maxSteps', typeof v === 'number' ? Math.min(50, Math.max(1, Math.round(v))) : undefined)
                      }
                    />
                  )}
                </PanelField>
                <PanelField label="Coût maximal par exécution" hint="Zéro ou plus ; vide = aucune limite propre à l'étape.">
                  {({ controlId, describedBy }) => (
                    <InputNumber
                      id={controlId}
                      aria-describedby={describedBy}
                      style={{ width: '100%' }}
                      min={0}
                      step={0.1}
                      value={spec.maxCostPerRun ?? null}
                      disabled={readOnly}
                      onChange={(v) => setOptional('maxCostPerRun', typeof v === 'number' ? Math.max(0, v) : undefined)}
                    />
                  )}
                </PanelField>
              </div>
            ),
          },
        ]}
      />
    </fieldset>
  );
}
