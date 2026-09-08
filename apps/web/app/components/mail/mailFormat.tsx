import { Typography } from 'antd';
import dayjs from 'dayjs';
import type { MailInputationView } from '../../lib/courriers';

export const fmt = (iso: string | null) => (iso ? dayjs(iso).format('DD/MM/YYYY') : '—');
export const fmtDt = (iso: string | null) => (iso ? dayjs(iso).format('DD/MM/YYYY HH:mm') : '—');

/**
 * `Actor.label` = « Nom — Groupe » (§08 Actor) : ne garde que la personne. Le groupe ne sert qu'à
 * lever l'ambiguïté dans les listes de sélection ; partout ailleurs il n'apporte que du bruit.
 * Le repli sur `label` couvre un libellé sans séparateur (et rend la fonction totale).
 */
export const personName = (label: string) => label.split(' — ')[0] ?? label;

/**
 * Historique d'une imputation : création → échéance → traitement. Trois jalons, tous issus de la
 * ligne `mail_inputation` (pas d'appel supplémentaire). L'échéance passée et non tenue ressort en
 * rouge — c'est le seul signal de retard visible depuis la visionneuse.
 */
export function imputationHistory(
  i: MailInputationView,
  actorLabel: (userGroupId: number) => string,
): Array<{ color: string; children: React.ReactNode }> {
  const overdue =
    i.deadline != null && i.dateTreated == null && dayjs(i.deadline).isBefore(dayjs());
  const items = [
    {
      color: 'blue',
      children: (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Créée le {fmtDt(i.createdAt)}
          {i.createdBy != null ? ` par ${actorLabel(i.createdBy)}` : ''}
        </Typography.Text>
      ),
    },
  ];
  if (i.deadline) {
    items.push({
      color: overdue ? 'red' : 'gray',
      children: (
        <Typography.Text type={overdue ? 'danger' : 'secondary'} style={{ fontSize: 12 }}>
          Échéance {fmtDt(i.deadline)}
          {overdue ? ' — dépassée' : ''}
        </Typography.Text>
      ),
    });
  }
  // Tant que l'imputation n'est pas traitée, on ne rajoute rien : la création (et l'échéance
  // éventuelle) suffisent, pas besoin d'un jalon « en attente ».
  if (i.dateTreated) {
    items.push({
      color: 'green',
      children: (
        <Typography.Text type="success" style={{ fontSize: 12 }}>
          Traitée le {fmtDt(i.dateTreated)}
        </Typography.Text>
      ),
    });
  }
  return items;
}
