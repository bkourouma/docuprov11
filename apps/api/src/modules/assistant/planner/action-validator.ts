import { Inject, Injectable } from '@nestjs/common';
import {
  ASST_ACTION_TOOL_VALUES,
  ASST_DRAFT_HTML_MAX_CHARS,
  ASST_IMPUTATION_RECIPIENTS_MAX,
  ASST_MESSAGE_MAX_CHARS,
  ASST_PROPOSAL_ACTIONS_MAX,
  ASST_RELANCE_MESSAGE_MAX,
  AsstActionTool,
  asstCanonicalActionsJson,
  asstProposedActionSchema,
  type AsstProposedAction,
} from '@archivage/types';
import type { AuthUser } from '../../auth/auth.types';
import { ActionApplierRegistry } from '../../workflow-agent-catalog/appliers/action-applier.registry';
import { EffectRefusedError, RELANCE_MAX_PER_TARGET_PER_DAY } from '../../workflow-agent-catalog/catalog.contracts';
import { charLength, neutralizeLine, sanitizeText, truncateSafe } from '../../workflow-agents/injection/untrusted';
import {
  buildActionSummary,
  buildConfirmationSummary,
  cleanLabel,
  safeMailReference,
  type SummaryItem,
  type SummaryMailRef,
} from './action-summary';
import {
  INTENT_CONFIRM_SUMMARY_MAX,
  formatClarificationContent,
  formatIntentConfirmation,
  parseClarificationContent,
} from './clarification-format';
import {
  confirmationAnswer,
  decideDelay,
  decideInputationType,
  distinctlyDesignated,
  hasIntentMark,
  intentAllows,
  isSignificant,
  liveUserTexts,
  mentionedMailIds,
  negatedUserTexts,
  normalizeUserTexts,
  normalizeWords,
  phraseInAny,
  splitPolarity,
} from './intent-guards';
import {
  ASST_PLANNER_DATA,
  PLANNER_CHOICES_MAX,
  PLANNER_CHOICES_MIN,
  PLANNER_MAX_ACTIONS_DEFAULT,
  PLANNER_REPLY_MAX_CHARS,
  type ActionValidationInput,
  type ActionValidationOutcome,
  type AsstActionValidator,
  type AsstPlannerDataPort,
  type PlannerActorView,
  type PlannerDraftTemplateView,
  type PlannerInputationTypeView,
  type PlannerInputationView,
  type PlannerMailView,
  type PlannerSpaceView,
} from './planner.types';

// Validateur des actions proposées par le modèle du planificateur : CŒUR de la défense anti-injection.
//
// Principe : le modèle ne fournit que des arguments MINIMAUX (identifiants) ; le CODE vérifie que chacun est établi
// par la demande de l'utilisateur (ou son contexte de page) et par ce que les outils de lecture ont réellement
// renvoyé, puis COMPLÈTE lui-même tout le reste (motif, message de relance, type, délai, brouillon). Aucun texte du
// modèle, d'un courrier ou d'un nom d'acteur n'est repris comme consigne. Échec fermé : au moindre doute, une
// question (`clarify`) ou un refus (`refuse`), avec un message français construit par le code.
//
// Principe « échec fermé par question » (`intent-guards.ts`) : un ordre accompagné d'une marque de réserve n'est
// JAMAIS proposé directement ; tous les contrôles ordinaires sont faits, puis la question de confirmation (résumé
// construit par le code, deux choix) remplace `ok: true`. Le « oui » suivant rejoue la validation (preuves fraîches) et
// n'aboutit que si le résumé recalculé est IDENTIQUE à celui de la question (`intentConfirmation`).

type Failure = Extract<ActionValidationOutcome, { ok: false }>;

/**
 * Confirmation d'intention en cours (principe « échec fermé par question », `intent-guards.ts`) : le message courant
 * répond « Oui, prépare cette action » à la question de confirmation précédente, dont `summary` est le résumé relu
 * (`parseIntentConfirmation`). Transmis par le planificateur en plus des champs de `ActionValidationInput` (contrat
 * interne `planner.types.ts` laissé inchangé) ; absent ou `null` = pas de confirmation.
 */
export interface IntentConfirmationContext {
  summary: string;
}
export type ActionValidationRequest = ActionValidationInput & { intentConfirmation?: IntentConfirmationContext | null };

/** Codes des issues du principe de confirmation. */
export const INTENT_CONFIRMATION_REASON = 'intent_confirmation';
const MSG_CONFIRMATION_MISMATCH =
  "Ce qui serait préparé ne correspond plus exactement à ce que vous avez confirmé : rien n'est proposé. Reformulez votre demande.";
const MSG_CONFIRMATION_INVALID = "Confirmation non reconnue : rien n'est proposé. Reformulez votre demande.";
const MSG_CONFIRMATION_TOO_LONG =
  "Votre message contient une réserve (négation, condition, report, question ou substitution) et la proposition est trop longue pour être confirmée en une fois : rien n'est proposé. Faites des demandes séparées, sans réserve.";

/** Arrêt immédiat de la validation sur un REFUS métier (jamais propagé hors du validateur). */
class ValidationStop extends Error {
  constructor(readonly outcome: Failure) {
    super(outcome.reason);
    this.name = 'ValidationStop';
  }
}

function refuse(reason: string, message: string): never {
  throw new ValidationStop({ ok: false, kind: 'refuse', reason, message: truncateSafe(message, PLANNER_REPLY_MAX_CHARS) });
}

function clarify(reason: string, message: string): Failure {
  return { ok: false, kind: 'clarify', reason, message: truncateSafe(message, PLANNER_REPLY_MAX_CHARS) };
}

/**
 * Question AVEC choix : au format de `clarification-format.ts` (question, ligne vide, « 1. choix »…) quand il y a
 * 2 à 6 choix distincts (sans casse), afin que le planificateur en tire une `clarification` structurée. Sinon
 * (trop de choix, homonymes, aucun choix), la question en ligne `inline` est renvoyée telle qu'avant.
 */
function clarifyWithChoices(reason: string, question: string, labels: readonly string[], inline: string): Failure {
  const choices: string[] = [];
  const seen = new Set<string>();
  for (const l of labels) {
    const c = cleanLabel(l, CHOICE_LABEL_MAX);
    const key = c.toLocaleLowerCase('fr');
    if (seen.has(key)) continue;
    seen.add(key);
    choices.push(c);
  }
  if (choices.length >= PLANNER_CHOICES_MIN && choices.length <= PLANNER_CHOICES_MAX) {
    const message = formatClarificationContent(question, choices);
    if (charLength(message) <= PLANNER_REPLY_MAX_CHARS && parseClarificationContent(message) !== null) {
      return { ok: false, kind: 'clarify', reason, message };
    }
  }
  return clarify(reason, inline);
}

const INTERNAL_MESSAGE = "Je ne peux pas préparer cette action pour le moment (erreur interne). Aucune action n'a été proposée.";
const V1_TOOLS: ReadonlySet<string> = new Set<string>(ASST_ACTION_TOOL_VALUES);
const ID_MAX = 2_147_483_647;
const WRITABLE_SPACES_LIMIT = 50;
const CHOICE_LABEL_MAX = 80;
const RATIONALE_MAX = 500;
const DRAFT_LABEL_MAX = 200;
const HISTORY_MAX = 20;
const DECISION_ID = /^\d{1,18}$/;

function readId(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= ID_MAX ? value : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Liste numérotée « 1) A ; 2) B », bornée à `PLANNER_CHOICES_MAX` entrées, libellés neutralisés. */
function numbered(labels: readonly string[]): string {
  const shown = labels.slice(0, PLANNER_CHOICES_MAX).map((l, i) => `${i + 1}) ${cleanLabel(l, CHOICE_LABEL_MAX)}`);
  return shown.join(' ; ') + (labels.length > PLANNER_CHOICES_MAX ? ' ; …' : '');
}

function mailChoiceLabel(m: { mailId: number; reference: string | null; title: string | null }): string {
  const ref = safeMailReference(m.reference);
  const title = m.title === null ? '' : neutralizeLine(m.title, '', 50);
  return `courrier ${m.mailId}${ref ? ` (réf. ${ref})` : ''}${title ? ` « ${title} »` : ''}`;
}

function mailDesignation(mail: { mailId: number; reference: string | null }): string {
  const ref = safeMailReference(mail.reference);
  return ref ? `réf. ${ref}` : `n°${mail.mailId}`;
}

function toSummaryMail(mail: PlannerMailView): SummaryMailRef {
  return { mailId: mail.mailId, reference: mail.reference, title: mail.title };
}

/** Contexte d'UNE validation (textes de l'utilisateur normalisés, caches de lecture). */
interface Ctx {
  input: ActionValidationInput;
  user: AuthUser;
  userTexts: string[];
  /** Textes de l'utilisateur normalisés, passages niés ou hypothétiques retirés (désignations). */
  userNorms: string[];
  /** Passages NIÉS des textes de l'utilisateur, normalisés : ce qu'ils désignent est exclu. */
  negatedNorms: string[];
  /** Message COURANT normalisé, passages positifs (peut être vide). */
  currentNorm: string;
  currentMentions: number[];
  historyMentions: number[];
  /** Numéros de courrier cités dans un passage nié (« pas le courrier 4321 ») : jamais établis. */
  negatedMentions: number[];
  cache: {
    canImpute?: Promise<boolean>;
    types?: Promise<PlannerInputationTypeView[]>;
    mails: Map<number, Promise<PlannerMailView | null>>;
    spaces?: Promise<PlannerSpaceView[]>;
  };
  /** Relances déjà retenues dans cette proposition, par cible `courrier:acteur`. */
  relanceTargets: Map<string, number>;
}

interface PreparedImputation {
  kind: 'imputation';
  action: AsstProposedAction;
  summary: SummaryItem;
  keys: string[];
}
interface PreparedRelance {
  kind: 'relance';
  action: AsstProposedAction;
  summary: SummaryItem;
  key: string;
}
interface PendingDraft {
  kind: 'brouillon';
  template: PlannerDraftTemplateView;
  label: string;
  mail: PlannerMailView | null;
  space: PlannerSpaceView;
}
type Prepared = PreparedImputation | PreparedRelance | PendingDraft;

@Injectable()
export class AsstActionValidatorService implements AsstActionValidator {
  constructor(
    @Inject(ASST_PLANNER_DATA) private readonly data: AsstPlannerDataPort,
    @Inject(ActionApplierRegistry) private readonly registry: ActionApplierRegistry,
  ) {}

  async validate(input: ActionValidationRequest): Promise<ActionValidationOutcome> {
    try {
      return await this.run(input);
    } catch (e) {
      if (e instanceof ValidationStop) return e.outcome;
      // Exception inattendue (port de données, générateur…) : échec fermé, message générique, aucun contenu.
      return { ok: false, kind: 'refuse', reason: 'internal', message: INTERNAL_MESSAGE };
    }
  }

  // -------------------------------------------------------------------------
  // Déroulé
  // -------------------------------------------------------------------------

  private async run(input: ActionValidationRequest): Promise<ActionValidationOutcome> {
    const raw = Array.isArray(input.rawActions) ? input.rawActions : [];
    const maxActions =
      Number.isInteger(input.maxActions) && input.maxActions >= 1
        ? Math.min(input.maxActions, ASST_PROPOSAL_ACTIONS_MAX)
        : PLANNER_MAX_ACTIONS_DEFAULT;

    // 0. Structure.
    if (raw.length === 0) refuse('no_actions', 'Aucune action à proposer.');
    if (raw.length > maxActions) {
      refuse('too_many_actions', `Trop d'actions dans une même proposition (${maxActions} au plus). Faites plusieurs demandes.`);
    }
    const seenRaw = new Set<string>();
    for (const a of raw) {
      if (!isPlainObject(a) || typeof a.tool !== 'string' || !V1_TOOLS.has(a.tool)) {
        refuse('unknown_tool', "Action non prise en charge par l'assistant.");
      }
      if (!isPlainObject(a.args)) refuse('invalid_arguments', 'Action refusée : arguments invalides.');
      const key = asstCanonicalActionsJson([{ tool: a.tool, args: a.args } as unknown as AsstProposedAction]);
      if (seenRaw.has(key)) refuse('duplicate_action', 'La même action figure deux fois dans la proposition.');
      seenRaw.add(key);
      if (!this.registry.get(a.tool)) refuse('applier_missing', "Action non prise en charge par l'assistant.");
    }

    // Historique : l'appelant (planificateur) ne transmet que les messages qui portent encore l'intention (réponse à
    // une question de précision) ; défense en profondeur, une annulation rend caducs les ordres qui la précèdent.
    const message = typeof input.userMessage === 'string' ? input.userMessage : '';
    const live = liveUserTexts(
      message,
      (Array.isArray(input.previousUserMessages) ? input.previousUserMessages : [])
        .filter((t): t is string => typeof t === 'string')
        .slice(-HISTORY_MAX),
    );
    // Confirmation d'intention : le message courant n'est qu'un « oui » ; la validation REJOUE les textes du tour qui
    // a posé la question (dernier message de la chaîne = « courant » de ce tour-là, les autres = précédents), avec les
    // preuves FRAÎCHES de cette requête. Le résumé recalculé devra être identique à celui qui a été confirmé.
    const confirmation =
      input.intentConfirmation && typeof input.intentConfirmation.summary === 'string' ? input.intentConfirmation : null;
    if (confirmation && (confirmationAnswer(message) !== 'yes' || live.length === 0)) {
      refuse('intent_confirmation_invalid', MSG_CONFIRMATION_INVALID);
    }
    const current = confirmation ? (live[live.length - 1] ?? '') : message;
    const previous = confirmation ? live.slice(0, -1) : live;
    const userTexts = [current, ...previous];
    // Niveau 2 du principe : une marque de réserve n'importe où dans les textes retenus => question de confirmation
    // (jamais de proposition directe). Sans objet quand l'utilisateur vient de confirmer.
    const marked = !confirmation && userTexts.some((t) => hasIntentMark(t));
    const positive = (t: string): string => splitPolarity(t).positive;
    const ctx: Ctx = {
      input,
      user: input.identity.user,
      userTexts,
      // Désignations : passages POSITIFS seulement (« impute à la DAF mais pas à la DRH » ne désigne pas la DRH).
      userNorms: normalizeUserTexts(current, previous),
      negatedNorms: negatedUserTexts(current, previous),
      currentNorm: normalizeWords(positive(current)),
      currentMentions: mentionedMailIds(positive(current)),
      historyMentions: previous.flatMap((t) => mentionedMailIds(positive(t))),
      negatedMentions: userTexts.flatMap((t) => mentionedMailIds(splitPolarity(t).negated)),
      cache: { mails: new Map() },
      relanceTargets: new Map(),
    };

    // 1. Intention (niveau 1 du principe) : un ordre POSITIF de l'utilisateur pour CHAQUE outil proposé ; sinon refus,
    // jamais une question. Ce contrôle précède toute lecture et toute génération (aucun brouillon n'est rédigé pour
    // une demande qui le refuse). Le niveau 2 (marques de réserve => confirmation) est appliqué après les contrôles.
    for (const a of raw) {
      if (!intentAllows(a.tool, userTexts)) {
        refuse(
          'intent_not_established',
          "Votre demande ne contient pas d'ordre correspondant à cette action : rien n'est proposé. Formulez explicitement ce que vous voulez faire.",
        );
      }
    }

    // 2 à 6. Contrôles par action : un refus arrête tout ; les questions sont gardées pour la fin (un refus prime).
    const prepared: Prepared[] = [];
    let firstClarify: Failure | null = null;
    for (const a of raw) {
      const r = await this.prepare(ctx, a.tool, a.args);
      if ('ok' in r) firstClarify ??= r;
      else prepared.push(r);
    }

    // 8. Doublons entre actions (même courrier + acteur + type ; même brouillon).
    const impKeys = new Set<string>();
    const draftKeys = new Set<string>();
    for (const p of prepared) {
      if (p.kind === 'imputation') {
        for (const k of p.keys) {
          if (impKeys.has(k)) {
            refuse('duplicate_recipient', 'Le même destinataire figure deux fois avec le même type pour ce courrier : rien n’est proposé.');
          }
          impKeys.add(k);
        }
      } else if (p.kind === 'brouillon') {
        const k = `${p.template.id}:${p.mail?.mailId ?? 0}:${p.space.spaceId}`;
        if (draftKeys.has(k)) refuse('duplicate_action', 'Le même brouillon figure deux fois dans la proposition.');
        draftKeys.add(k);
      }
    }
    if (firstClarify) {
      // Après une confirmation, une nouvelle précision voudrait dire que l'action a changé : refus (pas de boucle).
      if (confirmation) refuse('intent_confirmation_mismatch', MSG_CONFIRMATION_MISMATCH);
      return firstClarify;
    }

    // Résumé de ce qui serait préparé, construit SANS génération (un brouillon est décrit par modèle, courrier, espace).
    const items: SummaryItem[] = prepared.map((p) =>
      p.kind === 'brouillon'
        ? { kind: 'brouillon', mail: p.mail ? toSummaryMail(p.mail) : null, templateLabel: p.template.label, spaceLabel: p.space.label }
        : p.summary,
    );

    // Principe « échec fermé par question » : message marqué => question de confirmation construite par le code, après
    // TOUS les autres contrôles (un refus ordinaire reste un refus) et AVANT toute génération de brouillon.
    if (marked || confirmation) {
      for (const p of prepared) if (p.kind !== 'brouillon') this.finalCheck(p.action);
      const shown = buildConfirmationSummary(items, INTENT_CONFIRM_SUMMARY_MAX);
      if (shown === null) refuse('intent_confirmation_too_long', MSG_CONFIRMATION_TOO_LONG);
      if (marked) {
        const question = formatIntentConfirmation(shown);
        if (question === null) refuse('intent_confirmation_too_long', MSG_CONFIRMATION_TOO_LONG);
        return { ok: false, kind: 'clarify', reason: INTENT_CONFIRMATION_REASON, message: question };
      }
      // LIAISON : l'utilisateur ne confirme que ce qui lui a été montré, mot pour mot.
      if (confirmation && shown !== confirmation.summary) refuse('intent_confirmation_mismatch', MSG_CONFIRMATION_MISMATCH);
    }

    // Génération des brouillons (budgétée par le planificateur) EN DERNIER : rien n'est dépensé si une autre action
    // est refusée, demande une précision ou attend une confirmation.
    const finals: AsstProposedAction[] = [];
    let aiDecisionId: string | null = null;
    for (const p of prepared) {
      if (p.kind === 'brouillon') {
        const { action, decisionId } = await this.generateDraft(ctx, p);
        finals.push(action);
        aiDecisionId ??= decisionId;
      } else {
        finals.push(p.action);
      }
    }

    // Contrôle final : schéma strict de l'assistant, `parse` de l'applicateur du catalogue, JSON canonique stable.
    const actions = finals.map((a) => this.finalCheck(a));
    const canon = new Set<string>();
    for (const a of actions) {
      const k = asstCanonicalActionsJson([a]);
      if (canon.has(k)) refuse('duplicate_action', 'La même action figure deux fois dans la proposition.');
      canon.add(k);
    }
    return { ok: true, actions, summary: buildActionSummary(items), aiDecisionId };
  }

  private prepare(ctx: Ctx, tool: string, args: Record<string, unknown>): Promise<Prepared | Failure> {
    switch (tool) {
      case AsstActionTool.ImputationCourrier:
        return this.prepareImputation(ctx, args);
      case AsstActionTool.Relance:
        return this.prepareRelance(ctx, args);
      case AsstActionTool.BrouillonReponse:
        return this.prepareDraft(ctx, args);
      default:
        refuse('unknown_tool', "Action non prise en charge par l'assistant.");
    }
  }

  // -------------------------------------------------------------------------
  // Courrier
  // -------------------------------------------------------------------------

  /** Le courrier est-il désigné par l'utilisateur (citation, page ouverte, recherche demandée, référence citée) ? */
  private isMailEstablished(ctx: Ctx, mailId: number): boolean {
    // Un courrier écarté par l'utilisateur (« pas le courrier 4321 ») n'est jamais établi, même ouvert en page.
    if (ctx.negatedMentions.includes(mailId)) return false;
    // Un numéro cité dans le message COURANT l'emporte sur la page ouverte et sur l'historique.
    if (ctx.currentMentions.length > 0) return ctx.currentMentions.includes(mailId);
    const page = ctx.input.pageContext;
    const pageMail = page && page.subjectType === 'mail' && page.subjectId !== undefined ? page.subjectId : null;
    if (pageMail === String(mailId)) return true;
    // Une page de courrier est ouverte et le modèle en vise un autre : seul le message COURANT peut le désigner
    // (recherche ou référence citée) ; un numéro des messages précédents ne l'emporte pas sur « ce courrier ».
    const texts = pageMail !== null ? [ctx.currentNorm] : ctx.userNorms;
    if (pageMail === null && ctx.historyMentions.includes(mailId)) return true;
    const ev = ctx.input.evidence;
    for (const s of ev.mailSearches) {
      // Une recherche n'établit le courrier que si l'utilisateur a donné ce texte ET qu'elle n'a renvoyé que lui.
      if (s.mailIds.length !== 1 || s.mailIds[0] !== mailId) continue;
      const q = normalizeWords(s.query, 400);
      if (q.length >= 3 && isSignificant(q) && phraseInAny(texts, q)) return true;
    }
    const seen = ev.mails.get(mailId);
    const ref = safeMailReference(seen?.reference ?? null);
    if (ref) {
      const r = normalizeWords(ref, 200);
      if (r.length >= 3 && /\d/.test(r) && phraseInAny(texts, r)) return true;
    }
    return false;
  }

  private mailClarify(ctx: Ctx): Failure {
    const candidates = [...ctx.input.evidence.mails.values()];
    const list = candidates.length > 0 ? ` Courriers vus : ${numbered(candidates.map(mailChoiceLabel))}.` : '';
    return clarifyWithChoices(
      'mail_not_established',
      'Sur quel courrier ? Indiquez le numéro du courrier (par exemple « courrier 4321 »).',
      candidates.map(mailChoiceLabel),
      `Sur quel courrier ?${list} Indiquez le numéro du courrier (par exemple « courrier 4321 »).`,
    );
  }

  private readMail(ctx: Ctx, mailId: number): Promise<PlannerMailView | null> {
    let p = ctx.cache.mails.get(mailId);
    if (!p) {
      p = this.data.readMail(ctx.user, mailId, 0);
      ctx.cache.mails.set(mailId, p);
    }
    return p;
  }

  /** Courrier établi ET lisible par l'utilisateur ; sinon question (non établi) ou refus (illisible). */
  private async resolveMail(ctx: Ctx, mailId: number | undefined): Promise<PlannerMailView | Failure> {
    if (mailId === undefined || !this.isMailEstablished(ctx, mailId)) return this.mailClarify(ctx);
    const mail = await this.readMail(ctx, mailId);
    if (!mail || mail.mailId !== mailId) {
      refuse('mail_not_readable', `Le courrier n°${mailId} est introuvable ou non accessible : rien n'est proposé.`);
    }
    return mail;
  }

  private canImpute(ctx: Ctx): Promise<boolean> {
    ctx.cache.canImpute ??= this.data.canImpute(ctx.user);
    return ctx.cache.canImpute;
  }

  private activeTypes(ctx: Ctx): Promise<PlannerInputationTypeView[]> {
    ctx.cache.types ??= this.data.listInputationTypes();
    return ctx.cache.types;
  }

  // -------------------------------------------------------------------------
  // 3-4. Imputation
  // -------------------------------------------------------------------------

  private async prepareImputation(ctx: Ctx, args: Record<string, unknown>): Promise<PreparedImputation | Failure> {
    const mailId = readId(args.mailId);
    const rawRecipients = args.recipients;
    if (!Array.isArray(rawRecipients) || rawRecipients.length === 0) {
      refuse('invalid_arguments', 'Imputation refusée : aucun destinataire indiqué.');
    }
    const modelTypeIds: number[] = [];
    const recipientIds: number[] = [];
    for (const r of rawRecipients) {
      const id = isPlainObject(r) ? readId(r.userGroupId) : undefined;
      if (id === undefined) refuse('invalid_arguments', 'Imputation refusée : destinataire invalide.');
      const t = isPlainObject(r) ? readId(r.mailInputationTypeId) : undefined;
      if (t !== undefined && !modelTypeIds.includes(t)) modelTypeIds.push(t);
      // Dédoublonnage : un même acteur ne reçoit qu'une imputation (un seul type par proposition).
      if (!recipientIds.includes(id)) recipientIds.push(id);
    }
    if (recipientIds.length > ASST_IMPUTATION_RECIPIENTS_MAX) {
      refuse('too_many_recipients', `Trop de destinataires (${ASST_IMPUTATION_RECIPIENTS_MAX} au plus) : rien n'est proposé.`);
    }

    const mailOrClarify = await this.resolveMail(ctx, mailId);
    if ('ok' in mailOrClarify) return mailOrClarify;
    const mail = mailOrClarify;

    if (!(await this.canImpute(ctx))) {
      refuse('imputation_not_allowed', "Vous n'avez pas le droit d'imputer un courrier : rien n'est proposé.");
    }

    // Destinataires : origine (recherche demandée par l'utilisateur), non-ambiguïté, imputabilité.
    let pending: Failure | null = null;
    const resolved: Array<{ userGroupId: number; label: string }> = [];
    for (const id of recipientIds) {
      const origin = this.actorOrigin(ctx, id);
      if (origin.status === 'excluded') {
        refuse(
          'actor_excluded',
          `Le destinataire « ${cleanLabel(origin.label, 80)} » est écarté par votre demande : rien n'est proposé.`,
        );
      }
      if (origin.status === 'unknown') {
        refuse(
          'actor_not_established',
          `Le destinataire n°${id} n'a pas été désigné par votre demande (il ne provient pas d'une recherche que vous avez demandée) : rien n'est proposé.`,
        );
      }
      if (origin.status === 'ambiguous') {
        pending ??= clarifyWithChoices(
          'actor_ambiguous',
          `Plusieurs destinataires correspondent à « ${cleanLabel(origin.search, 60)} ». Lequel ? Répondez avec son nom complet.`,
          origin.actors.map((a) => a.label),
          `Plusieurs destinataires correspondent à « ${cleanLabel(origin.search, 60)} » : ${numbered(origin.actors.map((a) => a.label))}. Lequel ? Répondez avec son nom complet.`,
        );
        continue;
      }
      const actor = await this.data.resolveImputableActor(ctx.user, id);
      if (!actor || actor.userGroupId !== id) {
        refuse(
          'actor_not_imputable',
          `Le destinataire « ${cleanLabel(origin.label, 80)} » n'est pas imputable (compte inactif ou droits insuffisants) : rien n'est proposé.`,
        );
      }
      resolved.push({ userGroupId: id, label: actor.label });
    }

    // Type : décidé par le CODE (mention explicite, sinon « Pour suivi » par défaut). L'id du modèle est ignoré.
    const types = await this.activeTypes(ctx);
    const current = ctx.userTexts[0] ?? '';
    const previous = ctx.userTexts.slice(1);
    const decision = decideInputationType(current, previous, types);
    let type: PlannerInputationTypeView | null = null;
    let typeIsDefault = false;
    const typeList = numbered(types.map((t) => t.label));
    const typeLabels = types.map((t) => t.label);
    if (decision.status === 'ambiguous' || decision.status === 'unavailable') {
      pending ??= clarifyWithChoices(
        'type_ambiguous',
        "Quel type d'imputation ? Précisez-le dans votre demande.",
        typeLabels,
        `Quel type d'imputation ?${types.length > 0 ? ` ${typeList}.` : ''} Précisez-le dans votre demande.`,
      );
    } else if (recipientIds.length > 1 && modelTypeIds.length > 1) {
      // Le modèle a perçu des types différents selon les destinataires : un seul type par proposition, on demande.
      pending ??= clarifyWithChoices(
        'type_per_recipient',
        "Un seul type d'imputation s'applique à tous les destinataires de la proposition. Lequel ? Pour des types différents, faites des demandes séparées.",
        typeLabels,
        `Un seul type d'imputation s'applique à tous les destinataires de la proposition. Lequel ?${types.length > 0 ? ` ${typeList}.` : ''} Pour des types différents, faites des demandes séparées.`,
      );
    } else {
      const active = await this.data.getActiveInputationType(decision.typeId);
      if (!active || active.id !== decision.typeId) {
        pending ??= clarifyWithChoices(
          'type_unavailable',
          "Ce type d'imputation n'est pas disponible. Quel type ?",
          typeLabels,
          `Ce type d'imputation n'est pas disponible. Quel type ?${types.length > 0 ? ` ${typeList}.` : ''}`,
        );
      } else {
        type = active;
        typeIsDefault = decision.status === 'default';
      }
    }

    // Doublon d'une imputation encore ouverte (même courrier, acteur, type).
    if (type) {
      for (const r of resolved) {
        if (await this.data.hasOpenImputation(mail.mailId, r.userGroupId, type.id)) {
          refuse(
            'duplicate_open_imputation',
            `Une imputation « ${cleanLabel(type.label, 60)} » de ce courrier à « ${cleanLabel(r.label, 80)} » est encore ouverte : rien n'est proposé.`,
          );
        }
      }
    }

    // Délai : imposé par le CODE depuis les textes de l'utilisateur ; celui du modèle n'est jamais cru.
    const delay = decideDelay(current, previous);
    if (delay.status === 'ambiguous') pending ??= clarify('delay_ambiguous', 'Sous combien de jours (de 1 à 90) ?');

    if (pending) return pending;
    if (!type) return clarify('type_ambiguous', "Quel type d'imputation ?");
    const delayDays = delay.status === 'ok' ? delay.days : null;
    const chosenType = type;

    const action: AsstProposedAction = {
      tool: AsstActionTool.ImputationCourrier,
      args: {
        mailId: mail.mailId,
        recipients: resolved.map((r) => ({
          userGroupId: r.userGroupId,
          mailInputationTypeId: chosenType.id,
          ...(delayDays !== null ? { delayDays } : {}),
        })),
        rationale: this.rationale(current),
      },
    };
    return {
      kind: 'imputation',
      action,
      summary: {
        kind: 'imputation',
        mail: toSummaryMail(mail),
        recipients: resolved.map((r) => ({ label: r.label })),
        typeLabel: chosenType.label,
        typeIsDefault,
        delayDays,
      },
      keys: resolved.map((r) => `${mail.mailId}:${r.userGroupId}:${chosenType.id}`),
    };
  }

  /**
   * Origine d'un acteur proposé : il doit sortir d'un appel `acteurs_imputables` dont le filtre figure dans les
   * textes de l'utilisateur (et explique le résultat), ou être désigné par l'utilisateur (libellé complet ou partie
   * distinctive). Un nom d'acteur ne vient JAMAIS d'un courrier. Un acteur désigné par un passage NIÉ de la demande
   * (« pas à Awa », « sauf la DRH ») est exclu, quelle que soit la recherche.
   */
  private actorOrigin(
    ctx: Ctx,
    id: number,
  ):
    | { status: 'ok'; label: string }
    | { status: 'ambiguous'; search: string; actors: PlannerActorView[] }
    | { status: 'excluded'; label: string }
    | { status: 'unknown' } {
    let ambiguous: { search: string; actors: PlannerActorView[] } | null = null;
    for (const s of ctx.input.evidence.actorSearches) {
      const actor = s.actors.find((a) => a.userGroupId === id);
      if (!actor) continue;
      if (distinctlyDesignated(s.actors, (a) => a.label, ctx.negatedNorms).some((a) => a.userGroupId === id)) {
        return { status: 'excluded', label: actor.label };
      }
      const searchOk = s.search !== null && this.searchQualifies(ctx, s.search, actor);
      const designated = distinctlyDesignated(s.actors, (a) => a.label, ctx.userNorms).some((a) => a.userGroupId === id);
      if ((searchOk && s.actors.length === 1) || designated) return { status: 'ok', label: actor.label };
      if (searchOk) ambiguous ??= { search: s.search ?? '', actors: s.actors };
    }
    return ambiguous ? { status: 'ambiguous', ...ambiguous } : { status: 'unknown' };
  }

  /** Le filtre de recherche est donné par l'utilisateur (mots entiers, significatif) et explique l'acteur renvoyé. */
  private searchQualifies(ctx: Ctx, search: string, actor: PlannerActorView): boolean {
    const s = normalizeWords(search, 400);
    if (s.length < 2 || !isSignificant(s) || !phraseInAny(ctx.userNorms, s)) return false;
    const haystack = normalizeWords(`${actor.label} ${actor.roleName ?? ''} ${actor.organigrammeLabel ?? ''}`, 2_000);
    return haystack.includes(s);
  }

  private rationale(current: string): string {
    const prefix = "Demande de l'utilisateur (assistant) : « ";
    const suffix = ' »';
    const room = RATIONALE_MAX - charLength(prefix) - charLength(suffix);
    const said = neutralizeLine(current, '', room);
    return `${prefix}${said.length > 0 ? said : '(message vide)'}${suffix}`;
  }

  // -------------------------------------------------------------------------
  // 5. Relance
  // -------------------------------------------------------------------------

  private async prepareRelance(ctx: Ctx, args: Record<string, unknown>): Promise<PreparedRelance | Failure> {
    const mailId = readId(args.mailId);
    const inputationId = readId(args.mailInputationId);
    if (inputationId === undefined) refuse('invalid_arguments', 'Relance refusée : imputation non indiquée.');

    const mailOrClarify = await this.resolveMail(ctx, mailId);
    if ('ok' in mailOrClarify) return mailOrClarify;
    const mail = mailOrClarify;

    const seen = ctx.input.evidence.inputations.get(inputationId);
    if (!seen || seen.mailId !== mail.mailId) {
      refuse('inputation_not_seen', "Relance refusée : l'imputation visée n'a pas été vérifiée sur ce courrier.");
    }
    const view = await this.data.readInputation(ctx.user, mail.mailId, inputationId, ctx.input.now);
    if (!view || view.mailId !== mail.mailId || view.mailInputationId !== inputationId) {
      refuse('inputation_not_found', 'Relance refusée : imputation introuvable pour ce courrier.');
    }
    const who = cleanLabel(view.actorLabel, 80);
    if (view.treated) refuse('inputation_treated', `Relance refusée : l'imputation de « ${who} » est déjà traitée.`);
    const now = ctx.input.now.getTime();
    if (!view.late || view.deadline === null || !(view.deadline.getTime() < now)) {
      refuse('not_late', `Relance refusée : l'échéance de l'imputation de « ${who} » n'est pas dépassée.`);
    }
    if (!view.actorActive) refuse('actor_inactive', `Relance refusée : le compte de « ${who} » n'est pas actif.`);
    const author = view.createdBy !== null && ctx.user.userGroupId !== null && view.createdBy === ctx.user.userGroupId;
    if (!author && !(await this.canImpute(ctx))) {
      refuse('relance_not_allowed', "Relance refusée : vous n'avez ni le droit d'imputer ni la qualité d'auteur de cette imputation.");
    }
    const targetKey = `${mail.mailId}:${view.actorUserGroupId}`;
    const already = await this.data.countTargetRelancesToday(mail.mailId, view.actorUserGroupId, ctx.input.now);
    const inProposal = ctx.relanceTargets.get(targetKey) ?? 0;
    if (!Number.isFinite(already) || already + inProposal >= RELANCE_MAX_PER_TARGET_PER_DAY) {
      refuse('relance_cap', `Relance refusée : plafond quotidien de relances atteint pour « ${who} » sur ce courrier.`);
    }

    // Cible : si l'utilisateur nomme un acteur, ce doit être celui-ci ; plusieurs retards non départagés => question.
    const forMail = this.uniqueActors(
      [...ctx.input.evidence.inputations.values(), view].filter((i) => i.mailId === mail.mailId && !i.treated),
    );
    const excluded = distinctlyDesignated(forMail, (i) => i.actorLabel, ctx.negatedNorms).map((i) => i.actorUserGroupId);
    if (excluded.includes(view.actorUserGroupId)) {
      refuse('relance_target_excluded', `Relance refusée : « ${who} » est écarté par votre demande.`);
    }
    const designated = distinctlyDesignated(forMail, (i) => i.actorLabel, ctx.userNorms).map((i) => i.actorUserGroupId);
    const late = forMail.filter((i) => i.late && i.deadline !== null && i.deadline.getTime() < now);
    const lateLabels = late.map((i) => i.actorLabel);
    if (designated.length > 0 && !designated.includes(view.actorUserGroupId)) {
      return clarifyWithChoices(
        'relance_target_mismatch',
        "Qui faut-il relancer sur ce courrier (imputations en retard) ? Répondez avec le nom de l'acteur.",
        lateLabels,
        `Qui faut-il relancer sur ce courrier ? Imputations en retard : ${numbered(lateLabels)}. Répondez avec le nom de l'acteur.`,
      );
    }
    if (late.length > 1 && !designated.includes(view.actorUserGroupId)) {
      return clarifyWithChoices(
        'relance_target_ambiguous',
        "Plusieurs imputations sont en retard sur ce courrier. Laquelle relancer ? Répondez avec le nom de l'acteur.",
        lateLabels,
        `Plusieurs imputations sont en retard sur ce courrier : ${numbered(lateLabels)}. Laquelle relancer ? Répondez avec le nom de l'acteur.`,
      );
    }
    ctx.relanceTargets.set(targetKey, inProposal + 1);

    const message = truncateSafe(
      `Relance depuis l'assistant : merci de traiter le courrier ${mailDesignation(mail)}.`,
      ASST_RELANCE_MESSAGE_MAX,
    );
    return {
      kind: 'relance',
      action: {
        tool: AsstActionTool.Relance,
        args: {
          mailId: mail.mailId,
          mailInputationId: inputationId,
          recipientUserGroupId: view.actorUserGroupId,
          message,
        },
      },
      summary: {
        kind: 'relance',
        mail: toSummaryMail(mail),
        mailInputationId: inputationId,
        actorLabel: view.actorLabel,
        deadline: view.deadline,
      },
      key: targetKey,
    };
  }

  private uniqueActors(rows: PlannerInputationView[]): PlannerInputationView[] {
    const byActor = new Map<number, PlannerInputationView>();
    for (const r of rows) {
      const prev = byActor.get(r.actorUserGroupId);
      // Une imputation en retard représente l'acteur de préférence.
      if (!prev || (!prev.late && r.late)) byActor.set(r.actorUserGroupId, r);
    }
    return [...byActor.values()];
  }

  // -------------------------------------------------------------------------
  // 6. Brouillon
  // -------------------------------------------------------------------------

  private async prepareDraft(ctx: Ctx, args: Record<string, unknown>): Promise<PendingDraft | Failure> {
    const templateId = typeof args.templateId === 'string' ? args.templateId : undefined;
    const mailId = args.mailId === undefined ? undefined : readId(args.mailId);
    if (args.mailId !== undefined && mailId === undefined) refuse('invalid_arguments', 'Brouillon refusé : courrier invalide.');
    const spaceId = args.spaceId === undefined ? undefined : readId(args.spaceId);
    if (args.spaceId !== undefined && spaceId === undefined) refuse('invalid_arguments', 'Brouillon refusé : espace invalide.');

    const templates = this.data.listDraftTemplates();
    const template = templates.find((t) => t.id === templateId);
    if (!template) {
      if (templates.length === 0) refuse('no_template', 'Aucun modèle de rédaction disponible : rien n’est proposé.');
      return clarifyWithChoices(
        'template_unknown',
        'Quel modèle de rédaction utiliser ?',
        templates.map((t) => t.label),
        `Quel modèle de rédaction utiliser ? ${numbered(templates.map((t) => t.label))}.`,
      );
    }

    let mail: PlannerMailView | null = null;
    if (mailId !== undefined) {
      const m = await this.resolveMail(ctx, mailId);
      if ('ok' in m) return m;
      mail = m;
    }

    ctx.cache.spaces ??= this.data.listWritableSpaces(ctx.user, WRITABLE_SPACES_LIMIT);
    const spaces = await ctx.cache.spaces;
    if (spaces.length === 0) {
      refuse('no_writable_space', "Vous n'avez aucun espace où déposer un brouillon : rien n'est proposé.");
    }
    const spaceQuestion = (reason: string): Failure =>
      clarifyWithChoices(
        reason,
        "Dans quel espace déposer le brouillon ? Répondez avec le nom de l'espace.",
        spaces.map((s) => s.label),
        `Dans quel espace déposer le brouillon ? ${numbered(spaces.map((s) => s.label))}. Répondez avec le nom de l'espace.`,
      );
    if (spaceId === undefined) return spaceQuestion('space_required');
    const space = spaces.find((s) => s.spaceId === spaceId);
    if (!space) return spaceQuestion('space_unknown');
    if (distinctlyDesignated(spaces, (s) => s.label, ctx.negatedNorms).some((s) => s.spaceId === space.spaceId)) {
      refuse('space_excluded', `L'espace « ${cleanLabel(space.label, 80)} » est écarté par votre demande : rien n'est proposé.`);
    }
    // Plusieurs espaces : le choix doit venir de l'utilisateur (jamais un choix du modèle au hasard).
    if (spaces.length > 1) {
      const designated = distinctlyDesignated(spaces, (s) => s.label, ctx.userNorms);
      if (!designated.some((s) => s.spaceId === space.spaceId)) return spaceQuestion('space_ambiguous');
    }

    // Titre du document FIXÉ PAR LE CODE : le libellé du modèle (texte libre, absent du résumé confirmé par
    // l'utilisateur, possiblement dicté par un courrier) est ignoré (durcissement du corpus d'attaque).
    const label = mail ? `Réponse au courrier ${mailDesignation(mail)}` : 'Brouillon de réponse';
    return { kind: 'brouillon', template, label: truncateSafe(label, DRAFT_LABEL_MAX), mail, space };
  }

  private async generateDraft(ctx: Ctx, p: PendingDraft): Promise<{ action: AsstProposedAction; decisionId: string | null }> {
    // La consigne est le message COURANT de l'utilisateur (jamais un texte issu d'un courrier).
    const instruction = truncateSafe(sanitizeText(ctx.userTexts[0] ?? '', ASST_MESSAGE_MAX_CHARS * 4).trim(), ASST_MESSAGE_MAX_CHARS);
    const request: { templateId: string; instruction: string; mailId?: number } = { templateId: p.template.id, instruction };
    if (p.mail) request.mailId = p.mail.mailId;
    const result = await ctx.input.draftGenerator(request);
    if (result.status !== 'ok') {
      const said = neutralizeLine(result.message, '', 300);
      const fallback =
        result.status === 'disabled' ? 'La rédaction assistée est indisponible.' : 'La rédaction du brouillon a été refusée.';
      refuse(result.status === 'disabled' ? 'draft_disabled' : 'draft_refused', `${said || fallback} Rien n'est proposé.`);
    }
    const html = typeof result.draftHtml === 'string' ? result.draftHtml : '';
    if (html.trim().length === 0) refuse('draft_empty', "Le brouillon généré est vide : rien n'est proposé.");
    if (html.length > ASST_DRAFT_HTML_MAX_CHARS) {
      refuse('draft_too_large', "Le brouillon généré est trop volumineux : rien n'est proposé.");
    }
    const decisionId = typeof result.decisionId === 'string' && DECISION_ID.test(result.decisionId) ? result.decisionId : null;
    const args: Record<string, unknown> = { templateId: p.template.id, label: p.label, draftHtml: html };
    if (p.mail) args.mailId = p.mail.mailId;
    args.spaceId = p.space.spaceId;
    if (decisionId) args.decisionId = decisionId;
    return { action: { tool: AsstActionTool.BrouillonReponse, args } as AsstProposedAction, decisionId };
  }

  // -------------------------------------------------------------------------
  // Contrôle final
  // -------------------------------------------------------------------------

  private finalCheck(candidate: AsstProposedAction): AsstProposedAction {
    const parsed = asstProposedActionSchema.safeParse(candidate);
    if (!parsed.success) refuse('invalid_arguments', 'Action refusée : arguments invalides après complétion.');
    const action = parsed.data;
    const applier = this.registry.get(action.tool);
    if (!applier) refuse('applier_missing', "Action non prise en charge par l'assistant.");
    let applied: unknown;
    try {
      applied = applier.parse(action.args);
    } catch (e) {
      if (e instanceof EffectRefusedError) refuse('applier_refused', neutralizeLine(e.message, '', 300));
      throw e;
    }
    // Stabilité : la revalidation (schéma de l'assistant puis applicateur) ne doit rien transformer, sinon le hash
    // calculé à la proposition ne serait pas celui recalculé à la confirmation.
    const canon = asstCanonicalActionsJson([action]);
    const again = asstProposedActionSchema.safeParse(JSON.parse(canon)[0]);
    if (
      canon !== asstCanonicalActionsJson([candidate]) ||
      !again.success ||
      asstCanonicalActionsJson([again.data]) !== canon ||
      asstCanonicalActionsJson([{ tool: action.tool, args: applied } as AsstProposedAction]) !== canon
    ) {
      refuse('unstable_arguments', "Action refusée : arguments instables (erreur interne). Aucune action n'a été proposée.");
    }
    return action;
  }
}
