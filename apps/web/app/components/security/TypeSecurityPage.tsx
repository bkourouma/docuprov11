'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  App,
  Button,
  Card,
  DatePicker,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { TableColumnsType } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { apiJson } from '../../lib/api';
import { lookups, type DocumentTypeOption } from '../../lib/archives';
import { typePermissionsApi, type TypePermissionRow } from '../../lib/security';
import { filterByLabel } from '../../lib/filters';
import { PageHeader } from '../PageHeader';
import { EmptyState } from '../EmptyState';
import { useThemeMode } from '../Providers';
import { icons, type IconName } from '../../theme/icons';
import { colors, colorsDark, fontSize, space } from '../../theme/tokens';

const { Text } = Typography;

/**
 * Champ de la barre d'octroi. Le libellé est PERSISTANT : le placeholder seul disparaissait dès
 * la première valeur choisie, emportant avec lui la mention « facultatif » des deux dates — la
 * barre finissait alignée sur six contrôles que plus rien n'identifiait. `htmlFor` vise l'`id`
 * du contrôle AntD, qui le pose sur son input interne.
 */
function GrantField({
  htmlFor,
  label,
  hint,
  children,
}: {
  htmlFor: string;
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: space.sm }}>
      <label htmlFor={htmlFor} style={{ fontSize: fontSize.base }}>
        {label}
        {hint && <Text type="secondary"> {hint}</Text>}
      </label>
      {children}
    </div>
  );
}

interface LevelRow {
  permissionLevelId: number;
  name: string;
}
interface ActorRow {
  value: number;
  label: string;
}

const fmt = (iso: string | null) => (iso ? dayjs(iso).format('DD/MM/YYYY') : '—');

/** Un groupe = un bénéficiaire (acteur ou rôle) et les droits qui lui sont accordés. */
interface ActorGroup {
  key: string;
  actor: string;
  items: TypePermissionRow[];
}

const byLabel = (a: string, b: string) => a.localeCompare(b, 'fr');

/**
 * Sécurité Documentaire — droits par TYPE de document, un seul composant paramétré par `scope` :
 * « Sécurité type document par utilisateur » et « par rôle » lisent et écrivent la MÊME table
 * (`document_type_permission`), au bénéficiaire près — même patron que `AccessTab` pour les droits
 * par document. `actorsLoader` fournit les options du bénéficiaire (acteurs nommés ou rôles).
 *
 * L'octroi porte sur un produit cartésien acteurs × types : pas d'endpoint bulk dédié, une boucle
 * client suffit (volumes réalistes ici — quelques acteurs, quelques types).
 *
 * Le tableau est un ACCORDÉON, une ligne d'en-tête par bénéficiaire à déplier pour voir ses droits
 * — même patron que « Métadonnées par type de document »
 * (`app/admin/archives/metadonnees-types/page.tsx`). C'est justement le produit cartésien qui rend
 * la liste à plat pénible à lire, le même nom s'y répétant sur autant de lignes que de types.
 */
export function TypeSecurityPage({
  scope,
  icon,
  title,
  actorLabel,
  actorPlaceholder,
  actorsLoader,
}: {
  scope: 'user' | 'role';
  icon: IconName;
  title: string;
  actorLabel: string;
  actorPlaceholder: string;
  actorsLoader: () => Promise<ActorRow[]>;
}) {
  const { message } = App.useApp();
  const { mode } = useThemeMode();
  // Fond des lignes de groupe : le ton d'en-tête de table (#f8f9fb / #1e1e20), qui détache le
  // repli de la carte blanche sans lui donner le poids d'une ligne de données.
  const groupBg = (mode === 'dark' ? colorsDark : colors).theadBg;

  const [rows, setRows] = useState<TypePermissionRow[]>([]);
  const [types, setTypes] = useState<DocumentTypeOption[]>([]);
  const [actors, setActors] = useState<ActorRow[]>([]);
  const [levels, setLevels] = useState<LevelRow[]>([]);
  const [loading, setLoading] = useState(true);

  const [actorIds, setActorIds] = useState<number[]>([]);
  const [typeIds, setTypeIds] = useState<number[]>([]);
  const [levelId, setLevelId] = useState<number | null>(null);
  const [startDate, setStartDate] = useState<Dayjs | null>(null);
  const [endDate, setEndDate] = useState<Dayjs | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const all = await typePermissionsApi.list();
      setRows(all.filter((r) => r.scope === scope));
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Chargement impossible');
    } finally {
      setLoading(false);
    }
  }, [message, scope]);

  useEffect(() => {
    void load();
    void lookups
      .documentTypes()
      .then(setTypes)
      .catch(() => undefined);
    void actorsLoader()
      .then(setActors)
      .catch(() => undefined);
    void apiJson<LevelRow[]>('/referentials/permission-levels')
      .then(setLevels)
      .catch(() => setLevels([]));
    // `actorsLoader` est stable côté appelant (fonction module-level) : ne pas le mettre en
    // dépendance éviterait une boucle si un appelant en passait une nouvelle à chaque rendu.
  }, [load]);

  const grant = async () => {
    if (actorIds.length === 0 || typeIds.length === 0 || levelId == null) {
      message.warning('Choisissez au moins un bénéficiaire, un type et un niveau.');
      return;
    }
    setBusy(true);
    try {
      await Promise.all(
        actorIds.flatMap((actorId) =>
          typeIds.map((documentTypeId) =>
            typePermissionsApi.grant({
              documentTypeId,
              permissionLevelId: levelId,
              ...(scope === 'role' ? { roleId: actorId } : { userGroupId: actorId }),
              ...(startDate ? { startDate: startDate.format('YYYY-MM-DD') } : {}),
              ...(endDate ? { endDate: endDate.format('YYYY-MM-DD') } : {}),
            }),
          ),
        ),
      );
      message.success(`Droit accordé (${actorIds.length} × ${typeIds.length}).`);
      setActorIds([]);
      setTypeIds([]);
      setLevelId(null);
      setStartDate(null);
      setEndDate(null);
      await load();
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Échec de l’octroi');
    } finally {
      setBusy(false);
    }
  };

  /**
   * Retrait, d'un droit ou de tous ceux d'un bénéficiaire. Une boucle client, comme l'octroi : le
   * back n'expose que le retrait unitaire, et les volumes en jeu ne le justifient pas.
   */
  const revoke = async (ids: number[]) => {
    try {
      await Promise.all(ids.map((id) => typePermissionsApi.revoke(id)));
      message.success(ids.length > 1 ? `${ids.length} droits retirés.` : 'Droit retiré.');
      await load();
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Échec');
    }
  };

  /**
   * Regroupement par bénéficiaire. La clé est `roleId`/`userGroupId`, pas le libellé : rien
   * n'impose l'unicité du nom d'un rôle, et deux homonymes doivent rester deux groupes.
   */
  const groupedByActor: ActorGroup[] = useMemo(() => {
    const groups = new Map<string, ActorGroup>();
    for (const r of rows) {
      const key = `g${r.roleId ?? r.userGroupId ?? r.label}`;
      const group = groups.get(key) ?? { key, actor: r.label, items: [] };
      group.items.push(r);
      groups.set(key, group);
    }
    const list = [...groups.values()].sort((a, b) => byLabel(a.actor, b.actor));
    list.forEach((g) => g.items.sort((a, b) => byLabel(a.documentTypeLabel, b.documentTypeLabel)));
    return list;
  }, [rows]);

  /** Ligne d'en-tête (accordéon) : le bénéficiaire et le nombre de droits qu'il détient. */
  const outerColumns: TableColumnsType<ActorGroup> = [
    {
      title: actorLabel,
      key: 'actor',
      render: (_, g) => (
        <Space>
          <Text strong>{g.actor}</Text>
          <Tag>
            {g.items.length} droit{g.items.length > 1 ? 's' : ''}
          </Tag>
        </Space>
      ),
    },
    {
      title: '',
      key: 'actions',
      width: 160,
      align: 'right',
      render: (_, g) => (
        <Popconfirm
          title={
            g.items.length > 1
              ? `Retirer les ${g.items.length} droits de ce bénéficiaire ?`
              : 'Retirer le droit de ce bénéficiaire ?'
          }
          description="Il perdra l’accès aux types de documents concernés."
          okText="Tout retirer"
          okButtonProps={{ danger: true }}
          cancelText="Annuler"
          onConfirm={() => void revoke(g.items.map((i) => i.documentTypePermissionId))}
        >
          <Button danger size="small" icon={<icons.delete size={14} />}>
            Tout retirer
          </Button>
        </Popconfirm>
      ),
    },
  ];

  /** Contenu déplié : le détail des droits de ce bénéficiaire, retrait individuel possible. */
  const innerColumns: TableColumnsType<TypePermissionRow> = [
    { title: 'Type de document', key: 'type', render: (_, r) => r.documentTypeLabel },
    {
      title: 'Niveau',
      key: 'level',
      width: 190,
      // Badge plein : le niveau est une donnée de classement, pas une alerte — il prend le
      // primaire (blanc dessus, 9,25:1) posé par AntD via `ant-tag-has-color`. La taille 11 px
      // vient du thème (`Tag.fontSizeSM`), seule la graisse est à forcer.
      render: (_, r) => (
        <Tag color={colors.primary} style={{ fontWeight: 600 }}>
          {r.permissionLevelName}
        </Tag>
      ),
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
    {
      title: '',
      key: 'actions',
      width: 56,
      align: 'center',
      render: (_, r) => (
        <Popconfirm
          title="Retirer ce droit ?"
          description="Le bénéficiaire perdra l’accès à ce type de document."
          okText="Retirer"
          okButtonProps={{ danger: true }}
          cancelText="Annuler"
          onConfirm={() => void revoke([r.documentTypePermissionId])}
        >
          <Button type="text" danger size="small" icon={<icons.delete size={16} />} />
        </Popconfirm>
      ),
    },
  ];

  return (
    <div>
      <PageHeader icon={icon} title={title} />
      <Card>
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          {/* Les libellés alignent leurs contrôles par le BAS (`align="end"`) : le bouton, qui
              n'en porte pas, reste sur la même ligne de base que les champs. */}
          <Space wrap align="end" size={[space.lg, space.md]} style={{ width: '100%' }}>
            <GrantField htmlFor="grant-actors" label={`${actorLabel}s`}>
              <Select
                id="grant-actors"
                mode="multiple"
                style={{ minWidth: 260 }}
                value={actorIds}
                onChange={(v) => setActorIds(v as number[])}
                options={actors.map((a) => ({ value: a.value, label: a.label }))}
                showSearch
                filterOption={filterByLabel}
                placeholder={actorPlaceholder}
                maxTagCount="responsive"
              />
            </GrantField>
            <GrantField htmlFor="grant-types" label="Types de document">
              <Select
                id="grant-types"
                mode="multiple"
                style={{ minWidth: 260 }}
                value={typeIds}
                onChange={(v) => setTypeIds(v as number[])}
                options={types.map((t) => ({ value: t.documentTypeId, label: t.label }))}
                showSearch
                filterOption={filterByLabel}
                placeholder="Types de document…"
                maxTagCount="responsive"
              />
            </GrantField>
            <GrantField htmlFor="grant-level" label="Niveau de permission">
              <Select
                id="grant-level"
                style={{ minWidth: 200 }}
                value={levelId ?? undefined}
                onChange={(v) => setLevelId((v as number) ?? null)}
                options={levels.map((l) => ({ value: l.permissionLevelId, label: l.name }))}
                allowClear
                placeholder="Niveau…"
              />
            </GrantField>
            <GrantField htmlFor="grant-start" label="Début" hint="(facultatif)">
              <DatePicker
                id="grant-start"
                value={startDate}
                onChange={setStartDate}
                format="DD/MM/YYYY"
                placeholder="JJ/MM/AAAA"
              />
            </GrantField>
            <GrantField htmlFor="grant-end" label="Fin" hint="(facultatif)">
              <DatePicker
                id="grant-end"
                value={endDate}
                onChange={setEndDate}
                format="DD/MM/YYYY"
                placeholder="JJ/MM/AAAA"
              />
            </GrantField>
            <Button
              type="primary"
              icon={<icons.add size={16} />}
              loading={busy}
              onClick={() => void grant()}
            >
              Accorder
            </Button>
          </Space>

          {!loading && rows.length === 0 ? (
            <EmptyState compact icon={icon} title="Aucun droit" />
          ) : (
            // Le wrapper capture le débordement horizontal dans SA propre zone de défilement
            // (même patron que « Paramétrage des types de documents ») : sur un petit écran, la
            // largeur cumulée des colonnes dépasse la carte, `scroll.x` seul suffit déjà à
            // contenir la table, ce `div` évite qu'un dépassement résiduel gagne toute la page.
            <div style={{ overflowX: 'auto' }}>
              {/* Un bénéficiaire = une ligne d'en-tête repliée par défaut ; on déplie ceux qu'on
                  veut inspecter, plutôt que d'imposer tous les droits d'un coup. */}
              <Table<ActorGroup>
                rowKey="key"
                dataSource={groupedByActor}
                columns={outerColumns}
                loading={loading}
                size="middle"
                scroll={{ x: 'max-content' }}
                onRow={() => ({ style: { background: groupBg } })}
                pagination={{
                  pageSize: 20,
                  showSizeChanger: true,
                  // La pagination porte sur les lignes d'EN-TÊTE, donc sur les bénéficiaires et non
                  // sur les droits — le total le dit, sinon « 3 droit(s) » pour trente lignes
                  // dépliées serait faux.
                  showTotal: (t) => `${t} ${actorLabel.toLowerCase()}(s) — ${rows.length} droit(s)`,
                }}
                expandable={{
                  expandedRowRender: (g) => (
                    <Table<TypePermissionRow>
                      rowKey="documentTypePermissionId"
                      dataSource={g.items}
                      columns={innerColumns}
                      size="small"
                      pagination={false}
                      showHeader
                    />
                  ),
                }}
              />
            </div>
          )}
        </Space>
      </Card>
    </div>
  );
}
