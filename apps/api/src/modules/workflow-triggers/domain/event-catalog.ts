import type { WfTriggerEventType } from '@archivage/types';
import type { WfSubjectKind } from './contracts';

/**
 * Catalogue FERMÉ des champs structurés disponibles pour chaque type d'événement (conditions et contexte de
 * l'instance). Aucun texte libre : les champs `string` sont des codes ou des dates ISO (`STRING_FIELD_PATTERN`,
 * sans espace), donc impropres à porter une instruction.
 */
export type WfFieldKind = 'number' | 'boolean' | 'string';

export interface WfFieldSpec {
  kind: WfFieldKind;
  label: string;
}

export interface WfEventSpec {
  subjectType: WfSubjectKind;
  label: string;
  fields: Readonly<Record<string, WfFieldSpec>>;
}

/** Une valeur `string` d'événement : 1 à 40 caractères parmi lettres, chiffres, `_ . : + -` (dates ISO, codes). */
export const STRING_FIELD_PATTERN = /^[A-Za-z0-9_.:+-]{1,40}$/;

export const WF_EVENT_CATALOG: Readonly<Record<WfTriggerEventType, WfEventSpec>> = {
  'mail.arrived': {
    subjectType: 'mail',
    label: 'Courrier arrivé (enregistré)',
    fields: {
      mailType: { kind: 'number', label: 'Type de courrier (0 arrivée, 1 départ, 2 interne)' },
      status: { kind: 'number', label: 'Statut du courrier' },
      mailNatureId: { kind: 'number', label: 'Nature (identifiant)' },
      confidentialiteId: { kind: 'number', label: 'Confidentialité (identifiant)' },
      externalEntityId: { kind: 'number', label: 'Correspondant externe (identifiant)' },
      destinataireRoleId: { kind: 'number', label: 'Rôle destinataire (identifiant)' },
      destinataireUserGroupId: { kind: 'number', label: 'Destinataire nommé (identifiant)' },
      organigrammeId: { kind: 'number', label: 'Organigramme (identifiant)' },
      mailObjetId: { kind: 'number', label: 'Objet normalisé (identifiant du référentiel, pas le texte)' },
      hasDocument: { kind: 'boolean', label: 'Une pièce est rattachée' },
      hasDeadline: { kind: 'boolean', label: 'Une date butoir est posée' },
      dateButoire: { kind: 'string', label: 'Date butoir (ISO UTC)' },
    },
  },
  'document.deposited': {
    subjectType: 'document',
    label: 'Document déposé',
    fields: {
      documentTypeId: { kind: 'number', label: 'Type de document (identifiant)' },
      planId: { kind: 'number', label: 'Plan de classement (identifiant)' },
      locationId: { kind: 'number', label: 'Localisation (identifiant)' },
      dossierId: { kind: 'number', label: 'Dossier (identifiant)' },
      confidentialiteId: { kind: 'number', label: 'Confidentialité (identifiant)' },
      batchId: { kind: 'number', label: "Lot d'acquisition (identifiant)" },
      createdBy: { kind: 'number', label: 'Créateur (user_group_id)' },
      pageCount: { kind: 'number', label: 'Nombre de pages' },
      source: { kind: 'string', label: 'Origine : acquisition, fusion, externe, editeur ou scan' },
    },
  },
  'deadline.reached': {
    subjectType: 'mail',
    label: 'Échéance atteinte (date butoir d’un courrier)',
    fields: {
      mailType: { kind: 'number', label: 'Type de courrier' },
      status: { kind: 'number', label: 'Statut du courrier' },
      mailNatureId: { kind: 'number', label: 'Nature (identifiant)' },
      confidentialiteId: { kind: 'number', label: 'Confidentialité (identifiant)' },
      externalEntityId: { kind: 'number', label: 'Correspondant externe (identifiant)' },
      destinataireRoleId: { kind: 'number', label: 'Rôle destinataire (identifiant)' },
      destinataireUserGroupId: { kind: 'number', label: 'Destinataire nommé (identifiant)' },
      dateButoire: { kind: 'string', label: 'Date butoir (ISO UTC)' },
      hoursOverdue: { kind: 'number', label: 'Heures de dépassement (négatif : échéance à venir)' },
    },
  },
  'threshold.crossed': {
    subjectType: 'document',
    label: 'Seuil dépassé (métadonnée numérique d’un document)',
    fields: {
      documentTypeId: { kind: 'number', label: 'Type de document (identifiant)' },
      dossierId: { kind: 'number', label: 'Dossier (identifiant)' },
      metaDataId: { kind: 'number', label: 'Métadonnée (identifiant)' },
      value: { kind: 'number', label: 'Valeur constatée' },
      thresholdValue: { kind: 'number', label: 'Seuil configuré' },
    },
  },
};
