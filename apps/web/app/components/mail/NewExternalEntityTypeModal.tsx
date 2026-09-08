'use client';

import { useEffect, useState } from 'react';
import { App, Form, Input, Modal, Typography } from 'antd';
import { externalEntityTypesApi, type ExternalEntityTypeRow } from '../../lib/courriers';

/**
 * Création d'un type d'entité externe (§16) depuis l'écran des entités externes — le type se crée
 * là où on en a besoin, sans quitter la saisie du correspondant (l'écran dédié a été retiré).
 *
 * `onCreated` reçoit le type créé pour que l'appelant rafraîchisse sa liste ET le sélectionne : une
 * création suivie d'un choix manuel dans le select serait un pas de plus pour rien.
 */
export function NewExternalEntityTypeModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (created: ExternalEntityTypeRow) => void;
}) {
  const { message } = App.useApp();
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);

  // Repart d'un champ vide à chaque ouverture : sinon un abandon laisserait sa saisie à la suivante.
  useEffect(() => {
    if (open) setLabel('');
  }, [open]);

  const submit = async () => {
    const value = label.trim();
    if (!value) return;
    setBusy(true);
    try {
      const created = await externalEntityTypesApi.create({ label: value });
      message.success('Type d’entité externe créé');
      onCreated(created);
      onClose();
    } catch (e) {
      // Le back normalise et dédoublonne les libellés (§16) : son message porte le motif exact.
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
      title="Nouveau type d'entité externe"
      destroyOnHidden
    >
      <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
        Catégorie de correspondant (ex. Ministère, Entreprise). Les libellés sont normalisés et
        dédoublonnés à l&apos;enregistrement.
      </Typography.Paragraph>
      {/*
        Label posé AU-DESSUS du champ : le libellé vivait auparavant dans un `Text secondary` qui
        n'était relié à aucun champ (ni <label>, ni astérisque d'AntD). `component={false}` : on
        veut la mise en page et le libellé d'AntD, pas un <form> qui capturerait la touche Entrée
        (elle est déjà câblée sur la création).
      */}
      <Form component={false} layout="vertical">
        <Form.Item
          label="Libellé"
          htmlFor="new-entity-type-label"
          required
          style={{ marginBottom: 0 }}
        >
          <Input
            id="new-entity-type-label"
            autoFocus
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onPressEnter={() => void submit()}
            placeholder="Ex. Ministère"
          />
        </Form.Item>
      </Form>
    </Modal>
  );
}
