import { ASST_SUMMARY_MAX_CHARS } from '@archivage/types';
import { neutralizeLine, sanitizeText, truncateSafe } from '../../workflow-agents/injection/untrusted';

// Résumé lisible d'une proposition, CONSTRUIT PAR LE CODE à partir des arguments validés et des noms RÉSOLUS
// (courrier relu, acteur résolu, type actif, espace et modèle listés). Jamais le texte du modèle.
// Chaque libellé issu des données passe par `neutralizeLine` (une ligne, chevrons neutralisés, invisibles retirés)
// et est borné ; le résumé complet tient TOUJOURS dans `ASST_SUMMARY_MAX_CHARS`.

/** Référence d'un courrier, relue avec les droits de l'utilisateur. */
export interface SummaryMailRef {
  mailId: number;
  reference: string | null;
  title: string | null;
}

export type SummaryItem =
  | {
      kind: 'imputation';
      mail: SummaryMailRef;
      recipients: ReadonlyArray<{ label: string }>;
      typeLabel: string;
      typeIsDefault: boolean;
      delayDays: number | null;
    }
  | {
      kind: 'relance';
      mail: SummaryMailRef;
      mailInputationId: number;
      actorLabel: string;
      deadline: Date | null;
    }
  | {
      kind: 'brouillon';
      mail: SummaryMailRef | null;
      templateLabel: string;
      spaceLabel: string;
    };

/** Plafonds successifs (caractères) des libellés ; on resserre tant que le résumé dépasse. */
const LABEL_CAPS: readonly number[] = [80, 50, 30, 18, 10];
/** Le titre du courrier est moins utile que les noms : il est borné plus court. */
const TITLE_RATIO = 0.75;

/** Référence « sûre » d'un courrier (caractères d'identifiant seulement), sinon `null`. */
export function safeMailReference(reference: string | null | undefined): string | null {
  if (typeof reference !== 'string') return null;
  const cleaned = sanitizeText(reference, 400).trim();
  return /^[A-Za-z0-9][A-Za-z0-9/._\- ]{0,59}$/.test(cleaned) ? cleaned : null;
}

/** Libellé neutralisé, sur une ligne, borné ; « (sans nom) » s'il est vide. */
export function cleanLabel(text: unknown, max: number): string {
  const out = neutralizeLine(text, '', max);
  return out.length > 0 ? out : '(sans nom)';
}

function mailRef(mail: SummaryMailRef, cap: number): string {
  const ref = mail.reference === null ? '' : neutralizeLine(mail.reference, '', Math.max(8, Math.floor(cap / 2)));
  const title = mail.title === null ? '' : neutralizeLine(mail.title, '', Math.max(8, Math.floor(cap * TITLE_RATIO)));
  return `n°${mail.mailId}${ref ? ` (réf. ${ref})` : ''}${title ? ` « ${title} »` : ''}`;
}

function days(n: number): string {
  return `${n} jour${n > 1 ? 's' : ''}`;
}

function utcDate(d: Date): string {
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${d.getUTCFullYear()}`;
}

function linesFor(item: SummaryItem, cap: number): string[] {
  switch (item.kind) {
    case 'imputation': {
      const type = `type « ${cleanLabel(item.typeLabel, cap)} »${item.typeIsDefault ? ' (type par défaut)' : ''}`;
      const delay = item.delayDays === null ? 'sans délai' : `délai de ${days(item.delayDays)}`;
      const mail = mailRef(item.mail, cap);
      return item.recipients.map(
        (r) => `- Imputer le courrier ${mail} à « ${cleanLabel(r.label, cap)} » : ${type}, ${delay}.`,
      );
    }
    case 'relance': {
      const deadline = item.deadline === null ? '' : `, échéance du ${utcDate(item.deadline)} dépassée`;
      return [
        `- Relancer « ${cleanLabel(item.actorLabel, cap)} » sur le courrier ${mailRef(item.mail, cap)} (imputation n°${item.mailInputationId}${deadline}) par une notification interne.`,
      ];
    }
    case 'brouillon': {
      const mail = item.mail === null ? '' : ` au courrier ${mailRef(item.mail, cap)}`;
      return [
        `- Préparer un brouillon de réponse${mail} (modèle « ${cleanLabel(item.templateLabel, cap)} ») dans l'espace « ${cleanLabel(item.spaceLabel, cap)} » : document brouillon, rien n'est envoyé.`,
      ];
    }
  }
}

/**
 * Résumé de la proposition : un en-tête puis UNE LIGNE PAR EFFET (un destinataire d'imputation = un effet).
 * Garantie : longueur (points de code) <= `max` (par défaut `ASST_SUMMARY_MAX_CHARS`).
 */
export function buildActionSummary(items: readonly SummaryItem[], max: number = ASST_SUMMARY_MAX_CHARS): string {
  const effects = items.reduce((n, i) => n + (i.kind === 'imputation' ? i.recipients.length : 1), 0);
  const header = `À confirmer (${effects} effet${effects > 1 ? 's' : ''}) :`;
  let text = '';
  for (const cap of LABEL_CAPS) {
    text = [header, ...items.flatMap((i) => linesFor(i, cap))].join('\n');
    if (Array.from(text).length <= max) return text;
  }
  return truncateSafe(text, max);
}
