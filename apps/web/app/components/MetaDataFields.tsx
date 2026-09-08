'use client';

import { Col, DatePicker, InputNumber, Input, Row, Select, Switch, Typography } from 'antd';
import dayjs from 'dayjs';
import { MetaDataType, type MetaDataField, type MetaDataValue } from '../lib/archives';
import { filterByLabel } from '../lib/filters';

const { Text } = Typography;

/** Valeurs du formulaire, indexées par métadonnée (l'ordre d'affichage vient de `fields`). */
export type MetaValues = Record<number, MetaDataValue>;

/** Valeur d'un champ prête à afficher : une chaîne, quelle que soit la nature du champ. */
function textOf(values: MetaValues, metaDataId: number): string {
  return values[metaDataId]?.value ?? '';
}

/**
 * Formulaire dynamique des métadonnées d'un type de document (§7/§8) : un champ par métadonnée
 * rattachée au type, rendu selon son `dataType`.
 *
 * Le même composant sert à l'indexation COMMUNE (valeurs poussées ensuite sur tout le lot) et à
 * l'indexation d'UN document : il ne connaît que des couples champ/valeur, jamais le lot.
 * Les valeurs transitent en texte (contrat de `document_metadata_value`) ; seules les listes
 * portent une clé étrangère.
 */
export function MetaDataFields({
  fields,
  values,
  onChange,
  size,
}: {
  fields: MetaDataField[];
  values: MetaValues;
  onChange: (metaDataId: number, value: MetaDataValue) => void;
  size?: 'small' | 'middle';
}) {
  if (fields.length === 0) return null;

  return (
    <Row gutter={[12, 12]}>
      {fields.map((f) => {
        const set = (v: Omit<MetaDataValue, 'metaDataId'>) =>
          onChange(f.metaDataId, { metaDataId: f.metaDataId, ...v });
        // Un texte long occupe toute la largeur ; les autres se rangent deux par ligne.
        const span = f.dataType === MetaDataType.TexteLong ? 24 : 12;

        return (
          <Col xs={24} sm={span} key={f.metaDataId}>
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>
              {f.label}
            </Text>
            {f.dataType === MetaDataType.Liste ? (
              <Select
                size={size}
                style={{ width: '100%' }}
                value={values[f.metaDataId]?.metaDataListItemId ?? undefined}
                onChange={(v) => set({ metaDataListItemId: (v as number) ?? null, value: null })}
                options={f.options.map((o) => ({ value: o.metaDataListItemId, label: o.label }))}
                allowClear
                showSearch
                filterOption={filterByLabel}
                placeholder="Sélectionner"
              />
            ) : f.dataType === MetaDataType.Date ? (
              <DatePicker
                size={size}
                style={{ width: '100%' }}
                format="DD/MM/YYYY"
                placeholder="JJ/MM/AAAA"
                value={textOf(values, f.metaDataId) ? dayjs(textOf(values, f.metaDataId)) : null}
                onChange={(d) => set({ value: d ? d.format('YYYY-MM-DD') : null })}
              />
            ) : f.dataType === MetaDataType.Entier ? (
              <InputNumber
                size={size}
                style={{ width: '100%' }}
                precision={0}
                value={
                  textOf(values, f.metaDataId) === '' ? null : Number(textOf(values, f.metaDataId))
                }
                onChange={(v) => set({ value: v == null ? null : String(v) })}
                placeholder="Nombre entier"
              />
            ) : f.dataType === MetaDataType.Booleen ? (
              // Aligné sur la hauteur d'un champ de saisie : sans cela, l'interrupteur remonte et
              // désaligne toute la ligne dès qu'il voisine un Input.
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  height: size === 'small' ? 24 : 32,
                }}
              >
                <Switch
                  size="small"
                  checked={textOf(values, f.metaDataId) === 'true'}
                  onChange={(checked) => set({ value: checked ? 'true' : 'false' })}
                  checkedChildren="Oui"
                  unCheckedChildren="Non"
                />
              </div>
            ) : f.dataType === MetaDataType.TexteLong ? (
              <Input.TextArea
                size={size}
                rows={2}
                value={textOf(values, f.metaDataId)}
                onChange={(e) => set({ value: e.target.value })}
              />
            ) : (
              <Input
                size={size}
                value={textOf(values, f.metaDataId)}
                onChange={(e) => set({ value: e.target.value })}
              />
            )}
          </Col>
        );
      })}
    </Row>
  );
}
