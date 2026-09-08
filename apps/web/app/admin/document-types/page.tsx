'use client';

import { useCallback, useEffect, useState } from 'react';
import { App, Button, Input, Popconfirm, Table } from 'antd';
import type { TableColumnsType } from 'antd';
import { apiJson } from '../../lib/api';
import { RefLayout, NewItemField, NewItemForm } from '../../components/RefLayout';
import { EditableText } from '../../components/editable';
import { icons } from '../../theme/icons';

/**
 * Conséquence énoncée dans la confirmation (« verbe + objet + conséquence ») : la suppression est
 * une DÉSACTIVATION (`isActive = false`). Le paramétrage et la règle de cycle de vie du type
 * restent en base — ils cessent simplement de s'appliquer, faute de type à proposer.
 */
const EFFET_SUPPRESSION =
  'Le type disparaît des listes de choix : son paramétrage (dossier, plan, confidentialité) et sa règle de cycle de vie ne s’appliqueront plus. Les documents déjà typés gardent leur libellé.';

interface DocType {
  documentTypeId: number;
  label: string;
}

export default function DocumentTypesPage() {
  const { message } = App.useApp();
  const [rows, setRows] = useState<DocType[]>([]);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [highlightId, setHighlightId] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(await apiJson<DocType[]>('/referentials/document-types'));
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Erreur de chargement');
    }
  }, [message]);

  useEffect(() => {
    void load();
  }, [load]);

  const flash = (id: number) => {
    setHighlightId(id);
    setTimeout(() => setHighlightId(null), 1400);
  };

  const create = async (close: () => void) => {
    setBusy(true);
    try {
      const created = await apiJson<DocType>('/referentials/document-types', {
        method: 'POST',
        body: JSON.stringify({ label: label.trim() }),
      });
      setLabel('');
      await load();
      if (created?.documentTypeId) flash(created.documentTypeId);
      message.success('Type de document créé');
      close();
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Création impossible');
    } finally {
      setBusy(false);
    }
  };

  const save = async (id: number, next: string) => {
    try {
      await apiJson(`/referentials/document-types/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ label: next }),
      });
      await load();
      message.success('Modifié');
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Modification impossible');
      await load();
    }
  };

  const remove = async (id: number) => {
    try {
      await apiJson(`/referentials/document-types/${id}`, { method: 'DELETE' });
      await load();
      message.success('Type de document supprimé');
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Suppression impossible');
    }
  };

  const columns: TableColumnsType<DocType> = [
    {
      title: 'Libellé',
      dataIndex: 'label',
      key: 'label',
      render: (_, r) => (
        <EditableText value={r.label} required onSave={(v) => save(r.documentTypeId, v)} />
      ),
    },
    {
      title: '',
      key: 'actions',
      width: 56,
      align: 'center',
      render: (_, r) => (
        <Popconfirm
          title="Supprimer ce type de document ?"
          description={EFFET_SUPPRESSION}
          okText="Supprimer"
          okButtonProps={{ danger: true }}
          cancelText="Annuler"
          onConfirm={() => void remove(r.documentTypeId)}
        >
          <Button
            type="text"
            danger
            size="small"
            aria-label="Supprimer ce type de document"
            icon={<icons.delete size={16} />}
          />
        </Popconfirm>
      ),
    },
  ];

  return (
    <RefLayout
      icon="documentType"
      title="Types de document"
      exportPath="/referentials/document-types/export"
      exportFilename="types-document"
      // Titre de carte distinct du titre de page : les répéter à l'identique ne renseignait rien.
      tableTitle="Types enregistrés"
      formTitle="Nouveau type de document"
      table={
        <Table<DocType>
          rowKey="documentTypeId"
          dataSource={rows}
          columns={columns}
          size="middle"
          scroll={{ x: 'max-content' }}
          rowClassName={(r) => (r.documentTypeId === highlightId ? 'da-row-flash' : '')}
          pagination={{
            pageSize: 10,
            showSizeChanger: true,
            pageSizeOptions: ['10', '20', '50', '100'],
            showTotal: (total) => `${total} élément(s)`,
          }}
        />
      }
      renderForm={(close) => (
        <NewItemForm>
          <NewItemField label="Libellé" required>
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              onPressEnter={() => label.trim() && void create(close)}
              placeholder="Ex. Facture"
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
