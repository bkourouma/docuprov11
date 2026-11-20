'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, App, Button, Card, Select, Tag } from 'antd';
import {
  GOVERNANCE_KIND_LABELS,
  GOVERNANCE_KINDS,
  GOVERNANCE_STATUS_LABELS,
  GOVERNANCE_STATUSES,
  GovernanceKind,
  type GovernanceDashboard,
  type GovernanceProposalPage,
  type GovernanceProposalView,
} from '@archivage/types';
import { PageHeader } from '../components/PageHeader';
import { EmptyState } from '../components/EmptyState';
import { TableSkeleton } from '../components/skeletons';
import { getMe } from '../lib/auth';
import { icons, iconDefaults } from '../theme/icons';
import { GovernanceApiError, errorMessage, governanceApi } from './gouvernance-api';
import { AnalyzeModal } from './_components/AnalyzeModal';
import { ForbiddenState } from './_components/ForbiddenState';
import { LoweringConfirmModal } from './_components/LoweringConfirmModal';
import { ProposalDrawer } from './_components/ProposalDrawer';
import { ProposalsTable } from './_components/ProposalsTable';
import { SummaryCards } from './_components/SummaryCards';
import './gouvernance.css';

type StatusFilter = number | 'all';

const CONFIDENCE_OPTIONS = [
  { value: 0, label: 'Toutes' },
  { value: 0.5, label: '50 % et plus' },
  { value: 0.7, label: '70 % et plus' },
  { value: 0.9, label: '90 % et plus' },
];

const toError = (e: unknown) => (e instanceof GovernanceApiError ? e : new GovernanceApiError('generic'));

/** « dup:123 » -> « original n° 123 » (affichage du filtre de groupe). */
function groupLabel(groupKey: string): string {
  const m = /^dup:(\d+)$/.exec(groupKey);
  return m ? `Groupe de doublons (original n° ${m[1]})` : 'Groupe de doublons';
}

/**
 * Docu-GED lot 5 : gouvernance des documents (doublons, données personnelles, sensibilité).
 *
 * Les propositions viennent de règles et, si elle est active, de l'IA : l'humain décide, et
 * aucun document n'est jamais supprimé automatiquement. Les droits sont appliqués par l'API
 * (403 = accès refusé). Tout texte reçu (extraits, libellés) est rendu comme texte brut.
 */
export default function GouvernancePage() {
  const { message } = App.useApp();

  const [kind, setKind] = useState<GovernanceKind | undefined>();
  const [status, setStatus] = useState<StatusFilter>(0);
  const [minConfidence, setMinConfidence] = useState(0);
  const [groupKey, setGroupKey] = useState<string | undefined>();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const [dashboard, setDashboard] = useState<GovernanceDashboard | null>(null);
  const [data, setData] = useState<GovernanceProposalPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const [opened, setOpened] = useState<GovernanceProposalView | null>(null);
  const [loweringTarget, setLoweringTarget] = useState<GovernanceProposalView | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [analyzeOpen, setAnalyzeOpen] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);

  const listSeq = useRef(0);

  const loadDashboard = useCallback(async () => {
    try {
      setDashboard(await governanceApi.dashboard());
    } catch (e) {
      if (toError(e).kind === 'forbidden') setForbidden(true);
      // Autre erreur : la synthèse reste à son dernier état ; la liste porte le message d'erreur.
    }
  }, []);

  const loadList = useCallback(async () => {
    const seq = ++listSeq.current;
    setLoading(true);
    try {
      const res = await governanceApi.list({
        kind,
        status: status === 'all' ? undefined : status,
        groupKey,
        minConfidence: minConfidence > 0 ? minConfidence : undefined,
        page,
        pageSize,
      });
      if (seq !== listSeq.current) return;
      setData(res);
      setLoadError(null);
    } catch (e) {
      if (seq !== listSeq.current) return;
      const err = toError(e);
      if (err.kind === 'forbidden') setForbidden(true);
      else setLoadError(errorMessage(err));
    } finally {
      if (seq === listSeq.current) setLoading(false);
    }
  }, [kind, status, groupKey, minConfidence, page, pageSize]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  useEffect(() => {
    void loadDashboard();
  }, [loadDashboard]);

  // Le profil sert uniquement à proposer « Analyser tout le fonds » aux administrateurs ;
  // l'API reste seule juge (refus en cas de droit insuffisant).
  useEffect(() => {
    getMe()
      .then((me) => setIsAdmin(me.isAdmin === true))
      .catch(() => setIsAdmin(false));
  }, []);

  const refresh = useCallback(() => {
    void loadList();
    void loadDashboard();
  }, [loadList, loadDashboard]);

  const review = useCallback(
    async (view: GovernanceProposalView, action: 'validate' | 'reject', confirmLowering = false) => {
      setBusyId(view.id);
      try {
        if (action === 'reject') {
          await governanceApi.reject(view.id);
          message.success('Proposition rejetée. Le document n’est pas modifié.');
        } else {
          await governanceApi.validate(view.id, confirmLowering);
          if (view.kind === GovernanceKind.Sensibilite) message.success('Niveau de confidentialité appliqué.');
          else if (view.kind === GovernanceKind.DonneesPersonnelles) message.success('Prise d’acte enregistrée.');
          else message.success('Doublon archivé. Archivage logique : le document n’est pas supprimé.');
        }
        setOpened(null);
        setLoweringTarget(null);
        refresh();
      } catch (e) {
        const err = toError(e);
        if (err.kind === 'lowering_required') {
          // L'API exige une confirmation explicite : on la demande, on ne l'envoie jamais d'office.
          setLoweringTarget(view);
        } else if (err.kind === 'conflict' || err.kind === 'not_found') {
          message.warning(errorMessage(err, 'review'));
          setOpened(null);
          setLoweringTarget(null);
          refresh();
        } else {
          message.error(errorMessage(err, 'review'));
        }
      } finally {
        setBusyId(null);
      }
    },
    [message, refresh],
  );

  const onValidate = (v: GovernanceProposalView) => void review(v, 'validate');
  const onReject = (v: GovernanceProposalView) => void review(v, 'reject');

  const toggleKind = (k: GovernanceKind) => {
    setKind((cur) => (cur === k ? undefined : k));
    setPage(1);
  };

  const filtered = kind !== undefined || status !== 0 || minConfidence > 0 || groupKey !== undefined;
  const resetFilters = () => {
    setKind(undefined);
    setStatus(0);
    setMinConfidence(0);
    setGroupKey(undefined);
    setPage(1);
  };

  const Analyze = icons.search;
  const Refresh = icons.refresh;

  const actions = forbidden ? undefined : (
    <>
      <Button icon={<Refresh size={iconDefaults.size} />} onClick={refresh}>
        Actualiser
      </Button>
      <Button type="primary" icon={<Analyze size={iconDefaults.size} />} onClick={() => setAnalyzeOpen(true)}>
        Analyser un document
      </Button>
    </>
  );

  return (
    <div>
      <PageHeader title="Gouvernance" icon="roles" actions={actions} />

      {forbidden ? (
        <ForbiddenState />
      ) : (
        <>
          {dashboard && dashboard.aiEnabled === false && (
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 16 }}
              message={dashboard.aiMessage ?? 'IA désactivée : seules les détections déterministes sont actives.'}
            />
          )}

          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            message="Détection des noms de personnes : réalisée uniquement par un modèle local. En mode cloud, elle est désactivée : aucun nom n’est envoyé hors de l’installation. Les motifs (e-mail, téléphone, IBAN, etc.) restent détectés par des règles."
          />

          <SummaryCards dashboard={dashboard} loading={loading} activeKind={kind} onToggleKind={toggleKind} />

          <Card title="Propositions">
            <p className="gov-note">
              Ces propositions viennent de règles et, si elle est active, de l’IA. Vous décidez de chacune :
              aucun document n’est jamais supprimé automatiquement.
            </p>

            <div className="gov-filters" role="group" aria-label="Filtres de la liste">
              <div className="gov-filter">
                <label htmlFor="gov-f-kind">Nature</label>
                <Select<GovernanceKind | 'all'>
                  id="gov-f-kind"
                  value={kind ?? 'all'}
                  onChange={(v) => {
                    setKind(v === 'all' ? undefined : v);
                    setPage(1);
                  }}
                  options={[
                    { value: 'all', label: 'Toutes les natures' },
                    ...GOVERNANCE_KINDS.map((k) => ({ value: k, label: GOVERNANCE_KIND_LABELS[k] })),
                  ]}
                />
              </div>
              <div className="gov-filter">
                <label htmlFor="gov-f-status">Statut</label>
                <Select<StatusFilter>
                  id="gov-f-status"
                  value={status}
                  onChange={(v) => {
                    setStatus(v);
                    setPage(1);
                  }}
                  options={[
                    { value: 'all', label: 'Tous les statuts' },
                    ...GOVERNANCE_STATUSES.map((s) => ({ value: s, label: GOVERNANCE_STATUS_LABELS[s] })),
                  ]}
                />
              </div>
              <div className="gov-filter">
                <label htmlFor="gov-f-conf">Confiance minimale</label>
                <Select<number>
                  id="gov-f-conf"
                  value={minConfidence}
                  onChange={(v) => {
                    setMinConfidence(v);
                    setPage(1);
                  }}
                  options={CONFIDENCE_OPTIONS}
                />
              </div>
              {groupKey && (
                <Tag
                  closable
                  onClose={() => {
                    setGroupKey(undefined);
                    setPage(1);
                  }}
                  closeIcon={<span aria-label="Retirer le filtre de groupe">×</span>}
                >
                  {groupLabel(groupKey)}
                </Tag>
              )}
              {filtered && <Button onClick={resetFilters}>Réinitialiser les filtres</Button>}
            </div>

            <div aria-live="polite">
              {loading && !data ? (
                <TableSkeleton rows={5} columns={7} />
              ) : loadError && !data ? (
                <EmptyState
                  icon="alert"
                  title={loadError}
                  action={
                    <Button type="primary" onClick={refresh}>
                      Réessayer
                    </Button>
                  }
                />
              ) : data && data.total === 0 && !loading ? (
                <EmptyState
                  icon="validated"
                  title={
                    filtered
                      ? 'Aucune proposition ne correspond à ces filtres.'
                      : 'Aucune proposition en attente. Lancez une analyse pour en générer.'
                  }
                  action={
                    filtered ? (
                      <Button onClick={resetFilters}>Réinitialiser les filtres</Button>
                    ) : (
                      <Button type="primary" onClick={() => setAnalyzeOpen(true)}>
                        Analyser un document
                      </Button>
                    )
                  }
                />
              ) : (
                data && (
                  <>
                    {loadError && (
                      <Alert
                        type="error"
                        showIcon
                        style={{ marginBottom: 12 }}
                        message={loadError}
                        action={
                          <Button size="small" onClick={refresh}>
                            Réessayer
                          </Button>
                        }
                      />
                    )}
                    <ProposalsTable
                      data={data}
                      loading={loading}
                      busyId={busyId}
                      onPage={(p, s) => {
                        setPage(s !== pageSize ? 1 : p);
                        setPageSize(s);
                      }}
                      onOpen={setOpened}
                      onValidate={onValidate}
                      onReject={onReject}
                      onAskLowering={setLoweringTarget}
                      onGroup={(g) => {
                        setGroupKey(g);
                        setPage(1);
                      }}
                    />
                  </>
                )
              )}
            </div>
          </Card>

          <ProposalDrawer
            proposal={opened}
            busy={opened !== null && busyId === opened.id}
            onClose={() => setOpened(null)}
            onValidate={onValidate}
            onReject={onReject}
            onAskLowering={setLoweringTarget}
          />

          <LoweringConfirmModal
            proposal={loweringTarget}
            busy={loweringTarget !== null && busyId === loweringTarget.id}
            onCancel={() => setLoweringTarget(null)}
            onConfirm={(v) => void review(v, 'validate', true)}
          />

          <AnalyzeModal
            open={analyzeOpen}
            isAdmin={isAdmin}
            onClose={() => setAnalyzeOpen(false)}
            onQueued={refresh}
          />
        </>
      )}
    </div>
  );
}
