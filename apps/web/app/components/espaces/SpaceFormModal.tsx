'use client';

import { useEffect, useState } from 'react';
import { Form, Input, Modal, Radio, Space, Typography } from 'antd';
import { useFeedback } from '../feedback';
import {
  EDITABLE_KINDS,
  GED_SPACE_KIND_LABELS,
  KIND_HELP,
  espacesApi,
  type GedSpaceInput,
  type GedSpaceKind,
  type GedSpaceSummary,
} from '../../lib/espaces';

interface Values {
  label: string;
  description?: string;
  kind: GedSpaceKind;
}

/**
 * Création et modification d'un espace (même formulaire).
 *
 * La publication n'est PAS un type proposable ici : elle passe par l'action « Publier » du
 * détail, qui porte l'avertissement sur les documents confidentiels. Sur un espace déjà publié,
 * le type est donc masqué et non envoyé — l'API reste maîtresse de ce qu'elle accepte.
 */
export function SpaceFormModal({
  open,
  space,
  onClose,
  onSaved,
}: {
  open: boolean;
  /** Absent = création. */
  space?: GedSpaceSummary;
  onClose: () => void;
  onSaved: (saved: GedSpaceSummary) => void;
}) {
  const { message } = useFeedback();
  const [form] = Form.useForm<Values>();
  const [saving, setSaving] = useState(false);
  const kind = Form.useWatch('kind', form) as GedSpaceKind | undefined;
  const typeLocked = space?.kind === 3;

  useEffect(() => {
    if (!open) return;
    form.setFieldsValue({
      label: space?.label ?? '',
      description: space?.description ?? '',
      kind: (space && space.kind !== 3 ? space.kind : 0) as GedSpaceKind,
    });
  }, [open, space, form]);

  const submit = async (v: Values) => {
    setSaving(true);
    try {
      const body: Partial<GedSpaceInput> = {
        label: v.label.trim(),
        description: v.description?.trim() ? v.description.trim() : null,
        ...(typeLocked ? {} : { kind: v.kind }),
      };
      const saved = space
        ? await espacesApi.update(space.gedSpaceId, body)
        : await espacesApi.create(body as GedSpaceInput);
      message.success(space ? 'Espace modifié' : 'Espace créé');
      onSaved(saved);
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Enregistrement impossible');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      title={space ? "Modifier l'espace" : 'Nouvel espace'}
      okText={space ? 'Enregistrer' : "Créer l'espace"}
      cancelText="Annuler"
      confirmLoading={saving}
      onCancel={onClose}
      onOk={() => form.submit()}
      destroyOnClose
      forceRender
    >
      <Form form={form} layout="vertical" onFinish={submit} requiredMark="optional">
        <Form.Item
          name="label"
          label="Libellé"
          rules={[{ required: true, whitespace: true, message: 'Saisissez un libellé' }]}
        >
          <Input maxLength={200} autoFocus />
        </Form.Item>
        <Form.Item name="description" label="Description">
          <Input.TextArea rows={3} maxLength={1000} />
        </Form.Item>
        {!typeLocked && (
          <Form.Item name="kind" label="Type d'espace">
            <Radio.Group>
              <Space direction="vertical">
                {EDITABLE_KINDS.map((k) => (
                  <Radio key={k} value={k}>
                    {GED_SPACE_KIND_LABELS[k]}
                  </Radio>
                ))}
              </Space>
            </Radio.Group>
          </Form.Item>
        )}
        {!typeLocked && kind !== undefined && (
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
            {KIND_HELP[kind]} La publication se fait ensuite depuis le détail de l&apos;espace.
          </Typography.Paragraph>
        )}
      </Form>
    </Modal>
  );
}
