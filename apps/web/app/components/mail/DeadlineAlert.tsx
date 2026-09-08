'use client';

import { Alert } from 'antd';
import dayjs from 'dayjs';
import {
  DATE_BUTOIRE_LABELS,
  dateButoireAlert,
  daysUntilDeadline,
  type DateButoireAlert,
} from '@archivage/types';
import { space } from '../../theme/tokens';

/**
 * Ton du bandeau par palier — le retard et le jour J appellent une action immédiate.
 *
 * Chaque ton d'`Alert` se sert dans le thème (`colorInfo`/`colorWarning`/`colorError`), donc dans
 * les dérivés FORTS AA de la palette (`info` #007e95, `warning` #dd2a00, `danger` #e50047) et
 * jamais dans les vives : la teinte porte l'icône et la bordure, pas le texte.
 */
const TYPE: Record<DateButoireAlert, 'info' | 'warning' | 'error'> = {
  PREMIERE_ALERTE: 'info',
  RAPPEL: 'info',
  DERNIERE_CHANCE: 'warning',
  URGENCE: 'warning',
  RETARD: 'error',
};

/**
 * Bandeau d'échéance sur le détail d'un courrier (§03.5).
 *
 * Utilise EXACTEMENT les paliers des rappels planifiés (`@archivage/types`) : l'écran et l'e-mail
 * doivent dire la même chose le même jour. Un courrier hors palier (J-5, J-2…) n'affiche rien,
 * comme le job ne relance rien — sans quoi l'écran alerterait sur des jours où le système reste
 * volontairement muet.
 *
 * Un courrier déjà traité n'affiche rien non plus : son échéance n'engage plus personne.
 */
export function DeadlineAlert({
  dateButoire,
  treated,
}: {
  dateButoire: string | null;
  treated: boolean;
}) {
  if (!dateButoire || treated) return null;

  const deadline = dayjs(dateButoire);
  if (!deadline.isValid()) return null;

  const days = daysUntilDeadline(deadline.toDate(), new Date());
  const alert = dateButoireAlert(days);
  if (!alert) return null;

  const retard = alert === 'RETARD';
  const jours = Math.abs(days);

  return (
    <Alert
      type={TYPE[alert]}
      showIcon
      style={{ marginBottom: space.lg }}
      /*
        Titre et description sont épinglés sur la couleur de texte neutre du thème. Les teinter
        avec la sémantique de leur palier serait tentant (c'est le réflexe du bandeau « rouge »),
        mais le dérivé fort posé sur son propre fond doux ne mesure que 3,1:1 (info) à 4,2:1
        (avertissement) : le contraste s'effondrerait là où l'alerte doit rester la plus lisible.
      */
      message={
        <span style={{ color: 'var(--ant-color-text)', fontWeight: 600 }}>
          {DATE_BUTOIRE_LABELS[alert]}
        </span>
      }
      description={
        <span style={{ color: 'var(--ant-color-text)' }}>
          {retard
            ? `Ce courrier devait être traité le ${deadline.format('DD/MM/YYYY')} — ${jours} jour${jours > 1 ? 's' : ''} de retard.`
            : `Date butoir : ${deadline.format('DD/MM/YYYY')}.`}
        </span>
      }
    />
  );
}
