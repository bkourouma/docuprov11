'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Alert, Button, Checkbox, Input, Select, Skeleton } from 'antd';
import { useEditorState, type Editor } from '@tiptap/react';
import { icons } from '../../theme/icons';
import {
  GED_DRAFT_INSTRUCTION_MAX_CHARS,
  RedactionApiError,
  acquireInsertLock,
  buildDraftRequest,
  canInsertDraft,
  defaultDraftTemplateId,
  describeDraftError,
  isInstructionValid,
  redactionApi,
  resetInsertLock,
  selectionRange,
  settleInsertLock,
  skeletonTemplates,
  type GedDraftResponse,
  type GedDraftTemplatesResponse,
} from '../../lib/redaction';
import styles from './drafting.module.css';

type Proposal = Extract<GedDraftResponse, { disabled: false }>;

interface Props {
  editor: Editor;
  documentId: number;
  readOnly: boolean;
  /** Le bouton « Fermer » est porté par l'en-tête du panneau (EditorShell) ; conservé pour le contrat. */
  onClose?: () => void;
}

const READ_ONLY_HELP = 'Ce document est en lecture seule : l’insertion est désactivée.';

function errorText(e: unknown): string {
  if (e instanceof RedactionApiError) {
    const base = describeDraftError(e.status, e.message);
    return e.status === 429 && e.retryAfterSeconds ? `${base} (environ ${e.retryAfterSeconds} s)` : base;
  }
  return describeDraftError(0, '');
}

/** Panneau latéral « Rédiger avec l'IA ». Le brouillon est une proposition : jamais inséré sans clic. */
export function DraftingPanel({ editor, documentId, readOnly }: Props) {
  const ids = useId();
  const [catalog, setCatalog] = useState<GedDraftTemplatesResponse | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [templateId, setTemplateId] = useState<string | undefined>(undefined);
  const [instruction, setInstruction] = useState('');
  const [useContext, setUseContext] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [disabledMessage, setDisabledMessage] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [skeletonBusy, setSkeletonBusy] = useState<string | null>(null);
  const lastRequest = useRef<ReturnType<typeof buildDraftRequest> | null>(null);
  const seq = useRef(0);
  // Verrou posé de façon synchrone : un double clic sur « Insérer » n'insère qu'une fois.
  const insertLock = useRef(false);
  const [inserted, setInserted] = useState(false);

  const selection = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      const { from, to, empty } = e.state.selection;
      return { from, to, empty };
    },
  });
  const range = selectionRange(selection);

  useEffect(() => {
    let alive = true;
    redactionApi
      .listTemplates()
      .then((c) => {
        if (!alive) return;
        setCatalog(c);
        setTemplateId((cur) => cur ?? defaultDraftTemplateId(c.templates));
      })
      .catch((e) => alive && setCatalogError(errorText(e)));
    return () => {
      alive = false;
    };
  }, []);

  const aiOff = catalog ? !catalog.aiEnabled || disabledMessage !== null : false;

  const run = useCallback(
    async (req: ReturnType<typeof buildDraftRequest>) => {
      const mine = ++seq.current;
      setBusy(true);
      setError(null);
      setStatus('Génération du brouillon en cours…');
      lastRequest.current = req;
      resetInsertLock(insertLock);
      setInserted(false);
      try {
        const res = await redactionApi.draft(req);
        if (mine !== seq.current) return;
        if (res.disabled) {
          setDisabledMessage(res.message);
          setProposal(null);
          setStatus('L’IA est désactivée par l’administrateur.');
        } else {
          setProposal(res);
          setStatus('Proposition de l’IA prête. Elle n’est pas insérée dans le document.');
        }
      } catch (e) {
        if (mine !== seq.current) return;
        // L'ancienne proposition et la consigne saisie sont conservées.
        const msg = errorText(e);
        setError(msg);
        setStatus(msg);
      } finally {
        if (mine === seq.current) setBusy(false);
      }
    },
    [],
  );

  const generate = () => {
    if (!templateId || !isInstructionValid(instruction)) return;
    void run(buildDraftRequest({ templateId, instruction, useContext, documentId }));
  };

  const regenerate = () => {
    if (lastRequest.current) void run(lastRequest.current);
  };

  const reject = () => {
    seq.current++;
    resetInsertLock(insertLock);
    setInserted(false);
    setProposal(null);
    setBusy(false);
    setStatus('Proposition rejetée. Le document n’a pas été modifié.');
  };

  const insertHtml = (html: string, replace: boolean) => {
    if (readOnly || !canInsertDraft(html)) return false;
    const r = replace ? selectionRange(editor.state.selection) : null;
    if (replace && !r) return false;
    const ok = r ? editor.chain().focus().insertContentAt(r, html).run() : editor.chain().focus().insertContent(html).run();
    return ok;
  };

  const insertProposal = (replace: boolean) => {
    if (!proposal || !acquireInsertLock(insertLock)) return;
    const ok = insertHtml(proposal.draftHtml, replace);
    settleInsertLock(insertLock, ok);
    if (ok) setInserted(true);
    setStatus(
      ok
        ? replace
          ? 'La sélection a été remplacée par la proposition.'
          : 'La proposition a été insérée au curseur.'
        : 'L’insertion a échoué : le document n’a pas été modifié.',
    );
  };

  const insertSkeleton = async (id: string) => {
    setSkeletonBusy(id);
    setError(null);
    try {
      const detail = await redactionApi.getTemplate(id);
      const ok = insertHtml(detail.skeletonHtml, false);
      setStatus(ok ? `Le modèle « ${detail.label} » a été inséré au curseur.` : 'L’insertion a échoué : le document n’a pas été modifié.');
    } catch (e) {
      const msg = errorText(e);
      setError(msg);
      setStatus(msg);
    } finally {
      setSkeletonBusy(null);
    }
  };

  const live = (
    <div className={styles.srOnly} role="status" aria-live="polite" aria-atomic="true">
      {status}
    </div>
  );

  if (catalogError) {
    return (
      <div className={styles.root}>
        <Alert type="error" showIcon role="alert" message={catalogError} />
        {live}
      </div>
    );
  }

  if (!catalog) {
    return (
      <div className={styles.root} aria-busy="true" aria-label="Chargement des modèles">
        <Skeleton active paragraph={{ rows: 5 }} />
      </div>
    );
  }

  if (aiOff) {
    const skeletons = skeletonTemplates(catalog.templates);
    return (
      <div className={styles.root}>
        <Alert
          type="info"
          showIcon
          message="L’IA est désactivée par l’administrateur."
          description={disabledMessage ?? catalog.aiMessage ?? 'La génération de brouillons n’est pas disponible. Vous pouvez néanmoins insérer le squelette d’un modèle.'}
        />
        {readOnly && <span className={styles.hint}>{READ_ONLY_HELP}</span>}
        {error && <Alert type="error" showIcon role="alert" message={error} />}
        {skeletons.length === 0 ? (
          <span className={styles.hint}>Aucun modèle à insérer.</span>
        ) : (
          <ul className={styles.skeletonList} aria-label="Modèles à insérer">
            {skeletons.map((t) => (
              <li key={t.id} className={styles.skeletonItem}>
                <strong>{t.label}</strong>
                <span className={styles.hint}>{t.description}</span>
                <div>
                  <Button
                    size="small"
                    disabled={readOnly}
                    loading={skeletonBusy === t.id}
                    aria-label={`Insérer le modèle vide « ${t.label} » au curseur`}
                    onClick={() => void insertSkeleton(t.id)}
                  >
                    Insérer le modèle vide
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {live}
      </div>
    );
  }

  const instructionOk = isInstructionValid(instruction);
  const draftOk = proposal ? canInsertDraft(proposal.draftHtml) : false;
  const insertDisabled = readOnly || !draftOk || inserted;
  const SparkleIcon = icons.sparkle;

  return (
    <div className={styles.root} aria-busy={busy}>
      <div className={styles.field}>
        <label className={styles.label} htmlFor={`${ids}-tpl`}>
          Modèle
        </label>
        <Select
          id={`${ids}-tpl`}
          value={templateId}
          onChange={setTemplateId}
          options={catalog.templates.map((t) => ({ value: t.id, label: t.label }))}
          disabled={busy}
        />
        {templateId && (
          <span className={styles.hint}>{catalog.templates.find((t) => t.id === templateId)?.description}</span>
        )}
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor={`${ids}-instr`}>
          Consigne
        </label>
        <Input.TextArea
          id={`${ids}-instr`}
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          maxLength={GED_DRAFT_INSTRUCTION_MAX_CHARS}
          rows={5}
          placeholder="Ex. : Rédige un compte rendu de la réunion du 12 mars, ton formel."
          aria-describedby={`${ids}-count`}
        />
        <span
          id={`${ids}-count`}
          className={`${styles.counter} ${instruction.length >= GED_DRAFT_INSTRUCTION_MAX_CHARS ? styles.counterLimit : ''}`}
        >
          {instruction.length} / {GED_DRAFT_INSTRUCTION_MAX_CHARS}
        </span>
      </div>

      <Checkbox checked={useContext} onChange={(e) => setUseContext(e.target.checked)} disabled={busy}>
        Utiliser ce document comme contexte
      </Checkbox>

      <div className={styles.actions}>
        <Button
          type="primary"
          icon={<SparkleIcon size={16} />}
          loading={busy}
          disabled={!templateId || !instructionOk}
          onClick={generate}
        >
          Générer un brouillon
        </Button>
      </div>
      {!instructionOk && instruction.length > 0 && (
        <span className={styles.hint}>La consigne doit contenir au moins 3 caractères.</span>
      )}

      {error && <Alert type="error" showIcon role="alert" message={error} />}

      {proposal && (
        <section className={styles.proposal} aria-labelledby={`${ids}-prop`}>
          <h3 id={`${ids}-prop`} className={styles.proposalTitle}>
            Proposition de l’IA — non insérée
          </h3>
          <span className={styles.hint}>{proposal.notice}</span>
          <pre className={styles.proposalText} tabIndex={0} aria-label="Texte de la proposition">
            {proposal.draftText}
          </pre>
          {readOnly && <span className={styles.hint}>{READ_ONLY_HELP}</span>}
          {inserted && <span className={styles.hint}>Proposition déjà insérée dans le document.</span>}
          {!draftOk && !readOnly && (
            <span className={styles.hint}>Cette proposition est vide ou trop longue pour être insérée.</span>
          )}
          <div className={styles.actions}>
            <Button type="primary" disabled={insertDisabled} onClick={() => insertProposal(false)}>
              Insérer
            </Button>
            <Button
              disabled={insertDisabled || !range}
              title={!range ? 'Sélectionnez du texte dans le document pour le remplacer.' : undefined}
              onClick={() => insertProposal(true)}
            >
              Remplacer la sélection
            </Button>
            <Button onClick={reject}>Rejeter</Button>
            <Button disabled={busy || !lastRequest.current} onClick={regenerate}>
              Régénérer
            </Button>
          </div>
        </section>
      )}
      {live}
    </div>
  );
}
