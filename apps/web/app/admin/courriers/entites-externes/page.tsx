'use client';

import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { App, Button, Input, Popconfirm, Select, Space, Table, Tooltip } from 'antd';
import type { TableColumnsType } from 'antd';
import { NewItemField, NewItemForm, RefLayout } from '../../../components/RefLayout';
import { EditableSelect, EditableText } from '../../../components/editable';
import { EmptyState } from '../../../components/EmptyState';
import { TableSkeleton } from '../../../components/skeletons';
import { NewExternalEntityTypeModal } from '../../../components/mail/NewExternalEntityTypeModal';
import { icons } from '../../../theme/icons';
import { fontSize, space } from '../../../theme/tokens';
import {
  externalEntitiesApi,
  externalEntityTypesApi,
  type ExternalEntityRow,
  type ExternalEntityTypeRow,
} from '../../../lib/courriers';

/** Validation d'adresse alignée sur `z.string().email()` côté API — refus avant l'aller-retour. */
const isValidEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());

export default function ExternalEntitiesPage() {
  const { message } = App.useApp();
  const typeFieldId = useId();
  const [rows, setRows] = useState<ExternalEntityRow[]>([]);
  const [types, setTypes] = useState<ExternalEntityTypeRow[]>([]);
  const [search, setSearch] = useState('');
  const [label, setLabel] = useState('');
  const [email, setEmail] = useState('');
  const [tel, setTel] = useState('');
  const [typeId, setTypeId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [firstLoad, setFirstLoad] = useState(true);
  const [highlightId, setHighlightId] = useState<number | null>(null);
  const [newTypeOpen, setNewTypeOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [e, t] = await Promise.all([externalEntitiesApi.list(), externalEntityTypesApi.list()]);
      setRows(e);
      setTypes(t);
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Erreur de chargement');
    } finally {
      setLoading(false);
      setFirstLoad(false);
    }
  }, [message]);

  useEffect(() => {
    void load();
  }, [load]);

  const typeOptions = useMemo(
    () => types.map((t) => ({ value: t.externalEntityTypeId, label: t.label })),
    [types],
  );

  /**
   * Filtre CLIENT sur le nom : l'annuaire est chargé en entier par la liste, aucune requête
   * n'est refaite — le champ ne fait que réduire l'affichage (pagination de 20 sinon aveugle).
   */
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? rows.filter((r) => r.label.toLowerCase().includes(q)) : rows;
  }, [rows, search]);

  /**
   * Type fraîchement créé depuis le « + » : on l'insère dans la liste et on le sélectionne. Insérer
   * la ligne renvoyée plutôt que recharger évite que le select reste vide le temps de l'aller-retour.
   */
  const onTypeCreated = (created: ExternalEntityTypeRow) => {
    setTypes((prev) => [...prev, created]);
    setTypeId(created.externalEntityTypeId);
  };

  const emailInvalid = email.trim().length > 0 && !isValidEmail(email);

  const create = async (close: () => void) => {
    setBusy(true);
    try {
      const created = await externalEntitiesApi.create({
        label: label.trim(),
        email: email.trim() || undefined,
        telephone: tel.trim() || undefined,
        externalEntityTypeId: typeId ?? undefined,
      });
      setLabel('');
      setEmail('');
      setTel('');
      setTypeId(null);
      await load();
      // Repère visuel après création (motif /admin/users) : la ligne neuve se perd sinon dans
      // un annuaire trié par le serveur.
      const createdId = created?.externalEntityId;
      if (typeof createdId === 'number') {
        setHighlightId(createdId);
        setTimeout(() => setHighlightId(null), 1400);
      }
      message.success('Entité externe créée');
      close();
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Création impossible');
    } finally {
      setBusy(false);
    }
  };

  const patch = async (id: number, body: Record<string, unknown>) => {
    try {
      await externalEntitiesApi.update(id, body);
      await load();
      message.success('Modifié');
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Modification impossible');
      await load();
    }
  };

  const remove = async (id: number) => {
    try {
      await externalEntitiesApi.remove(id);
      await load();
      message.success('Entité externe désactivée');
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Désactivation impossible');
    }
  };

  const columns: TableColumnsType<ExternalEntityRow> = [
    {
      title: 'Nom',
      dataIndex: 'label',
      key: 'label',
      render: (_, r) => (
        <EditableText
          value={r.label}
          required
          onSave={(v) => patch(r.externalEntityId, { label: v })}
        />
      ),
    },
    {
      title: 'Type',
      key: 'type',
      width: 200,
      render: (_, r) => (
        <EditableSelect
          currentId={r.externalEntityTypeId}
          currentLabel={r.externalEntityType?.label ?? ''}
          options={typeOptions}
          onSave={(v) => patch(r.externalEntityId, { externalEntityTypeId: v })}
        />
      ),
    },
    {
      title: 'E-mail',
      dataIndex: 'email',
      key: 'email',
      width: 220,
      render: (_, r) => (
        <EditableText
          value={r.email}
          onSave={(v) => patch(r.externalEntityId, { email: v || null })}
        />
      ),
    },
    {
      title: 'Téléphone',
      dataIndex: 'telephone',
      key: 'telephone',
      width: 170,
      render: (_, r) => (
        <EditableText
          value={r.telephone}
          onSave={(v) => patch(r.externalEntityId, { telephone: v || null })}
        />
      ),
    },
    {
      title: '',
      key: 'actions',
      width: 56,
      align: 'center',
      // Densité production : la cellule rend son padding vertical au bouton, qui porte seul
      // la cible tactile de 40 px.
      onCell: () => ({ style: { paddingBlock: 0, verticalAlign: 'middle' } }),
      render: (_, r) => (
        <Popconfirm
          title="Désactiver ce correspondant ?"
          description="Il ne sera plus proposé comme expéditeur ni comme destinataire ; les courriers existants le conservent."
          okText="Désactiver"
          cancelText="Annuler"
          okButtonProps={{ danger: true }}
          onConfirm={() => void remove(r.externalEntityId)}
        >
          <Button
            type="text"
            danger
            size="small"
            aria-label={`Désactiver ${r.label}`}
            style={{ height: 40, minWidth: 40 }}
            icon={<icons.delete size={16} />}
          />
        </Popconfirm>
      ),
    },
  ];

  return (
    <>
      <NewExternalEntityTypeModal
        open={newTypeOpen}
        onClose={() => setNewTypeOpen(false)}
        onCreated={onTypeCreated}
      />
      <RefLayout
        icon="users"
        title="Entités externes"
        tableTitle="Entités externes"
        formTitle="Nouvelle entité externe"
        tableSpan={16}
        table={
          firstLoad && loading ? (
            <TableSkeleton rows={8} columns={5} />
          ) : (
            <Space direction="vertical" size="middle" style={{ width: '100%' }}>
              {/* Barre d'outils hors du gabarit « large » (RefLayout ne l'applique qu'au
                  formulaire) : elle garde la hauteur standard de 36 px. */}
              <Input
                allowClear
                style={{ maxWidth: 420 }}
                prefix={<icons.search size={15} />}
                placeholder="Filtrer par nom…"
                aria-label="Filtrer les correspondants par nom"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <Table<ExternalEntityRow>
                rowKey="externalEntityId"
                dataSource={filtered}
                columns={columns}
                loading={loading}
                // Annuaire volumineux : densité de PRODUCTION (plan §5.2).
                size="small"
                scroll={{ x: 'max-content' }}
                rowClassName={(r) => (r.externalEntityId === highlightId ? 'da-row-flash' : '')}
                locale={
                  // Le vide « référentiel jamais alimenté » de RefLayout serait trompeur quand
                  // c'est le filtre qui ne ramène rien.
                  search.trim() && filtered.length === 0
                    ? {
                        emptyText: (
                          <EmptyState
                            compact
                            icon="users"
                            title="Aucun correspondant ne porte ce nom"
                          />
                        ),
                      }
                    : undefined
                }
                pagination={{
                  pageSize: 20,
                  showSizeChanger: true,
                  pageSizeOptions: ['20', '50', '100'],
                  showTotal: (t) => `${t} correspondant(s)`,
                }}
              />
            </Space>
          )
        }
        renderForm={(close) => (
          <NewItemForm>
            <NewItemField label="Nom" required>
              <Input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Ex. Ministère des Finances"
              />
            </NewItemField>
            {/* Champ étiqueté « à la main » : `NewItemField` pose son `htmlFor` sur l'enfant
                direct, ici le conteneur Space.Compact — un <div> n'est pas étiquetable, le
                libellé doit viser le Select lui-même. */}
            <div>
              <label
                htmlFor={typeFieldId}
                style={{
                  display: 'block',
                  marginBottom: space.sm,
                  fontSize: fontSize.base,
                  color: 'var(--ant-color-text)',
                }}
              >
                Type
              </label>
              <Space.Compact style={{ width: '100%' }}>
                <Select
                  id={typeFieldId}
                  style={{ width: '100%' }}
                  allowClear
                  showSearch
                  optionFilterProp="label"
                  placeholder="—"
                  value={typeId ?? undefined}
                  onChange={(v) => setTypeId((v as number) ?? null)}
                  options={typeOptions}
                />
                <Tooltip title="Créer un type d'entité externe">
                  {/* Aucune taille epinglee : dans un Space.Compact, un bouton d'une hauteur
                      differente de celle du champ auquel il est colle casse le groupe. */}
                  <Button
                    icon={<icons.add size={16} />}
                    aria-label="Créer un type d'entité externe"
                    onClick={() => setNewTypeOpen(true)}
                  />
                </Tooltip>
              </Space.Compact>
            </div>
            <NewItemField label="E-mail">
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="contact@exemple.org"
                status={emailInvalid ? 'error' : undefined}
              />
            </NewItemField>
            <NewItemField label="Téléphone">
              <Input value={tel} onChange={(e) => setTel(e.target.value)} placeholder="+221 …" />
            </NewItemField>
            <Button
              type="primary"
              block
              loading={busy}
              disabled={!label.trim() || emailInvalid}
              onClick={() => void create(close)}
            >
              Ajouter
            </Button>
          </NewItemForm>
        )}
      />
    </>
  );
}
