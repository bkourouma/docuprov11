'use client';

import { Alert, Card } from 'antd';
import { formatDateTime } from '../../_lib/format';
import { subjectText } from '../../_lib/instances-logic';
import type { WfInstanceDetail } from '../../../lib/workflows-api';
import { DueTag, InstanceStatusTag } from '../../_components/StatusTags';

const TERMINAL: readonly number[] = [2, 3, 4];

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="wfi-fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** En-tête du détail : identité, version, statut, dates, objet lié, clé d'idempotence, déclencheur, erreur. */
export function InstanceHeader({ detail }: { detail: WfInstanceDetail }) {
  const { instance: i } = detail;
  const subject = subjectText(i.subjectType, i.subjectId);
  return (
    <Card className="wfi-head" aria-label="Informations de l’instance">
      {i.status === 3 && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 16 }}
          message="Cette instance a échoué."
          description={i.errorMessage ?? 'Aucun détail n’a été enregistré.'}
        />
      )}
      {i.status !== 3 && i.errorMessage && (
        <Alert type="error" showIcon style={{ marginBottom: 16 }} message={i.errorMessage} />
      )}
      <dl className="wfi-facts">
        <Fact label="Workflow">{detail.definitionName}</Fact>
        <Fact label="Version">Version n° {detail.versionNumber}</Fact>
        <Fact label="Statut">
          <InstanceStatusTag status={i.status} />
        </Fact>
        <Fact label="Lancée par">Utilisateur n° {i.startedBy}</Fact>
        <Fact label="Démarrée">
          <time dateTime={i.startedAt}>{formatDateTime(i.startedAt)}</time>
        </Fact>
        <Fact label="Échéance">{TERMINAL.includes(i.status) ? '—' : <DueTag dueAt={i.dueAt} />}</Fact>
        <Fact label="Terminée">
          {i.finishedAt ? <time dateTime={i.finishedAt}>{formatDateTime(i.finishedAt)}</time> : '—'}
        </Fact>
        {subject && <Fact label="Objet lié">{subject}</Fact>}
        {i.idempotencyKey && <Fact label="Clé d’idempotence">{i.idempotencyKey}</Fact>}
        {i.triggerId !== null && <Fact label="Déclencheur">Déclencheur n° {i.triggerId}</Fact>}
      </dl>
    </Card>
  );
}
