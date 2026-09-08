'use client';

import { useCallback, useEffect, useState } from 'react';
import { App, Button, Input, Popconfirm, Space, Table, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import { NewItemField, NewItemForm, RefLayout } from '../RefLayout';
import { EditableText } from '../editable';
import { icons, type IconName } from '../../theme/icons';
import { fontSize, space } from '../../theme/tokens';
import { bulkMessage, type BulkCreateResult } from '../../lib/archives';

/**
 * Conséquence énoncée dans les confirmations (format « verbe + objet + conséquence ») : elle
 * décrit la désactivation telle qu'elle est réellement implémentée — la ligne disparaît des
 * listes de choix, jamais des enregistrements qui la citent.
 */
const EFFET_UN =
  'Le libellé reste lisible sur les enregistrements existants, mais il ne sera plus proposé dans les listes de choix.';
const EFFET_PLUSIEURS =
  'Leurs libellés restent lisibles sur les enregistrements existants, mais ils ne seront plus proposés dans les listes de choix.';

/**
 * Écran de référentiel plat à CRÉATION EN MASSE — patron des trois référentiels du cycle de vie
 * (modes de destruction, sorts finaux, motifs de prêt), qui n'ont qu'un libellé et se comportent
 * exactement de la même façon.
 *
 * Reprend le `CreateMultipleNodes` du module source : une ligne par libellé dans la zone de
 * saisie, tout est créé d'un coup et les doublons sont ignorés sans faire échouer le lot.
 * La suppression est une DÉSACTIVATION (convention V6) : les documents déjà classés gardent un
 * libellé lisible.
 */
export function BulkRefPage<T>({
  icon,
  title,
  tableTitle,
  formTitle,
  itemSingular,
  itemPlural,
  itemNoun,
  placeholder,
  idOf,
  labelOf,
  api,
  extraColumns,
  singleEntry,
}: {
  icon: IconName;
  title: string;
  /** Omis = pas de texte sous le titre (RefLayout n'en affiche alors aucun). */
  tableTitle: string;
  formTitle: string;
  /**
   * Avec démonstratif, pour la confirmation de désactivation : « Désactiver {itemSingular} ? »
   * (ex. « ce mode de destruction »).
   */
  itemSingular: string;
  itemPlural: string;
  /**
   * Nom NU, sans démonstratif, pour le message de création (« 1 {itemNoun} créé », et non
   * « 1 ce mode de destruction créé » — le « ce » ne s'accorde pas après un compte). Par défaut,
   * retombe sur `itemSingular` pour ne rien changer aux écrans qui ne le précisent pas.
   */
  itemNoun?: string;
  placeholder: string;
  idOf: (row: T) => number;
  labelOf: (row: T) => string;
  api: {
    list: () => Promise<T[]>;
    create: (labels: string[]) => Promise<BulkCreateResult>;
    update: (id: number, label: string) => Promise<unknown>;
    remove: (ids: number[]) => Promise<unknown>;
  };
  /** Colonnes supplémentaires insérées avant la colonne d'actions. */
  extraColumns?: TableColumnsType<T>;
  /**
   * Un champ simple (Entrée pour valider) au lieu de la zone multi-lignes « un par ligne ».
   * L'API accepte toujours un tableau : on lui envoie un tableau à un seul élément. Par défaut
   * `false` — ne change rien aux écrans qui n'en font pas la demande.
   */
  singleEntry?: boolean;
}) {
  const { message } = App.useApp();
  const [rows, setRows] = useState<T[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<number[]>([]);

  /**
   * En saisie unitaire, le titre fourni par les pages est au pluriel (« Nouveaux modes ») alors
   * que le formulaire ne crée qu'un élément : on le reconstruit au singulier sur le nom nu. Le
   * genre se lit sur le démonstratif d'`itemSingular` (« ce … » / « cette … »), seule marque de
   * genre dont le composant dispose.
   */
  const nomNu = itemNoun ?? itemSingular.replace(/^(cette|cet|ce)\s+/i, '');
  const formTitleAffiche = singleEntry
    ? `${
        /^cette\s/i.test(itemSingular)
          ? 'Nouvelle'
          : /^[aeiouâàéèêîïôûü]/i.test(nomNu)
            ? 'Nouvel'
            : 'Nouveau'
      } ${nomNu}`
    : formTitle;

  const load = useCallback(async () => {
    try {
      setRows(await api.list());
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Erreur de chargement');
    }
    // `api` est un objet de module (une constante), son identité ne change pas d'un rendu à
    // l'autre : le citer en dépendance est exact et ne relance rien.
  }, [api, message]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Une ligne = un libellé. Les lignes vides sont ignorées, pas refusées. */
  const parseDraft = (): string[] =>
    draft
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

  const create = async (close: () => void) => {
    const labels = parseDraft();
    if (!labels.length) return;
    setBusy(true);
    try {
      const result = await api.create(labels);
      setDraft('');
      await load();
      message.success(
        bulkMessage(result, `${itemNoun ?? itemSingular} créé`, `${itemPlural} créés`),
      );
      close();
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Création impossible');
    } finally {
      setBusy(false);
    }
  };

  const rename = async (id: number, label: string) => {
    try {
      await api.update(id, label);
      await load();
      message.success('Modifié');
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Modification impossible');
      await load();
    }
  };

  const remove = async (ids: number[]) => {
    try {
      await api.remove(ids);
      setSelected((s) => s.filter((id) => !ids.includes(id)));
      await load();
      message.success(ids.length > 1 ? `${ids.length} éléments désactivés` : 'Élément désactivé');
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Désactivation impossible');
    }
  };

  const columns: TableColumnsType<T> = [
    {
      title: 'Libellé',
      key: 'label',
      render: (_, r) => (
        <EditableText value={labelOf(r)} required onSave={(v) => rename(idOf(r), v)} />
      ),
    },
    ...(extraColumns ?? []),
    {
      title: '',
      key: 'actions',
      width: 56,
      align: 'center',
      // Épinglée à droite : le tableau défile horizontalement sur écran étroit, et sans cela il
      // fallait faire défiler toute la ligne pour atteindre l'action. Sans effet visible en
      // desktop, où le tableau tient dans sa carte et n'a donc rien à faire défiler.
      fixed: 'right',
      render: (_, r) => (
        <Popconfirm
          title={`Désactiver ${itemSingular} ?`}
          description={EFFET_UN}
          okText="Désactiver"
          okButtonProps={{ danger: true }}
          cancelText="Annuler"
          onConfirm={() => void remove([idOf(r)])}
        >
          <Button
            type="text"
            danger
            size="small"
            aria-label={`Désactiver ${itemSingular}`}
            icon={<icons.delete size={16} />}
          />
        </Popconfirm>
      ),
    },
  ];

  return (
    <RefLayout
      icon={icon}
      title={title}
      tableTitle={tableTitle}
      formTitle={formTitleAffiche}
      table={
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          {/* Emplacement RÉSERVÉ : la barre de lot n'apparaissait qu'une fois une ligne cochée
              et poussait toute la table vers le bas à chaque clic. Le conteneur garde sa
              hauteur (celle d'un bouton `small`, controlHeightSM = 28) et se contente
              d'échanger son contenu ; au repos il porte l'affordance de la sélection. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: space.sm, minHeight: 28 }}>
            {selected.length > 0 ? (
              <>
                <Typography.Text type="secondary">{selected.length} sélectionné(s)</Typography.Text>
                <Popconfirm
                  title={`Désactiver ces ${selected.length} ${itemPlural} ?`}
                  description={EFFET_PLUSIEURS}
                  okText="Désactiver"
                  okButtonProps={{ danger: true }}
                  cancelText="Annuler"
                  onConfirm={() => void remove(selected)}
                >
                  <Button danger size="small" icon={<icons.delete size={14} />}>
                    Désactiver la sélection
                  </Button>
                </Popconfirm>
              </>
            ) : (
              <Typography.Text type="secondary" style={{ fontSize: fontSize.xs }}>
                Cochez des lignes pour les désactiver en lot.
              </Typography.Text>
            )}
          </div>
          {/* Densité « consultation » (plan §5.3) : les référentiels restent en `middle`, le
              padding des cellules vient du thème. */}
          <Table<T>
            rowKey={(r) => idOf(r)}
            dataSource={rows}
            columns={columns}
            size="middle"
            scroll={{ x: 'max-content' }}
            rowSelection={{
              selectedRowKeys: selected,
              onChange: (keys) => setSelected(keys as number[]),
            }}
            pagination={{
              pageSize: 10,
              showSizeChanger: true,
              showTotal: (t) => `${t} élément(s)`,
            }}
          />
        </Space>
      }
      renderForm={(close) => (
        <NewItemForm>
          <NewItemField label={singleEntry ? 'Libellé' : 'Libellé(s) — un par ligne'} required>
            {singleEntry ? (
              <Input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onPressEnter={() => draft.trim() && void create(close)}
                placeholder={placeholder}
              />
            ) : (
              <Input.TextArea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={5}
                placeholder={placeholder}
              />
            )}
          </NewItemField>
          {/* Indication retirée en saisie unitaire (demandé) ; conservée en mode multi-lignes,
              où elle explique pourquoi certaines lignes collées peuvent ne pas apparaître. */}
          {!singleEntry && (
            <Typography.Text type="secondary" style={{ fontSize: fontSize.xs }}>
              Les libellés déjà utilisés sont ignorés — la casse et les espaces ne comptent pas.
            </Typography.Text>
          )}
          <Button
            type="primary"
            block
            loading={busy}
            disabled={parseDraft().length === 0}
            onClick={() => void create(close)}
          >
            Ajouter
          </Button>
        </NewItemForm>
      )}
    />
  );
}
