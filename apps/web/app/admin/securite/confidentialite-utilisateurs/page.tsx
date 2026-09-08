'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Input,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { TableColumnsType } from 'antd';
import { apiJson } from '../../../lib/api';
import { filterByLabel, normalizeText } from '../../../lib/filters';
import { EmptyState } from '../../../components/EmptyState';
import { PageHeader } from '../../../components/PageHeader';
import { icons } from '../../../theme/icons';
import { colors, fontSize, space } from '../../../theme/tokens';

const { Text } = Typography;

interface UserRow {
  userId: number;
  username: string;
  fullName: string | null;
  confidentialiteId: number | null;
  confidentialite: { confidentialiteId: number; label: string; rank: number } | null;
}

/** Compte super-admin protégé (seed) : `PATCH /users/:id` le rejette toujours, donc il n'a pas sa place ici. */
const PROTECTED_ADMIN = 'admin';

interface ConfidentialiteOption {
  confidentialiteId: number;
  label: string;
  rank: number;
}

/** Libellé de champ de la barre d'octroi : le placeholder seul disparaît dès la saisie. */
function FieldLabel({ htmlFor, children }: { htmlFor: string; children: string }) {
  return (
    <label
      htmlFor={htmlFor}
      style={{
        display: 'block',
        marginBottom: space.xs,
        fontSize: fontSize.sm,
        color: 'var(--ant-color-text-secondary)',
      }}
    >
      {children}
    </label>
  );
}

/**
 * Sécurité Documentaire — « Confidentialité des utilisateurs » : affecte un niveau de
 * confidentialité à plusieurs utilisateurs en une seule opération (legacy `UpdateConfidentiality`).
 * `/admin/users` sait déjà éditer ce champ, mais un utilisateur à la fois — cet écran couvre le
 * geste en masse que le legacy propose.
 *
 * Écrit via `PATCH /users/confidentialite` (endpoint dédié) et NON via `PATCH /users/:id` : ce
 * dernier reste réservé au menu « Utilisateurs » car il touche aussi `isAdmin`, `roleId` et le mot
 * de passe. L'endpoint dédié n'expose que le champ de cet écran, et accepte donc ce menu-ci.
 */
export default function ConfidentialiteUtilisateursPage() {
  const { message } = App.useApp();
  const [users, setUsers] = useState<UserRow[]>([]);
  const [niveaux, setNiveaux] = useState<ConfidentialiteOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [choix, setChoix] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [u, n] = await Promise.all([
        apiJson<UserRow[]>('/users'),
        apiJson<ConfidentialiteOption[]>('/referentials/confidentialites'),
      ]);
      setUsers(u.filter((row) => row.username !== PROTECTED_ADMIN));
      setNiveaux(n);
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Chargement impossible');
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void load();
  }, [load]);

  const apply = async () => {
    if (selectedIds.length === 0) {
      message.warning('Sélectionnez au moins un utilisateur.');
      return;
    }
    setBusy(true);
    try {
      const { updated } = await apiJson<{ updated: number }>('/users/confidentialite', {
        method: 'PATCH',
        body: JSON.stringify({ userIds: selectedIds, confidentialiteId: choix }),
      });
      message.success(`Niveau appliqué à ${updated} utilisateur(s).`);
      setSelectedIds([]);
      await load();
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Échec de la mise à jour');
    } finally {
      setBusy(false);
    }
  };

  /**
   * Recherche d'appoint : elle ne restreint QUE l'affichage. « Sélectionner tout le monde »
   * continue de porter sur l'annuaire entier, sans quoi le libellé du bouton mentirait.
   */
  const visibleUsers = useMemo(() => {
    const q = normalizeText(query.trim());
    if (!q) return users;
    return users.filter(
      (u) => normalizeText(u.fullName ?? '').includes(q) || normalizeText(u.username).includes(q),
    );
  }, [users, query]);

  const choixLabel = niveaux.find((n) => n.confidentialiteId === choix)?.label ?? null;

  const columns: TableColumnsType<UserRow> = [
    { title: 'Utilisateur', key: 'label', render: (_, r) => r.fullName || r.username },
    {
      // Deux homonymes ne se distinguent que par leur identifiant de connexion : il devient
      // une colonne à part entière, en chasse fixe comme partout où l'on compare des codes.
      title: 'Identifiant',
      dataIndex: 'username',
      key: 'username',
      width: 220,
      render: (v: string) => <span className="da-mono">{v}</span>,
    },
    {
      title: 'Confidentialité actuelle',
      key: 'confidentialite',
      width: 240,
      // Badge plein : le niveau est une donnée de classement, pas une alerte (même motif que
      // « Sécurité type document par… »). Le blanc posé par AntD passe à 9,25:1 sur le primaire.
      render: (_, r) =>
        r.confidentialite ? (
          <Tag color={colors.primary} style={{ fontWeight: 600 }}>
            {r.confidentialite.label}
          </Tag>
        ) : (
          <Text type="secondary">Aucune</Text>
        ),
    },
  ];

  return (
    <div>
      <PageHeader icon="lock" title="Confidentialité des utilisateurs" />

      <Card>
        <Space wrap align="end" size="middle" style={{ marginBottom: space.lg }}>
          <div>
            <FieldLabel htmlFor="conf-niveau">Niveau à appliquer</FieldLabel>
            <Select
              id="conf-niveau"
              style={{ minWidth: 260 }}
              value={choix ?? undefined}
              onChange={(v) => setChoix((v as number) ?? null)}
              options={niveaux.map((n) => ({ value: n.confidentialiteId, label: n.label }))}
              allowClear
              showSearch
              filterOption={filterByLabel}
              placeholder="Aucun — retirer l’habilitation"
            />
          </div>
          <div>
            <FieldLabel htmlFor="conf-recherche">Rechercher</FieldLabel>
            <Input
              id="conf-recherche"
              allowClear
              style={{ minWidth: 240 }}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              prefix={<icons.search size={14} />}
              placeholder="Nom ou identifiant"
            />
          </div>
          <Button
            icon={<icons.check size={16} />}
            disabled={users.length === 0}
            onClick={() => setSelectedIds(users.map((u) => u.userId))}
          >
            Sélectionner tout le monde ({users.length})
          </Button>
          {/* L'opération écrase une habilitation existante sans retour possible : elle passe
              par une confirmation qui chiffre la portée et énonce la conséquence. */}
          <Popconfirm
            title={`Appliquer à ${selectedIds.length} utilisateur(s) ?`}
            description={
              choixLabel
                ? `Leur habilitation actuelle sera remplacée par « ${choixLabel} ».`
                : 'Leur habilitation sera retirée : ils n’atteindront plus aucun document porteur d’un niveau.'
            }
            okText={choixLabel ? 'Appliquer' : 'Retirer'}
            cancelText="Annuler"
            okButtonProps={{ danger: !choixLabel }}
            disabled={selectedIds.length === 0}
            onConfirm={() => void apply()}
          >
            <Button
              type="primary"
              icon={<icons.check size={16} />}
              loading={busy}
              disabled={selectedIds.length === 0}
            >
              Appliquer ({selectedIds.length})
            </Button>
          </Popconfirm>
        </Space>

        {/* La sémantique destructive du niveau vide était portée par le seul placeholder :
            elle s'affiche dès qu'une sélection est prête à partir sans niveau. */}
        {!choix && selectedIds.length > 0 && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: space.lg }}
            message="Aucun niveau sélectionné"
            description={`Appliquer maintenant RETIRERA l’habilitation de ${selectedIds.length} utilisateur(s), qui perdront l’accès à tout document porteur d’un niveau de confidentialité.`}
          />
        )}

        <Table<UserRow>
          rowKey="userId"
          dataSource={visibleUsers}
          columns={columns}
          loading={loading}
          size="middle"
          scroll={{ x: 'max-content' }}
          locale={{
            emptyText: (
              <EmptyState
                icon="users"
                compact
                title={query ? 'Aucun utilisateur trouvé' : 'Aucun compte à habiliter'}
              />
            ),
          }}
          rowSelection={{
            selectedRowKeys: selectedIds,
            onChange: (keys) => setSelectedIds(keys as number[]),
          }}
          pagination={{
            pageSize: 20,
            showSizeChanger: true,
            showTotal: (t) => `${t} utilisateur(s)`,
          }}
        />
      </Card>
    </div>
  );
}
