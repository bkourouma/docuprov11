'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  App,
  Button,
  Card,
  Col,
  Input,
  Modal,
  Row,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { TableColumnsType } from 'antd';
import { apiJson } from '../../lib/api';
import { normalizeText } from '../../lib/filters';
import { EmptyState } from '../../components/EmptyState';
import { PageHeader } from '../../components/PageHeader';
import { StatTile } from '../../components/StatTile';
import { useFeedback } from '../../components/feedback';
import { icons } from '../../theme/icons';
import { colors, fontSize, radii, space } from '../../theme/tokens';

/** Compte super-admin protégé : ni modifiable ni supprimable. */
const PROTECTED_ADMIN = 'admin';

interface User {
  userId: number;
  username: string;
  firstName: string;
  lastName: string;
  fullName: string | null;
  /** Adresse de notification. Nullable : comptes créés avant que le champ soit obligatoire. */
  email: string | null;
  isAdmin: boolean;
  isDisabled: boolean;
  roleId: number | null;
  role: { roleId: number; name: string } | null;
  /** Habilitation de confidentialité : rang minimal que l'utilisateur peut consulter. */
  confidentialiteId: number | null;
  confidentialite: { confidentialiteId: number; label: string; rank: number } | null;
}

interface ConfidentialiteOption {
  confidentialiteId: number;
  label: string;
  rank: number;
}

/** Validation d'adresse alignée sur `z.string().email()` côté API — refus avant l'aller-retour. */
const isValidEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());

interface RoleOption {
  roleId: number;
  name: string;
  isSystem: boolean;
}

/** Longueur minimale du mot de passe. */
const PASSWORD_MIN = 6;

/** Libellé de champ du formulaire de compte : un vrai `<label>` associé au champ. */
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

export default function UsersAdminPage() {
  const { message } = App.useApp();
  const { confirm } = useFeedback();
  const [rows, setRows] = useState<User[]>([]);
  const [roles, setRoles] = useState<RoleOption[]>([]);
  const [confidentialites, setConfidentialites] = useState<ConfidentialiteOption[]>([]);
  const [query, setQuery] = useState('');
  const [highlightId, setHighlightId] = useState<number | null>(null);

  /**
   * Création et modification partagent UN SEUL contenant : la carte dépliée doublait la modale,
   * avec deux jeux de champs à maintenir en parallèle. `editing = null` ⟹ création.
   */
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<User | null>(null);
  const [username, setUsername] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [roleId, setRoleId] = useState<number | null>(null);
  const [confidentialiteId, setConfidentialiteId] = useState<number | null>(null);
  const [disabled, setDisabled] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [u, r, c] = await Promise.all([
        apiJson<User[]>('/users'),
        apiJson<RoleOption[]>('/roles'),
        // Référentiel facultatif : son absence ne doit pas priver l'écran des utilisateurs.
        apiJson<ConfidentialiteOption[]>('/referentials/confidentialites').catch(
          () => [] as ConfidentialiteOption[],
        ),
      ]);
      // Compte protégé : jamais modifiable/supprimable (voir PROTECTED_ADMIN), on ne l'affiche pas.
      setRows(u.filter((x) => x.username !== PROTECTED_ADMIN));
      // Le rôle système (Admin système) n'est pas assignable : on l'exclut des sélecteurs.
      setRoles(r.filter((x) => !x.isSystem));
      setConfidentialites(c);
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Erreur de chargement');
    }
  }, [message]);

  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = () => {
    setEditing(null);
    setUsername('');
    setFirstName('');
    setLastName('');
    setEmail('');
    setPassword('');
    setRoleId(null);
    setConfidentialiteId(null);
    setDisabled(false);
    setFormOpen(true);
  };

  const openEdit = (u: User) => {
    setEditing(u);
    setUsername(u.username);
    setFirstName(u.firstName);
    setLastName(u.lastName);
    setEmail(u.email ?? '');
    setPassword('');
    setRoleId(u.roleId);
    setConfidentialiteId(u.confidentialiteId);
    setDisabled(u.isDisabled);
    setFormOpen(true);
  };

  // L'écran de connexion rogne la saisie : un mot de passe bordé d'espaces serait inutilisable
  // (l'API le refuse aussi, `users.dto.ts`).
  const passwordEdgeSpaces = password !== password.trim();
  // En création le mot de passe est obligatoire ; en modification, vide signifie « ne change pas ».
  const canSubmit =
    !!(username.trim() && firstName.trim() && lastName.trim()) &&
    isValidEmail(email) &&
    !passwordEdgeSpaces &&
    (editing
      ? password === '' || password.length >= PASSWORD_MIN
      : password.length >= PASSWORD_MIN);

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    try {
      const saved = editing
        ? await apiJson<User>(`/users/${editing.userId}`, {
            method: 'PATCH',
            body: JSON.stringify({
              username: username.trim(),
              firstName: firstName.trim(),
              lastName: lastName.trim(),
              email: email.trim(),
              roleId,
              confidentialiteId,
              isDisabled: disabled,
              ...(password ? { password } : {}),
            }),
          })
        : await apiJson<User>('/users', {
            method: 'POST',
            body: JSON.stringify({
              username: username.trim(),
              firstName: firstName.trim(),
              lastName: lastName.trim(),
              email: email.trim(),
              password,
              roleId: roleId ?? undefined,
            }),
          });
      message.success(editing ? 'Utilisateur modifié' : 'Utilisateur créé');
      const targetId = editing?.userId ?? saved?.userId;
      setFormOpen(false);
      setEditing(null);
      await load();
      if (targetId) {
        setHighlightId(targetId);
        setTimeout(() => setHighlightId(null), 1400);
      }
    } catch (e) {
      message.error(
        e instanceof Error
          ? e.message
          : editing
            ? 'Modification impossible'
            : 'Création impossible',
      );
    } finally {
      setBusy(false);
    }
  };

  const removeUser = (u: User) =>
    confirm({
      title: `Supprimer l'utilisateur « ${u.username} » ?`,
      content: 'Cette action est définitive.',
      okText: 'Supprimer',
      danger: true,
      onOk: async () => {
        try {
          await apiJson(`/users/${u.userId}`, { method: 'DELETE' });
          message.success('Utilisateur supprimé');
          await load();
        } catch (e) {
          message.error(e instanceof Error ? e.message : 'Suppression impossible');
        }
      },
    });

  /** Filtre d'appoint sur le nom et l'identifiant de connexion (annuaire paginé par 10). */
  const visibleRows = useMemo(() => {
    const q = normalizeText(query.trim());
    if (!q) return rows;
    return rows.filter(
      (r) => normalizeText(r.fullName ?? '').includes(q) || normalizeText(r.username).includes(q),
    );
  }, [rows, query]);

  const columns: TableColumnsType<User> = [
    {
      title: 'Nom d’utilisateur',
      dataIndex: 'username',
      key: 'username',
      // Un compte désactivé se lit désormais sur la ligne : le seul indice était l'interrupteur,
      // au fond de la fiche. Badge plein neutre (blanc à 4,74:1) — ce n'est pas une alerte.
      render: (v: string, r) => (
        <Space size={8}>
          <span className="da-mono">{v}</span>
          {r.isDisabled && (
            <Tag color={colors.secondaryStrong} style={{ fontWeight: 600 }}>
              Désactivé
            </Tag>
          )}
        </Space>
      ),
    },
    { title: 'Nom', dataIndex: 'fullName', key: 'fullName', render: (v) => v || '—' },
    {
      title: 'Adresse e-mail',
      dataIndex: 'email',
      key: 'email',
      // Une adresse manquante n'est pas cosmétique : ce compte ne recevra AUCUNE notification par
      // e-mail, et en silence. On le signale plutôt que d'afficher un tiret anodin.
      render: (v: string | null) =>
        v?.trim() ? (
          v
        ) : (
          <Tag color={colors.warning} style={{ fontWeight: 600 }}>
            Aucune — pas de notification
          </Tag>
        ),
    },
    {
      title: 'Rôle',
      dataIndex: 'role',
      key: 'role',
      render: (r: User['role']) =>
        r?.name ? <Tag>{r.name}</Tag> : <Typography.Text type="secondary">—</Typography.Text>,
    },
    {
      title: '',
      key: 'actions',
      width: 110,
      align: 'right',
      render: (_, r) => (
        <Space size={4}>
          <Button
            type="text"
            size="small"
            icon={<icons.edit size={16} />}
            onClick={() => openEdit(r)}
            aria-label="Modifier"
          />
          <Button
            type="text"
            size="small"
            danger
            icon={<icons.delete size={16} />}
            onClick={() => removeUser(r)}
            aria-label="Supprimer"
          />
        </Space>
      ),
    },
  ];

  return (
    <div>
      <PageHeader icon="users" title="Utilisateurs" />

      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={12} md={8}>
          <StatTile tone="ink" label="Comptes" value={rows.length} icon="users" />
        </Col>
        <Col xs={12} md={8}>
          <StatTile
            tone="sky"
            label="Actifs"
            value={rows.filter((r) => !r.isDisabled).length}
            icon="validated"
          />
        </Col>
        <Col xs={24} md={8}>
          <StatTile
            tone="violet"
            label="Désactivés"
            value={rows.filter((r) => r.isDisabled).length}
            icon="lock"
          />
        </Col>
      </Row>

      <Card
        title="Comptes"
        extra={
          <Space wrap size={8}>
            <Input
              allowClear
              style={{ width: 240 }}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              prefix={<icons.search size={14} />}
              placeholder="Nom ou identifiant"
              aria-label="Rechercher un compte"
            />
            <Button type="primary" icon={<icons.add size={16} />} onClick={openCreate}>
              Ajouter un utilisateur
            </Button>
          </Space>
        }
      >
        <Table<User>
          rowKey="userId"
          dataSource={visibleRows}
          columns={columns}
          size="middle"
          scroll={{ x: 'max-content' }}
          rowClassName={(r) => (r.userId === highlightId ? 'da-row-flash' : '')}
          locale={{
            emptyText: (
              <EmptyState
                icon="users"
                compact
                title={query ? 'Aucun compte trouvé' : 'Aucun compte'}
              />
            ),
          }}
          pagination={{
            pageSize: 10,
            showSizeChanger: true,
            pageSizeOptions: ['10', '20', '50', '100'],
            showTotal: (total) => `${total} utilisateur(s)`,
          }}
        />
      </Card>

      <Modal
        open={formOpen}
        width={560}
        onCancel={() => setFormOpen(false)}
        onOk={() => void submit()}
        okText={editing ? 'Enregistrer' : 'Créer'}
        okButtonProps={{ disabled: !canSubmit }}
        confirmLoading={busy}
        title={editing ? `Modifier « ${editing.username} »` : 'Nouvel utilisateur'}
        destroyOnHidden
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginTop: 8 }}>
          <div>
            <FieldLabel htmlFor="user-username" required>
              Nom d’utilisateur
            </FieldLabel>
            <Input
              id="user-username"
              aria-required
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="ex. agent.archives"
            />
          </div>
          <Row gutter={16}>
            <Col xs={24} md={12}>
              <FieldLabel htmlFor="user-firstname" required>
                Prénom
              </FieldLabel>
              <Input
                id="user-firstname"
                aria-required
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                placeholder="Prénom"
              />
            </Col>
            <Col xs={24} md={12}>
              <FieldLabel htmlFor="user-lastname" required>
                Nom
              </FieldLabel>
              <Input
                id="user-lastname"
                aria-required
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                placeholder="Nom"
              />
            </Col>
          </Row>
          <div>
            <FieldLabel htmlFor="user-email" required>
              Adresse e-mail
            </FieldLabel>
            <Input
              id="user-email"
              aria-required
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="prenom.nom@exemple.ci"
              status={email && !isValidEmail(email) ? 'error' : undefined}
            />
          </div>
          <div>
            <FieldLabel htmlFor="user-password" required={!editing}>
              {editing
                ? 'Mot de passe (laisser vide pour ne pas changer)'
                : 'Mot de passe (6 caractères min.)'}
            </FieldLabel>
            <Input.Password
              id="user-password"
              aria-required={!editing}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onPressEnter={() => void submit()}
              placeholder="••••••••"
              status={passwordEdgeSpaces ? 'error' : undefined}
              aria-describedby={passwordEdgeSpaces ? 'user-password-error' : undefined}
            />
            {passwordEdgeSpaces && (
              <Typography.Text
                id="user-password-error"
                type="danger"
                style={{ fontSize: fontSize.xs }}
              >
                Le mot de passe ne doit ni commencer ni finir par une espace.
              </Typography.Text>
            )}
          </div>
          <div>
            <FieldLabel htmlFor="user-role">Rôle</FieldLabel>
            <Select
              id="user-role"
              style={{ width: '100%' }}
              value={roleId ?? undefined}
              onChange={(v) => setRoleId((v as number) ?? null)}
              options={roles.map((r) => ({ value: r.roleId, label: r.name }))}
              allowClear
              showSearch
              optionFilterProp="label"
              placeholder="Sélectionnez un rôle"
            />
          </div>
          {/* Habilitation et désactivation ne sont acceptées que par `PATCH /users/:id` :
                elles n'apparaissent donc qu'en modification. */}
          {editing && confidentialites.length > 0 && (
            <div>
              <FieldLabel htmlFor="user-confidentialite">
                Habilitation de confidentialité
              </FieldLabel>
              <Select
                id="user-confidentialite"
                style={{ width: '100%' }}
                value={confidentialiteId ?? undefined}
                onChange={(v) => setConfidentialiteId((v as number) ?? null)}
                options={confidentialites.map((c) => ({
                  value: c.confidentialiteId,
                  label: c.label,
                }))}
                allowClear
                placeholder="Aucune habilitation"
              />
              <Typography.Text type="secondary" style={{ fontSize: fontSize.xs }}>
                Niveau maximal de document que cet utilisateur peut consulter. Sans habilitation, il
                n’atteint aucun document porteur d’un niveau.
              </Typography.Text>
            </div>
          )}
          {editing && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                padding: '10px 12px',
                // Rayon de carte.
                borderRadius: radii.card,
                background: disabled ? 'var(--ant-color-fill-quaternary)' : undefined,
              }}
            >
              <div>
                <Typography.Text strong={disabled}>Compte désactivé</Typography.Text>
                <div>
                  <Typography.Text type="secondary" style={{ fontSize: fontSize.xs }}>
                    Empêche la connexion et retire l’utilisateur des destinataires par rôle et des
                    notifications, sans supprimer le compte.
                  </Typography.Text>
                </div>
              </div>
              <Switch checked={disabled} onChange={setDisabled} aria-label="Compte désactivé" />
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
}
