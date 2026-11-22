'use client';

import type { DragEvent } from 'react';
import type { WfTaskTypeKey } from '@archivage/types';
import { stepTypeLabel } from '../../../_lib/labels';
import { PALETTE_ITEMS } from './canvas-logic';
import { StepTypeIcon } from './step-visuals';
import { STEP_DRAG_MIME } from './types';

export interface StepPaletteProps {
  disabled: boolean;
  onAdd(type: WfTaskTypeKey): void;
}

/** Palette des types d'étape : clic/Entrée pour ajouter, ou glisser-déposer vers le canevas. */
export function StepPalette({ disabled, onAdd }: StepPaletteProps) {
  const onDragStart = (event: DragEvent<HTMLButtonElement>, type: WfTaskTypeKey) => {
    event.dataTransfer.setData(STEP_DRAG_MIME, type);
    event.dataTransfer.effectAllowed = 'copy';
  };

  return (
    <section className="wfc-palette" aria-labelledby="wfc-palette-title">
      <h2 id="wfc-palette-title" className="wfc-palette-title">
        Ajouter une étape
      </h2>
      {disabled && <p className="wfc-palette-note">Version en lecture seule</p>}
      <ul className="wfc-palette-list">
        {PALETTE_ITEMS.map(({ type, description }) => (
          <li key={type}>
            <button
              type="button"
              className="wfc-palette-btn"
              disabled={disabled}
              draggable={!disabled}
              onDragStart={(e) => onDragStart(e, type)}
              onClick={() => onAdd(type)}
            >
              <span className="wfc-palette-icon">
                <StepTypeIcon type={type} />
              </span>
              <span className="wfc-palette-text">
                <span className="wfc-palette-label">
                  {stepTypeLabel(type)}
                  {type === 'agent' && <span className="wfc-badge wfc-badge--ai">IA</span>}
                </span>
                <span className="wfc-palette-desc">{description}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
