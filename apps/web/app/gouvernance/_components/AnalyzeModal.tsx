'use client';

import { useEffect, useState } from 'react';
import { Alert, Button, Input, Modal, Popconfirm } from 'antd';
import { GED_GOVERNANCE_ANALYZE_MAX_DOCUMENTS, type GovernanceAnalyzeResponse } from '@archivage/types';
import { GovernanceApiError, errorMessage, governanceApi } from '../gouvernance-api';

/**
 * Analyse un ou plusieurs documents par leur numéro. Retourne `{ ids }` ou `{ error }` : la
 * saisie est validée côté client (entiers strictement positifs, doublons retirés, plafond de l'API).
 */
export function parseDocumentIds(raw: string): { ids: number[] } | { error: string } {
  const tokens = raw.split(/[\s,;]+/).filter(Boolean);
  if (tokens.length === 0) return { error: 'Saisissez au moins un numéro de document.' };
  const ids: number[] = [];
  for (const t of tokens) {
    if (!/^\d{1,10}$/.test(t) || Number(t) < 1 || Number(t) > 2_147_483_647) {
      return { error: `« ${t.slice(0, 20)} » n’est pas un numéro de document valide.` };
    }
    const n = Number(t);
    if (!ids.includes(n)) ids.push(n);
  }
  if (ids.length > GED_GOVERNANCE_ANALYZE_MAX_DOCUMENTS) {
    return { error: `Au plus ${GED_GOVERNANCE_ANALYZE_MAX_DOCUMENTS} documents à la fois.` };
  }
  return { ids };
}

/** Texte de résultat d'une demande d'analyse. */
function resultText(r: GovernanceAnalyzeResponse): string {
  const parts = [`${r.queued} document(s) mis en file`];
  if (r.ignored > 0) parts.push(`${r.ignored} ignoré(s)`);
  return `${parts.join(', ')}.`;
}

export function AnalyzeModal({
  open,
  isAdmin,
  onClose,
  onQueued,
}: {
  open: boolean;
  isAdmin: boolean;
  onClose: () => void;
  /** Appelé après une demande acceptée (la liste sera actualisée par la page). */
  onQueued: () => void;
}) {
  const [text, setText] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<GovernanceAnalyzeResponse | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setText('');
      setFieldError(null);
      setResult(null);
      setFailure(null);
    }
  }, [open]);

  const run = async (body: Parameters<typeof governanceApi.analyze>[0]) => {
    setBusy(true);
    setFailure(null);
    setResult(null);
    try {
      const r = await governanceApi.analyze(body);
      setResult(r);
      onQueued();
    } catch (e) {
      setFailure(errorMessage(e instanceof GovernanceApiError ? e : new GovernanceApiError('generic'), 'analyze'));
    } finally {
      setBusy(false);
    }
  };

  const submit = () => {
    const parsed = parseDocumentIds(text);
    if ('error' in parsed) {
      setFieldError(parsed.error);
      return;
    }
    setFieldError(null);
    const [first] = parsed.ids;
    void run(parsed.ids.length === 1 && first !== undefined ? { documentId: first } : { documentIds: parsed.ids });
  };

  return (
    <Modal
      open={open}
      title="Analyser un document"
      onCancel={onClose}
      destroyOnHidden
      footer={[
        <Button key="close" onClick={onClose}>
          Fermer
        </Button>,
        isAdmin && (
          <Popconfirm
            key="all"
            title="Analyser tout le fonds ?"
            description="Tous les documents archivés seront mis en file d’analyse. Cela peut prendre du temps."
            okText="Lancer l’analyse"
            cancelText="Annuler"
            onConfirm={() => void run({ all: true })}
          >
            <Button disabled={busy}>Analyser tout le fonds</Button>
          </Popconfirm>
        ),
        <Button key="go" type="primary" loading={busy} onClick={submit}>
          Lancer l’analyse
        </Button>,
      ]}
    >
      <label htmlFor="gov-doc-ids" style={{ display: 'block', marginBottom: 8, fontWeight: 600 }}>
        Numéro(s) de document
      </label>
      <Input.TextArea
        id="gov-doc-ids"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setFieldError(null);
        }}
        autoSize={{ minRows: 2, maxRows: 6 }}
        status={fieldError ? 'error' : undefined}
        aria-invalid={fieldError ? true : undefined}
        aria-describedby="gov-doc-ids-help"
        placeholder="Par exemple : 1204 ou 1204, 1205 1310"
      />
      <div
        id="gov-doc-ids-help"
        role={fieldError ? 'alert' : undefined}
        style={{
          marginTop: 6,
          fontSize: 12,
          color: fieldError ? 'var(--ant-color-error)' : 'var(--ant-color-text-secondary)',
        }}
      >
        {fieldError ??
          `Un numéro, ou plusieurs séparés par des virgules ou des espaces (${GED_GOVERNANCE_ANALYZE_MAX_DOCUMENTS} au plus).`}
      </div>

      <div aria-live="polite" style={{ marginTop: 16 }}>
        {failure && <Alert type="error" showIcon message={failure} />}
        {result && (
          <Alert
            type="success"
            showIcon
            message={resultText(result)}
            description={
              <>
                L’analyse s’exécute en arrière-plan : les propositions apparaîtront dans la liste dans quelques instants.
                {result.message && <div style={{ marginTop: 6 }}>{result.message}</div>}
              </>
            }
          />
        )}
      </div>
    </Modal>
  );
}
