'use client';

import { Bot, CheckSquare, FileEdit, GitBranch, ListChecks, UserCheck, Wand2, type LucideIcon } from 'lucide-react';
import type { WfTaskTypeKey } from '@archivage/types';
import { iconDefaults } from '../../../../theme/icons';

/** Une icône par type d'étape (lucide, mêmes réglages de trait que le reste de l'application). */
const STEP_ICONS: Record<WfTaskTypeKey, LucideIcon> = {
  formulaire: FileEdit,
  generation: Wand2,
  checklist: ListChecks,
  affectation: UserCheck,
  validation: CheckSquare,
  decision: GitBranch,
  agent: Bot,
};

export function StepTypeIcon({ type, size = iconDefaults.size }: { type: string; size?: number }) {
  const Icon = (STEP_ICONS as Record<string, LucideIcon | undefined>)[type] ?? FileEdit;
  // Décoratif : le libellé du type est toujours écrit à côté.
  return <Icon size={size} strokeWidth={iconDefaults.strokeWidth} aria-hidden="true" focusable="false" />;
}
