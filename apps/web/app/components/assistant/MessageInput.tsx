'use client';

// Zone de saisie contrôlée. N'envoie JAMAIS seule : uniquement Entrée dans la zone ou clic sur « Envoyer ».
// Aucune validation ici ne remplace celle du serveur.
import { useId, type KeyboardEvent, type Ref } from 'react';
import { Button, Input } from 'antd';
import type { TextAreaRef } from 'antd/es/input/TextArea';
import { ASST_MESSAGE_MAX_CHARS } from '@archivage/types';
import { composerState, shouldSendOnKey } from './_lib/composer-logic';

export interface MessageInputProps {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (text: string) => void;
  sending: boolean;
  blocked: boolean;
  blockedMessage?: string | null;
  onCancel: () => void;
  autoFocus?: boolean;
  inputRef?: Ref<HTMLTextAreaElement>;
}

export function MessageInput({
  value,
  onChange,
  onSubmit,
  sending,
  blocked,
  blockedMessage,
  onCancel,
  autoFocus,
  inputRef,
}: MessageInputProps) {
  const uid = useId();
  const inputId = `asst-input-${uid}`;
  const helpId = `asst-input-help-${uid}`;
  const counterId = `asst-input-counter-${uid}`;
  const errorId = `asst-input-error-${uid}`;
  const blockedId = `asst-input-blocked-${uid}`;
  const st = composerState(value);
  const showCounter = st.length > ASST_MESSAGE_MAX_CHARS * 0.8;
  const canSend = st.canSend && !sending && !blocked;

  const submit = (): void => {
    if (!canSend) return;
    onSubmit(st.trimmed);
  };

  const describedBy = [
    helpId,
    showCounter ? counterId : null,
    st.tooLong ? errorId : null,
    blocked && blockedMessage ? blockedId : null,
  ]
    .filter((x): x is string => x !== null)
    .join(' ');

  // antd expose un TextAreaRef ; on relaie le <textarea> natif au parent.
  const relayRef = (r: TextAreaRef | null): void => {
    const el = r?.resizableTextArea?.textArea ?? null;
    if (typeof inputRef === 'function') inputRef(el);
    else if (inputRef) (inputRef as { current: HTMLTextAreaElement | null }).current = el;
  };

  return (
    <form
      className="asst-composer"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <label htmlFor={inputId} className="asst-sr-only">
        Votre message à l’assistant
      </label>
      {blocked && blockedMessage && (
        <p id={blockedId} className="asst-composer-blocked">
          {blockedMessage}
        </p>
      )}
      <Input.TextArea
        id={inputId}
        ref={relayRef}
        className="asst-composer-input"
        value={value}
        autoSize={{ minRows: 1, maxRows: 6 }}
        autoFocus={autoFocus}
        disabled={blocked}
        status={st.tooLong ? 'error' : undefined}
        aria-describedby={describedBy}
        aria-invalid={st.tooLong || undefined}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e: KeyboardEvent<HTMLTextAreaElement>) => {
          if (shouldSendOnKey(e)) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <div className="asst-composer-meta">
        <p id={helpId} className="asst-composer-help">
          Entrée pour envoyer, Maj+Entrée pour un saut de ligne
        </p>
        {showCounter && (
          <p id={counterId} className={`asst-composer-counter${st.tooLong ? ' asst-composer-counter--over' : ''}`}>
            {st.counterLabel}
          </p>
        )}
      </div>
      {st.tooLong && (
        <p id={errorId} className="asst-composer-error" role="alert">
          Message trop long
        </p>
      )}
      <div className="asst-composer-buttons">
        {sending && (
          <Button className="asst-btn" htmlType="button" onClick={() => onCancel()}>
            Arrêter l’attente
          </Button>
        )}
        <Button type="primary" className="asst-btn" htmlType="submit" disabled={!canSend}>
          Envoyer
        </Button>
      </div>
    </form>
  );
}
