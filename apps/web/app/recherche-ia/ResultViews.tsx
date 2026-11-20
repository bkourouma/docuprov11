'use client';

import { Fragment, type ReactNode } from 'react';
import Link from 'next/link';
import { Alert, Card, Skeleton, Typography } from 'antd';
import type { GedCitation, GedSemanticHit } from '@archivage/types';
import { EmptyState } from '../components/EmptyState';
import { icons } from '../theme/icons';
import { fontSize, space } from '../theme/tokens';

const { Text } = Typography;

/** Libellé de pages : « p. 3 » ou « p. 3 à 5 » ; vide si aucune page connue. */
export function pagesLabel(from: number | null, to: number | null): string | null {
  if (from == null && to == null) return null;
  const a = from ?? to;
  const b = to ?? from;
  return a === b ? `p. ${a}` : `p. ${a} à ${b}`;
}

/** Ligne de références : version, pages (éléments absents omis). */
function metaLine(versionNumber: number | null, pageFrom: number | null, pageTo: number | null): string {
  return [versionNumber != null ? `version ${versionNumber}` : null, pagesLabel(pageFrom, pageTo)]
    .filter(Boolean)
    .join(' · ');
}

/**
 * Lien vers le document. La visionneuse (/documents/[documentId]) n'accepte aucun paramètre
 * d'URL de version ou de page : le lien est donc simple, la version et les pages sont indiquées
 * en clair à côté.
 */
function documentHref(documentId: number): string {
  return `/documents/${documentId}`;
}

const excerptStyle = {
  margin: `${space.sm}px 0 0`,
  paddingLeft: space.md,
  borderLeft: '2px solid var(--ant-color-border)',
  color: 'var(--ant-color-text-secondary)',
  fontSize: fontSize.base,
  overflowWrap: 'anywhere' as const,
  whiteSpace: 'pre-wrap' as const,
};

/** Texte de réponse rendu comme TEXTE ; seuls les marqueurs [n] connus deviennent des boutons. */
export function AnswerText({
  text,
  markers,
  onMarker,
}: {
  text: string;
  markers: Set<number>;
  onMarker: (marker: number) => void;
}) {
  const parts = text.split(/(\[\d{1,3}\])/g);
  return (
    <p style={{ margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.7 }}>
      {parts.map((part, i) => {
        const m = /^\[(\d{1,3})\]$/.exec(part);
        const n = m ? Number(m[1]) : null;
        if (n != null && markers.has(n)) {
          return (
            <button
              key={i}
              type="button"
              className="ria-marker"
              aria-label={`Aller à la source ${n}`}
              onClick={() => onMarker(n)}
            >
              [{n}]
            </button>
          );
        }
        return <Fragment key={i}>{part}</Fragment>;
      })}
    </p>
  );
}

export function CitationList({ citations }: { citations: GedCitation[] }) {
  return (
    <ol className="ria-list" aria-label="Sources citées">
      {citations.map((c) => (
        <li key={c.marker} id={`ria-source-${c.marker}`} tabIndex={-1} className="ria-item">
          <div className="ria-item-head">
            <span className="ria-badge" aria-hidden="true">
              {c.marker}
            </span>
            <div style={{ minWidth: 0 }}>
              <Link href={documentHref(c.documentId)} aria-label={`Source ${c.marker} : ouvrir ${c.documentLabel}`}>
                {c.documentLabel}
              </Link>
              <div>
                <Text type="secondary" style={{ fontSize: fontSize.sm }}>
                  {metaLine(c.versionNumber, c.pageFrom, c.pageTo)}
                </Text>
              </div>
            </div>
          </div>
          {c.excerpt && <blockquote style={excerptStyle}>{c.excerpt}</blockquote>}
        </li>
      ))}
    </ol>
  );
}

export function HitList({ hits, label }: { hits: GedSemanticHit[]; label: string }) {
  return (
    <ul className="ria-list" aria-label={label}>
      {hits.map((h, i) => {
        const meta = metaLine(h.versionNumber, h.pageFrom, h.pageTo);
        return (
          <li key={`${h.documentId}-${h.chunkIndex ?? 'doc'}-${i}`} className="ria-item">
            <div className="ria-item-head" style={{ justifyContent: 'space-between' }}>
              <div style={{ minWidth: 0 }}>
                <Link href={documentHref(h.documentId)}>{h.documentLabel}</Link>
                {meta && (
                  <div>
                    <Text type="secondary" style={{ fontSize: fontSize.sm }}>
                      {meta}
                    </Text>
                  </div>
                )}
              </div>
              {h.score != null && (
                <Text type="secondary" style={{ fontSize: fontSize.sm, flex: 'none' }}>
                  {Math.round(Math.min(1, Math.max(0, h.score)) * 100)} % de pertinence
                </Text>
              )}
            </div>
            {h.excerpt && <blockquote style={excerptStyle}>{h.excerpt}</blockquote>}
          </li>
        );
      })}
    </ul>
  );
}

/** Bandeau « IA désactivée » (repli plein texte). */
export function FulltextBanner({ message }: { message?: string }) {
  return (
    <Alert
      type="info"
      showIcon
      style={{ marginBottom: space.lg }}
      message="L’IA est désactivée"
      description={message ?? 'Les résultats proviennent de la recherche plein texte.'}
    />
  );
}

/** État « je ne sais pas » : sobre, sans source, avec suggestion de reformuler. */
export function UnknownState({ answer }: { answer: string }) {
  const Glyph = icons.search;
  return (
    <div className="ria-unknown">
      <span className="ria-unknown-icon" aria-hidden="true">
        <Glyph size={22} />
      </span>
      <div style={{ minWidth: 0 }}>
        <Text strong style={{ display: 'block' }}>
          Aucune réponse fiable trouvée
        </Text>
        <p style={{ margin: `${space.xs}px 0 0`, overflowWrap: 'anywhere' }}>{answer}</p>
        <p style={{ margin: `${space.sm}px 0 0`, color: 'var(--ant-color-text-secondary)' }}>
          Essayez de reformuler votre question avec d’autres mots, ou de la rendre plus précise (nom du
          document, de la période ou du sujet).
        </p>
      </div>
    </div>
  );
}

export function ResultsSkeleton() {
  return (
    <Card aria-busy="true" aria-label="Chargement des résultats">
      <Skeleton active title={{ width: 140 }} paragraph={{ rows: 4 }} />
      <Skeleton active title={{ width: 110 }} paragraph={{ rows: 2 }} style={{ marginTop: space.lg }} />
    </Card>
  );
}

export function EmptyResults({ children }: { children?: ReactNode }) {
  return <EmptyState icon="search" title="Aucun résultat pour cette recherche" action={children} compact />;
}
