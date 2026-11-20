'use client';

import { Alert, Checkbox, Divider, Form, Input, InputNumber, Select, Typography } from 'antd';
import { space as spacing } from '../../theme/tokens';
import { useDocuproGroups } from './useDocuproGroups';
import { WhatsappSendersEditor } from './WhatsappSendersEditor';
import { DEFAULT_GRAPH_API_VERSION, toGroupId } from './whatsapp-config';

const SECRETS = [
  { name: 'accessToken', label: 'Jeton d’accès (Access token)' },
  { name: 'appSecret', label: 'Secret de l’application (App secret)' },
  { name: 'verifyToken', label: 'Jeton de vérification (Verify token)' },
] as const;

/**
 * Sous-formulaire du connecteur WhatsApp Business. Champs sous `whatsapp.*` dans le formulaire parent.
 * Secrets : jamais pré-remplis ; à l'édition, ils ne sont envoyés que si « Remplacer les secrets » est
 * cochée (et alors les trois sont exigés).
 */
export function WhatsappFormSection({
  editing,
  hasCredentials,
  replaceSecrets,
}: {
  editing: boolean;
  hasCredentials: boolean;
  replaceSecrets: boolean;
}) {
  const groups = useDocuproGroups();
  const askSecrets = !editing || !hasCredentials || replaceSecrets;

  return (
    <>
      <Divider orientation="left" plain>
        WhatsApp Business
      </Divider>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: spacing.lg }}
        message="Mode Copie, sans synchronisation planifiée : WhatsApp envoie les messages au webhook de DocuPro, qui les copie."
      />
      <Form.Item
        name={['whatsapp', 'phoneNumberId']}
        label="Numéro WhatsApp Business (Phone Number ID)"
        extra="Identifiant du numéro dans la console Meta (chiffres uniquement), pas le numéro de téléphone."
        rules={[
          { required: true, whitespace: true, message: 'Renseignez le Phone Number ID' },
          { pattern: /^\s*\d+\s*$/, message: 'Le Phone Number ID ne contient que des chiffres' },
        ]}
      >
        <Input autoComplete="off" inputMode="numeric" maxLength={40} />
      </Form.Item>
      <Form.Item
        name={['whatsapp', 'graphApiVersion']}
        label="Version de l’API Graph (facultatif)"
        extra={`Vide : ${DEFAULT_GRAPH_API_VERSION}.`}
        rules={[{ pattern: /^\s*v\d+\.\d+\s*$|^\s*$/, message: 'Format attendu : v21.0' }]}
      >
        <Input autoComplete="off" placeholder={DEFAULT_GRAPH_API_VERSION} maxLength={12} />
      </Form.Item>
      <Form.Item
        name={['whatsapp', 'maxFileMio']}
        label="Taille maximale d’un document (Mio, facultatif)"
        extra="Peut seulement resserrer la limite générale des connecteurs."
      >
        <InputNumber min={0.1} precision={2} style={{ width: '100%' }} />
      </Form.Item>
      <Form.Item name={['whatsapp', 'ackEnabled']} valuePropName="checked">
        <Checkbox>Envoyer l’accusé de réception</Checkbox>
      </Form.Item>
      <Form.Item name={['whatsapp', 'refuseUnknownSenders']} valuePropName="checked">
        <Checkbox>Répondre poliment aux expéditeurs inconnus</Checkbox>
      </Form.Item>

      <Divider orientation="left" plain>
        Secrets
      </Divider>
      {editing && hasCredentials && (
        <>
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: spacing.lg }}
            message="Secrets enregistrés (••••••••)"
            description="Ils ne sont jamais réaffichés. Pour les changer, cochez « Remplacer les secrets » : les trois valeurs sont alors à ressaisir."
          />
          <Form.Item name={['whatsapp', 'replaceSecrets']} valuePropName="checked">
            <Checkbox>Remplacer les secrets</Checkbox>
          </Form.Item>
        </>
      )}
      {askSecrets &&
        SECRETS.map((s) => (
          <Form.Item
            key={s.name}
            name={['whatsapp', 'secrets', s.name]}
            label={s.label}
            rules={[{ required: true, message: `Renseignez « ${s.label} »` }]}
          >
            <Input.Password autoComplete="new-password" />
          </Form.Item>
        ))}

      <Divider orientation="left" plain>
        Expéditeurs autorisés
      </Divider>
      <Typography.Text strong id="wa-senders-label">
        Seuls ces numéros peuvent déposer des documents
      </Typography.Text>
      <Typography.Paragraph type="secondary" style={{ marginTop: spacing.xs }}>
        Le groupe choisi pour un expéditeur reçoit la consultation de ses documents ; sans groupe,
        ce sont les groupes de repli.
      </Typography.Paragraph>
      <WhatsappSendersEditor groups={groups} />

      <Divider orientation="left" plain>
        Droits d&apos;origine
      </Divider>
      <Form.Item
        name={['whatsapp', 'fallbackGroupIds']}
        label="Groupes de repli"
        extra="Obligatoire : groupes qui voient les documents d’un expéditeur sans groupe."
        rules={[
          {
            validator: async (_, value: (number | string)[] | undefined) => {
              const list = value ?? [];
              if (list.length === 0) throw new Error('Choisissez au moins un groupe de repli');
              if (list.some((v) => toGroupId(v) === null)) {
                throw new Error('Saisissez uniquement des identifiants numériques positifs');
              }
            },
          },
        ]}
      >
        <Select
          mode={groups.loaded ? 'multiple' : 'tags'}
          showSearch
          optionFilterProp="label"
          aria-label="Groupes de repli"
          placeholder={groups.loaded ? 'Choisir des groupes' : 'Identifiants de groupes (ex. 3)'}
          options={groups.options}
          tokenSeparators={[',', ' ']}
        />
      </Form.Item>
    </>
  );
}
