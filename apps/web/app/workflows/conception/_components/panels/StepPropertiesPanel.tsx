'use client';

import { useEffect, useState } from 'react';
import { Button, Checkbox, Input, InputNumber, Popconfirm, Select, Tag } from 'antd';
import {
  WF_TASK_TYPE_KEYS,
  type WfAgentStepSpec,
  type WfStep,
} from '@archivage/types';
import type { WfDefinitionIssue, WfToolCatalogEntry } from '../../../../lib/workflows-api';
import { stepTypeLabel } from '../../../_lib/labels';
import {
  HOURS_MAX,
  MAX_ATTEMPTS_MAX,
  MAX_ATTEMPTS_MIN,
  STEP_KEY_RE,
  readChoices,
  readEscalation,
  readFields,
  readItems,
  readManual,
  readMaxAttempts,
  readPriority,
  writeChoices,
  writeEscalation,
  writeFields,
  writeItems,
  writeManual,
  writeMaxAttempts,
  writePriority,
  type PriorityValue,
} from '../../../_lib/step-config';
import { AgentSpecFields } from './AgentSpecFields';
import { AssigneeFields } from './AssigneeFields';
import { ConfigListEditor } from './ConfigListEditor';
import { EscalationFields } from './EscalationFields';
import { HoursInput } from './HoursInput';
import { PanelField } from './PanelField';

export interface StepPropertiesPanelProps {
  step: WfStep;
  /** Toutes les clés du graphe (détection de doublon au renommage). */
  stepKeys: string[];
  isStart: boolean;
  /** Version publiée ou archivée : tout est désactivé. */
  readOnly: boolean;
  isLowRisk: boolean;
  /** null = API d'évaluation indisponible. */
  hasPassedEval: boolean | null;
  /** null = catalogue d'outils indisponible. */
  tools: WfToolCatalogEntry[] | null;
  /** Problèmes de CETTE étape (détaillés ailleurs). */
  issues: WfDefinitionIssue[];
  /** `undefined` dans le patch = supprimer le champ. */
  onChange(patch: Partial<Omit<WfStep, 'key' | 'next'>>): void;
  /** Renvoie un message d'erreur en français, ou `undefined` si le renommage est accepté. */
  onRenameKey(newKey: string): string | undefined;
  onSetStart(): void;
  onRemove(): void;
}

type StepType = WfStep['type'];

const PRIORITY_OPTIONS: Array<{ value: PriorityValue; label: string }> = [
  { value: 0, label: 'Basse' },
  { value: 1, label: 'Normale' },
  { value: 2, label: 'Haute' },
];

/** Configuration d'agent créée au passage vers le type « agent » (à compléter par l'utilisateur). */
const NEW_AGENT_SPEC: WfAgentStepSpec = {
  objective: '',
  tools: [],
  confidenceThreshold: 0.8,
  autonomy: 'suggere',
};

export function StepPropertiesPanel({
  step,
  stepKeys,
  isStart,
  readOnly,
  isLowRisk,
  hasPassedEval,
  tools,
  issues,
  onChange,
  onRenameKey,
  onSetStart,
  onRemove,
}: StepPropertiesPanelProps) {
  // Seul état local : la clé technique en cours de saisie (validée à la sortie du champ).
  const [draftKey, setDraftKey] = useState(step.key);
  const [keyError, setKeyError] = useState<string | null>(null);

  useEffect(() => {
    setDraftKey(step.key);
    setKeyError(null);
  }, [step.key]);

  const commitKey = () => {
    if (draftKey === step.key) {
      setKeyError(null);
      return;
    }
    if (draftKey.length === 0 || draftKey.length > 100 || !STEP_KEY_RE.test(draftKey)) {
      setKeyError("Clé invalide : minuscules, chiffres et _, en commençant par une lettre (100 caractères au plus).");
      return;
    }
    if (stepKeys.includes(draftKey)) {
      setKeyError('Cette clé est déjà utilisée par une autre étape.');
      return;
    }
    const message = onRenameKey(draftKey);
    setKeyError(message ?? null);
  };

  const config = step.config;
  const manual = readManual(config);
  const hasHumanTask = step.type !== 'agent' && (step.type !== 'decision' || manual);
  const dueBeforeReminder =
    step.dueInHours !== undefined && step.reminderAfterHours !== undefined && step.reminderAfterHours >= step.dueInHours;

  const changeType = (type: StepType) => {
    if (type === step.type) return;
    const patch: Partial<Omit<WfStep, 'key' | 'next'>> = { type };
    // Cohérence avec le validateur : l'agent n'existe que pour le type « agent ».
    if (type === 'agent' && step.agent === undefined) patch.agent = NEW_AGENT_SPEC;
    if (type !== 'agent' && step.agent !== undefined) patch.agent = undefined;
    onChange(patch);
  };

  const setConfig = (next: WfStep['config']) => onChange({ config: next });

  return (
    <section className="wfp-panel" aria-labelledby="wfp-step-title" aria-disabled={readOnly || undefined}>
      <h3 id="wfp-step-title" className="wfp-title">
        Propriétés de l&apos;étape
      </h3>
      {readOnly ? <div className="wfp-hint">Cette version n&apos;est plus modifiable : lecture seule.</div> : null}
      {issues.length > 0 ? (
        <Tag color="warning" role="status">{`${issues.length} problème${issues.length > 1 ? 's' : ''} sur cette étape`}</Tag>
      ) : null}

      <PanelField
        label="Nom de l'étape"
        error={step.name.trim() === '' ? "Le nom de l'étape est obligatoire." : null}
      >
        {({ controlId, describedBy }) => (
          <Input
            id={controlId}
            aria-describedby={describedBy}
            maxLength={200}
            value={step.name}
            disabled={readOnly}
            onChange={(e) => onChange({ name: e.target.value })}
          />
        )}
      </PanelField>

      <PanelField
        label="Clé technique"
        hint="Identifiant interne, minuscules/chiffres/_ (commence par une lettre). Les transitions suivent le renommage."
        error={keyError}
      >
        {({ controlId, describedBy }) => (
          <div className="wfp-inline">
            <Input
              id={controlId}
              aria-describedby={describedBy}
              aria-invalid={keyError !== null || undefined}
              status={keyError ? 'error' : undefined}
              maxLength={100}
              value={draftKey}
              disabled={readOnly}
              onChange={(e) => setDraftKey(e.target.value)}
              onBlur={commitKey}
              onPressEnter={commitKey}
            />
            <Button disabled={readOnly || draftKey === step.key} onClick={commitKey}>
              Renommer
            </Button>
          </div>
        )}
      </PanelField>

      <PanelField
        label="Type d'étape"
        hint={
          "Passer vers ou depuis « Agent » ajoute ou retire la configuration d'agent de l'étape."
        }
      >
        {({ controlId, describedBy }) => (
          <Select
            id={controlId}
            aria-describedby={describedBy}
            style={{ width: '100%' }}
            value={step.type}
            disabled={readOnly}
            options={WF_TASK_TYPE_KEYS.map((k) => ({ value: k, label: stepTypeLabel(k) }))}
            onChange={changeType}
          />
        )}
      </PanelField>

      <PanelField label="Consigne montrée à la personne assignée">
        {({ controlId, describedBy }) => (
          <Input.TextArea
            id={controlId}
            aria-describedby={describedBy}
            rows={3}
            value={step.description ?? ''}
            disabled={readOnly}
            onChange={(e) => onChange({ description: e.target.value === '' ? undefined : e.target.value })}
          />
        )}
      </PanelField>

      <div className="wfp-field">
        {isStart ? (
          <Tag color="processing">Étape de départ</Tag>
        ) : (
          <Button disabled={readOnly} onClick={onSetStart}>
            Définir comme étape de départ
          </Button>
        )}
      </div>

      {step.type !== 'agent' ? (
        <AssigneeFields value={step.assignee} readOnly={readOnly} onChange={(assignee) => onChange({ assignee })} />
      ) : null}

      <HoursInput
        label="Échéance (heures)"
        value={step.dueInHours}
        disabled={readOnly}
        hint={`Entier entre 1 et ${HOURS_MAX}. Vide = aucune échéance.`}
        onCommit={(dueInHours) => onChange({ dueInHours })}
      />
      <HoursInput
        label="Relance (heures)"
        value={step.reminderAfterHours}
        disabled={readOnly}
        hint="Rappel envoyé à la personne assignée. Doit arriver avant l'échéance."
        warning={dueBeforeReminder ? "La relance devrait arriver avant l'échéance." : null}
        onCommit={(reminderAfterHours) => onChange({ reminderAfterHours })}
      />

      <PanelField label="Priorité" hint="Vide = priorité normale.">
        {({ controlId, describedBy }) => (
          <Select
            id={controlId}
            aria-describedby={describedBy}
            style={{ width: '100%' }}
            allowClear
            placeholder="Normale (par défaut)"
            value={readPriority(config)}
            disabled={readOnly}
            options={PRIORITY_OPTIONS}
            onChange={(p: PriorityValue | undefined) => setConfig(writePriority(config, p))}
          />
        )}
      </PanelField>

      <PanelField
        label="Nombre maximal de passages"
        hint={`Limite les retours en arrière sur cette étape (${MAX_ATTEMPTS_MIN} à ${MAX_ATTEMPTS_MAX}).`}
      >
        {({ controlId, describedBy }) => (
          <InputNumber
            id={controlId}
            aria-describedby={describedBy}
            style={{ width: '100%' }}
            min={MAX_ATTEMPTS_MIN}
            max={MAX_ATTEMPTS_MAX}
            precision={0}
            value={readMaxAttempts(config) ?? null}
            disabled={readOnly}
            onChange={(v) =>
              setConfig(
                writeMaxAttempts(
                  config,
                  typeof v === 'number'
                    ? Math.min(MAX_ATTEMPTS_MAX, Math.max(MAX_ATTEMPTS_MIN, Math.round(v)))
                    : undefined,
                ),
              )
            }
          />
        )}
      </PanelField>

      {step.type === 'formulaire' ? (
        <ConfigListEditor
          title="Champs du formulaire"
          keyPrefix="champ"
          addLabel="Ajouter un champ"
          items={readFields(config)}
          readOnly={readOnly}
          onChange={(list) => setConfig(writeFields(config, list))}
        />
      ) : null}

      {step.type === 'checklist' ? (
        <ConfigListEditor
          title="Éléments de la checklist"
          keyPrefix="element"
          addLabel="Ajouter un élément"
          items={readItems(config)}
          readOnly={readOnly}
          onChange={(list) => setConfig(writeItems(config, list))}
        />
      ) : null}

      {step.type === 'decision' ? (
        <fieldset className="wfp-section" disabled={readOnly} aria-disabled={readOnly || undefined}>
          <legend className="wfp-legend">Décision</legend>
          <Checkbox
            checked={manual}
            disabled={readOnly}
            onChange={(e) => setConfig(writeManual(config, e.target.checked))}
          >
            Décision manuelle
          </Checkbox>
          <div className="wfp-hint">
            Sans décision manuelle, le moteur choisit seul la transition d&apos;après les conditions.
          </div>
          {manual ? (
            <PanelField
              label="Choix proposés"
              hint="Facultatif : sans liste, la personne saisit librement son choix. Utilisez ces valeurs dans les conditions (last.choice)."
            >
              {({ controlId, describedBy }) => (
                <Select
                  id={controlId}
                  aria-describedby={describedBy}
                  mode="tags"
                  open={false}
                  style={{ width: '100%' }}
                  tokenSeparators={[',']}
                  value={readChoices(config)}
                  disabled={readOnly}
                  placeholder="Un choix puis Entrée"
                  onChange={(values: string[]) => setConfig(writeChoices(config, values.map((v) => v.trim())))}
                />
              )}
            </PanelField>
          ) : null}
        </fieldset>
      ) : null}

      {step.type === 'agent' && step.agent ? (
        <AgentSpecFields
          spec={step.agent}
          readOnly={readOnly}
          isLowRisk={isLowRisk}
          hasPassedEval={hasPassedEval}
          tools={tools}
          onChange={(agent) => onChange({ agent })}
        />
      ) : null}

      {hasHumanTask ? (
        <EscalationFields
          value={readEscalation(config)}
          readOnly={readOnly}
          onChange={(next) => setConfig(writeEscalation(config, next))}
        />
      ) : null}

      <Popconfirm
        title="Supprimer cette étape ?"
        description={
          isStart
            ? "C'est l'étape de départ : il faudra en désigner une autre. Ses transitions seront retirées."
            : 'Ses transitions seront retirées.'
        }
        okText="Supprimer"
        cancelText="Annuler"
        okButtonProps={{ danger: true }}
        disabled={readOnly}
        onConfirm={onRemove}
      >
        <Button danger disabled={readOnly}>
          Supprimer l&apos;étape
        </Button>
      </Popconfirm>
    </section>
  );
}
