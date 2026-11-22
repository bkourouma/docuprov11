'use client';

import { useState } from 'react';
import { Alert, Form, Input, Modal } from 'antd';
import { useRouter } from 'next/navigation';
import { WorkflowApiError, workflowErrorMessage, workflowsApi } from '../../../../lib/workflows-api';
import { emptyGraph } from '../../../_lib/graph-model';

const NAME_MAX = 200;
const DESCRIPTION_MAX = 4000;

/** Création d'un workflow : nom + description, graphe de départ à une étape, puis ouverture de l'éditeur. */
export function CreateDefinitionModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setName('');
    setDescription('');
    setNameError(null);
    setError(null);
  };

  const submit = async () => {
    if (busy) return;
    const trimmed = name.trim();
    if (trimmed.length < 1 || trimmed.length > NAME_MAX) {
      setNameError(`Le nom est obligatoire (1 à ${NAME_MAX} caractères).`);
      return;
    }
    if (description.length > DESCRIPTION_MAX) {
      setError(`La description ne peut pas dépasser ${DESCRIPTION_MAX} caractères.`);
      return;
    }
    setBusy(true);
    setNameError(null);
    setError(null);
    try {
      const res = await workflowsApi.createDefinition({
        name: trimmed,
        ...(description.trim() !== '' ? { description: description.trim() } : {}),
        graph: emptyGraph(),
      });
      reset();
      router.push(`/workflows/conception/${res.definition.wfDefinitionId}`);
    } catch (e) {
      // 409 : nom déjà pris. Le message est rattaché au champ pour être relié par les lecteurs d'écran.
      if (e instanceof WorkflowApiError && e.conflict) {
        setNameError('Ce nom est déjà utilisé par un autre workflow. Choisissez-en un autre.');
      } else {
        setError(workflowErrorMessage(e));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      title="Nouveau workflow"
      okText="Créer et ouvrir"
      cancelText="Annuler"
      confirmLoading={busy}
      onOk={() => void submit()}
      onCancel={() => {
        if (busy) return;
        reset();
        onClose();
      }}
      maskClosable={false}
      destroyOnHidden
    >
      <Form layout="vertical" onFinish={() => void submit()} requiredMark="optional">
        <Form.Item
          label="Nom du workflow"
          htmlFor="wfe-create-name"
          required
          validateStatus={nameError ? 'error' : undefined}
          help={nameError ?? undefined}
        >
          <Input
            id="wfe-create-name"
            autoFocus
            value={name}
            maxLength={NAME_MAX}
            onChange={(e) => {
              setName(e.target.value);
              setNameError(null);
            }}
            aria-invalid={nameError ? true : undefined}
            onPressEnter={() => void submit()}
          />
        </Form.Item>
        <Form.Item label="Description (facultative)" htmlFor="wfe-create-description">
          <Input.TextArea
            id="wfe-create-description"
            value={description}
            maxLength={DESCRIPTION_MAX}
            autoSize={{ minRows: 3, maxRows: 8 }}
            showCount
            onChange={(e) => setDescription(e.target.value)}
          />
        </Form.Item>
        {error && <Alert type="error" showIcon message={error} />}
      </Form>
    </Modal>
  );
}
