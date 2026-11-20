'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { Tag, Typography } from 'antd';
import type { GovernanceDocumentSummary } from '@archivage/types';
import { formatBytes, formatDate, formatDateTime } from './labels';

interface Field {
  key: string;
  label: string;
  /** Valeur normalisée pour la comparaison (chaîne). */
  value: (d: GovernanceDocumentSummary) => string;
  render?: (d: GovernanceDocumentSummary) => ReactNode;
}

const none = '—';

const FIELDS: Field[] = [
  {
    key: 'label',
    label: 'Libellé',
    value: (d) => d.label,
    render: (d) => <Link href={`/documents/${d.documentId}`}>{d.label}</Link>,
  },
  { key: 'cote', label: 'Cote', value: (d) => d.cote ?? none },
  { key: 'type', label: 'Type de document', value: (d) => d.documentTypeLabel ?? none },
  { key: 'date', label: 'Date du document', value: (d) => formatDate(d.documentDate) },
  { key: 'conf', label: 'Confidentialité', value: (d) => d.confidentialiteLabel ?? none },
  { key: 'created', label: 'Créé le', value: (d) => formatDateTime(d.createdAt) },
  { key: 'files', label: 'Nombre de fichiers', value: (d) => String(d.fileCount) },
  { key: 'pages', label: 'Pages', value: (d) => (d.pageCount == null ? none : String(d.pageCount)) },
  { key: 'size', label: 'Taille', value: (d) => formatBytes(d.byteLength) },
  {
    key: 'overview',
    label: 'Extrait de la synthèse',
    value: (d) => d.overviewExcerpt ?? none,
    render: (d) =>
      d.overviewExcerpt ? (
        <span style={{ whiteSpace: 'pre-wrap' }}>{d.overviewExcerpt}</span>
      ) : (
        <Typography.Text type="secondary">{none}</Typography.Text>
      ),
  },
];

function Column({
  title,
  doc,
  other,
}: {
  title: string;
  doc: GovernanceDocumentSummary;
  other: GovernanceDocumentSummary;
}) {
  return (
    <section className="gov-compare-col" aria-label={title}>
      <h4>
        {title}
        {doc.isFrozen && (
          <Tag style={{ marginInlineStart: 8 }}>Document figé</Tag>
        )}
      </h4>
      {FIELDS.map((f) => {
        const differs = f.value(doc) !== f.value(other);
        return (
          <div key={f.key} className={`gov-field${differs ? ' gov-field-diff' : ''}`}>
            <span className="gov-field-name">
              {f.label}
              {differs && <Tag style={{ marginInlineEnd: 0 }}>différent</Tag>}
            </span>
            <div>{f.render ? f.render(doc) : f.value(doc)}</div>
          </div>
        );
      })}
    </section>
  );
}

/**
 * Comparaison côte à côte (l'une sous l'autre sur écran étroit). Un champ qui diffère est
 * signalé par le texte « différent » ET un fond discret : la couleur ne porte jamais seule le sens.
 * Tout est rendu comme texte.
 */
export function DuplicateComparison({
  original,
  duplicate,
}: {
  original: GovernanceDocumentSummary;
  duplicate: GovernanceDocumentSummary;
}) {
  return (
    <div className="gov-compare">
      <Column title="Original" doc={original} other={duplicate} />
      <Column title="Doublon proposé" doc={duplicate} other={original} />
    </div>
  );
}
