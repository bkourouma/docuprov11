'use client';

import { Input } from 'antd';
import type { WfDefinitionVersionSummary } from '../../../../lib/workflows-api';
import { LowRiskToggle } from '../panels/LowRiskToggle';
import { TriggersSlot } from '../panels/TriggersSlot';
import { VersionsPanel } from './VersionsPanel';

export const NAME_MAX = 200;
export const DESCRIPTION_MAX = 4000;

export interface WorkflowInfoPanelProps {
  definitionId: number;
  name: string;
  description: string;
  readOnly: boolean;
  isLowRisk: boolean;
  canMarkLowRisk: boolean;
  lowRiskBusy: boolean;
  hasAutonomousStep: boolean;
  versions: WfDefinitionVersionSummary[];
  openedVersion: number;
  definitionArchived: boolean;
  versionsBusy: boolean;
  onName(value: string): void;
  onDescription(value: string): void;
  onLowRisk(next: boolean): void;
  onOpenVersion(versionNumber: number): void;
  onCreateDraftFrom(versionNumber: number): void;
}

/** Fiche du workflow : affichée quand ni étape ni transition n'est sélectionnée. */
export function WorkflowInfoPanel(props: WorkflowInfoPanelProps) {
  const nameEmpty = props.name.trim() === '';
  return (
    <div className="wfe-info">
      <h2 className="wfe-panel-title">Fiche du workflow</h2>

      <div className="wfe-field">
        <label htmlFor="wfe-name">Nom du workflow</label>
        <Input
          id="wfe-name"
          value={props.name}
          maxLength={NAME_MAX}
          disabled={props.readOnly}
          status={nameEmpty ? 'error' : undefined}
          aria-invalid={nameEmpty ? true : undefined}
          aria-describedby={nameEmpty ? 'wfe-name-error' : undefined}
          onChange={(e) => props.onName(e.target.value)}
        />
        {nameEmpty && (
          <span id="wfe-name-error" className="wfe-error" role="alert">
            Le nom est obligatoire.
          </span>
        )}
      </div>

      <div className="wfe-field">
        <label htmlFor="wfe-description">Description (facultative)</label>
        <Input.TextArea
          id="wfe-description"
          value={props.description}
          maxLength={DESCRIPTION_MAX}
          disabled={props.readOnly}
          autoSize={{ minRows: 3, maxRows: 8 }}
          onChange={(e) => props.onDescription(e.target.value)}
        />
      </div>

      <LowRiskToggle
        isLowRisk={props.isLowRisk}
        canMark={props.canMarkLowRisk}
        busy={props.lowRiskBusy}
        hasAutonomousStep={props.hasAutonomousStep}
        onChange={props.onLowRisk}
      />

      <VersionsPanel
        versions={props.versions}
        openedNumber={props.openedVersion}
        definitionArchived={props.definitionArchived}
        busy={props.versionsBusy}
        onOpen={props.onOpenVersion}
        onCreateDraftFrom={props.onCreateDraftFrom}
      />

      <TriggersSlot definitionId={props.definitionId} />
    </div>
  );
}
