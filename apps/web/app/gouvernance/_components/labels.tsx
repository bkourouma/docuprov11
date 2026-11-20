'use client';

import type { ReactNode } from 'react';
import { Tag, Typography } from 'antd';
import {
  GOVERNANCE_KIND_LABELS,
  GOVERNANCE_PII_ENTITY_LABELS,
  GOVERNANCE_STATUS_LABELS,
  GovernanceKind,
  type GovernanceDuplicateOutput,
  type GovernanceProposalView,
  type GovernanceSensitivityReason,
  type GovernanceStatus,
} from '@archivage/types';
import { icons } from '../../theme/icons';
import { fontSize, space } from '../../theme/tokens';

const { Text } = Typography;

/** Libellés lisibles des raisons d'une proposition de sensibilité. */
export const SENSITIVITY_REASON_LABELS: Record<GovernanceSensitivityReason, string> = {
  pii_email: 'Adresses e-mail détectées',
  pii_phone: 'Numéros de téléphone détectés',
  pii_iban: 'IBAN détectés',
  pii_card: 'Numéros de carte bancaire détectés',
  pii_nir: 'Numéros de sécurité sociale détectés',
  pii_identity: 'Pièces d’identité détectées',
  pii_name: 'Noms de personnes détectés par le modèle',
  keyword_health: 'Vocabulaire lié à la santé',
  keyword_hr: 'Vocabulaire lié aux ressources humaines',
  keyword_legal: 'Vocabulaire juridique ou contentieux',
  keyword_finance: 'Vocabulaire financier sensible',
  keyword_secret: 'Mentions de confidentialité ou de secret',
  ai_moderate: 'Avis du modèle : sensibilité modérée',
  ai_high: 'Avis du modèle : sensibilité élevée',
};

/** Méthode de détection d'un doublon. */
export const DUPLICATE_METHOD_LABELS: Record<GovernanceDuplicateOutput['method'], string> = {
  file_hash: 'empreinte du fichier identique',
  source_hash: 'empreinte de la source identique',
  embedding: 'similarité sémantique',
  title_metadata: 'titre et métadonnées proches',
};

/** Pourcentage entier (0..1 -> « 87 % ») ; tiret si inconnu. */
export function percent(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return '—';
  return `${Math.round(value * 100)} %`;
}

const dateTime = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
const dateOnly = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short' });

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : dateTime.format(d);
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : dateOnly.format(d);
}

export function formatBytes(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1).replace('.', ',')} Ko`;
  return `${(n / (1024 * 1024)).toFixed(1).replace('.', ',')} Mo`;
}

/** Libellé de document : le libellé reçu, sinon le numéro. */
export function docName(id: number | null, label: string | null): string {
  if (label) return label;
  return id != null ? `Document n° ${id}` : 'Document inconnu';
}

const KIND_COLOR: Record<GovernanceKind, string> = {
  [GovernanceKind.DoublonExact]: 'blue',
  [GovernanceKind.QuasiDoublon]: 'geekblue',
  [GovernanceKind.DonneesPersonnelles]: 'purple',
  [GovernanceKind.Sensibilite]: 'gold',
};

export function KindTag({ kind }: { kind: GovernanceKind }) {
  return <Tag color={KIND_COLOR[kind]}>{GOVERNANCE_KIND_LABELS[kind]}</Tag>;
}

const STATUS_COLOR: Record<GovernanceStatus, string> = { 0: 'processing', 1: 'success', 2: 'default' };

/** Statut : texte toujours présent (la couleur ne porte jamais seule le sens). */
export function StatusTag({ status }: { status: GovernanceStatus }) {
  return <Tag color={STATUS_COLOR[status]}>{GOVERNANCE_STATUS_LABELS[status]}</Tag>;
}

/** Libellés d'action selon la nature de la proposition. */
export function validateWording(kind: GovernanceKind): {
  button: string;
  title: string;
  note: string | null;
} {
  switch (kind) {
    case GovernanceKind.DoublonExact:
    case GovernanceKind.QuasiDoublon:
      return {
        button: 'Archiver le doublon',
        title: 'Archiver ce doublon ?',
        note: 'Archivage logique : le document n’est pas supprimé.',
      };
    case GovernanceKind.Sensibilite:
      return {
        button: 'Appliquer le niveau',
        title: 'Appliquer le niveau de confidentialité proposé ?',
        note: null,
      };
    default:
      return {
        button: 'Prendre acte',
        title: 'Prendre acte de cette détection ?',
        note: 'Aucune modification n’est faite sur le document.',
      };
  }
}

/** Avertissement affiché pour qu'une action ne soit jamais un effet de bord caché. */
export function directionTag(view: GovernanceProposalView): ReactNode {
  if (view.output.kind !== GovernanceKind.Sensibilite) return null;
  const raise = view.output.direction === 'raise';
  const Glyph = raise ? icons.chevronUp : icons.chevronDown;
  return (
    <Tag color={raise ? 'success' : 'warning'}>
      <Glyph size={fontSize.xs} style={{ verticalAlign: 'text-bottom', marginInlineEnd: space.xs }} />
      {raise ? 'Élévation' : 'Abaissement'}
    </Tag>
  );
}

/** Détail court d'une proposition, pour la liste. Texte uniquement. */
export function ProposalSummary({ view }: { view: GovernanceProposalView }) {
  const out = view.output;
  if (out.kind === GovernanceKind.DoublonExact || out.kind === GovernanceKind.QuasiDoublon) {
    return (
      <div className="gov-short">
        <Text>Copie de « {docName(view.originalDocumentId, view.originalDocumentLabel)} »</Text>
        <Text type="secondary" style={{ fontSize: fontSize.sm }}>
          {DUPLICATE_METHOD_LABELS[out.method]} · similarité {percent(out.similarity)}
        </Text>
      </div>
    );
  }
  if (out.kind === GovernanceKind.DonneesPersonnelles) {
    return (
      <div className="gov-short">
        {out.findings.map((f) => (
          <Text key={f.entity}>
            {GOVERNANCE_PII_ENTITY_LABELS[f.entity]} ({f.count})
          </Text>
        ))}
      </div>
    );
  }
  return (
    <div className="gov-short">
      <Text>
        {view.currentConfidentialiteLabel ?? 'Aucun niveau'} → {view.proposedConfidentialiteLabel ?? 'Niveau proposé'}
      </Text>
      <span>{directionTag(view)}</span>
    </div>
  );
}
