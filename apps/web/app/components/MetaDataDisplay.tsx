'use client';

import { Typography } from 'antd';
import dayjs from 'dayjs';
import { MetaDataType, type MetaDataField } from '../lib/archives';
import type { MetaValues } from './MetaDataFields';

const { Text } = Typography;

/** Formate une valeur selon le type de saisie de son champ — pendant, en lecture seule, de ce que `MetaDataFields` édite. */
function formatValue(field: MetaDataField, values: MetaValues): string {
  const v = values[field.metaDataId];
  if (!v) return '—';
  if (field.dataType === MetaDataType.Liste) {
    const item = field.options.find((o) => o.metaDataListItemId === v.metaDataListItemId);
    return item?.label ?? '—';
  }
  if (v.value == null || v.value.trim() === '') return '—';
  if (field.dataType === MetaDataType.Date) return dayjs(v.value).format('DD/MM/YYYY');
  if (field.dataType === MetaDataType.Booleen) return v.value === 'true' ? 'Oui' : 'Non';
  return v.value;
}

/**
 * Rappel EN LECTURE SEULE des métadonnées d'un document — le pendant consultation de
 * `MetaDataFields` (formulaire d'indexation) : mêmes champs, même mise en forme par `dataType`,
 * mais aucune saisie possible ici.
 */
export function MetaDataDisplay({
  fields,
  values,
}: {
  fields: MetaDataField[];
  values: MetaValues;
}) {
  return (
    <>
      {fields.map((f) => (
        <div key={f.metaDataId} style={{ marginBottom: 10 }}>
          <Text strong>{f.label} : </Text>
          <Text>{formatValue(f, values)}</Text>
        </div>
      ))}
    </>
  );
}
