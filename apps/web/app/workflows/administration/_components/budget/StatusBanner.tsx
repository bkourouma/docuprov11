import { GED_AI_MODE_LABELS, type GedAiMode, type WfBudgetDto } from '@archivage/types';
import { icons, iconDefaults } from '../../../../theme/icons';
import { statusSummary } from '../../../_lib/budget-logic';
import { formatDateTime } from '../../../_lib/format';
import { stopAuthorText } from './budget-view-logic';

interface StatusLike {
  aiEnabled: boolean;
  aiMode: number;
  emergencyStopGlobal: boolean;
}
interface OverviewLike {
  global: WfBudgetDto;
  workflows: WfBudgetDto[];
}

/** Bandeau d'état : IA, arrêt d'urgence global, workflows à l'arrêt. Alerte visible si l'arrêt global est actif. */
export function StatusBanner({ status, overview }: { status: StatusLike | null; overview: OverviewLike | null }) {
  const summary = statusSummary(status, overview);
  const globalStop = status?.emergencyStopGlobal === true || overview?.global.emergencyStop === true;
  const stopped = overview ? overview.workflows.filter((w) => w.emergencyStop).length : 0;
  const AlertGlyph = icons.alert;
  const InfoGlyph = status?.aiEnabled === false ? icons.lock : icons.check;
  const g = overview?.global;

  return (
    <section className="wfp-status" aria-labelledby="wfp-status-title">
      <h2 id="wfp-status-title" className="wfp-h2">
        État des agents
      </h2>
      {globalStop && (
        <div className="wfp-alert-stop" role="alert">
          <AlertGlyph size={22} strokeWidth={iconDefaults.strokeWidth} aria-hidden="true" />
          <div>
            <p className="wfp-alert-title">Arrêt d’urgence global actif : aucun agent ne fonctionne.</p>
            <p>
              Activé par {stopAuthorText(g?.emergencyStopBy)}, le {formatDateTime(g?.emergencyStopAt)}.{' '}
              {g?.emergencyStopReason ? `Motif : ${g.emergencyStopReason}` : 'Aucun motif indiqué.'}
            </p>
          </div>
        </div>
      )}
      <p className="wfp-summary">
        <InfoGlyph size={16} strokeWidth={iconDefaults.strokeWidth} aria-hidden="true" /> {summary}
      </p>
      {status && (
        <ul className="wfp-chips">
          <li>
            {status.aiEnabled ? 'IA active' : 'IA désactivée'} (mode : {GED_AI_MODE_LABELS[status.aiMode as GedAiMode] ?? 'inconnu'})
          </li>
          <li>{globalStop ? 'Arrêt global : actif' : 'Arrêt global : inactif'}</li>
          <li>{overview ? `Workflows à l’arrêt : ${stopped}` : 'Workflows à l’arrêt : inconnu'}</li>
        </ul>
      )}
    </section>
  );
}
