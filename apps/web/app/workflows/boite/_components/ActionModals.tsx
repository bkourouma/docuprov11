'use client';

import { useId, useState } from 'react';
import { Alert, Input, Modal } from 'antd';
import { parseComment, parseDelegateInput } from '../../_lib/inbox-logic';

const { TextArea } = Input;

/**
 * Confirmation de refus. Le moteur n'emprunte que les voies conditionnées du workflow : sans voie de
 * correction, le workflow est suspendu (docs/workflow-moteur.md, 3.8). On le dit AVANT de confirmer.
 * `onConfirm` renvoie un message d'erreur (la modale reste ouverte) ou null (le parent ferme).
 */
export function RejectModal({
  open,
  busy,
  title,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  busy: boolean;
  title: string;
  onConfirm: (comment: string | undefined) => Promise<string | null>;
  onCancel: () => void;
}) {
  const uid = useId();
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const c = parseComment(comment);
    if (!c.ok) {
      setError(c.error);
      return;
    }
    setError(null);
    const failure = await onConfirm(c.value);
    if (failure) setError(failure);
  };

  return (
    <Modal
      open={open}
      title="Rejeter cette tâche ?"
      okText="Confirmer le refus"
      okButtonProps={{ danger: true, loading: busy }}
      cancelText="Annuler"
      cancelButtonProps={{ disabled: busy }}
      onOk={submit}
      onCancel={busy ? undefined : onCancel}
      maskClosable={false}
      keyboard={!busy}
      destroyOnHidden
      afterClose={() => {
        setComment('');
        setError(null);
      }}
    >
      <p>
        Vous allez refuser « <strong>{title}</strong> ».
      </p>
      <p className="wf-muted">
        Le refus n’emprunte que les voies conditionnées du workflow ; sans voie de correction le workflow est suspendu.
      </p>
      <div className="wf-field wfb-field">
        <label htmlFor={`${uid}-c`}>Commentaire (facultatif, 4 000 caractères au plus)</label>
        <TextArea
          id={`${uid}-c`}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          autoSize={{ minRows: 3, maxRows: 8 }}
          showCount
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${uid}-e` : undefined}
        />
      </div>
      <div id={`${uid}-e`} role="alert">
        {error && <Alert type="error" showIcon message={error} />}
      </div>
    </Modal>
  );
}

/**
 * Délégation à un autre utilisateur. Aucun endpoint de recherche d'utilisateurs n'est exposé à cet
 * écran : l'identifiant (`user_group_id`) est saisi à la main.
 */
export function DelegateModal({
  open,
  busy,
  title,
  selfUserGroupId,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  busy: boolean;
  title: string;
  selfUserGroupId: number | null;
  onConfirm: (toUserGroupId: number, comment: string | undefined) => Promise<string | null>;
  onCancel: () => void;
}) {
  const uid = useId();
  const [userText, setUserText] = useState('');
  const [comment, setComment] = useState('');
  const [errors, setErrors] = useState<string[]>([]);

  const submit = async () => {
    const parsed = parseDelegateInput(userText, comment, selfUserGroupId);
    if (!parsed.ok) {
      setErrors(parsed.errors);
      return;
    }
    setErrors([]);
    const failure = await onConfirm(parsed.toUserGroupId, parsed.comment);
    if (failure) setErrors([failure]);
  };

  return (
    <Modal
      open={open}
      title="Déléguer cette tâche"
      okText="Déléguer"
      okButtonProps={{ loading: busy }}
      cancelText="Annuler"
      cancelButtonProps={{ disabled: busy }}
      onOk={submit}
      onCancel={busy ? undefined : onCancel}
      maskClosable={false}
      keyboard={!busy}
      destroyOnHidden
      afterClose={() => {
        setUserText('');
        setComment('');
        setErrors([]);
      }}
    >
      <p>
        Vous allez confier « <strong>{title}</strong> » à un autre utilisateur.
      </p>
      <div className="wf-field wfb-field">
        <label htmlFor={`${uid}-u`}>Numéro d’utilisateur du destinataire (obligatoire)</label>
        <Input
          id={`${uid}-u`}
          value={userText}
          inputMode="numeric"
          onChange={(e) => setUserText(e.target.value)}
          aria-required
          aria-invalid={errors.length > 0 ? true : undefined}
          aria-describedby={`${uid}-h${errors.length > 0 ? ` ${uid}-e` : ''}`}
        />
        <span id={`${uid}-h`} className="wf-muted">
          L’annuaire n’est pas accessible depuis cet écran : saisissez le numéro d’utilisateur fourni par votre
          administrateur.
        </span>
      </div>
      <div className="wf-field wfb-field">
        <label htmlFor={`${uid}-c`}>Commentaire (facultatif, 4 000 caractères au plus)</label>
        <TextArea
          id={`${uid}-c`}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          autoSize={{ minRows: 2, maxRows: 8 }}
          showCount
        />
      </div>
      <div id={`${uid}-e`} role="alert">
        {errors.length > 0 && (
          <Alert
            type="error"
            showIcon
            message={
              <ul className="wfb-errors">
                {errors.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            }
          />
        )}
      </div>
    </Modal>
  );
}
