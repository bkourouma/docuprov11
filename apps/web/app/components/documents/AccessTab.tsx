'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  App,
  Button,
  DatePicker,
  Popconfirm,
  Select,
  Space,
  Table,
  Tooltip,
  Typography,
} from 'antd';
import type { TableColumnsType } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import {
  documentsApi,
  lookups,
  type ActorOption,
  type DocumentPermissionRow,
} from '../../lib/archives';
import { apiJson } from '../../lib/api';
import { filterByLabel } from '../../lib/filters';
import { personName } from '../mail/mailFormat';
import { EmptyState } from '../EmptyState';
import { StateTag } from './shared';
import { icons } from '../../theme/icons';
import { fontSize, space } from '../../theme/tokens';

const { Text } = Typography;

/**
 * Cible pointable de l'unique action destructrice de l'onglet : 40 px, là où le `size="small"`
 * d'AntD tombe à 28 px — écart d'autant moins tenable que le geste retire un droit et n'est pas
 * rattrapable en un clic.
 *
 * La marge négative reprend exactement le `cellPaddingBlockSM` du thème (7 px de part et
 * d'autre) : le bouton déborde dans le rembourrage de sa cellule au lieu de l'allonger, ce qui
 * garde la ligne au gabarit des autres tables annexes de la fiche au lieu de l'étirer à 55 px.
 */
const ROW_ACTION_SIZE = 40;
const ROW_ACTION_BLEED = -7;

const fmt = (iso: string | null) => (iso ? dayjs(iso).format('DD/MM/YYYY') : '—');

interface LevelRow {
  permissionLevelId: number;
  name: string;
}
interface GroupRow {
  groupId: number;
  name: string;
}

/**
 * Onglets « Accès par Utilisateur » et « Accès par Profil » — un seul composant paramétré par
 * `scope` : les deux listent la même table (`document_permission`), au bénéficiaire près. Les
 * dupliquer aurait fait diverger deux écrans identiques à un champ de formulaire près.
 *
 * Depuis le 2026-08-04, le niveau accordé ici est RÉELLEMENT appliqué (cf. mémo
 * `docupro-v6-permission-levels-enforcement`) : Consultation (2, plancher de quiconque peut ouvrir
 * la fiche) ne donne accès qu'à la lecture, Modification (3) déverrouille l'onglet Indexation,
 * Administration (4) — géré ici via `canManage`, calculé par la page appelante à partir du niveau
 * effectif — permet d'accorder/retirer ces droits, Archivistique (5) déverrouille en plus le cycle
 * de vie et la création d'un nouveau prêt. « Denied » n'apparaît jamais dans la liste des niveaux :
 * l'absence de droit EST le refus.
 */
export function AccessTab({
  documentId,
  canManage,
  scope,
}: {
  documentId: number;
  canManage: boolean;
  scope: 'user' | 'group';
}) {
  const { message } = App.useApp();
  const isGroup = scope === 'group';

  const [rows, setRows] = useState<DocumentPermissionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [actors, setActors] = useState<ActorOption[]>([]);
  const [groups, setGroups] = useState<GroupRow[]>([]);
  const [levels, setLevels] = useState<LevelRow[]>([]);
  const [targetId, setTargetId] = useState<number | null>(null);
  const [levelId, setLevelId] = useState<number | null>(null);
  const [startDate, setStartDate] = useState<Dayjs | null>(null);
  const [endDate, setEndDate] = useState<Dayjs | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const all = await documentsApi.permissions(documentId);
      setRows(all.filter((r) => r.scope === scope));
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Chargement impossible');
    } finally {
      setLoading(false);
    }
  }, [documentId, message, scope]);

  useEffect(() => {
    void load();
    void apiJson<LevelRow[]>('/referentials/permission-levels')
      .then(setLevels)
      .catch(() => setLevels([]));
    if (isGroup) {
      // Lookup déjà exposé pour l'administration des utilisateurs — pas de second endpoint à créer.
      void apiJson<GroupRow[]>('/users/groups/all')
        .then(setGroups)
        .catch(() => setGroups([]));
    } else {
      void lookups
        .actors()
        .then(setActors)
        .catch(() => undefined);
    }
  }, [load, isGroup]);

  const grant = async () => {
    if (targetId == null || levelId == null) {
      message.warning(
        isGroup ? 'Choisissez un profil et un niveau.' : 'Choisissez un utilisateur et un niveau.',
      );
      return;
    }
    setBusy(true);
    try {
      await documentsApi.grantPermission(documentId, {
        ...(isGroup ? { groupId: targetId } : { userGroupId: targetId }),
        permissionLevelId: levelId,
        ...(startDate ? { startDate: startDate.format('YYYY-MM-DD') } : {}),
        ...(endDate ? { endDate: endDate.format('YYYY-MM-DD') } : {}),
      });
      message.success('Droit accordé.');
      setTargetId(null);
      setLevelId(null);
      setStartDate(null);
      setEndDate(null);
      await load();
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Échec');
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (permissionId: number) => {
    try {
      await documentsApi.revokePermission(documentId, permissionId);
      message.success('Droit retiré.');
      await load();
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Échec');
    }
  };

  const columns: TableColumnsType<DocumentPermissionRow> = [
    {
      // Nom sur UNE ligne : « Admin Système » se coupait en deux dans une colonne étroite. Le
      // débordement éventuel part dans le défilement horizontal de la table (`scroll.x`).
      title: isGroup ? 'Profil' : 'Utilisateur',
      key: 'label',
      render: (_, r) => <span style={{ whiteSpace: 'nowrap' }}>{r.label}</span>,
    },
    ...(isGroup
      ? []
      : [
          {
            title: 'Groupe',
            key: 'group',
            width: 200,
            render: (_: unknown, r: DocumentPermissionRow) => r.groupName ?? '—',
          },
        ]),
    {
      title: 'Niveau',
      key: 'level',
      width: 190,
      render: (_, r) => <StateTag tone="brand">{r.permissionLevelName}</StateTag>,
    },
    {
      title: 'Accordé le',
      key: 'grantedAt',
      width: 140,
      render: (_, r) => dayjs(r.grantedAt).format('DD/MM/YYYY'),
    },
    {
      title: 'Période',
      key: 'period',
      width: 210,
      render: (_, r) =>
        r.startDate || r.endDate ? (
          <span style={{ whiteSpace: 'nowrap' }}>
            {fmt(r.startDate)} → {fmt(r.endDate)}
          </span>
        ) : (
          <Text type="secondary">Sans limite</Text>
        ),
    },
    ...(canManage
      ? [
          {
            title: '',
            key: 'actions',
            width: 64,
            align: 'center' as const,
            render: (_: unknown, r: DocumentPermissionRow) => (
              <Popconfirm
                title="Retirer ce droit ?"
                description={
                  isGroup
                    ? 'Le profil perdra l’accès nominatif à ce document.'
                    : 'L’utilisateur perdra l’accès nominatif à ce document.'
                }
                okText="Retirer"
                okButtonProps={{ danger: true }}
                cancelText="Annuler"
                onConfirm={() => void revoke(r.documentPermissionId)}
              >
                <Tooltip title="Retirer ce droit">
                  <Button
                    type="text"
                    danger
                    icon={<icons.delete size={16} />}
                    style={{
                      width: ROW_ACTION_SIZE,
                      height: ROW_ACTION_SIZE,
                      marginBlock: ROW_ACTION_BLEED,
                    }}
                  />
                </Tooltip>
              </Popconfirm>
            ),
          },
        ]
      : []),
  ];

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      {canManage && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: space.sm, width: '100%' }}>
          <Select
            style={{ flex: '1 1 260px', minWidth: 260 }}
            value={targetId ?? undefined}
            onChange={(v) => setTargetId((v as number) ?? null)}
            options={
              isGroup
                ? groups.map((g) => ({ value: g.groupId, label: g.name }))
                : // `Actor.label` vaut « Nom — Groupe » : on ne garde que la personne, le tableau
                  // ci-dessous ayant déjà sa colonne « Groupe » pour la situer.
                  actors.map((a) => ({ value: a.userGroupId, label: personName(a.label) }))
            }
            showSearch
            allowClear
            filterOption={filterByLabel}
            placeholder={isGroup ? 'Profil…' : 'Utilisateur…'}
          />
          <Select
            style={{ minWidth: 200 }}
            value={levelId ?? undefined}
            onChange={(v) => setLevelId((v as number) ?? null)}
            options={levels.map((l) => ({ value: l.permissionLevelId, label: l.name }))}
            allowClear
            placeholder="Niveau…"
          />
          <DatePicker
            value={startDate}
            onChange={setStartDate}
            format="DD/MM/YYYY"
            placeholder="Date de début (facultatif)"
          />
          <DatePicker
            value={endDate}
            onChange={setEndDate}
            format="DD/MM/YYYY"
            placeholder="Date de fin (facultatif)"
          />
          <Button
            type="primary"
            icon={<icons.add size={16} />}
            loading={busy}
            onClick={() => void grant()}
          >
            Accorder
          </Button>
        </div>
      )}

      {!loading && rows.length === 0 ? (
        <EmptyState compact icon={isGroup ? 'roles' : 'users'} title="Aucun droit explicite" />
      ) : (
        <Table<DocumentPermissionRow>
          rowKey="documentPermissionId"
          dataSource={rows}
          columns={columns}
          loading={loading}
          size="small"
          scroll={{ x: 'max-content' }}
          pagination={false}
        />
      )}
      <Text type="secondary" style={{ fontSize: fontSize.xs }}>
        Les droits par TYPE de document se gèrent dans l’administration, pas ici.
      </Text>
    </Space>
  );
}
