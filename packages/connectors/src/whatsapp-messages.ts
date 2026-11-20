// Lot 2c — WhatsApp Business : textes envoyés aux expéditeurs.
//
// Textes FIXES en français. Ils ne contiennent jamais de nom de fichier, d'extrait de contenu, de
// nom d'organisation ni d'indication sur la liste blanche : un message WhatsApp sort du périmètre
// de l'organisation et peut être lu par n'importe qui ayant accès au téléphone de l'expéditeur.

/** Référence affichable : lettres, chiffres et tirets, 40 caractères au plus. */
const REFERENCE_REGEX = /^[A-Za-z0-9-]{1,40}$/;
/** Identifiant d'élément (`ged_source_item_id`) en décimal. */
const ITEM_ID_REGEX = /^[0-9]{1,30}$/;

/** Référence d'un document reçu par WhatsApp : `WA-<itemId>`. */
export function whatsappReference(itemId: bigint | string): string {
  let id: string;
  if (typeof itemId === 'bigint') {
    if (itemId < 0n) throw new Error('Identifiant d’élément invalide.');
    id = itemId.toString(10);
  } else if (typeof itemId === 'string') {
    id = itemId;
  } else {
    throw new Error('Identifiant d’élément invalide.');
  }
  if (!ITEM_ID_REGEX.test(id)) throw new Error('Identifiant d’élément invalide.');
  return `WA-${id}`;
}

/** Accusé de réception : « Document reçu. Référence : <reference>. Merci. » */
export function buildAckMessage(reference: string): string {
  if (typeof reference !== 'string' || !REFERENCE_REGEX.test(reference)) {
    throw new Error('Référence de document invalide.');
  }
  return `Document reçu. Référence : ${reference}. Merci.`;
}

const REFUSAL_MESSAGES: Readonly<Record<'unknown_sender' | 'unsupported_type', string>> =
  Object.freeze({
    unknown_sender:
      "Bonjour. Votre message n'a pas pu être pris en compte par ce service. Merci de votre compréhension.",
    unsupported_type:
      'Bonjour. Seuls les documents et les photos peuvent être reçus par ce service. Merci de votre compréhension.',
  });

/** Message poli et générique de refus (n'indique ni l'organisation ni l'existence d'une liste d'expéditeurs). */
export function buildRefusalMessage(reason: 'unknown_sender' | 'unsupported_type'): string {
  if (reason !== 'unknown_sender' && reason !== 'unsupported_type') {
    throw new Error('Motif de refus inconnu.');
  }
  return REFUSAL_MESSAGES[reason];
}

/** Document reçu mais refusé par les contrôles (type, taille, contenu). */
export function buildRejectedMessage(): string {
  return "Votre document n'a pas pu être pris en compte (format ou taille non pris en charge).";
}
