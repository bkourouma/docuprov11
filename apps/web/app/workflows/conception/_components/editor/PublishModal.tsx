'use client';

import { Input, Modal } from 'antd';

import { CHANGE_NOTE_MAX } from '../../../_lib/editor-state';

export interface PublishModalProps {
  open: boolean;
  versionNumber: number;
  note: string;
  busy: boolean;
  onNote(value: string): void;
  onConfirm(): void;
  onCancel(): void;
}

/** Confirmation de publication : rappelle l'immutabilité, note de version facultative. */
export function PublishModal(p: PublishModalProps) {
  return (
    <Modal
      open={p.open}
      title={`Publier la version n° ${p.versionNumber} ?`}
      okText="Publier"
      cancelText="Annuler"
      confirmLoading={p.busy}
      onOk={p.onConfirm}
      onCancel={() => {
        if (!p.busy) p.onCancel();
      }}
      maskClosable={false}
    >
      <p>
        La version publiée devient immuable et remplace la précédente ; les instances en cours ne sont pas touchées.
      </p>
      <div className="wfe-field">
        <label htmlFor="wfe-change-note">Note de version (facultative)</label>
        <Input.TextArea
          id="wfe-change-note"
          value={p.note}
          maxLength={CHANGE_NOTE_MAX}
          showCount
          autoSize={{ minRows: 2, maxRows: 6 }}
          placeholder="Ce qui change dans cette version"
          onChange={(e) => p.onNote(e.target.value)}
        />
      </div>
    </Modal>
  );
}
