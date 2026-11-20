'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Form,
  Input,
  Modal,
  Popconfirm,
  Radio,
  Select,
  Space,
  Table,
  Tabs,
  Typography,
} from 'antd';
import type { TableColumnsType } from 'antd';
import { PageHeader } from '../../components/PageHeader';
import { EmptyState } from '../../components/EmptyState';
import { TableSkeleton } from '../../components/skeletons';
import { useFeedback } from '../../components/feedback';
import { AccessTag, PublicationTag, SpaceKindTag } from '../../components/espaces/SpaceBadges';
import { DocumentCount } from '../../components/espaces/SpaceCount';
import { SpaceFormModal } from '../../components/espaces/SpaceFormModal';
import { SpaceDocumentsTable } from '../../components/espaces/SpaceDocumentsTable';
import { icons, iconDefaults } from '../../theme/icons';
import { fontSize, space as spacing } from '../../theme/tokens';
import {
  GED_SPACE_PERMISSION_LABELS,
  espacesApi,
  publicPath,
  searchDocumentsByLabel,
  type DocumentSearchRow,
  type GedSpaceDetail,
  type GedSpaceDocumentRow,
  type GedSpaceMemberCandidates,
  type GedSpaceMemberRow,
  type GedSpacePermission,
} from '../../lib/espaces';

const SHORT_FIELD = spacing.xxxl * 4;
const MID_FIELD = spacing.xxxl * 5;
const ACTION_COL = spacing.xxxl * 3;

const PERMISSION_OPTIONS = ([0, 1, 2] as const).map((p) => ({
  value: p,
  label: GED_SPACE_PERMISSION_LABELS[p],
}));

/**
 * Docu-GED lot 4a — détail d'un espace.
 *
 * Les boutons suivent `canManage` / `canContribute` / `myAccess` pour ne pas proposer ce qui sera
 * refusé, mais l'API reste l'autorité : chaque échec affiche SON message (`message.error`).
 */
export default function EspaceDetailPage() {
  const { spaceId } = useParams<{ spaceId: string }>();
  const id = Number(spaceId);
  const router = useRouter();
  const { message, confirm } = useFeedback();

  const [space, setSpace] = useState<GedSpaceDetail | null>(null);
  const [documents, setDocuments] = useState<GedSpaceDocumentRow[]>([]);
  const [members, setMembers] = useState<GedSpaceMemberRow[]>([]);
  /** Identifiant d'URL non numérique : on n'appelle pas l'API et on ne montre jamais de squelette. */
  const invalidId = !Number.isInteger(id) || id <= 0;
  const [loading, setLoading] = useState(!invalidId);
  const [failed, setFailed] = useState(invalidId);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [publishing, setPublishing] = useState(false);
  /** Avertissement renvoyé par la dernière publication (documents confidentiels). */
  const [publishWarning, setPublishWarning] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [detail, docs] = await Promise.all([espacesApi.get(id), espacesApi.listDocuments(id)]);
      setSpace(detail);
      setMembers(detail.members);
      setDocuments(docs);
      setFailed(false);
      setErrorMsg(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Chargement de l'espace impossible";
      setFailed(true);
      setErrorMsg(msg);
      message.error(msg);
    } finally {
      setLoading(false);
    }
  }, [id, message]);

  useEffect(() => {
    if (!invalidId) void load();
  }, [invalidId, load]);

  const reloadDocuments = async () => {
    try {
      setDocuments(await espacesApi.listDocuments(id));
      setSpace(await espacesApi.get(id));
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Actualisation impossible');
    }
  };

  const detach = async (documentId: number) => {
    try {
      await espacesApi.detachDocument(id, documentId);
      message.success('Document détaché');
      await reloadDocuments();
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Détachement impossible');
    }
  };

  const unpublish = async () => {
    try {
      await espacesApi.unpublish(id);
      message.success('Espace dépublié');
      setPublishWarning(null);
      await load();
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Dépublication impossible');
    }
  };

  const remove = () =>
    confirm({
      title: `Supprimer l'espace « ${space?.label} » ?`,
      content:
        "L'espace disparaît des listes (suppression logique). Les documents rattachés ne sont pas supprimés.",
      okText: 'Supprimer',
      danger: true,
      onOk: async () => {
        try {
          await espacesApi.remove(id);
          message.success('Espace supprimé');
          router.push('/espaces');
        } catch (e) {
          message.error(e instanceof Error ? e.message : 'Suppression impossible');
        }
      },
    });

  const crumbRoot = [{ label: 'Espaces', href: '/espaces' }];

  if (loading && !space && !invalidId) {
    return (
      <div>
        <PageHeader title="Espace" icon="dossier" breadcrumb={crumbRoot} />
        <Card>
          <TableSkeleton rows={4} columns={4} />
        </Card>
      </div>
    );
  }
  if (!space) {
    return (
      <div>
        <PageHeader title="Espace" icon="dossier" breadcrumb={crumbRoot} />
        <Card>
          {(invalidId || errorMsg) && (
            <Alert
              type="error"
              showIcon
              style={{ marginBottom: spacing.lg }}
              message={invalidId ? "L'identifiant d'espace est invalide." : errorMsg}
            />
          )}
          <EmptyState
            icon="alert"
            title={failed ? 'Cet espace est introuvable ou inaccessible.' : 'Espace indisponible.'}
            action={
              <Link href="/espaces">
                <Button>Retour aux espaces</Button>
              </Link>
            }
          />
        </Card>
      </div>
    );
  }

  const Edit = icons.edit;
  const Send = icons.send;
  const Del = icons.delete;
  const Add = icons.add;
  const Lock = icons.lock;
  const isOwner = space.myAccess === 'owner';
  const slug = space.publicationSlug;

  const actions = space.canManage ? (
    <>
      <Button icon={<Edit size={iconDefaults.size} />} onClick={() => setEditing(true)}>
        Modifier
      </Button>
      {slug !== null ? (
        <Popconfirm
          title="Dépublier cet espace ?"
          description={`Le lien ${publicPath(slug)} cessera de fonctionner.`}
          okText="Dépublier"
          cancelText="Annuler"
          onConfirm={unpublish}
        >
          <Button icon={<Lock size={iconDefaults.size} />}>Dépublier</Button>
        </Popconfirm>
      ) : (
        <Button icon={<Send size={iconDefaults.size} />} onClick={() => setPublishing(true)}>
          Publier
        </Button>
      )}
      {isOwner && (
        <Button danger icon={<Del size={iconDefaults.size} />} onClick={remove}>
          Supprimer
        </Button>
      )}
    </>
  ) : undefined;

  return (
    <div>
      <PageHeader
        title={space.label}
        icon="dossier"
        breadcrumb={[...crumbRoot, { label: space.label }]}
        actions={actions}
      />

      {slug !== null && (
        <Alert
          type="success"
          showIcon
          style={{ marginBottom: spacing.lg }}
          message={
            <span>
              Espace publié sous l&apos;adresse{' '}
              <Link href={publicPath(slug)}>
                <code>{publicPath(slug)}</code>
              </Link>
            </span>
          }
        />
      )}
      {publishWarning !== null && publishWarning > 0 && (
        <Alert
          type="warning"
          showIcon
          closable
          onClose={() => setPublishWarning(null)}
          style={{ marginBottom: spacing.lg }}
          message={`${publishWarning} document(s) à confidentialité ne seront pas visibles du public de la publication.`}
        />
      )}

      <Card style={{ marginBottom: spacing.lg }}>
        <Descriptions
          size="small"
          column={{ xs: 1, sm: 2, lg: 3 }}
          items={[
            { key: 'kind', label: 'Type', children: <SpaceKindTag kind={space.kind} /> },
            { key: 'owner', label: 'Propriétaire', children: space.ownerName ?? '—' },
            { key: 'access', label: 'Mon droit', children: <AccessTag access={space.myAccess} /> },
            {
              key: 'pub',
              label: 'Publication',
              children: <PublicationTag slug={space.publicationSlug} />,
            },
            { key: 'docs', label: 'Documents', children: <DocumentCount value={space.documentCount} /> },
            { key: 'members', label: 'Membres', children: space.memberCount },
            ...(space.description
              ? [
                  {
                    key: 'desc',
                    label: 'Description',
                    span: 'filled' as const,
                    children: space.description,
                  },
                ]
              : []),
          ]}
        />
      </Card>

      <Card>
        <Tabs
          items={[
            {
              key: 'documents',
              label: `Documents (${documents.length})`,
              children: (
                <>
                  {space.canContribute && documents.length > 0 && (
                    <div style={{ marginBottom: spacing.lg }}>
                      <Button
                        type="primary"
                        icon={<Add size={iconDefaults.size} />}
                        onClick={() => setAttaching(true)}
                      >
                        Rattacher un document
                      </Button>
                    </div>
                  )}
                  {documents.length === 0 ? (
                    <EmptyState
                      compact
                      icon="document"
                      title="Aucun document dans cet espace."
                      action={
                        space.canContribute ? (
                          <Button type="primary" onClick={() => setAttaching(true)}>
                            Rattacher un document
                          </Button>
                        ) : undefined
                      }
                    />
                  ) : (
                    <SpaceDocumentsTable
                      rows={documents}
                      loading={loading}
                      onDetach={space.canContribute ? detach : undefined}
                    />
                  )}
                </>
              ),
            },
            {
              key: 'members',
              label: 'Membres',
              children: space.kind === 0 ? (
                <EmptyState
                  compact
                  icon="lock"
                  title="Un espace privé est réservé à son propriétaire."
                />
              ) : space.canManage ? (
                <MembersPanel
                  spaceId={id}
                  members={members}
                  onChanged={async () => {
                    try {
                      const fresh = await espacesApi.get(id);
                      setSpace(fresh);
                      setMembers(fresh.members);
                    } catch (e) {
                      message.error(e instanceof Error ? e.message : 'Actualisation impossible');
                    }
                  }}
                />
              ) : (
                <EmptyState
                  compact
                  icon="lock"
                  title="La liste des membres est réservée au propriétaire et aux membres en gestion."
                />
              ),
            },
          ]}
        />
      </Card>

      <SpaceFormModal
        open={editing}
        space={space}
        onClose={() => setEditing(false)}
        onSaved={() => {
          setEditing(false);
          void load();
        }}
      />
      <AttachModal
        open={attaching}
        attachedIds={documents.map((d) => d.documentId)}
        onClose={() => setAttaching(false)}
        onAttach={async (documentId) => {
          await espacesApi.attachDocument(id, documentId);
          message.success('Document rattaché');
          setAttaching(false);
          await reloadDocuments();
        }}
      />
      <PublishModal
        open={publishing}
        onClose={() => setPublishing(false)}
        onPublish={async (slugInput) => {
          const res = await espacesApi.publish(id, slugInput);
          message.success('Espace publié');
          setPublishing(false);
          setPublishWarning(res.nonPublishableCount);
          await load();
        }}
      />
    </div>
  );
}

/** Publication : le slug est facultatif (l'API en propose un depuis le libellé). */
function PublishModal({
  open,
  onClose,
  onPublish,
}: {
  open: boolean;
  onClose: () => void;
  onPublish: (slug?: string) => Promise<void>;
}) {
  const { message } = useFeedback();
  const [slug, setSlug] = useState('');
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    setSaving(true);
    try {
      await onPublish(slug.trim() || undefined);
      setSlug('');
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Publication impossible');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      open={open}
      title="Publier l'espace"
      okText="Publier"
      cancelText="Annuler"
      confirmLoading={saving}
      onCancel={onClose}
      onOk={submit}
      destroyOnClose
    >
      <Typography.Paragraph>
        Les documents de l&apos;espace deviennent consultables en lecture seule par le public de la
        publication. Ceux dont la confidentialité est posée restent invisibles.
      </Typography.Paragraph>
      <Form layout="vertical" onFinish={submit}>
        <Form.Item
          label="Adresse (facultative)"
          extra="Laissez vide pour la générer à partir du libellé."
        >
          <Input
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            maxLength={80}
            placeholder="mon-espace"
            addonBefore="/espaces/publie/"
          />
        </Form.Item>
      </Form>
    </Modal>
  );
}

/** Rattachement : recherche par libellé (recherche documentaire existante) puis sélection. */
function AttachModal({
  open,
  attachedIds,
  onClose,
  onAttach,
}: {
  open: boolean;
  attachedIds: number[];
  onClose: () => void;
  onAttach: (documentId: number) => Promise<void>;
}) {
  const { message } = useFeedback();
  const [options, setOptions] = useState<DocumentSearchRow[]>([]);
  const [selected, setSelected] = useState<number | undefined>();
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (!open) {
      setOptions([]);
      setSelected(undefined);
    }
    return () => clearTimeout(timer.current);
  }, [open]);

  /** Anti-rebond : une requête par pause de frappe, pas une par touche. */
  const onSearch = (text: string) => {
    clearTimeout(timer.current);
    if (text.trim().length < 2) {
      setOptions([]);
      return;
    }
    timer.current = setTimeout(async () => {
      setSearching(true);
      try {
        setOptions(await searchDocumentsByLabel(text.trim()));
      } catch (e) {
        message.error(e instanceof Error ? e.message : 'Recherche impossible');
      } finally {
        setSearching(false);
      }
    }, 300);
  };

  const submit = async () => {
    if (selected === undefined) return;
    setSaving(true);
    try {
      await onAttach(selected);
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Rattachement impossible');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      title="Rattacher un document"
      okText="Rattacher"
      cancelText="Annuler"
      okButtonProps={{ disabled: selected === undefined }}
      confirmLoading={saving}
      onCancel={onClose}
      onOk={submit}
      destroyOnClose
    >
      <label htmlFor="espace-doc-search" style={{ display: 'block', marginBottom: spacing.sm }}>
        Rechercher un document par son libellé
      </label>
      <Select
        id="espace-doc-search"
        showSearch
        filterOption={false}
        value={selected}
        onChange={setSelected}
        onSearch={onSearch}
        loading={searching}
        style={{ width: '100%' }}
        placeholder="Saisissez au moins 2 caractères"
        notFoundContent={searching ? 'Recherche…' : 'Aucun résultat'}
        options={options.map((d) => ({
          value: d.documentId,
          disabled: attachedIds.includes(d.documentId),
          label: `${d.label}${d.documentType ? ` — ${d.documentType}` : ''}${
            attachedIds.includes(d.documentId) ? ' (déjà rattaché)' : ''
          }`,
        }))}
      />
    </Modal>
  );
}

/** Membres : tableau, changement de droit, retrait, ajout d'un utilisateur ou d'un rôle. */
function MembersPanel({
  spaceId,
  members,
  onChanged,
}: {
  spaceId: number;
  members: GedSpaceMemberRow[];
  onChanged: () => Promise<void>;
}) {
  const { message } = useFeedback();
  const [candidates, setCandidates] = useState<GedSpaceMemberCandidates | null>(null);
  const [granteeType, setGranteeType] = useState<'user' | 'role'>('user');
  const [granteeId, setGranteeId] = useState<number | undefined>();
  const [permission, setPermission] = useState<GedSpacePermission>(0);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    void espacesApi
      .candidates()
      .then(setCandidates)
      .catch((e) =>
        message.error(e instanceof Error ? e.message : 'Chargement des candidats impossible'),
      );
  }, [message]);

  const Remove = icons.delete;
  const Add = icons.add;

  const add = async () => {
    if (granteeId === undefined) return;
    setAdding(true);
    try {
      await espacesApi.addMember(
        spaceId,
        granteeType === 'user'
          ? { userGroupId: granteeId, permission }
          : { roleId: granteeId, permission },
      );
      message.success('Membre ajouté');
      setGranteeId(undefined);
      await onChanged();
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Ajout impossible');
    } finally {
      setAdding(false);
    }
  };

  const changePermission = async (m: GedSpaceMemberRow, p: GedSpacePermission) => {
    try {
      await espacesApi.updateMember(spaceId, m.gedSpaceMemberId, p);
      message.success('Droit modifié');
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Modification impossible');
    }
    // Recharge dans tous les cas : en cas de refus, le Select reprend la valeur du serveur.
    await onChanged();
  };

  const removeMember = async (m: GedSpaceMemberRow) => {
    try {
      await espacesApi.removeMember(spaceId, m.gedSpaceMemberId);
      message.success('Membre retiré');
      await onChanged();
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Retrait impossible');
    }
  };

  const columns: TableColumnsType<GedSpaceMemberRow> = [
    {
      title: 'Bénéficiaire',
      dataIndex: 'granteeLabel',
      render: (v: string, m) => (
        <Space direction="vertical" size={0}>
          <span>{v}</span>
          <Typography.Text type="secondary">
            {m.granteeType === 'user' ? 'Utilisateur' : 'Rôle'}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: 'Droit',
      dataIndex: 'permission',
      width: MID_FIELD,
      render: (p: GedSpacePermission, m) => (
        <Select<GedSpacePermission>
          value={p}
          options={PERMISSION_OPTIONS}
          style={{ width: '100%' }}
          aria-label={`Droit de ${m.granteeLabel}`}
          onChange={(v) => void changePermission(m, v)}
        />
      ),
    },
    {
      title: 'Actions',
      key: 'actions',
      width: ACTION_COL,
      render: (_, m) => (
        <Popconfirm
          title="Retirer ce membre ?"
          okText="Retirer"
          cancelText="Annuler"
          onConfirm={() => removeMember(m)}
        >
          <Button
            size="small"
            danger
            icon={<Remove size={fontSize.base} />}
            aria-label={`Retirer ${m.granteeLabel}`}
          >
            Retirer
          </Button>
        </Popconfirm>
      ),
    },
  ];

  const granteeOptions =
    granteeType === 'user'
      ? (candidates?.users ?? []).map((u) => ({
          value: u.userGroupId,
          label: `${u.fullName} (${u.username})`,
        }))
      : (candidates?.roles ?? []).map((r) => ({ value: r.roleId, label: r.label }));

  return (
    <div>
      <div
        style={{
          display: 'flex',
          gap: spacing.md,
          flexWrap: 'wrap',
          alignItems: 'flex-end',
          marginBottom: spacing.lg,
        }}
      >
        <div>
          <div id="espace-grantee-type" style={{ marginBottom: spacing.sm }}>
            Ajouter
          </div>
          <Radio.Group
            aria-labelledby="espace-grantee-type"
            value={granteeType}
            onChange={(e) => {
              setGranteeType(e.target.value);
              setGranteeId(undefined);
            }}
            options={[
              { value: 'user', label: 'Un utilisateur' },
              { value: 'role', label: 'Un rôle' },
            ]}
          />
        </div>
        <Select
          showSearch
          optionFilterProp="label"
          aria-label={granteeType === 'user' ? 'Utilisateur à ajouter' : 'Rôle à ajouter'}
          placeholder={granteeType === 'user' ? 'Choisir un utilisateur' : 'Choisir un rôle'}
          style={{ flex: `1 1 ${MID_FIELD}px`, minWidth: SHORT_FIELD }}
          loading={candidates === null}
          value={granteeId}
          onChange={setGranteeId}
          options={granteeOptions}
        />
        <Select<GedSpacePermission>
          aria-label="Droit accordé"
          style={{ width: SHORT_FIELD }}
          value={permission}
          onChange={setPermission}
          options={PERMISSION_OPTIONS}
        />
        <Button
          type="primary"
          icon={<Add size={iconDefaults.size} />}
          loading={adding}
          disabled={granteeId === undefined}
          onClick={add}
        >
          Ajouter
        </Button>
      </div>
      <Table<GedSpaceMemberRow>
        rowKey="gedSpaceMemberId"
        size="middle"
        columns={columns}
        dataSource={members}
        pagination={false}
        scroll={{ x: 'max-content' }}
        locale={{
          emptyText: (
            <EmptyState
              compact
              icon="users"
              title="Aucun membre : seul le propriétaire accède à l'espace."
            />
          ),
        }}
      />
    </div>
  );
}
