'use client';

import { useEffect, useRef, useState } from 'react';
import { Button, Input, Modal } from 'antd';
import { useRouter } from 'next/navigation';
import type { WfTemplateSummary } from '@archivage/types';
import { workflowsApi } from '../../../../lib/workflows-api';
import {
  authoringErrorMessage,
  editorPath,
  filterTemplates,
  templateTagsLabel,
  usableTemplates,
} from '../../../_lib/authoring-logic';

/** Liste des modèles (rendu seul : testable sans réseau). Tout est affiché en texte brut. */
export function TemplatePickerView({
  templates,
  query,
  busyKey,
  onQuery,
  onPick,
}: {
  templates: WfTemplateSummary[];
  query: string;
  busyKey: string | null;
  onQuery: (q: string) => void;
  onPick: (key: string) => void;
}) {
  const shown = filterTemplates(templates, query);
  return (
    <div className="wfa-form" aria-busy={busyKey !== null}>
      {templates.length > 6 && (
        <div className="wfa-field">
          <label htmlFor="wfa-tpl-search" className="wfa-label">
            Rechercher un modèle
          </label>
          <Input id="wfa-tpl-search" allowClear value={query} onChange={(e) => onQuery(e.target.value)} placeholder="Nom, description ou étiquette" />
        </div>
      )}
      {shown.length === 0 ? (
        <p className="wfa-hint">Aucun modèle ne correspond à cette recherche.</p>
      ) : (
        <ul className="wfa-templates" aria-label="Modèles de workflow">
          {shown.map((t) => {
            const tags = templateTagsLabel(t.tags);
            const busy = busyKey === t.key;
            return (
              <li key={t.key} className="wfa-template">
                <h3 className="wfa-template-name">{t.name}</h3>
                {t.description && <p className="wfa-template-desc">{t.description}</p>}
                <p className="wfa-hint">
                  {t.agentKey ? <span className="wfa-chip">Contient une étape agent</span> : null}
                  {tags ? <span className="wfa-tags">Étiquettes : {tags}</span> : null}
                </p>
                <Button
                  loading={busy}
                  disabled={busyKey !== null}
                  onClick={() => onPick(t.key)}
                  aria-label={`Créer un brouillon à partir du modèle ${t.name}`}
                >
                  {busy ? 'Création en cours…' : 'Utiliser ce modèle'}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Dialogue de choix d'un modèle : instancie un BROUILLON (jamais publié) puis ouvre l'éditeur. */
export function TemplatePickerModal({
  open,
  templates,
  onClose,
}: {
  open: boolean;
  templates: WfTemplateSummary[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  const pick = async (key: string) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusyKey(key);
    setError(null);
    try {
      const res = await workflowsApi.instantiateTemplate(key);
      const path = editorPath(res?.definitionId);
      if (!path) {
        setError('La réponse du serveur est incomplète : consultez la liste des workflows.');
        return;
      }
      router.push(path);
    } catch (e) {
      setError(authoringErrorMessage(e));
    } finally {
      busyRef.current = false;
      setBusyKey(null);
    }
  };

  return (
    <Modal
      open={open}
      className="wfa-modal"
      title="Créer un brouillon depuis un modèle"
      onCancel={() => {
        if (busyRef.current) return;
        setError(null);
        onClose();
      }}
      footer={<Button onClick={() => { if (!busyRef.current) { setError(null); onClose(); } }}>Fermer</Button>}
      maskClosable={false}
      destroyOnHidden
      afterOpenChange={(isOpen) => {
        if (isOpen) bodyRef.current?.querySelector<HTMLElement>('input, button')?.focus();
      }}
    >
      <div ref={bodyRef}>
        <p className="wfa-notice">Le modèle crée un brouillon que vous pouvez modifier : rien n’est publié.</p>
        <div role="alert" className="wfa-alert-zone">
          {error && <p className="wfa-error">{error}</p>}
        </div>
        <TemplatePickerView templates={templates} query={query} busyKey={busyKey} onQuery={setQuery} onPick={(k) => void pick(k)} />
      </div>
    </Modal>
  );
}

/**
 * Bouton « Depuis un modèle » : se masque (sans erreur visible) tant que l'API des modèles (W6) n'est pas livrée,
 * si elle répond « refusé » ou en erreur, ou si la liste est vide.
 */
export function TemplateButton() {
  const [templates, setTemplates] = useState<WfTemplateSummary[] | null>(null);
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let alive = true;
    workflowsApi
      .listTemplates()
      .then((list) => {
        if (alive) setTemplates(usableTemplates(list));
      })
      .catch(() => {
        if (alive) setTemplates(null);
      });
    return () => {
      alive = false;
    };
  }, []);

  if (!templates || templates.length === 0) return null;
  return (
    <>
      <Button ref={btnRef} onClick={() => setOpen(true)}>
        Depuis un modèle
      </Button>
      <TemplatePickerModal
        open={open}
        templates={templates}
        onClose={() => {
          setOpen(false);
          window.setTimeout(() => btnRef.current?.focus(), 0);
        }}
      />
    </>
  );
}
