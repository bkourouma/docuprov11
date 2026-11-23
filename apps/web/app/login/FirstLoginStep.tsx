'use client';

import { useState } from 'react';
import { Alert, Button, Form, Input, Typography } from 'antd';
import { API_BASE } from '../lib/api';
import { icons } from '../theme/icons';
import { changeProvisionalPassword } from './first-login';
import { newPasswordError } from './password-policy';

interface FirstLoginForm {
  newPassword: string;
  confirmPassword: string;
}

/**
 * Étape imposée après la connexion d'un compte marqué `mustChangePwd` : l'utilisateur choisit un
 * mot de passe personnel avant d'entrer dans l'application.
 *
 * Le mot de passe provisoire vient d'être saisi (et accepté) à l'étape précédente : on ne le
 * redemande pas, il sert de `currentPassword`. Le jeton reste en mémoire jusqu'au succès — voir
 * `first-login.ts`.
 */
export function FirstLoginStep({
  username,
  accessToken,
  provisionalPassword,
  mutedColor,
  onDone,
  onCancel,
}: {
  username: string;
  accessToken: string;
  provisionalPassword: string;
  /** Encre atténuée de la carte de connexion (palette locale de l'écran). */
  mutedColor: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [form] = Form.useForm<FirstLoginForm>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const Lock = icons['lock'];

  const onFinish = async (values: FirstLoginForm) => {
    setSaving(true);
    setError(null);
    try {
      const result = await changeProvisionalPassword(
        fetch,
        API_BASE,
        accessToken,
        provisionalPassword,
        values.newPassword,
      );
      if (result.ok) {
        onDone();
        return;
      }
      setError(result.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Typography.Title level={3} className="da-display" style={{ marginBottom: 4 }}>
        Nouveau mot de passe
      </Typography.Title>
      <Typography.Paragraph style={{ color: mutedColor, marginBottom: 24 }}>
        Le mot de passe du compte <strong className="da-mono">{username}</strong> a été attribué par
        un administrateur. Choisissez un mot de passe personnel pour continuer.
      </Typography.Paragraph>

      {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} />}

      <Form<FirstLoginForm>
        form={form}
        name="first-login"
        layout="vertical"
        onFinish={(v) => void onFinish(v)}
        requiredMark={false}
        autoComplete="off"
      >
        <Form.Item
          name="newPassword"
          label="Nouveau mot de passe"
          rules={[
            { required: true, message: 'Saisissez un nouveau mot de passe.' },
            {
              validator: (_, value: string | undefined) => {
                const problem = newPasswordError(value, { provisional: provisionalPassword });
                return problem ? Promise.reject(new Error(problem)) : Promise.resolve();
              },
            },
          ]}
        >
          <Input.Password
            autoFocus
            autoComplete="new-password"
            prefix={
              <Lock
                size={16}
                strokeWidth={1.75}
                style={{ color: 'var(--ant-color-text-tertiary)' }}
              />
            }
          />
        </Form.Item>
        <Form.Item
          name="confirmPassword"
          label="Confirmer le nouveau mot de passe"
          dependencies={['newPassword']}
          rules={[
            { required: true, message: 'Confirmez le nouveau mot de passe.' },
            ({ getFieldValue }) => ({
              validator: (_, value: string | undefined) =>
                !value || getFieldValue('newPassword') === value
                  ? Promise.resolve()
                  : Promise.reject(new Error('Les deux saisies diffèrent')),
            }),
          ]}
        >
          <Input.Password
            autoComplete="new-password"
            prefix={
              <Lock
                size={16}
                strokeWidth={1.75}
                style={{ color: 'var(--ant-color-text-tertiary)' }}
              />
            }
          />
        </Form.Item>
        <Button
          type="primary"
          htmlType="submit"
          block
          loading={saving}
          className="da-login-cta"
          style={{ marginTop: 4 }}
        >
          Valider et continuer
        </Button>
        <Button type="link" block onClick={onCancel} style={{ marginTop: 8 }} disabled={saving}>
          Revenir à la connexion
        </Button>
      </Form>
    </>
  );
}
