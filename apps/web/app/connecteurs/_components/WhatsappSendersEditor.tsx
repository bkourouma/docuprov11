'use client';

import { Button, Form, Input, InputNumber, Select } from 'antd';
import { icons, iconDefaults } from '../../theme/icons';
import { space as spacing } from '../../theme/tokens';
import type { GroupOptions } from './useDocuproGroups';
import { normalizeWhatsappPhone, type WhatsappFormValues } from './whatsapp-config';

const LIST = ['whatsapp', 'senders'] as const;

/**
 * Éditeur des expéditeurs autorisés : numéro international, libellé, groupe DocuPro.
 * Le numéro est normalisé comme côté serveur (voir `normalizeWhatsappPhone`) et reformaté à la sortie
 * du champ ; les doublons sont refusés. « Aucun groupe » = groupes de repli.
 */
export function WhatsappSendersEditor({ groups }: { groups: GroupOptions }) {
  const form = Form.useFormInstance();
  const Add = icons.add;
  const Remove = icons.delete;

  return (
    <>
      <Form.List name={[...LIST]}>
        {(fields, { add, remove }) => (
          <div role="group" aria-labelledby="wa-senders-label">
            {fields.length === 0 && (
              <p style={{ marginTop: 0 }}>
                Aucun expéditeur autorisé : tous les messages reçus seront refusés.
              </p>
            )}
            {fields.map((field, index) => (
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
                  name={[field.name, 'phone']}
                  validateTrigger={['onBlur', 'onChange']}
                  rules={[
                    {
                      validator: async (_, value: string | undefined) => {
                        const check = normalizeWhatsappPhone(value);
                        if (!check.ok) throw new Error(check.error);
                        const rows = (form.getFieldValue([...LIST]) ??
                          []) as WhatsappFormValues['senders'];
                        const same = (rows ?? []).filter((r, i) => {
                          if (i === index) return false;
                          const other = normalizeWhatsappPhone(r?.phone);
                          return other.ok && other.phone === check.phone;
                        });
                        if (same.length > 0)
                          throw new Error('Ce numéro figure déjà dans la liste.');
                      },
                    },
                  ]}
                  style={{ flex: '2 1 200px', marginBottom: spacing.sm }}
                >
                  <Input
                    aria-label={`Numéro de l’expéditeur ${index + 1}`}
                    placeholder="Numéro international (ex. 221 77 123 45 67)"
                    autoComplete="off"
                    inputMode="tel"
                    maxLength={30}
                    onBlur={(e) => {
                      const check = normalizeWhatsappPhone(e.target.value);
                      if (check.ok) {
                        form.setFieldValue([...LIST, field.name, 'phone'], check.phone);
                      }
                    }}
                  />
                </Form.Item>
                <Form.Item
                  name={[field.name, 'label']}
                  style={{ flex: '2 1 160px', marginBottom: spacing.sm }}
                >
                  <Input
                    aria-label={`Libellé de l’expéditeur ${index + 1}`}
                    placeholder="Libellé (ex. Service comptabilité)"
                    maxLength={100}
                  />
                </Form.Item>
                <Form.Item
                  name={[field.name, 'userGroupId']}
                  style={{ flex: '2 1 180px', marginBottom: spacing.sm }}
                >
                  {groups.loaded ? (
                    <Select
                      allowClear
                      showSearch
                      optionFilterProp="label"
                      aria-label={`Groupe DocuPro de l’expéditeur ${index + 1}`}
                      placeholder="Groupes de repli"
                      options={groups.options}
                    />
                  ) : (
                    <InputNumber
                      aria-label={`Identifiant du groupe DocuPro de l’expéditeur ${index + 1}`}
                      placeholder="Identifiant du groupe (vide : repli)"
                      min={1}
                      precision={0}
                      style={{ width: '100%' }}
                    />
                  )}
                </Form.Item>
                <Button
                  type="text"
                  danger
                  aria-label={`Supprimer l’expéditeur ${index + 1}`}
                  icon={<Remove size={iconDefaults.size} />}
                  onClick={() => remove(field.name)}
                />
              </div>
            ))}
            <Button
              type="dashed"
              icon={<Add size={iconDefaults.size} />}
              onClick={() => add({ phone: '', label: '', userGroupId: null })}
            >
              Ajouter un expéditeur
            </Button>
          </div>
        )}
      </Form.List>
      {!groups.loaded && (
        <p style={{ marginBottom: 0, marginTop: spacing.sm }}>
          La liste des groupes n’a pas pu être chargée : saisissez l’identifiant numérique du
          groupe.
        </p>
      )}
    </>
  );
}
