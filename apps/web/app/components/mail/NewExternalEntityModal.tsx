'use client';

import { useEffect, useState } from 'react';
import { App, Form, Input, Modal, Select, Space } from 'antd';
import {
  externalEntitiesApi,
  type ExternalEntityRow,
  type ExternalEntityTypeRow,
} from '../../lib/courriers';

/**
 * Création d'un correspondant (§17) depuis l'écran où on en a besoin — à l'enregistrement, le
 * bureau d'ordre découvre l'expéditeur en ouvrant le courrier et ne doit pas quitter sa saisie
 * pour le créer.
 *
 * `onCreated` reçoit la ligne créée pour que l'appelant l'ajoute à sa liste ET la sélectionne.
 * Seul le nom est requis, comme côté API (`createExternalEntitySchema`).
 */
export function NewExternalEntityModal({
  open,
  onClose,
  onCreated,
  types,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (created: ExternalEntityRow) => void;
  /** Types proposés — liste déjà chargée par l'appelant (le type reste facultatif). */
  types: ExternalEntityTypeRow[];
}) {
  const { message } = App.useApp();
  const [label, setLabel] = useState('');
  const [typeId, setTypeId] = useState<number | null>(null);
  const [email, setEmail] = useState('');
  const [tel, setTel] = useState('');
  const [busy, setBusy] = useState(false);

  // Repart d'un formulaire vide à chaque ouverture : un abandon ne doit rien laisser à la suivante.
  useEffect(() => {
    if (open) {
      setLabel('');
      setTypeId(null);
      setEmail('');
      setTel('');
    }
  }, [open]);

  const submit = async () => {
    const nom = label.trim();
    if (!nom) return;
    setBusy(true);
    try {
      const created = await externalEntitiesApi.create({
        label: nom,
        externalEntityTypeId: typeId ?? undefined,
        email: email.trim() || undefined,
        telephone: tel.trim() || undefined,
      });
      message.success('Correspondant créé');
      onCreated(created);
      onClose();
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Création impossible');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onCancel={onClose}
      onOk={() => void submit()}
      okText="Créer"
      cancelText="Annuler"
      okButtonProps={{ loading: busy, disabled: !label.trim() }}
      title="Nouvel expéditeur (entité externe)"
      destroyOnHidden
    >
      {/*
          Labels posés AU-DESSUS des champs : les libellés vivaient auparavant dans un
          `Text secondary` qui n'était relié à aucun champ (ni <label>, ni astérisque d'AntD).
          `component={false}` : on veut la mise en page et les libellés d'AntD, pas un <form>
          qui capturerait la touche Entrée (elle est déjà câblée sur la création).
        */}
      <Form component={false} layout="vertical">
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Form.Item label="Nom" htmlFor="new-entity-label" required style={{ marginBottom: 0 }}>
            <Input
              id="new-entity-label"
              autoFocus
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              onPressEnter={() => void submit()}
              placeholder="Ex. Ministère des Finances"
            />
          </Form.Item>
          <Form.Item label="Type" htmlFor="new-entity-type" style={{ marginBottom: 0 }}>
            <Select
              id="new-entity-type"
              style={{ width: '100%' }}
              allowClear
              showSearch
              optionFilterProp="label"
              placeholder="—"
              value={typeId ?? undefined}
              onChange={(v) => setTypeId((v as number) ?? null)}
              options={types.map((t) => ({ value: t.externalEntityTypeId, label: t.label }))}
            />
          </Form.Item>
          <Form.Item label="E-mail" htmlFor="new-entity-email" style={{ marginBottom: 0 }}>
            <Input
              id="new-entity-email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="contact@exemple.org"
            />
          </Form.Item>
          <Form.Item label="Téléphone" htmlFor="new-entity-tel" style={{ marginBottom: 0 }}>
            <Input
              id="new-entity-tel"
              value={tel}
              onChange={(e) => setTel(e.target.value)}
              placeholder="+221 …"
            />
          </Form.Item>
        </Space>
      </Form>
    </Modal>
  );
}
