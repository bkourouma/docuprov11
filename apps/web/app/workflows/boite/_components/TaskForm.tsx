'use client';

import { useEffect, useId, useState, type ReactNode } from 'react';
import { Alert, Button, Checkbox, Input, Radio, Select } from 'antd';
import { directoryApi } from '../../../lib/workflows-api';
import type { WfInboxEntry } from '../../../lib/workflows-api';
import { icons, iconDefaults } from '../../../theme/icons';
import {
  buildAgentResult,
  buildApprovalResult,
  buildAssignmentResult,
  buildChecklistResult,
  buildDecisionResult,
  buildFormResult,
  buildFreeFormResult,
  buildGenerationResult,
  initialGenerationContent,
  prettyJson,
  proposalAsResult,
  readChecklistItems,
  readChoices,
  readFields,
  type BuildResult,
} from '../../_lib/inbox-logic';

const { TextArea } = Input;

export interface TaskFormProps {
  entry: WfInboxEntry;
  /** Configuration de l'étape (`graph.steps[].config`) ; null sans droit de conception => formulaire de repli. */
  config: unknown;
  /** `task.input` de l'instance (suggestion de génération). */
  taskInput: unknown;
  submitting: boolean;
  /** Une autre action est en cours : tout est bloqué (pas de double envoi). */
  disabled: boolean;
  /** Erreur renvoyée par le serveur (422, 409…) : la saisie reste ouverte. */
  serverError: string | null;
  submitLabel: string;
  onSubmit: (result: Record<string, unknown>) => void;
  onCancel: () => void;
}

/** Contexte commun passé aux formulaires par type. */
interface FormCtx {
  entry: WfInboxEntry;
  config: unknown;
  taskInput: unknown;
  /** Identifiant du bloc d'erreurs, relié aux champs par `aria-describedby`. */
  errorsId: string;
  invalid: boolean;
  /** Valeurs proposées par l'agent (validation d'agent) pour préremplir. */
  prefill: Record<string, unknown> | null;
  submit: (r: BuildResult) => void;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function Field({ id, label, hint, children }: { id: string; label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="wf-field wfb-field">
      <label htmlFor={id}>{label}</label>
      {children}
      {hint && <span className="wf-muted">{hint}</span>}
    </div>
  );
}

/** Enveloppe commune : erreurs de validation (liées aux champs), erreur serveur, boutons. */
function FormShell({
  errors,
  errorsId,
  serverError,
  submitting,
  disabled,
  submitLabel,
  onSubmit,
  onCancel,
  children,
}: {
  errors: string[];
  errorsId: string;
  serverError: string | null;
  submitting: boolean;
  disabled: boolean;
  submitLabel: string;
  onSubmit: () => void;
  onCancel: () => void;
  children: ReactNode;
}) {
  return (
    <form
      className="wfb-form"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      {children}
      <div id={errorsId} role="alert" aria-live="assertive">
        {errors.length > 0 && (
          <Alert
            type="error"
            showIcon
            message={errors.length === 1 ? 'Une information est à corriger' : 'Des informations sont à corriger'}
            description={
              <ul className="wfb-errors">
                {errors.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            }
          />
        )}
        {serverError && <Alert type="error" showIcon message={serverError} />}
      </div>
      <div className="wfb-form-actions">
        <Button
          type="primary"
          htmlType="submit"
          icon={<icons.check {...iconDefaults} />}
          loading={submitting}
          disabled={disabled && !submitting}
        >
          {submitLabel}
        </Button>
        <Button htmlType="button" onClick={onCancel} disabled={disabled}>
          Annuler
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Formulaires par type de tâche
// ---------------------------------------------------------------------------

/** 0 — formulaire : champs déclarés, à défaut lignes clé/valeur libres. */
function FormTypeForm({ ctx, shell }: { ctx: FormCtx; shell: (body: ReactNode, onSubmit: () => void) => ReactNode }) {
  const uid = useId();
  const fields = readFields(ctx.config);
  const proposed = isRecord(ctx.prefill?.values) ? ctx.prefill.values : {};
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(Object.entries(proposed).map(([k, v]) => [k, typeof v === 'string' ? v : v == null ? '' : String(v)])),
  );
  const [rows, setRows] = useState<{ key: string; value: string }[]>(() => {
    const init = Object.entries(values).map(([key, value]) => ({ key, value }));
    return init.length > 0 ? init : [{ key: '', value: '' }];
  });
  const described = ctx.invalid ? ctx.errorsId : undefined;

  if (fields.length > 0) {
    return shell(
      fields.map((f, i) => (
        <Field key={f.key} id={`${uid}-f${i}`} label={f.required ? `${f.label} (obligatoire)` : f.label}>
          <Input
            id={`${uid}-f${i}`}
            value={values[f.key] ?? ''}
            onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
            aria-required={f.required}
            aria-invalid={ctx.invalid && f.required && !(values[f.key] ?? '').trim() ? true : undefined}
            aria-describedby={described}
          />
        </Field>
      )),
      () => ctx.submit(buildFormResult(fields, values)),
    );
  }
  return shell(
    <>
      <p className="wf-muted">
        Les champs de cette étape ne sont pas connus de cet écran : saisissez les valeurs sous forme de lignes « nom /
        valeur ».
      </p>
      {rows.map((row, i) => (
        <div className="wfb-row" key={i}>
          <Field id={`${uid}-k${i}`} label={`Nom du champ ${i + 1}`}>
            <Input
              id={`${uid}-k${i}`}
              value={row.key}
              onChange={(e) => setRows((r) => r.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))}
              aria-describedby={described}
            />
          </Field>
          <Field id={`${uid}-v${i}`} label={`Valeur ${i + 1}`}>
            <Input
              id={`${uid}-v${i}`}
              value={row.value}
              onChange={(e) => setRows((r) => r.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
              aria-describedby={described}
            />
          </Field>
          {rows.length > 1 && (
            <Button
              htmlType="button"
              aria-label={`Retirer la ligne ${i + 1}`}
              icon={<icons.delete {...iconDefaults} />}
              onClick={() => setRows((r) => r.filter((_, j) => j !== i))}
            />
          )}
        </div>
      ))}
      <Button
        htmlType="button"
        icon={<icons.add {...iconDefaults} />}
        onClick={() => setRows((r) => [...r, { key: '', value: '' }])}
      >
        Ajouter une ligne
      </Button>
    </>,
    () => ctx.submit(buildFreeFormResult(rows)),
  );
}

/** 1 — génération : contenu rédigé (prérempli par la proposition ou la suggestion) + document facultatif. */
function GenerationForm({ ctx, shell }: { ctx: FormCtx; shell: (body: ReactNode, onSubmit: () => void) => ReactNode }) {
  const uid = useId();
  const [content, setContent] = useState(() => initialGenerationContent(ctx.entry, ctx.taskInput));
  const [documentId, setDocumentId] = useState(() => {
    const d = ctx.prefill?.documentId;
    return typeof d === 'number' || typeof d === 'string' ? String(d) : '';
  });
  const described = ctx.invalid ? ctx.errorsId : undefined;
  return shell(
    <>
      <Field id={`${uid}-c`} label="Contenu rédigé (obligatoire)">
        <TextArea
          id={`${uid}-c`}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          autoSize={{ minRows: 6, maxRows: 18 }}
          aria-required
          aria-describedby={described}
        />
      </Field>
      <Field id={`${uid}-d`} label="Numéro du document lié (facultatif)" hint="Entier supérieur à 0.">
        <Input
          id={`${uid}-d`}
          value={documentId}
          inputMode="numeric"
          onChange={(e) => setDocumentId(e.target.value)}
          aria-describedby={described}
        />
      </Field>
    </>,
    () => ctx.submit(buildGenerationResult(content, documentId)),
  );
}

/** 2 — checklist : cases depuis `config.items`, à défaut saisie libre des éléments cochés. */
function ChecklistForm({ ctx, shell }: { ctx: FormCtx; shell: (body: ReactNode, onSubmit: () => void) => ReactNode }) {
  const uid = useId();
  const items = readChecklistItems(ctx.config);
  const [checked, setChecked] = useState<string[]>(() =>
    Array.isArray(ctx.prefill?.checked) ? ctx.prefill.checked.filter((k): k is string => typeof k === 'string') : [],
  );
  const described = ctx.invalid ? ctx.errorsId : undefined;

  if (items.length > 0) {
    return shell(
      <fieldset className="wfb-fieldset" aria-describedby={described}>
        <legend>Éléments à cocher</legend>
        {items.map((it, i) => (
          <Checkbox
            key={it.key}
            id={`${uid}-i${i}`}
            checked={checked.includes(it.key)}
            onChange={(e) =>
              setChecked((c) => (e.target.checked ? [...c.filter((k) => k !== it.key), it.key] : c.filter((k) => k !== it.key)))
            }
          >
            {it.required ? `${it.label} (obligatoire)` : it.label}
          </Checkbox>
        ))}
      </fieldset>,
      () => ctx.submit(buildChecklistResult(items, checked)),
    );
  }
  return shell(
    <Field
      id={`${uid}-t`}
      label="Éléments cochés"
      hint="Les éléments de cette étape ne sont pas connus de cet écran : saisissez chaque élément coché puis validez avec Entrée."
    >
      <Select
        id={`${uid}-t`}
        mode="tags"
        value={checked}
        onChange={(v: string[]) => setChecked(v)}
        tokenSeparators={[',']}
        open={false}
        suffixIcon={null}
        aria-describedby={described}
        style={{ width: '100%' }}
      />
    </Field>,
    () => ctx.submit(buildChecklistResult([], checked)),
  );
}

type AssignKind = 'userGroupId' | 'groupId' | 'roleId';

/** 3 — affectation : utilisateur, groupe ou rôle (annuaire si accessible, sinon identifiant numérique). */
function AssignmentForm({ ctx, shell }: { ctx: FormCtx; shell: (body: ReactNode, onSubmit: () => void) => ReactNode }) {
  const uid = useId();
  const [kind, setKind] = useState<AssignKind>('userGroupId');
  const [idText, setIdText] = useState('');
  // Annuaire : undefined = pas encore tenté ; null = inaccessible (403/404) => saisie numérique.
  const [directory, setDirectory] = useState<Record<'groupId' | 'roleId', { value: number; label: string }[] | null | undefined>>({
    groupId: undefined,
    roleId: undefined,
  });
  const described = ctx.invalid ? ctx.errorsId : undefined;

  useEffect(() => {
    if (kind === 'userGroupId' || directory[kind] !== undefined) return;
    let alive = true;
    const load = async () => {
      try {
        if (kind === 'groupId') {
          const list = await directoryApi.groups();
          return list ? list.map((g) => ({ value: g.groupId, label: g.name })) : null;
        }
        const list = await directoryApi.roles();
        return list ? list.map((r) => ({ value: r.roleId, label: r.name })) : null;
      } catch {
        return null; // annuaire indisponible : repli sur la saisie numérique
      }
    };
    void load().then((options) => {
      if (alive) setDirectory((d) => ({ ...d, [kind]: options }));
    });
    return () => {
      alive = false;
    };
  }, [kind, directory]);

  const options = kind === 'userGroupId' ? null : directory[kind];
  const labels: Record<AssignKind, string> = { userGroupId: 'Utilisateur', groupId: 'Groupe', roleId: 'Rôle' };

  return shell(
    <>
      <fieldset className="wfb-fieldset">
        <legend>Bénéficiaire</legend>
        <Radio.Group
          value={kind}
          onChange={(e) => {
            setKind(e.target.value as AssignKind);
            setIdText('');
          }}
          options={(Object.keys(labels) as AssignKind[]).map((k) => ({ value: k, label: labels[k] }))}
        />
      </fieldset>
      {kind !== 'userGroupId' && directory[kind] === undefined ? (
        <p className="wf-muted" role="status">
          Chargement de la liste…
        </p>
      ) : options ? (
        <Field id={`${uid}-s`} label={`${labels[kind]} (obligatoire)`}>
          <Select
            id={`${uid}-s`}
            showSearch
            optionFilterProp="label"
            options={options}
            value={idText === '' ? undefined : Number(idText)}
            onChange={(v: number) => setIdText(String(v))}
            placeholder="Choisir…"
            aria-describedby={described}
            style={{ width: '100%' }}
          />
        </Field>
      ) : (
        <Field
          id={`${uid}-n`}
          label={`Numéro ${kind === 'userGroupId' ? 'd’utilisateur' : kind === 'groupId' ? 'de groupe' : 'de rôle'} (obligatoire)`}
          hint="La liste n’est pas accessible depuis cet écran : saisissez le numéro fourni par votre administrateur."
        >
          <Input
            id={`${uid}-n`}
            value={idText}
            inputMode="numeric"
            onChange={(e) => setIdText(e.target.value)}
            aria-describedby={described}
          />
        </Field>
      )}
    </>,
    () => ctx.submit(buildAssignmentResult({ [kind]: idText })),
  );
}

/** 4 — validation : approuver ou non (clôture avec approved=false), commentaire facultatif. */
function ApprovalForm({ ctx, shell }: { ctx: FormCtx; shell: (body: ReactNode, onSubmit: () => void) => ReactNode }) {
  const uid = useId();
  const [approved, setApproved] = useState<boolean | null>(() =>
    typeof ctx.prefill?.approved === 'boolean' ? ctx.prefill.approved : null,
  );
  const [comment, setComment] = useState(() => (typeof ctx.prefill?.comment === 'string' ? ctx.prefill.comment : ''));
  const described = ctx.invalid ? ctx.errorsId : undefined;
  return shell(
    <>
      <fieldset className="wfb-fieldset" aria-describedby={described}>
        <legend>Votre décision (obligatoire)</legend>
        <Radio.Group
          value={approved}
          onChange={(e) => setApproved(e.target.value as boolean)}
          options={[
            { value: true, label: 'Approuver' },
            { value: false, label: 'Ne pas approuver' },
          ]}
        />
      </fieldset>
      <p className="wf-muted">
        « Ne pas approuver » termine la tâche avec un avis négatif ; « Rejeter » refuse la tâche et n’emprunte que les
        voies de correction du workflow.
      </p>
      <Field id={`${uid}-c`} label="Commentaire (facultatif, 4 000 caractères au plus)">
        <TextArea
          id={`${uid}-c`}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          autoSize={{ minRows: 3, maxRows: 10 }}
          showCount
          aria-describedby={described}
        />
      </Field>
    </>,
    () => ctx.submit(buildApprovalResult(approved, comment)),
  );
}

/** 5 — décision manuelle : choix déclarés (radio), sinon texte libre. */
function DecisionForm({ ctx, shell }: { ctx: FormCtx; shell: (body: ReactNode, onSubmit: () => void) => ReactNode }) {
  const uid = useId();
  const choices = readChoices(ctx.config);
  const [choice, setChoice] = useState(() => (typeof ctx.prefill?.choice === 'string' ? ctx.prefill.choice : ''));
  const described = ctx.invalid ? ctx.errorsId : undefined;
  return shell(
    choices.length > 0 ? (
      <fieldset className="wfb-fieldset" aria-describedby={described}>
        <legend>Décision (obligatoire)</legend>
        <Radio.Group
          value={choice === '' ? undefined : choice}
          onChange={(e) => setChoice(e.target.value as string)}
          options={choices.map((c) => ({ value: c.value, label: c.label }))}
          className="wfb-vertical"
        />
      </fieldset>
    ) : (
      <Field
        id={`${uid}-d`}
        label="Décision (obligatoire)"
        hint="Les choix de cette étape ne sont pas connus de cet écran : saisissez la décision."
      >
        <Input id={`${uid}-d`} value={choice} onChange={(e) => setChoice(e.target.value)} aria-describedby={described} />
      </Field>
    ),
    () => ctx.submit(buildDecisionResult(choices, choice)),
  );
}

/** 6 — agent : objet JSON éditable (proposition de l'agent, ou objet libre si un humain reprend l'étape). */
function AgentForm({ ctx, shell }: { ctx: FormCtx; shell: (body: ReactNode, onSubmit: () => void) => ReactNode }) {
  const uid = useId();
  const [text, setText] = useState(() => (ctx.prefill ? prettyJson(ctx.prefill) : '{\n  \n}'));
  const described = ctx.invalid ? ctx.errorsId : undefined;
  return shell(
    <Field
      id={`${uid}-j`}
      label="Résultat (objet JSON)"
      hint="Le résultat doit être un objet entre accolades, par exemple {&quot;cle&quot;: &quot;valeur&quot;}."
    >
      <TextArea
        id={`${uid}-j`}
        className="wfb-json"
        value={text}
        onChange={(e) => setText(e.target.value)}
        autoSize={{ minRows: 6, maxRows: 18 }}
        spellCheck={false}
        aria-describedby={described}
      />
    </Field>,
    () => ctx.submit(buildAgentResult(text)),
  );
}

// ---------------------------------------------------------------------------
// Point d'entrée
// ---------------------------------------------------------------------------

/**
 * Formulaire de clôture d'une tâche, choisi selon `task.taskType`. La construction du résultat est faite par
 * les fonctions pures d'`inbox-logic.ts` ; le serveur revalide de toute façon (422 affiché sans fermer la saisie).
 */
export function TaskForm(props: TaskFormProps) {
  const { entry, submitting, disabled, serverError, submitLabel, onSubmit, onCancel } = props;
  const errorsId = useId();
  const [errors, setErrors] = useState<string[]>([]);

  const ctx: FormCtx = {
    entry,
    config: props.config,
    taskInput: props.taskInput,
    errorsId,
    invalid: errors.length > 0 || serverError !== null,
    prefill: proposalAsResult(entry),
    submit: (r) => {
      if (r.ok) {
        setErrors([]);
        onSubmit(r.result);
      } else setErrors(r.errors);
    },
  };

  const shell = (body: ReactNode, submit: () => void) => (
    <FormShell
      errors={errors}
      errorsId={errorsId}
      serverError={serverError}
      submitting={submitting}
      disabled={disabled}
      submitLabel={submitLabel}
      onSubmit={submit}
      onCancel={onCancel}
    >
      {body}
    </FormShell>
  );

  switch (entry.task.taskType) {
    case 0:
      return <FormTypeForm ctx={ctx} shell={shell} />;
    case 1:
      return <GenerationForm ctx={ctx} shell={shell} />;
    case 2:
      return <ChecklistForm ctx={ctx} shell={shell} />;
    case 3:
      return <AssignmentForm ctx={ctx} shell={shell} />;
    case 4:
      return <ApprovalForm ctx={ctx} shell={shell} />;
    case 5:
      return <DecisionForm ctx={ctx} shell={shell} />;
    default:
      return <AgentForm ctx={ctx} shell={shell} />;
  }
}
