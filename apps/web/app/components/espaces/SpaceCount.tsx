'use client';

import { Typography } from 'antd';
import { InfoTooltip } from '../InfoTooltip';

/**
 * Nombre de documents d'un espace. `null` = non exposé par l'API (l'acteur n'a pas le droit de
 * le connaître) : on affiche un tiret ACCESSIBLE — texte lu par les lecteurs d'écran, infobulle
 * atteignable au clavier et au doigt — plutôt qu'un « 0 » qui mentirait.
 */
export function DocumentCount({ value }: { value: number | null | undefined }) {
  if (value === null || value === undefined) {
    return (
      <InfoTooltip title="Nombre non communiqué">
        <Typography.Text type="secondary">—</Typography.Text>
      </InfoTooltip>
    );
  }
  return <>{value}</>;
}
