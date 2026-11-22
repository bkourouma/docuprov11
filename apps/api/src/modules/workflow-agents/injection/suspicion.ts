import { sanitizeText } from './untrusted';

/**
 * Détection HEURISTIQUE des tentatives d'injection de consignes (français et anglais).
 *
 * Elle SIGNALE (drapeau `suspicion_injection`, revue humaine) ; elle n'est PAS la défense : celle-ci tient
 * à l'isolation des données (blocs à jeton, chevrons neutralisés), au schéma de sortie strict, à la liste
 * blanche d'outils de l'étape et à la validation humaine. Un faux négatif ne donne donc aucun droit ; un
 * faux positif renvoie seulement la proposition à un humain, sans action préparée.
 *
 * Les raisons sont des CODES courts : jamais un extrait du contenu analysé.
 */

export type InjectionReason =
  | 'ignorer_consignes'
  | 'changement_role'
  | 'prompt_systeme'
  | 'revelation_consignes'
  | 'exfiltration'
  | 'fausse_balise'
  | 'faux_message_role'
  | 'faux_appel_outil'
  | 'caracteres_caches';

export interface InjectionDetection {
  suspicious: boolean;
  reasons: InjectionReason[];
}

/** Texte analysé au plus (unités UTF-16) : au-delà, le prompt ne le transmet de toute façon pas. */
export const DETECTION_MAX_CHARS = 200_000;

// Contrebande « tag » (U+E0000-E007F) et forçages bidirectionnels (U+202D/202E, U+2066-2069) : rares dans
// un courrier légitime, classiques pour cacher une consigne au relecteur.
const HIDDEN_SMUGGLING = /[\u202D\u202E\u2066-\u2069\u{E0000}-\u{E007F}]/u;

// Sosies latins usuels (cyrillique, grec) : utilisés seulement pour la DÉTECTION, jamais pour réécrire.
const CONFUSABLES: Record<string, string> = {
  '\u0430': 'a', '\u0435': 'e', '\u043E': 'o', '\u0440': 'p', '\u0441': 'c', '\u0445': 'x', '\u0443': 'y', '\u0456': 'i', '\u0458': 'j', '\u0455': 's', '\u0501': 'd', '\u04BB': 'h', '\u04CF': 'l',
  '\u03BF': 'o', '\u03B1': 'a', '\u03B5': 'e', '\u03B9': 'i', '\u03BA': 'k', '\u03BD': 'v', '\u03C4': 't', '\u03C1': 'p', '\u03C5': 'u', '\u03C7': 'x',
};
const CONFUSABLE_RE = new RegExp(`[${Object.keys(CONFUSABLES).join('')}]`, 'g');

/** Forme canonique pour la détection : minuscules, sans accents, sosies ramenés, chevrons ramenés à `<`/`>`. */
export function normalizeForDetection(input: unknown): string {
  return sanitizeText(input, DETECTION_MAX_CHARS)
    .toLowerCase()
    .replace(CONFUSABLE_RE, (c) => CONFUSABLES[c] ?? c)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[\u2018’\u201B\u2032\u00B4`]/g, "'")
    .replace(/[\u201C\u201D\u201E\u2033«»]/g, '"')
    .replace(/[‹\u2329\u27E8\u3008]/g, '<')
    .replace(/[›\u232A\u27E9\u3009]/g, '>')
    .replace(/[\u226A\u27EA\u300A]/g, '<<')
    .replace(/[\u226B\u27EB\u300B]/g, '>>')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[ \t\u00A0\u202F\u3000]+/g, ' ');
}

// Vocabulaire : « consignes » au sens d'un modèle.
const RULES_FR = '(?:regles?|instructions?|consignes?|directives?|prompts?|restrictions?|garde-fous|limitations?)';
const RULES_EN_ALT = 'instructions?|rules?|prompts?|directives?|guidelines?|constraints?|restrictions?|guardrails?';
const RULES_EN = `(?:${RULES_EN_ALT})`;
// Destination d'une exfiltration : adresse électronique ou URL.
const DESTINATION = '(?:[a-z0-9._%+-]+@[a-z0-9-]+(?:\\.[a-z0-9-]+)+|https?://|www\\.|ftp://)';
const OBJECT_FR = '(?:documents?|fichiers?|courriers?|courriels?|mails?|dossiers?|pieces?|donnees|contenus?|contrats?|factures?|informations?|tout|toutes?|copies?|pj|archives?)';
const OBJECT_EN = '(?:documents?|files?|mails?|emails?|letters?|folders?|data|contents?|contracts?|invoices?|records?|information|everything|attachments?|archives?|copies)';

interface Rule {
  reason: InjectionReason;
  re: RegExp;
}

const RULES: readonly Rule[] = [
  // --- Ignorer / oublier les consignes -----------------------------------------------------------------
  {
    reason: 'ignorer_consignes',
    re: new RegExp(
      `\\b(?:ignore[rsz]?|ignorez|oubli(?:e|es|ez|er)|neglige[rz]?|outrepasse[rz]?|contourne[rz]?|desobei[rs]?|ne (?:tiens|tenez|tenir) (?:pas|plus) compte d[eu']s?|fai(?:s|tes) abstraction d[eu']s?)\\b[^.\\n]{0,40}?\\b${RULES_FR}\\b`,
    ),
  },
  { reason: 'ignorer_consignes', re: /\boubli(?:e|ez)[- ]tout\b|\boubli(?:e|ez) (?:tout )?ce qu(?:e|'on|i) (?:t'|vous )?(?:a|as|avez|ete|on t)/ },
  { reason: 'ignorer_consignes', re: /\b(?:ignore|oubli(?:e|ez)|ignorez) tout ce qui (?:precede|est au-dessus|a ete dit)\b/ },
  {
    reason: 'ignorer_consignes',
    re: new RegExp(
      `\\b(?:ignore|disregard|forget|override|bypass|neglect)\\b[^.\\n]{0,40}?\\b${RULES_EN}\\b`,
    ),
  },
  { reason: 'ignorer_consignes', re: /\bforget (?:everything|all of (?:it|that|the above))\b|\bignore (?:everything|all of) (?:above|before|previous|that)\b/ },

  // --- Changement de rôle ------------------------------------------------------------------------------
  { reason: 'changement_role', re: /\b(?:tu es|t'es) (?:maintenant|desormais|a present|dorenavant)\b/ },
  {
    reason: 'changement_role',
    re: /\bvous etes (?:maintenant|desormais|a present|dorenavant) (?:un |une |l'|le |la )?(?:assistant|ia|agent|robot|administrateur|developpeur|modele|pirate|dan)\b/,
  },
  { reason: 'changement_role', re: /\b(?:a partir de maintenant|desormais|dorenavant),? tu (?:es|dois|agis|reponds|obeis)\b/ },
  // « nouveau rôle » adressé au modèle (« ton nouveau rôle », « Nouveau rôle : ») ; pas « son nouveau rôle de directeur ».
  {
    reason: 'changement_role',
    re: /\b(?:ton|ta|voici (?:ton|ta|le|un|une)|tu as (?:un|une|le)|adopte(?:z)? (?:un|une|le|ce|cette))\s+nouve(?:au|lle) (?:role|personnalite|persona)\b|\bnouve(?:au|lle) (?:role|personnalite|persona)\s*:/,
  },
  { reason: 'changement_role', re: /\bnouvelles? (?:instructions?|directives?|consignes?) (?:systeme|pour (?:toi|l'assistant|l'ia|l'agent|le modele|le robot))\b/ },
  { reason: 'changement_role', re: /\b(?:agis|agissez|comporte-toi|comportez-vous|fais semblant|faites semblant|joue(?:z)? le role)\b[^.\n]{0,20}\b(?:comme|en tant que|d'etre|de)\b[^.\n]{0,20}\b(?:administrateur|admin|developpeur|systeme|ia|assistant|robot|dan|pirate|sans (?:limite|restriction|filtre))/ },
  { reason: 'changement_role', re: /\bmode (?:developpeur|administrateur|admin|debogage|debug|dan|dieu|sans (?:limite|restriction|filtre))\b/ },
  { reason: 'changement_role', re: /\byou are now\b|\bfrom now on,? you (?:are|will|must|should)\b|\byou (?:will|must) now act\b/ },
  { reason: 'changement_role', re: /\bnew (?:role|persona|personality|system (?:prompt|message))\b|\b(?:your|the) new instructions\b|\bnew instructions\s*:/ },
  { reason: 'changement_role', re: /\b(?:act|behave) as (?:an? |the )?(?:admin|administrator|developer|system|unrestricted|unfiltered|jailbroken|dan|root)\b|\bpretend (?:to be|you are|that you)\b|\broleplay as\b/ },
  { reason: 'changement_role', re: /\b(?:developer|dan|god|admin|debug|unrestricted) mode\b|\bjailbreak/ },

  // --- Prompt système ----------------------------------------------------------------------------------
  { reason: 'prompt_systeme', re: /\b(?:system|systeme) ?prompt\b|\bprompt (?:systeme|system|initial|cache|secret)\b/ },
  { reason: 'prompt_systeme', re: /\bmessage (?:systeme|du systeme)\b|\bsystem message\b|\binitial (?:prompt|instructions)\b/ },
  { reason: 'prompt_systeme', re: new RegExp(`\\b${RULES_FR} (?:systeme|du systeme|initiales?|cachees?|secretes?)\\b`) },
  { reason: 'prompt_systeme', re: new RegExp(`\\b(?:hidden|secret|original) ${RULES_EN}\\b`) },

  // --- Révéler les consignes ---------------------------------------------------------------------------
  {
    reason: 'revelation_consignes',
    re: new RegExp(
      `\\b(?:revele[rsz]?|divulgue[rsz]?|recite[rsz]?|repete[rsz]?|affiche[rsz]?|montre[rsz]?|donne[rsz]?|ecri[st]|ecrivez|imprime[rsz]?|copie[rsz]?|dis|dites)(?:-(?:moi|nous))?\\b[^.\\n]{0,15}?\\b(?:tes|ton|ta)\\b[^.\\n]{0,20}?\\b${RULES_FR}\\b`,
    ),
  },
  {
    reason: 'revelation_consignes',
    re: new RegExp(`\\b(?:revele[rsz]?|divulgue[rsz]?|recite[rsz]?)\\b[^.\\n]{0,15}?\\b(?:vos|votre|les|le|la)\\b[^.\\n]{0,20}?\\b${RULES_FR}\\b`),
  },
  { reason: 'revelation_consignes', re: /\b(?:revele|donne|affiche|montre|dis)[- ](?:moi|nous)? ?(?:le|ton|votre) jeton\b/ },
  {
    reason: 'revelation_consignes',
    re: new RegExp(
      `\\b(?:reveal|print|show|repeat|output|display|tell me|leak|disclose|recite|dump|write out)\\b[^.\\n]{0,30}?\\b(?:your|the|system|initial|hidden|secret|original)\\b[^.\\n]{0,20}?\\b(?:${RULES_EN_ALT}|nonce|token|delimiters?)\\b`,
    ),
  },

  // --- Exfiltration ------------------------------------------------------------------------------------
  {
    reason: 'exfiltration',
    re: new RegExp(
      `\\b(?:envoie[rsz]?|envoyez|envoyer|transfere[rsz]?|transmet[stz]?|transmettez|transmettre|expedie[rsz]?|partage[rsz]?|fai(?:s|tes) suivre|faire suivre|redirige[rsz]?|copie[rsz]?|publie[rsz]?|televerse[rsz]?|exporte[rsz]?)\\b[^\\n]{0,80}?\\b${OBJECT_FR}\\b[^\\n]{0,80}?${DESTINATION}`,
    ),
  },
  {
    reason: 'exfiltration',
    re: new RegExp(
      `\\b(?:envoie|transfere|transmets|expedie|partage|fais suivre|redirige)\\b[^.\\n]{0,20}?\\b(?:ce|ces|cet|cette|le|les|tous les|toutes les|tout|l'ensemble)\\b[^.\\n]{0,20}?\\b${OBJECT_FR}\\b[^.\\n]{0,40}?\\b(?:a|au|aux|vers|chez)\\b`,
    ),
  },
  {
    reason: 'exfiltration',
    re: new RegExp(
      `\\b(?:send|forward|e-?mail|transfer|transmit|upload|post|exfiltrate|share|leak|copy|export)\\b[^\\n]{0,80}?\\b${OBJECT_EN}\\b[^\\n]{0,80}?${DESTINATION}`,
    ),
  },
  {
    reason: 'exfiltration',
    re: new RegExp(`\\b(?:send|forward|transfer|exfiltrate|leak)\\b[^.\\n]{0,20}?\\b(?:this|these|the|all|every)\\b[^.\\n]{0,20}?\\b${OBJECT_EN}\\b[^.\\n]{0,30}?\\b(?:to|towards)\\b`),
  },

  // --- Fausses balises de bloc et jetons de structure ----------------------------------------------------
  { reason: 'fausse_balise', re: /<<\s*\/?\s*(?:fin_|end_|debut_|begin_)?(?:donnees|data|document|consigne|objectif|systeme|system|regles|squelette|outil|tool|resultat|result|instructions?|user|assistant)\b/ },
  { reason: 'fausse_balise', re: /\b(?:fin|end|debut|begin)_(?:donnees|data|objectif|consigne|regles|systeme|system|document|outil|resultat)\b/ },
  { reason: 'fausse_balise', re: /<\s*\/?\s*(?:data|donnees|document|system|systeme|instructions?|user|assistant|tool|tool_result|function|context|prompt|im_start|im_end)\b[^<>\n]{0,60}>/ },
  { reason: 'fausse_balise', re: /<\|\s*(?:im_start|im_end|endoftext|system|assistant|user|eot_id|start_header_id|end_header_id)\s*\|>|\[\/?(?:inst|sys|system)\]|<<\/?sys>>/ },
  { reason: 'fausse_balise', re: /^\s*#{2,}\s*(?:system|systeme|instruction|instructions|assistant|consignes?)\b/m },

  // --- Faux messages de rôle -----------------------------------------------------------------------------
  { reason: 'faux_message_role', re: /^\s*[[(]?\s*(?:system|systeme|assistant|developer|developpeur|administrateur|admin|ia|ai|model|modele|claude|chatgpt|gpt)\s*[\])]?\s*:/m },
  { reason: 'faux_message_role', re: /["']role["']\s*:\s*["'](?:system|assistant|developer|tool|function)["']/ },

  // --- JSON imitant un appel d'outil ou une conclusion du modèle -----------------------------------------
  { reason: 'faux_appel_outil', re: /["']type["']\s*:\s*["'](?:tool_call|tool_use|function_call|final)["']/ },
  { reason: 'faux_appel_outil', re: /["'](?:tool|tool_name|tool_calls?|function_call|tool_use|tool_choice)["']\s*:/ },
  { reason: 'faux_appel_outil', re: /["']arguments["']\s*:\s*[{"']/ },
];

/**
 * Analyse un texte NON FIABLE. Ne lève jamais ; ne renvoie aucun extrait du texte.
 */
export function detectInjection(text: unknown): InjectionDetection {
  const reasons = new Set<InjectionReason>();
  const raw = typeof text === 'string' ? text.slice(0, DETECTION_MAX_CHARS) : '';
  if (raw && HIDDEN_SMUGGLING.test(raw)) reasons.add('caracteres_caches');
  const norm = normalizeForDetection(raw);
  if (norm) {
    for (const rule of RULES) {
      if (reasons.has(rule.reason)) continue;
      if (rule.re.test(norm)) reasons.add(rule.reason);
    }
  }
  return { suspicious: reasons.size > 0, reasons: [...reasons] };
}
