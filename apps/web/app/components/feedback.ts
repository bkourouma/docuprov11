'use client';

import { App } from 'antd';

/**
 * Helpers de feedback cohérents (au-dessus du contexte AntD `App`).
 * Vocabulaire FR uniforme : Confirmer / Annuler.
 */
export function useFeedback() {
  const { message, modal } = App.useApp();

  /** Boîte de confirmation pour une action importante/destructrice. */
  const confirm = (opts: {
    title: string;
    content?: React.ReactNode;
    okText?: string;
    danger?: boolean;
    onOk: () => void | Promise<void>;
  }) =>
    modal.confirm({
      title: opts.title,
      content: opts.content,
      okText: opts.okText ?? 'Confirmer',
      cancelText: 'Annuler',
      okButtonProps: opts.danger ? { danger: true } : undefined,
      onOk: opts.onOk,
    });

  return { message, confirm };
}
