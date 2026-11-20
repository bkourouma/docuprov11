'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Divider,
  Form,
  Input,
  InputNumber,
  Modal,
  Radio,
  Select,
  Space,
  Switch,
  Typography,
} from 'antd';
import { useFeedback } from '../../components/feedback';
import { icons, iconDefaults } from '../../theme/icons';
import { space as spacing } from '../../theme/tokens';
import {
  GED_SOURCE_MODE_LABELS,
  GedSourceMode,
  MODE_HELP,
  RIGHTS_HELP,
  buildCreateBody,
  buildUpdateBody,
  connecteursApi,
  hasInvalidIds,
  toFormValues,
  type ConnectorFormValues,
  type GedConnectorFieldDescriptor,
  type GedConnectorTypeInfo,
  type GedConnectorView,
} from '../../lib/connecteurs';

const SYNC_MIN = 5;
const SYNC_MAX = 10080;

interface Values extends ConnectorFormValues {
  intervalKind?: 'manual' | 'every';
}

const ALL_MODES = [
  GedSourceMode.Copie,
  GedSourceMode.IndexationEnPlace,
  GedSourceMode.Synchro,
] as const;

/** Un champ du registre rendu selon son `kind`. Les mots de passe ne sont jamais pré-remplis. */
function DynamicField({
  group,
  field,
  required,
  extraRules,
}: {
  group: 'config' | 'credentials';
  field: GedConnectorFieldDescriptor;
  required: boolean;
  extraRules?: { validator: (rule: unknown, value: unknown) => Promise<void> }[];
}) {
  const label = field.label;
  const common = {
    name: [group, field.name],
    label,
    extra: field.help,
    rules: [
      ...(required ? [{ required: true, message: `Renseignez « ${label} »` }] : []),
      ...(extraRules ?? []),
    ],
  };
  switch (field.kind) {
    case 'boolean':
      return (
        <Form.Item {...common} valuePropName="checked">
          <Switch aria-label={label} />
        </Form.Item>
      );
    case 'number':
      return (
        <Form.Item {...common}>
          <InputNumber style={{ width: '100%' }} placeholder={field.placeholder} />
        </Form.Item>
      );
    case 'password':
      return (
        <Form.Item {...common}>
          <Input.Password autoComplete="new-password" placeholder={field.placeholder} />
        </Form.Item>
      );
    case 'textarea':
      return (
        <Form.Item {...common}>
          <Input.TextArea rows={3} placeholder={field.placeholder} />
        </Form.Item>
      );
    default:
      return (
        <Form.Item {...common}>
          <Input autoComplete="off" placeholder={field.placeholder} />
        </Form.Item>
      );
  }
}

/**
 * Création et modification d'un connecteur (même formulaire, en modale comme SpaceFormModal).
 *
 * Sécurité : les identifiants ne sont JAMAIS pré-remplis (l'API ne les renvoie pas). À l'édition,
 * laisser vide les conserve ; « Effacer les identifiants » envoie `credentials: null`. Le formulaire
 * est vidé à l'ouverture et après enregistrement.
 */
export function ConnectorFormModal({
  open,
  types,
  connector,
  onClose,
  onSaved,
}: {
  open: boolean;
  types: GedConnectorTypeInfo[];
  /** Absent = création. */
  connector?: GedConnectorView;
  onClose: () => void;
  onSaved: (saved: GedConnectorView) => void;
}) {
  const { message } = useFeedback();
  const [form] = Form.useForm<Values>();
  const [saving, setSaving] = useState(false);
  const [clearCredentials, setClearCredentials] = useState(false);
  const typeId = Form.useWatch('connectorType', form) as string | undefined;
  const intervalKind = Form.useWatch('intervalKind', form);
  const mode = Form.useWatch('mode', form) as GedSourceMode | undefined;
  const editing = !!connector;
  const Add = icons.add;
  const Remove = icons.delete;

  const info = useMemo(() => types.find((t) => t.type === typeId), [types, typeId]);
  const modes = info?.supportedModes?.length ? info.supportedModes : [...ALL_MODES];

  useEffect(() => {
    if (!open) return;
    setClearCredentials(false);
    form.resetFields();
    if (connector) {
      const base = toFormValues(
        connector,
        types.find((t) => t.type === connector.connectorType),
      );
      const initial: Values = {
        ...base,
        intervalKind: connector.syncIntervalMinutes ? 'every' : 'manual',
      };
      form.setFieldsValue(initial as Parameters<typeof form.setFieldsValue>[0]);
    } else {
      form.setFieldsValue({
        connectorType: types[0]?.type,
        mode: types[0]?.supportedModes?.[0] ?? GedSourceMode.Copie,
        intervalKind: 'manual',
        syncIntervalMinutes: null,
        principalMap: [],
        fallbackGroups: '',
        config: {},
        credentials: {},
      });
    }
  }, [open, connector, types, form]);

  const onTypeChange = (t: string) => {
    const next = types.find((x) => x.type === t);
    const supported = next?.supportedModes ?? [];
    form.setFieldsValue({ config: {}, credentials: {} });
    if (mode === undefined || (supported.length > 0 && !supported.includes(mode))) {
      form.setFieldValue('mode', supported[0] ?? GedSourceMode.Copie);
    }
  };

  const submit = async (v: Values) => {
    setSaving(true);
    try {
      const values: ConnectorFormValues = {
        ...v,
        syncIntervalMinutes: v.intervalKind === 'every' ? (v.syncIntervalMinutes ?? null) : null,
      };
      const saved = connector
        ? await connecteursApi.update(
            connector.gedSourceConnectorId,
            buildUpdateBody(info, values, connector.config, clearCredentials),
          )
        : await connecteursApi.create(buildCreateBody(info, values));
      message.success(connector ? 'Connecteur modifié' : 'Connecteur créé');
      form.resetFields();
      onSaved(saved);
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Enregistrement impossible');
    } finally {
      setSaving(false);
    }
  };

  const keptCredentials = editing && !!connector?.hasCredentials && !clearCredentials;
  const credentialFields = info?.credentialFields ?? [];

  /** Remplacement complet : si l'on saisit un identifiant, les champs obligatoires doivent l'être aussi. */
  const wholeSetRule = (f: GedConnectorFieldDescriptor) =>
    keptCredentials && f.required
      ? [
          {
            validator: async (_: unknown, value: unknown) => {
              const entered = form.getFieldValue('credentials') as
                | Record<string, string>
                | undefined;
              const any = Object.values(entered ?? {}).some(
                (x) => typeof x === 'string' && x !== '',
              );
              if (any && !value) {
                throw new Error(
                  `Renseignez « ${f.label} » : la saisie remplace tous les identifiants`,
                );
              }
            },
          },
        ]
      : undefined;

  return (
    <Modal
      open={open}
      width={720}
      title={editing ? 'Modifier le connecteur' : 'Nouveau connecteur'}
      okText={editing ? 'Enregistrer' : 'Créer le connecteur'}
      cancelText="Annuler"
      confirmLoading={saving}
      onCancel={() => {
        form.resetFields();
        onClose();
      }}
      onOk={() => form.submit()}
      destroyOnClose
      forceRender
    >
      <Form form={form} layout="vertical" onFinish={submit} requiredMark="optional">
        <Form.Item
          name="label"
          label="Libellé"
          rules={[{ required: true, whitespace: true, message: 'Saisissez un libellé' }]}
        >
          <Input maxLength={200} autoFocus />
        </Form.Item>

        <Form.Item
          name="connectorType"
          label="Type de source"
          rules={[{ required: true, message: 'Choisissez un type de source' }]}
          extra={
            editing ? 'Le type ne peut pas être modifié après la création.' : info?.description
          }
        >
          <Select
            disabled={editing}
            onChange={onTypeChange}
            options={types.map((t) => ({ value: t.type, label: t.label }))}
            placeholder="Choisir un type"
          />
        </Form.Item>

        <Form.Item
          name="mode"
          label="Mode"
          rules={[{ required: true, message: 'Choisissez un mode' }]}
        >
          <Radio.Group>
            <Space direction="vertical">
              {ALL_MODES.filter((m) => modes.includes(m)).map((m) => (
                <Radio key={m} value={m}>
                  {GED_SOURCE_MODE_LABELS[m]}
                </Radio>
              ))}
            </Space>
          </Radio.Group>
        </Form.Item>
        {mode !== undefined && (
          <Typography.Paragraph type="secondary">{MODE_HELP[mode]}</Typography.Paragraph>
        )}

        {info && info.configFields.length > 0 && (
          <>
            <Divider orientation="left" plain>
              Configuration
            </Divider>
            {info.configFields.map((f) => (
              <DynamicField key={f.name} group="config" field={f} required={f.required} />
            ))}
          </>
        )}

        {info && credentialFields.length > 0 && (
          <>
            <Divider orientation="left" plain>
              Identifiants
            </Divider>
            {keptCredentials && (
              <Alert
                type="info"
                showIcon
                style={{ marginBottom: spacing.lg }}
                message="Identifiants enregistrés — laisser vide pour conserver"
                description="Si vous en saisissez, ils remplacent la totalité des identifiants actuels."
                action={
                  <Button size="small" danger onClick={() => setClearCredentials(true)}>
                    Effacer les identifiants
                  </Button>
                }
              />
            )}
            {editing && connector?.hasCredentials && clearCredentials && (
              <Alert
                type="warning"
                showIcon
                style={{ marginBottom: spacing.lg }}
                message="Les identifiants seront effacés à l’enregistrement."
                action={
                  <Button size="small" onClick={() => setClearCredentials(false)}>
                    Annuler
                  </Button>
                }
              />
            )}
            {credentialFields.map((f) => (
              <DynamicField
                key={f.name}
                group="credentials"
                field={f}
                required={f.required && !keptCredentials}
                extraRules={wholeSetRule(f)}
              />
            ))}
          </>
        )}

        <Divider orientation="left" plain>
          Planification et destination
        </Divider>
        <Form.Item name="intervalKind" label="Synchronisation">
          <Radio.Group>
            <Radio value="manual">Manuelle</Radio>
            <Radio value="every">Toutes les N minutes</Radio>
          </Radio.Group>
        </Form.Item>
        {intervalKind === 'every' && (
          <Form.Item
            name="syncIntervalMinutes"
            label="Intervalle (minutes)"
            rules={[
              { required: true, message: 'Indiquez un intervalle' },
              {
                type: 'number',
                min: SYNC_MIN,
                max: SYNC_MAX,
                message: `Entre ${SYNC_MIN} minutes et ${SYNC_MAX} minutes (7 jours)`,
              },
            ]}
          >
            <InputNumber min={SYNC_MIN} max={SYNC_MAX} precision={0} style={{ width: '100%' }} />
          </Form.Item>
        )}
        <Form.Item
          name="targetDossierId"
          label="Dossier de destination (identifiant)"
          extra="Facultatif. Laissez vide pour utiliser le rangement par défaut."
        >
          <InputNumber min={1} precision={0} style={{ width: '100%' }} />
        </Form.Item>

        <Divider orientation="left" plain>
          Droits d&apos;origine
        </Divider>
        <Alert type="info" showIcon message={RIGHTS_HELP} style={{ marginBottom: spacing.lg }} />
        <Typography.Text strong id="principal-map-label">
          Correspondance « principal de la source → groupe DocuPro »
        </Typography.Text>
        <Form.List name="principalMap">
          {(fields, { add, remove }) => (
            <div
              role="group"
              aria-labelledby="principal-map-label"
              style={{ marginTop: spacing.sm }}
            >
              {fields.map((field) => (
                <div
                  key={field.key}
                  style={{
                    display: 'flex',
                    gap: spacing.sm,
                    alignItems: 'flex-start',
                    flexWrap: 'wrap',
                  }}
                >
                  <Form.Item
                    name={[field.name, 'principal']}
                    rules={[{ required: true, whitespace: true, message: 'Principal requis' }]}
                    style={{ flex: '2 1 200px', marginBottom: spacing.sm }}
                  >
                    <Input
                      aria-label="Principal de la source"
                      placeholder="Principal de la source (ex. compta@exemple.fr)"
                      maxLength={300}
                    />
                  </Form.Item>
                  <Form.Item
                    name={[field.name, 'userGroupId']}
                    rules={[{ required: true, message: 'Groupe requis' }]}
                    style={{ flex: '1 1 140px', marginBottom: spacing.sm }}
                  >
                    <InputNumber
                      aria-label="Identifiant du groupe DocuPro"
                      placeholder="Identifiant du groupe"
                      min={1}
                      precision={0}
                      style={{ width: '100%' }}
                    />
                  </Form.Item>
                  <Button
                    type="text"
                    danger
                    aria-label="Supprimer cette correspondance"
                    icon={<Remove size={iconDefaults.size} />}
                    onClick={() => remove(field.name)}
                  />
                </div>
              ))}
              <Button
                type="dashed"
                icon={<Add size={iconDefaults.size} />}
                onClick={() => add({ principal: '', userGroupId: null })}
              >
                Ajouter une correspondance
              </Button>
            </div>
          )}
        </Form.List>
        <Form.Item
          name="fallbackGroups"
          label="Groupes de repli (identifiants, séparés par des virgules)"
          style={{ marginTop: spacing.lg }}
          extra="Vide : votre propre groupe sera utilisé."
          rules={[
            {
              validator: async (_, value: string | undefined) => {
                if (hasInvalidIds(value)) {
                  throw new Error('Saisissez uniquement des identifiants numériques positifs');
                }
              },
            },
          ]}
        >
          <Input placeholder="ex. 3, 7" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
