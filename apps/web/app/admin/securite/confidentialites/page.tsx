'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { App, Button, Input, Popconfirm, Table } from 'antd';
import type { TableColumnsType } from 'antd';
import { NewItemField, NewItemForm, RefLayout } from '../../../components/RefLayout';
import { EditableText } from '../../../components/editable';
import { EmptyState } from '../../../components/EmptyState';
import { TableSkeleton } from '../../../components/skeletons';
import { icons } from '../../../theme/icons';
import { colors, fontSize } from '../../../theme/tokens';
import { confidentialitesArchivesApi, type ConfidentialiteArchiveRow } from '../../../lib/security';

/**
 * Rang d'un niveau : pastille numérotée + jauge de gradation. C'est l'ORDRE qui porte la règle
 * d'accès, or il n'était lisible nulle part — la jauge le rend perceptible d'un coup d'œil sans
 * rien demander à l'API ni changer l'ordre qu'elle renvoie.
 *
 * Le remplissage est `menuActiveBg` : seul bleu constant entre les deux thèmes et porteur de
 * blanc (6,08:1). La jauge ne porte aucun texte, elle reste donc un élément purement graphique.
 */
function RankCell({ rank, max }: { rank: number; max: number }) {
  const ratio = max > 0 ? Math.min(Math.max(rank / max, 0), 1) : 1;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
      <span
        className="da-mono da-pill"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          minWidth: 28,
          height: 24,
          padding: '0 8px',
          background: colors.menuActiveBg,
          color: 'var(--ant-color-white)',
          fontWeight: 700,
          fontSize: fontSize.sm,
        }}
      >
        {rank}
      </span>
      <span
        aria-hidden
        className="da-pill"
        style={{
          display: 'block',
          width: 64,
          height: 6,
          overflow: 'hidden',
          background: 'var(--ant-color-primary-bg)',
        }}
      >
        <span
          className="da-pill"
          style={{
            display: 'block',
            height: '100%',
            width: `${Math.round(ratio * 100)}%`,
            background: colors.menuActiveBg,
          }}
        />
      </span>
    </span>
  );
}

/**
 * Sécurité Documentaire — référentiel des niveaux de confidentialité (archives).
 *
 * Même patron que les référentiels « libellé seul » (RefLayout + édition inline + désactivation),
 * avec une colonne de rang en plus : le patron partagé n'expose que le libellé, alors qu'ici la
 * donnée la plus structurante du référentiel est justement la position dans l'ordre.
 *
 * Table de CONSULTATION (`size="middle"`, volumétrie faible).
 */
export default function SecuriteConfidentialitesPage() {
  const { message } = App.useApp();
  const [rows, setRows] = useState<ConfidentialiteArchiveRow[]>([]);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [firstLoad, setFirstLoad] = useState(true);
  const [highlightId, setHighlightId] = useState<number | null>(null);

  // Échec du chargement : le référentiel ne doit pas s'annoncer vide (cf. RefLayout).
  const [loadFailed, setLoadFailed] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await confidentialitesArchivesApi.list());
      setLoadFailed(false);
    } catch (e) {
      setLoadFailed(true);
      message.error(e instanceof Error ? e.message : 'Erreur de chargement');
    } finally {
      setLoading(false);
      setFirstLoad(false);
    }
  }, [message]);

  useEffect(() => {
    void load();
  }, [load]);

  const maxRank = useMemo(() => rows.reduce((m, r) => Math.max(m, r.rank), 0), [rows]);

  const create = async (close: () => void) => {
    setBusy(true);
    try {
      const created = await confidentialitesArchivesApi.create({ label: label.trim() });
      setLabel('');
      await load();
      // Repère visuel après création : la ligne neuve clignote le temps de l'animation
      // `da-row-flash`, sinon elle se perd dans une liste ordonnée par le serveur.
      if (created?.confidentialiteId) {
        setHighlightId(created.confidentialiteId);
        setTimeout(() => setHighlightId(null), 1400);
      }
      message.success('Élément créé');
      close();
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Création impossible');
    } finally {
      setBusy(false);
    }
  };

  const save = async (id: number, next: string) => {
    try {
      await confidentialitesArchivesApi.update(id, { label: next });
      await load();
      message.success('Modifié');
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Modification impossible');
      await load();
    }
  };

  const remove = async (id: number) => {
    try {
      await confidentialitesArchivesApi.remove(id);
      await load();
      message.success('Élément désactivé');
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Désactivation impossible');
    }
  };

  const columns: TableColumnsType<ConfidentialiteArchiveRow> = [
    {
      title: 'Rang',
      dataIndex: 'rank',
      key: 'rank',
      width: 160,
      render: (v: number) => <RankCell rank={v} max={maxRank} />,
    },
    {
      title: 'Libellé',
      dataIndex: 'label',
      key: 'label',
      render: (_, r) => (
        <EditableText value={r.label} required onSave={(v) => save(r.confidentialiteId, v)} />
      ),
    },
    {
      title: '',
      key: 'actions',
      width: 56,
      align: 'center',
      // La cible tactile de 40 px porterait la ligne à 70 px avec le padding de la densité
      // consultation : la cellule d'action rend son padding vertical au bouton.
      onCell: () => ({ style: { paddingBlock: 0, verticalAlign: 'middle' } }),
      render: (_, r) => (
        <Popconfirm
          title="Désactiver ce niveau de confidentialité ?"
          description="Il ne sera plus proposé ; les documents et les utilisateurs qui le portent le conservent, et l’ordre des autres niveaux est inchangé."
          okText="Désactiver"
          cancelText="Annuler"
          okButtonProps={{ danger: true }}
          onConfirm={() => void remove(r.confidentialiteId)}
        >
          <Button
            type="text"
            danger
            size="small"
            aria-label="Désactiver ce niveau de confidentialité"
            // Cible portée par la boîte du bouton, pas par la taille de l'icône.
            style={{ height: 40, minWidth: 40 }}
            icon={<icons.delete size={16} />}
          />
        </Popconfirm>
      ),
    },
  ];

  return (
    <RefLayout
      loadFailed={loadFailed && rows.length === 0}
      onRetry={load}
      icon="lock"
      title="Confidentialités"
      tableTitle="Confidentialités"
      formTitle="Nouveau niveau"
      table={
        // Sans état de chargement, la table affichait « Aucune donnée » le temps du premier
        // appel : squelette au premier chargement, voile de la table aux suivants.
        firstLoad && loading ? (
          <TableSkeleton rows={6} columns={3} />
        ) : rows.length === 0 ? (
          <EmptyState icon="lock" title="Aucun niveau" />
        ) : (
          <Table<ConfidentialiteArchiveRow>
            rowKey="confidentialiteId"
            // Le crayon d'édition hérite de `currentColor` : la règle descendante le passe au
            // primaire sans toucher au composant partagé.
            className="[&_.da-editable-pen]:text-[color:var(--ant-color-primary)]"
            dataSource={rows}
            columns={columns}
            loading={loading}
            size="middle"
            scroll={{ x: 'max-content' }}
            rowClassName={(r) => (r.confidentialiteId === highlightId ? 'da-row-flash' : '')}
            pagination={{
              pageSize: 10,
              showSizeChanger: true,
              pageSizeOptions: ['10', '20', '50', '100'],
              showTotal: (total) => `${total} niveau(x)`,
            }}
          />
        )
      }
      renderForm={(close) => (
        <NewItemForm>
          <NewItemField label="Libellé" required>
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              onPressEnter={() => label.trim() && void create(close)}
              placeholder="Ex. Confidentiel"
            />
          </NewItemField>
          <Button
            type="primary"
            block
            loading={busy}
            disabled={!label.trim()}
            onClick={() => void create(close)}
          >
            Ajouter
          </Button>
        </NewItemForm>
      )}
    />
  );
}
