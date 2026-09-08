'use client';

import { useCallback, useEffect, useState } from 'react';
import { App, Alert, Button, Form, Input, Space, Spin, Typography } from 'antd';
import {
  listCustomProperties,
  listCustomValues,
  setCustomValue,
  type CustomPropertyRow,
} from '../../lib/courriers';
import { fontSize } from '../../theme/tokens';

/**
 * Métadonnées de l'entité externe du courrier (EAV §17/§02.13).
 *
 * Le source n'a **aucun écran** pour ces valeurs : elles se saisissent depuis le workflow courrier
 * (`MailTabsController`), contre l'`ExternalEntityId` DU COURRIER — d'où ce panneau dans le
 * MailViewer plutôt qu'une page de paramétrage.
 *
 * Deux écarts assumés vs source :
 *  - le source construit le formulaire à partir de propriétés **extraites** (OCR/IA) ; l'extraction
 *    n'étant pas tranchée, on propose ici toutes les propriétés actives. Le pré-remplissage pourra
 *    s'y brancher plus tard sans redessiner le panneau.
 *  - le source CRÉE la valeur dès la lecture (`GetOrCreateCustomValueByPropertyAndEntity`) ; on
 *    n'écrit qu'à l'enregistrement — consulter un courrier ne doit pas créer de lignes vides.
 */
export function MailMetadataPanel({
  externalEntityId,
  externalEntityLabel,
}: {
  externalEntityId: number | null;
  externalEntityLabel: string | null;
}) {
  const { message } = App.useApp();
  const [properties, setProperties] = useState<CustomPropertyRow[]>([]);
  const [values, setValues] = useState<Record<number, string>>({});
  const [initial, setInitial] = useState<Record<number, string>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (externalEntityId == null) return;
    setLoading(true);
    try {
      const [props, vals] = await Promise.all([
        listCustomProperties(),
        listCustomValues(externalEntityId),
      ]);
      const map: Record<number, string> = {};
      for (const v of vals) map[v.externalEntityCustomPropertyId] = v.value;
      setProperties(props);
      setValues(map);
      setInitial(map);
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Métadonnées indisponibles');
    } finally {
      setLoading(false);
    }
  }, [externalEntityId, message]);

  useEffect(() => {
    void load();
  }, [load]);

  // N'envoie que les valeurs réellement modifiées : une propriété laissée vide et jamais saisie
  // ne crée pas de ligne.
  const dirty = properties.filter(
    (p) =>
      (values[p.externalEntityCustomPropertyId] ?? '') !==
      (initial[p.externalEntityCustomPropertyId] ?? ''),
  );

  const save = useCallback(async () => {
    if (externalEntityId == null || dirty.length === 0) return;
    setSaving(true);
    try {
      for (const p of dirty) {
        await setCustomValue({
          externalEntityId,
          externalEntityCustomPropertyId: p.externalEntityCustomPropertyId,
          value: values[p.externalEntityCustomPropertyId] ?? '',
        });
      }
      message.success(`${dirty.length} métadonnée(s) enregistrée(s).`);
      setInitial({ ...values });
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Enregistrement impossible');
    } finally {
      setSaving(false);
    }
  }, [dirty, externalEntityId, values, message]);

  // Règle du source : sans entité externe, aucune métadonnée n'est rattachable.
  if (externalEntityId == null) {
    return (
      <Alert
        type="info"
        showIcon
        style={{ marginTop: 8 }}
        message="Aucun correspondant sur ce courrier"
        description="Les métadonnées se rattachent à l'entité externe du courrier : renseignez un correspondant pour en saisir."
      />
    );
  }

  if (loading) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', padding: 24 }}>
        <Spin size="small" />
      </div>
    );
  }

  if (properties.length === 0) {
    return (
      <Alert
        type="info"
        showIcon
        style={{ marginTop: 8 }}
        message="Aucune propriété personnalisée"
        description="Créez des propriétés dans le paramétrage pour les renseigner ici."
      />
    );
  }

  return (
    /*
      Labels posés AU-DESSUS des champs : les libellés vivaient auparavant dans un `Text` nu, relié
      à aucun champ. `component={false}` : on veut la mise en page et les libellés d'AntD, pas un
      <form> imbriqué dans la fiche courrier (la soumission reste le bouton).
    */
    <Form component={false} layout="vertical">
      <Space direction="vertical" size="small" style={{ width: '100%', marginTop: 8 }}>
        <Typography.Text type="secondary" style={{ fontSize: fontSize.xs }}>
          Métadonnées de « {externalEntityLabel ?? 'correspondant'} » — partagées par tous ses
          courriers.
        </Typography.Text>
        {properties.map((p) => (
          <Form.Item
            key={p.externalEntityCustomPropertyId}
            label={p.label}
            htmlFor={`meta-${p.externalEntityCustomPropertyId}`}
            style={{ marginBottom: 0 }}
          >
            <Input
              id={`meta-${p.externalEntityCustomPropertyId}`}
              // Panneau latéral de la fiche : saisie dense, à l'inverse des formulaires
              // pleine page.
              size="small"
              value={values[p.externalEntityCustomPropertyId] ?? ''}
              onChange={(e) =>
                setValues((v) => ({ ...v, [p.externalEntityCustomPropertyId]: e.target.value }))
              }
              placeholder="—"
            />
          </Form.Item>
        ))}
        <Button
          type="primary"
          size="small"
          loading={saving}
          disabled={dirty.length === 0}
          onClick={() => void save()}
        >
          Enregistrer{dirty.length > 0 ? ` (${dirty.length})` : ''}
        </Button>
      </Space>
    </Form>
  );
}
