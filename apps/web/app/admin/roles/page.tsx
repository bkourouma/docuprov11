'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  App,
  Button,
  Card,
  Checkbox,
  Col,
  Collapse,
  Input,
  Row,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { TableColumnsType } from 'antd';
import { apiJson } from '../../lib/api';
import { PageHeader } from '../../components/PageHeader';
import { StatTile } from '../../components/StatTile';
import { useFeedback } from '../../components/feedback';
import { icons } from '../../theme/icons';
import { colors, fontSize, space } from '../../theme/tokens';

/**
 * Ligne du rôle en cours d'édition : le formulaire est à droite, la table à gauche, et rien
 * ne reliait les deux. Teinte du primaire à 10 % posée sur les cellules — la ligne ne porte
 * aucun texte inversé, le contraste du libellé est donc intact dans les deux thèmes.
 */
const EDITING_ROW_CLASS =
  '[&>td]:!bg-[color-mix(in_srgb,var(--ant-color-primary)_10%,transparent)]';

/** Libellé de champ du formulaire de rôle : un vrai `<label>` associé au champ. */
function FieldLabel({
  htmlFor,
  required = false,
  children,
}: {
  htmlFor: string;
  required?: boolean;
  children: string;
}) {
  return (
    <label
      htmlFor={htmlFor}
      style={{
        display: 'block',
        marginBottom: space.sm,
        fontSize: fontSize.base,
        color: 'var(--ant-color-text)',
      }}
    >
      {children}
      {required && (
        <span aria-hidden style={{ marginLeft: 4, color: 'var(--ant-color-error)' }}>
          *
        </span>
      )}
    </label>
  );
}

/** Deux jeux de menus identiques à l'ordre près : la comparaison porte sur l'ensemble. */
const sameKeys = (a: string[], b: string[]) => {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((k) => set.has(k));
};

interface RoleDto {
  roleId: number;
  name: string;
  description: string | null;
  isActive: boolean;
  isSystem: boolean;
  menuKeys: string[];
  userCount: number;
}

interface MenuPermission {
  key: string;
  label: string;
  section: string;
}

export default function RolesAdminPage() {
  const { message } = App.useApp();
  const { confirm } = useFeedback();

  const [roles, setRoles] = useState<RoleDto[]>([]);
  const [menus, setMenus] = useState<MenuPermission[]>([]);

  // Formulaire (création ou édition selon editingId).
  const [editingId, setEditingId] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [openSections, setOpenSections] = useState<string[]>([]); // accordéons « Menus accessibles »
  const [busy, setBusy] = useState(false);
  const [highlightId, setHighlightId] = useState<number | null>(null);
  // État du formulaire au moment où il a été ouvert : sert de référence pour détecter les
  // coches modifiées et prévenir avant de changer de rôle.
  const [baseline, setBaseline] = useState<{
    name: string;
    description: string;
    selected: string[];
  }>({
    name: '',
    description: '',
    selected: [],
  });

  const load = useCallback(async () => {
    try {
      const [r, m] = await Promise.all([
        apiJson<RoleDto[]>('/roles'),
        apiJson<MenuPermission[]>('/roles/menus'),
      ]);
      setRoles(r);
      setMenus(m);
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Erreur de chargement');
    }
  }, [message]);

  useEffect(() => {
    void load();
  }, [load]);

  // Menus regroupés par section, dans l'ordre du catalogue.
  const sections = useMemo(() => {
    const map = new Map<string, MenuPermission[]>();
    for (const m of menus) {
      const arr = map.get(m.section) ?? [];
      arr.push(m);
      map.set(m.section, arr);
    }
    return [...map.entries()];
  }, [menus]);

  // Tout déplié par défaut une fois le catalogue chargé.
  useEffect(() => {
    setOpenSections(sections.map(([section]) => section));
  }, [sections]);

  const resetForm = () => {
    setEditingId(null);
    setName('');
    setDescription('');
    setSelected([]);
    setBaseline({ name: '', description: '', selected: [] });
  };

  const editRole = (role: RoleDto) => {
    setEditingId(role.roleId);
    setName(role.name);
    setDescription(role.description ?? '');
    setSelected(role.menuKeys);
    setBaseline({ name: role.name, description: role.description ?? '', selected: role.menuKeys });
  };

  const isDirty =
    name !== baseline.name ||
    description !== baseline.description ||
    !sameKeys(selected, baseline.selected);

  /**
   * Garde de perte de saisie : ouvrir un autre rôle remplace le contenu du formulaire, ce qui
   * effaçait des coches en silence — le seul repère d'édition étant le titre de la carte.
   */
  const askRole = (role: RoleDto) => {
    if (!isDirty) {
      editRole(role);
      return;
    }
    confirm({
      title: 'Abandonner les modifications non enregistrées ?',
      content: editingId
        ? 'Les menus cochés pour le rôle en cours d’édition ne seront pas enregistrés.'
        : 'Le rôle en cours de création ne sera pas enregistré.',
      okText: 'Abandonner',
      danger: true,
      onOk: () => editRole(role),
    });
  };

  /** Même garde pour « Annuler » / « Fermer », qui vide le formulaire. */
  const askReset = () => {
    if (!isDirty) {
      resetForm();
      return;
    }
    confirm({
      title: 'Abandonner les modifications non enregistrées ?',
      content: 'Les menus cochés ne seront pas enregistrés.',
      okText: 'Abandonner',
      danger: true,
      onOk: resetForm,
    });
  };

  /** Coche/décoche un bloc de menus (une section) sans toucher aux autres sections. */
  const onSectionChange = (sectionKeys: string[], vals: string[]) => {
    setSelected((prev) => [...prev.filter((k) => !sectionKeys.includes(k)), ...vals]);
  };

  const canSubmit = name.trim().length > 0;
  const editingRole =
    editingId != null ? (roles.find((r) => r.roleId === editingId) ?? null) : null;
  const lockMenus = !!editingRole?.isSystem; // rôle système : permissions verrouillées

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    try {
      const body = {
        name: name.trim(),
        description: description.trim() || undefined,
        menuKeys: selected,
      };
      const saved = editingId
        ? await apiJson<RoleDto>(`/roles/${editingId}`, {
            method: 'PATCH',
            body: JSON.stringify(body),
          })
        : await apiJson<RoleDto>('/roles', { method: 'POST', body: JSON.stringify(body) });
      message.success(editingId ? 'Rôle mis à jour' : 'Rôle créé');
      resetForm();
      await load();
      if (saved?.roleId) {
        setHighlightId(saved.roleId);
        setTimeout(() => setHighlightId(null), 1400);
      }
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Enregistrement impossible');
    } finally {
      setBusy(false);
    }
  };

  const removeRole = (role: RoleDto) =>
    confirm({
      title: `Supprimer le rôle « ${role.name} » ?`,
      content:
        role.userCount > 0
          ? `${role.userCount} utilisateur(s) perdront ce rôle (ils ne verront plus que l'accueil).`
          : 'Cette action est définitive.',
      okText: 'Supprimer',
      danger: true,
      onOk: async () => {
        try {
          await apiJson(`/roles/${role.roleId}`, { method: 'DELETE' });
          message.success('Rôle supprimé');
          if (editingId === role.roleId) resetForm();
          await load();
        } catch (e) {
          message.error(e instanceof Error ? e.message : 'Suppression impossible');
        }
      },
    });

  const columns: TableColumnsType<RoleDto> = [
    {
      title: 'Rôle',
      dataIndex: 'name',
      key: 'name',
      render: (v: string, r) => (
        <Space size={8}>
          <strong>{v}</strong>
          {/* Badge plein neutre (blanc à 4,74:1) : « Système » qualifie le rôle, ce n'est ni
              une alerte ni un état d'avancement. */}
          {r.isSystem && (
            <Tag color={colors.secondaryStrong} style={{ fontWeight: 600 }}>
              Système
            </Tag>
          )}
        </Space>
      ),
    },
    {
      title: '',
      key: 'actions',
      align: 'right',
      render: (_, r) =>
        r.isSystem ? (
          // Rôle système : non modifiable → consultation seule.
          <Button size="small" icon={<icons.view size={16} />} onClick={() => askRole(r)}>
            Voir
          </Button>
        ) : (
          <Space size={8}>
            <Button size="small" icon={<icons.edit size={16} />} onClick={() => askRole(r)}>
              Permissions
            </Button>
            <Button
              type="text"
              size="small"
              danger
              icon={<icons.delete size={16} />}
              onClick={() => removeRole(r)}
              aria-label="Supprimer"
            />
          </Space>
        ),
    },
  ];

  return (
    <div>
      <PageHeader icon="roles" title="Rôles" />

      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={12} md={8}>
          <StatTile tone="ink" label="Rôles" value={roles.length} icon="roles" />
        </Col>
        <Col xs={12} md={8}>
          <StatTile
            tone="sky"
            label="Personnalisés"
            value={roles.filter((r) => !r.isSystem).length}
            icon="edit"
          />
        </Col>
        <Col xs={24} md={8}>
          <StatTile
            tone="violet"
            label="Système"
            value={roles.filter((r) => r.isSystem).length}
            icon="lock"
          />
        </Col>
      </Row>

      <Row gutter={[16, 16]} align="top">
        <Col xs={24} lg={14}>
          <Card title="Rôles">
            <Table<RoleDto>
              rowKey="roleId"
              dataSource={roles}
              columns={columns}
              size="middle"
              scroll={{ x: 'max-content' }}
              rowClassName={(r) =>
                r.roleId === highlightId
                  ? 'da-row-flash'
                  : r.roleId === editingId
                    ? EDITING_ROW_CLASS
                    : ''
              }
              pagination={{ pageSize: 10, showSizeChanger: true, showTotal: (t) => `${t} rôle(s)` }}
            />
          </Card>
        </Col>

        <Col xs={24} lg={10}>
          <Card
            title={
              editingId
                ? lockMenus
                  ? 'Permissions du rôle (lecture seule)'
                  : 'Modifier le rôle'
                : 'Nouveau rôle'
            }
            extra={
              editingId ? (
                <Button type="text" size="small" onClick={askReset}>
                  {lockMenus ? 'Fermer' : 'Annuler'}
                </Button>
              ) : null
            }
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div>
                <FieldLabel htmlFor="role-name" required>
                  Nom du rôle
                </FieldLabel>
                <Input
                  id="role-name"
                  aria-required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="ex. Agent de saisie"
                  disabled={lockMenus}
                />
              </div>

              <div>
                <Typography.Text type="secondary">Menus accessibles</Typography.Text>
                <Collapse
                  size="small"
                  style={{ marginTop: 8 }}
                  activeKey={openSections}
                  onChange={(keys) => setOpenSections(keys as string[])}
                  items={sections.map(([section, items]) => {
                    const sectionKeys = items.map((i) => i.key);
                    const value = selected.filter((k) => sectionKeys.includes(k));
                    return {
                      key: section,
                      // Motif d'intitulé de section de l'interface : 11 px / 600, capitales.
                      label: (
                        <Typography.Text
                          strong
                          style={{
                            fontSize: 11,
                            fontWeight: 600,
                            textTransform: 'uppercase',
                            letterSpacing: 0.4,
                          }}
                        >
                          {section}
                        </Typography.Text>
                      ),
                      extra: (
                        <Typography.Text type="secondary" style={{ fontSize: fontSize.xs }}>
                          {value.length}/{items.length}
                        </Typography.Text>
                      ),
                      children: (
                        <Checkbox.Group
                          style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
                          options={items.map((i) => ({ label: i.label, value: i.key }))}
                          value={value}
                          disabled={lockMenus}
                          onChange={(vals) => onSectionChange(sectionKeys, vals as string[])}
                        />
                      ),
                    };
                  })}
                />
                {lockMenus && (
                  <Typography.Text
                    type="warning"
                    style={{ fontSize: fontSize.xs, display: 'block', marginTop: 8 }}
                  >
                    Rôle système : accès complet, non modifiable et non supprimable.
                  </Typography.Text>
                )}
                <Typography.Text
                  type="secondary"
                  style={{ fontSize: fontSize.xs, display: 'block', marginTop: 10 }}
                >
                  Le tableau de bord (accueil) reste toujours visible. Les administrateurs voient
                  tous les menus.
                </Typography.Text>
              </div>

              {!lockMenus && (
                <Button
                  type="primary"
                  block
                  icon={<icons.check size={16} />}
                  loading={busy}
                  disabled={!canSubmit}
                  onClick={() => void submit()}
                >
                  {editingId ? 'Enregistrer' : 'Créer le rôle'}
                </Button>
              )}
            </div>
          </Card>
        </Col>
      </Row>
    </div>
  );
}
