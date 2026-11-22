'use client';

import { useEffect, useRef, useState } from 'react';
import { App, Button, Input, Modal } from 'antd';
import type { TextAreaRef } from 'antd/es/input/TextArea';
import { useRouter } from 'next/navigation';
import { workflowsApi } from '../../../../lib/workflows-api';
import {
  AUTHORING_DESCRIPTION_MAX,
  AUTHORING_EXAMPLE,
  AUTHORING_WARNING,
  authoringEditorPath,
  authoringErrorMessage,
  buildBannerState,
  countChars,
  counterLabel,
  saveBannerState,
  validateDescription,
  type BannerStorageLike,
} from '../../../_lib/authoring-logic';

/** `sessionStorage` peut lever (navigation privée, stockage bloqué) : on le traite comme absent. */
export function safeSessionStorage(): BannerStorageLike | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/** Dialogue « Décrire le besoin » : la description devient un BROUILLON de workflow, jamais publié. */
export function DescribeNeedModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const { message } = App.useApp();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const areaRef = useRef<TextAreaRef>(null);

  // Quitter la page pendant la génération : on cesse d'attendre.
  useEffect(() => () => abortRef.current?.abort(), []);

  const close = () => {
    abortRef.current?.abort();
    setError(null);
    setDone(false);
    onClose();
  };

  const submit = async () => {
    if (busyRef.current || done) return;
    const problem = validateDescription(text);
    if (problem) {
      setError(problem);
      areaRef.current?.focus();
      return;
    }
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const res = await workflowsApi.authoringGenerate({ description: text.trim() }, ctrl.signal);
      if (ctrl.signal.aborted) return;
      const path = authoringEditorPath(res?.definitionId);
      if (!path) {
        setError('La réponse du serveur est incomplète : le brouillon n’a pas pu être ouvert. Consultez la liste des workflows.');
        return;
      }
      // Le bandeau de relecture est retrouvé par l'éditeur : l'état voyage par sessionStorage (borné, facultatif).
      saveBannerState(safeSessionStorage(), res.definitionId, buildBannerState(res));
      setDone(true);
      message.success('Brouillon créé : relisez-le avant toute publication.');
      router.push(path);
    } catch (e) {
      if (!ctrl.signal.aborted) setError(authoringErrorMessage(e));
    } finally {
      busyRef.current = false;
      abortRef.current = null;
      setBusy(false);
    }
  };

  const over = countChars(text) > AUTHORING_DESCRIPTION_MAX;
  const describedBy = ['wfa-counter', 'wfa-warning', 'wfa-hint', ...(error ? ['wfa-error'] : [])].join(' ');

  return (
    <Modal
      open={open}
      className="wfa-modal"
      title="Décrire le besoin"
      onCancel={close}
      maskClosable={false}
      destroyOnHidden
      afterOpenChange={(isOpen) => {
        if (isOpen) areaRef.current?.focus();
      }}
      footer={[
        <Button key="cancel" onClick={close}>
          {busy ? 'Annuler la génération' : 'Fermer'}
        </Button>,
        <Button key="ok" type="primary" loading={busy} disabled={busy || done} onClick={() => void submit()}>
          {busy ? 'Génération en cours…' : 'Générer le brouillon'}
        </Button>,
      ]}
    >
      <form
        className="wfa-form"
        aria-busy={busy}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label htmlFor="wfa-description" className="wfa-label">
          Décrivez en français le workflow souhaité
        </label>
        <p id="wfa-hint" className="wfa-hint">
          Dites quand il démarre, ce qui doit être vérifié ou extrait, et qui valide selon quels seuils. Vous pourrez tout
          corriger dans l’éditeur graphique.
        </p>
        <Input.TextArea
          id="wfa-description"
          ref={areaRef}
          autoFocus
          value={text}
          autoSize={{ minRows: 5, maxRows: 14 }}
          disabled={busy || done}
          aria-describedby={describedBy}
          aria-invalid={error !== null || over ? true : undefined}
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
        />
        <div className="wfa-row">
          <span id="wfa-counter" className={`wfa-counter${over ? ' wfa-counter--over' : ''}`} aria-live="polite">
            {counterLabel(text)}
            {over ? ' — limite dépassée' : ''}
          </span>
          <Button size="small" disabled={busy || done} onClick={() => { setText(AUTHORING_EXAMPLE); setError(null); areaRef.current?.focus(); }}>
            Utiliser l’exemple
          </Button>
        </div>
        <p className="wfa-example">
          <span className="wfa-example-label">Exemple : </span>
          {AUTHORING_EXAMPLE}
        </p>
        <p id="wfa-warning" className="wfa-notice">
          <strong>{AUTHORING_WARNING}</strong>
        </p>
        <div id="wfa-error" role="alert" className="wfa-alert-zone">
          {error && <p className="wfa-error">{error}</p>}
        </div>
        <div role="status" className="wfa-status">
          {busy ? 'Génération en cours…' : done ? 'Brouillon créé. Ouverture de l’éditeur…' : ''}
        </div>
      </form>
    </Modal>
  );
}

/** Bouton « Décrire le besoin » (en-tête de la liste) et son dialogue ; le focus revient au bouton à la fermeture. */
export function DescribeNeedButton() {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <Button ref={btnRef} onClick={() => setOpen(true)}>
        Décrire le besoin
      </Button>
      <DescribeNeedModal
        open={open}
        onClose={() => {
          setOpen(false);
          window.setTimeout(() => btnRef.current?.focus(), 0);
        }}
      />
    </>
  );
}
