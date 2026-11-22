'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Card } from 'antd';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { PageHeader } from '../../../components/PageHeader';
import { EmptyState } from '../../../components/EmptyState';
import { CardsSkeleton } from '../../../components/skeletons';
import { icons, iconDefaults } from '../../../theme/icons';
import {
  WorkflowApiError,
  isWorkflowBigintId,
  workflowErrorMessage,
  workflowsApi,
  type WfInstanceDetail,
} from '../../../lib/workflows-api';
import { useWorkflowAccess } from '../../_lib/useWorkflowAccess';
import { AccessDenied } from '../_components/AccessDenied';
import { EventJournal } from '../_components/EventJournal';
import { InstanceActions } from '../_components/InstanceActions';
import { InstanceHeader } from '../_components/InstanceHeader';
import { StepsTimeline } from '../_components/StepsTimeline';
import '../../workflows.css';
import '../instances.css';

/** Docu-Flow : détail d'une instance (en-tête, étapes franchies, journal lisible, actions). */
export default function InstanceDetailPage() {
  const params = useParams<{ instanceId: string }>();
  const rawId = params?.instanceId ?? '';
  // Identifiant d'URL : seul un entier décimal (comme l'API) part au réseau ; sinon page « introuvable ».
  const validId = isWorkflowBigintId(rawId);
  const instanceId = validId ? rawId : '';
  const { access } = useWorkflowAccess();

  const [detail, setDetail] = useState<WfInstanceDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const seq = useRef(0);

  const load = useCallback(
    async (silent = false) => {
      if (!instanceId) return;
      const mySeq = ++seq.current;
      if (!silent) setLoading(true);
      try {
        const d = await workflowsApi.getInstance(instanceId);
        if (mySeq !== seq.current) return;
        setDetail(d);
        setError(null);
        setNotFound(false);
        setForbidden(false);
      } catch (e) {
        if (mySeq !== seq.current) return;
        if (e instanceof WorkflowApiError && e.notFound) setNotFound(true);
        else if (e instanceof WorkflowApiError && e.forbidden) setForbidden(true);
        else setError(workflowErrorMessage(e));
      } finally {
        if (mySeq === seq.current) setLoading(false);
      }
    },
    [instanceId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const RefreshGlyph = icons.refresh;
  const crumbs = [{ label: 'Suivi des workflows', href: '/workflows/instances' }, { label: `Instance n° ${instanceId}` }];
  const refreshButton = (
    <Button onClick={() => void load()} loading={loading} icon={<RefreshGlyph size={16} strokeWidth={iconDefaults.strokeWidth} />}>
      Actualiser
    </Button>
  );

  if (notFound || forbidden || !validId) {
    return (
      <div>
        <PageHeader title={validId ? `Instance n° ${instanceId}` : 'Instance introuvable'} icon="pending" breadcrumb={crumbs} />
        {notFound || !validId ? (
          <Card>
            <div role="alert">
              <EmptyState
                icon="search"
                title="Instance introuvable ou hors de votre périmètre."
                action={
                  <Link href="/workflows/instances">
                    <Button type="primary">Retour au suivi</Button>
                  </Link>
                }
              />
            </div>
          </Card>
        ) : (
          <AccessDenied message="Accès refusé. Vous n’avez pas le droit de consulter cette instance." />
        )}
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title={detail ? detail.definitionName : `Instance n° ${instanceId}`}
        icon="pending"
        breadcrumb={crumbs}
        actions={
          <>
            {detail && access && (
              <InstanceActions instance={detail.instance} access={access} onChanged={() => void load(true)} />
            )}
            {refreshButton}
          </>
        }
      />

      <div aria-live="polite">
        {error && (
          <Alert
            type="error"
            showIcon
            style={{ marginBottom: 16 }}
            message={error}
            action={
              <Button size="small" onClick={() => void load()}>
                Réessayer
              </Button>
            }
          />
        )}
      </div>

      {!detail ? (
        loading ? <CardsSkeleton count={3} /> : null
      ) : (
        <>
          <InstanceHeader detail={detail} />
          <section className="wfi-section" aria-labelledby="wfi-steps-title">
            <Card>
              <h2 id="wfi-steps-title" className="wfi-section-title">
                Étapes franchies
              </h2>
              <StepsTimeline tasks={detail.tasks} inboxItems={detail.inboxItems} />
            </Card>
          </section>
          <section className="wfi-section" aria-labelledby="wfi-journal-title">
            <Card>
              <h2 id="wfi-journal-title" className="wfi-section-title">
                Journal des événements
              </h2>
              <EventJournal events={detail.events} />
            </Card>
          </section>
        </>
      )}
    </div>
  );
}
