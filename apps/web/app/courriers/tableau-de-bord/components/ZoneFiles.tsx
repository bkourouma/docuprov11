'use client';

import { Col, Row, Typography } from 'antd';
import { StatusTile } from '../../../components/StatusTile';
import type { FileCompteur, FilesResponse, MailScope } from '../lib/api';
import type { IconName } from '../../../theme/icons';
import { InfoTooltip } from '../../../components/InfoTooltip';

interface Tuile {
  cle: keyof Omit<FilesResponse, 'scope'>;
  label: string;
  icon: IconName;
  href: string;
  /** Précision affichée sous le compteur — sert surtout à lever les ambiguïtés de périmètre. */
  note?: string;
}

const TUILES: Tuile[] = [
  { cle: 'aControler', label: 'À contrôler', icon: 'mail', href: '/courriers/controle' },
  { cle: 'parapheur', label: 'Parapheur', icon: 'validated', href: '/courriers/parapheur' },
  {
    cle: 'validationDirection',
    label: 'Validation Direction',
    icon: 'check',
    href: '/courriers/validation',
  },
  {
    cle: 'decharge',
    label: 'Décharges en attente',
    icon: 'archive',
    href: '/courriers/integration-decharge',
  },
  { cle: 'enCours', label: 'En cours', icon: 'pending', href: '/courriers/suivi' },
];

/**
 * Zone 2 — tour de contrôle. Chaque compteur reprend le `where` réel de son écran (quirks compris)
 * pour réconcilier visuellement : un utilisateur recoupe toujours ces chiffres avec les listes, et
 * un écart inexpliqué ruine la confiance dans tout l'écran.
 *
 * ⚠️ En périmètre global, « À contrôler » et « Parapheur » sont des compteurs **tous services**,
 * alors que les écrans correspondants ne montrent QUE les courriers de l'utilisateur. L'écart est
 * voulu — il est libellé, faute de quoi il passerait pour un bug.
 */
export function ZoneFiles({
  data,
  loading,
  scope,
}: {
  data: FilesResponse | null;
  loading: boolean;
  scope: MailScope;
}) {
  const global = scope === 'all';

  const noteDe = (cle: Tuile['cle']): string | undefined => {
    if (!global) return 'Mon périmètre';
    if (cle === 'aControler' || cle === 'parapheur') return 'Tous services';
    return undefined;
  };

  const hint = (c: FileCompteur | undefined, note?: string): string | undefined => {
    const morceaux: string[] = [];
    if (note) morceaux.push(note);
    // Une file courte mais ancienne est plus alarmante qu'une longue et fraîche : c'est
    // l'information que les badges de menu ne donnent pas.
    if (c && c.count > 0 && c.oldestDays !== null) {
      morceaux.push(`plus ancien : ${c.oldestDays} j`);
    }
    return morceaux.length ? morceaux.join(' · ') : undefined;
  };

  return (
    <Row gutter={[16, 16]}>
      {TUILES.map((t) => {
        const c = data?.[t.cle];
        const note = noteDe(t.cle);
        return (
          // `flex` plutôt que des breakpoints `span` fixes : les tuiles se répartissent sur toute
          // la largeur quel que soit leur nombre, sans orphelin de fin de ligne ni recalcul manuel
          // si la liste change à nouveau (c'est ce qui a cassé le rendu au retrait des 2 tuiles).
          // `data-testid` : le libellé seul est ambigu (« En cours » figure aussi en Synthèse).
          <Col key={t.cle} xs={12} sm={8} flex="1 1 180px" data-testid={`tdb-file-${t.cle}`}>
            <StatusTile
              icon={t.icon}
              label={t.label}
              value={c ? c.count : null}
              hint={hint(c, note)}
              // Une file ancienne mérite l'œil même si elle est courte.
              tone={c && c.count > 0 && (c.oldestDays ?? 0) > 30 ? 'warning' : 'info'}
              href={t.href}
              loading={loading && !data}
            />
          </Col>
        );
      })}
    </Row>
  );
}

/** Rappel de périmètre affiché en tête de zone. */
export function MentionPerimetre({ scope }: { scope: MailScope }) {
  const texte =
    scope === 'all'
      ? 'Périmètre : tous les courriers'
      : scope === 'imputed'
        ? 'Périmètre : les courriers où vous êtes imputé'
        : 'Aucun périmètre de suivi accordé';
  return (
    <InfoTooltip title="Le périmètre découle de vos permissions de suivi ; il n'est pas modifiable ici.">
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {texte}
      </Typography.Text>
    </InfoTooltip>
  );
}
