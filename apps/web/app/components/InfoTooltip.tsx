'use client';

import { Tooltip, type TooltipProps } from 'antd';
import type { ReactNode } from 'react';

/**
 * Infobulle **porteuse d'information**, atteignable au doigt.
 *
 * Le problème : une `<Tooltip>` AntD se déclenche au survol. Sur un écran tactile, il n'y a pas
 * de survol — et son contenu devient donc inaccessible. Quand l'infobulle ne fait que redire le
 * libellé d'un bouton, ce n'est pas grave ; quand elle porte la SEULE formulation d'une
 * information (« Formats acceptés : PDF, JPG, PNG, TIFF », la définition d'une DUA, la raison
 * pour laquelle un indicateur n'est pas calculable), c'est une information perdue en mobile.
 *
 * Ce composant ajoute `focus` et `click` aux déclencheurs, et rend son enfant focalisable —
 * sans quoi ni le clavier ni le tactile ne peuvent l'atteindre, l'enfant étant en général une
 * simple icône. Le survol continue de fonctionner à l'identique au pointeur.
 *
 * Pourquoi un composant et pas un réglage global : `ConfigProvider.tooltip` n'accepte que
 * `className | style | styles | classNames` (vérifié dans
 * `antd/es/config-provider/context.d.ts`), donc pas `trigger`.
 *
 * À n'utiliser QUE lorsque l'infobulle porte de l'information. Sur un bouton dont elle répète
 * le libellé, la `<Tooltip>` ordinaire reste le bon choix.
 */
export function InfoTooltip({
  title,
  children,
  ...rest
}: { title: ReactNode; children: ReactNode } & Omit<
  TooltipProps,
  'title' | 'children' | 'trigger'
>) {
  return (
    <Tooltip title={title} trigger={['hover', 'focus', 'click']} {...rest}>
      <span
        tabIndex={0}
        role="button"
        aria-label={typeof title === 'string' ? title : undefined}
        style={{ display: 'inline-flex', alignItems: 'center', cursor: 'help' }}
      >
        {children}
      </span>
    </Tooltip>
  );
}
