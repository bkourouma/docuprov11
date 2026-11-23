'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, App, Button } from 'antd';
import { PageHeader } from '../../components/PageHeader';
import { EmptyState } from '../../components/EmptyState';
import { CardsSkeleton } from '../../components/skeletons';
import { icons, iconDefaults } from '../../theme/icons';
import { WorkflowApiError, workflowErrorMessage, workflowsApi } from '../../lib/workflows-api';
import type { WfInboxEntry } from '../../lib/workflows-api';
import { useWorkflowAccess } from '../_lib/useWorkflowAccess';
import {
  DEFAULT_FILTERS,
  DEFAULT_SORT,
  DEFAULT_STATUS_GROUP,
  INBOX_PAGE_SIZE,
  countSummary,
  filterEntries,
  filtersAreDefault,
  mergeEntries,
  sortEntries,
  statusesForGroup,
  type InboxFilters as Filters,
  type InboxSort,
  type InboxStatusGroup,
} from '../_lib/inbox-logic';
import { InboxCard } from './_components/InboxCard';
import { InboxDrawer, type DrawerActions, type PendingAction } from './_components/InboxDrawer';
import { InboxFilters } from './_components/InboxFilters';
// `workflows.css` porte la mise en ligne des filtres (`.wf-toolbar`, `.wf-field`) : sans cet
// import, un accès direct à la boîte les affichait empilés sur toute la largeur.
import '../workflows.css';
import './boite.css';

const AUTO_REFRESH_MS = 60_000;

/** Charge les pages 0..n (50 éléments chacune) jusqu'à couvrir `atLeast` éléments déjà affichés. */
async function fetchPages(statuses: number[], atLeast: number): Promise<{ items: WfInboxEntry[]; total: number }> {
  let items: WfInboxEntry[] = [];
  let total = 0;
  const wanted = Math.max(atLeast, INBOX_PAGE_SIZE);
  for (;;) {
    const page = await workflowsApi.listInbox({ statuses, limit: INBOX_PAGE_SIZE, offset: items.length });
    total = page.total;
    items = mergeEntries(items, page.items);
    if (page.items.length < INBOX_PAGE_SIZE || items.length >= total || items.length >= wanted) break;
  }
  return { items, total };
}

/**
 * Docu-Flow : boîte de tâches unifiée (tâches humaines et validations demandées par des agents).
 * Le statut est filtré par l'API ; nature, échéance, texte et tri s'appliquent aux éléments chargés.
 * Les droits sont jugés par le serveur (403/404/409/422 traduits en français, jamais de détail technique).
 */
export default function BoitePage() {
  const { message } = App.useApp();
  const { access } = useWorkflowAccess();

  const [group, setGroup] = useState<InboxStatusGroup>(DEFAULT_STATUS_GROUP);
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [sort, setSort] = useState<InboxSort>(DEFAULT_SORT);

  const [items, setItems] = useState<WfInboxEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());
  const [announce, setAnnounce] = useState('');
  const [refreshFailed, setRefreshFailed] = useState<string | null>(null);

  const [selected, setSelected] = useState<WfInboxEntry | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [pending, setPending] = useState<PendingAction | null>(null);

  // Chaque chargement porte un numéro : une réponse périmée (filtre changé entre-temps) est ignorée.
  const requestId = useRef(0);
  const itemsRef = useRef<WfInboxEntry[]>([]);
  const pendingRef = useRef(false);
  const lastRefresh = useRef(Date.now());
  const cardRefs = useRef(new Map<string, HTMLButtonElement>());
  const lastOpenedId = useRef<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const announceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  const statuses = useMemo(() => statusesForGroup(group), [group]);

  /** Chargement initial (ou changement de statut) : on repart d'une liste vide avec squelette. */
  const loadInitial = useCallback(async () => {
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    setMoreError(null);
    setRefreshFailed(null);
    try {
      const r = await fetchPages(statuses, INBOX_PAGE_SIZE);
      if (id !== requestId.current) return;
      setItems(r.items);
      setTotal(r.total);
      setNow(new Date());
      lastRefresh.current = Date.now();
    } catch (e) {
      if (id !== requestId.current) return;
      setItems([]);
      setTotal(0);
      setError(workflowErrorMessage(e));
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [statuses]);

  useEffect(() => {
    setSelected(null);
    setDrawerOpen(false);
    void loadInitial();
  }, [loadInitial]);

  /**
   * Actualisation : recharge ce qui est déjà affiché sans toucher aux filtres ni au tiroir ouvert.
   * En cas d'échec l'ancienne liste reste visible et un avertissement le dit.
   */
  const refresh = useCallback(
    async (opts: { announce: boolean }) => {
      const id = ++requestId.current;
      setRefreshing(true);
      try {
        const r = await fetchPages(statuses, itemsRef.current.length);
        if (id !== requestId.current) return;
        setItems(r.items);
        setTotal(r.total);
        setNow(new Date());
        setError(null);
        setRefreshFailed(null);
        lastRefresh.current = Date.now();
        if (opts.announce) {
          setAnnounce('Boîte actualisée');
          if (announceTimer.current) clearTimeout(announceTimer.current);
          // Vidée ensuite : la prochaine actualisation sera de nouveau annoncée.
          announceTimer.current = setTimeout(() => setAnnounce(''), 4000);
        }
      } catch (e) {
        if (id !== requestId.current) return;
        setRefreshFailed(workflowErrorMessage(e));
      } finally {
        if (id === requestId.current) {
          setRefreshing(false);
          setLoading(false);
        }
      }
    },
    [statuses],
  );

  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  // Actualisation automatique toutes les 60 s, uniquement si l'onglet est visible ; rattrapage au retour sur l'onglet.
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState !== 'visible') return;
      void refreshRef.current({ announce: true });
    };
    const timer = setInterval(tick, AUTO_REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastRefresh.current >= AUTO_REFRESH_MS) tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      if (announceTimer.current) clearTimeout(announceTimer.current);
    };
  }, []);

  // L'élément ouvert suit les actualisations (statut, version) ; s'il disparaît de la liste, on garde sa dernière version.
  useEffect(() => {
    setSelected((cur) => {
      if (!cur) return cur;
      const fresh = items.find((e) => e.item.wfInboxItemId === cur.item.wfInboxItemId);
      return fresh ?? cur;
    });
  }, [items]);

  const loadMore = async () => {
    const id = ++requestId.current;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await workflowsApi.listInbox({ statuses, limit: INBOX_PAGE_SIZE, offset: itemsRef.current.length });
      if (id !== requestId.current) return;
      setItems((cur) => mergeEntries(cur, page.items));
      setTotal(page.total);
    } catch (e) {
      if (id !== requestId.current) return;
      setMoreError(workflowErrorMessage(e));
    } finally {
      if (id === requestId.current) setLoadingMore(false);
    }
  };

  const visible = useMemo(() => sortEntries(filterEntries(items, filters, now), sort, now), [items, filters, sort, now]);
  const summary = countSummary(visible, now);
  const canReset = !filtersAreDefault(filters) || sort !== DEFAULT_SORT || group !== DEFAULT_STATUS_GROUP;

  const resetFilters = () => {
    setFilters(DEFAULT_FILTERS);
    setSort(DEFAULT_SORT);
    setGroup(DEFAULT_STATUS_GROUP);
  };

  const openEntry = (entry: WfInboxEntry) => {
    lastOpenedId.current = entry.item.wfInboxItemId;
    setSelected(entry);
    setDrawerOpen(true);
  };

  /** Focus renvoyé à la carte ; si elle a quitté la liste (élément traité), à la région de la liste. */
  const restoreFocus = () => {
    const el = lastOpenedId.current ? cardRefs.current.get(lastOpenedId.current) : undefined;
    (el ?? listRef.current)?.focus();
  };

  /**
   * Exécute une action du moteur. Un seul appel à la fois (pas de double envoi). Renvoie le message d'erreur à
   * afficher dans la saisie (qui reste ouverte), ou null en cas de succès uniquement. 409 : l'état a changé => rechargement.
   */
  const perform = async (
    kind: PendingAction,
    call: () => Promise<unknown>,
    success: string,
    closeDrawer: boolean,
  ): Promise<string | null> => {
    // Une action est déjà en cours : on NE renvoie PAS null (= succès, la saisie se fermerait) mais un message.
    if (pendingRef.current) return 'Une action est déjà en cours : patientez quelques secondes puis réessayez.';
    pendingRef.current = true;
    setPending(kind);
    try {
      await call();
      message.success(success);
      await refresh({ announce: false });
      if (closeDrawer) setDrawerOpen(false);
      return null;
    } catch (e) {
      if (e instanceof WorkflowApiError && e.status === 409) {
        message.info('Actualisation…');
        void refresh({ announce: false });
      }
      return workflowErrorMessage(e);
    } finally {
      pendingRef.current = false;
      setPending(null);
    }
  };

  const itemId = selected?.item.wfInboxItemId ?? '';
  const actions: DrawerActions = {
    onClaim: () => perform('claim', () => workflowsApi.claim(itemId), 'Tâche prise en charge.', false),
    onComplete: (result, rowVersion, accepted) =>
      perform(
        accepted ? 'accept' : 'complete',
        () => workflowsApi.complete(itemId, result, rowVersion),
        accepted ? 'Proposition acceptée.' : 'Tâche terminée.',
        true,
      ),
    onReject: (comment) => perform('reject', () => workflowsApi.reject(itemId, comment), 'Tâche rejetée.', true),
    onDelegate: (to, comment) =>
      perform('delegate', () => workflowsApi.delegate(itemId, to, comment), 'Tâche déléguée.', true),
  };

  const hasItems = items.length > 0;
  const remaining = Math.max(0, total - items.length);

  return (
    <div className="wfb-page">
      <PageHeader
        title="Boîte de tâches"
        icon="acquisition"
        actions={
          <Button icon={<icons.refresh {...iconDefaults} />} loading={refreshing} onClick={() => void refresh({ announce: true })}>
            Actualiser
          </Button>
        }
      />

      <InboxFilters
        group={group}
        filters={filters}
        sort={sort}
        canReset={canReset}
        onGroup={setGroup}
        onFilters={setFilters}
        onSort={setSort}
        onReset={resetFilters}
      />

      {/* Régions vivantes : le compteur suit les filtres, la seconde annonce les actualisations. */}
      <p className="wfb-count" role="status" aria-live="polite">
        {loading ? 'Chargement…' : error && !hasItems ? '' : summary.text}
        {!loading && remaining > 0 && <span className="wf-muted">{` · ${items.length} chargés sur ${total}`}</span>}
      </p>
      <div className="wf-sr-only" role="status" aria-live="polite">
        {announce}
      </div>
      {refreshFailed && (
        <Alert
          type="warning"
          showIcon
          className="wfb-gap"
          message="Actualisation impossible"
          description={`${refreshFailed} La liste affichée peut ne plus être à jour.`}
        />
      )}

      <div ref={listRef} tabIndex={-1} className="wfb-list-wrap" aria-busy={loading}>
        {loading ? (
          <CardsSkeleton count={4} />
        ) : error && !hasItems ? (
          <Alert
            type="error"
            showIcon
            message="La boîte n’a pas pu être chargée"
            description={error}
            action={
              <Button size="small" onClick={() => void loadInitial()}>
                Réessayer
              </Button>
            }
          />
        ) : !hasItems ? (
          <EmptyState
            icon="validated"
            title={group === 'open' ? 'Rien à traiter' : 'Aucun élément dans cette catégorie'}
            action={group !== 'open' ? <Button onClick={() => setGroup('open')}>Voir ce qui est à traiter</Button> : undefined}
          />
        ) : visible.length === 0 ? (
          <EmptyState
            icon="search"
            title="Aucun résultat pour ces filtres"
            action={
              <Button icon={<icons.reset {...iconDefaults} />} onClick={resetFilters}>
                Réinitialiser les filtres
              </Button>
            }
          />
        ) : (
          <ul role="list" className="wfb-list" aria-label="Éléments de la boîte de tâches">
            {visible.map((entry) => (
              <InboxCard
                key={entry.item.wfInboxItemId}
                entry={entry}
                now={now}
                selected={drawerOpen && selected?.item.wfInboxItemId === entry.item.wfInboxItemId}
                onOpen={openEntry}
                registerRef={(id, el) => {
                  if (el) cardRefs.current.set(id, el);
                  else cardRefs.current.delete(id);
                }}
              />
            ))}
          </ul>
        )}

        {!loading && remaining > 0 && (
          <div className="wfb-more">
            {moreError && <Alert type="error" showIcon message={moreError} />}
            <Button loading={loadingMore} onClick={() => void loadMore()}>
              Charger plus
            </Button>
            <span className="wf-muted">{`${remaining} élément${remaining > 1 ? 's' : ''} restant${remaining > 1 ? 's' : ''}`}</span>
          </div>
        )}
      </div>

      <InboxDrawer
        entry={selected}
        open={drawerOpen}
        access={access}
        pending={pending}
        actions={actions}
        onClose={() => setDrawerOpen(false)}
        onAfterClose={restoreFocus}
      />
    </div>
  );
}
