'use client';

import '@ant-design/v5-patch-for-react-19';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Drawer, Grid, Layout, Menu, Spin, type MenuProps } from 'antd';
import { getBadges, type BadgeCounts } from '../lib/courriers';
import { getMe, type Me } from '../lib/auth';
import { icons } from '../theme/icons';
import { MODULES, activeItem, placeOfPath, type NavItem, type NavModule } from './nav';
import { Logo, LogoIcon } from './BrandMark';
import { TopBar } from './TopBar';
import { UserMenu } from './UserMenu';
import { CommandPalette } from './CommandPalette';
import dynamic from 'next/dynamic';
import { hasAssistantMenu } from './assistant/_lib/access';
import { pageContextFromPath } from './assistant/_lib/page-context';
import { useAssistantShortcut } from './assistant/useAssistantShortcut';

// Panneau de l'assistant : chargé à la demande, côté client seulement (jamais pour qui n'a pas le menu).
const AssistantDrawer = dynamic(() => import('./assistant/AssistantDrawer').then((m) => m.AssistantDrawer), {
  ssr: false,
});

const { Content } = Layout;

const COLLAPSE_KEY = 'da-sider-collapsed';

/** Intervalle de rafraîchissement des badges de menu (§04.7 : 120 s dans la source). */
const BADGE_POLL_MS = 120_000;

/** Entrées de menu porteuses d'un compteur (§04.7) → clé du compteur renvoyé par /courriers/badges. */
const BADGE_KEY_BY_MENU: Record<string, keyof BadgeCounts> = {
  '/courriers/controle': 'controle',
  '/courriers/validation': 'validation',
  '/courriers/suivi': 'suivi',
  '/courriers/parapheur': 'parapheur',
  '/courriers/integration-decharge': 'decharge',
  '/courriers/documents-scannes': 'scans',
};

/** Compteur d'un écran (0 = rien à afficher). */
function countOf(item: NavItem, badges: BadgeCounts | null): number {
  const badgeKey = BADGE_KEY_BY_MENU[item.key];
  return badgeKey && badges ? badges[badgeKey] : 0;
}

/**
 * Modules visibles pour l'utilisateur : chaque groupe ne garde que les écrans autorisés
 * (`allowed`, `null` = aucun filtrage), les groupes puis les modules vides disparaissent.
 * Le tableau de bord (« /dashboards ») reste toujours visible. Même règle qu'avant le passage
 * en modules : une permission de périmètre restreint (`altKeys`) ouvre le même écran.
 */
function useVisibleModules(allowed: Set<string> | null): NavModule[] {
  return useMemo(
    () =>
      MODULES.map((module) => ({
        ...module,
        groups: module.groups
          .map((group) => ({
            ...group,
            items: group.items.filter(
              (item) =>
                !allowed ||
                item.key === '/dashboards' ||
                allowed.has(item.key) ||
                item.altKeys?.some((k) => allowed.has(k)),
            ),
          }))
          .filter((group) => group.items.length > 0),
      })).filter((module) => module.groups.length > 0),
    [allowed],
  );
}

/**
 * Items du panneau : les écrans du module courant, regroupés par geste (Traiter, Suivre…).
 *
 * Le libellé reste une CHAÎNE, compteur ou pas ; le compteur passe par `extra`, le mécanisme
 * prévu par AntD pour l'aligner à droite. Un compteur nul n'affiche rien.
 */
function usePanelItems(module: NavModule | undefined, badges: BadgeCounts | null): MenuProps['items'] {
  return useMemo(
    () =>
      (module?.groups ?? []).map((group) => ({
        type: 'group' as const,
        key: `groupe:${module?.id}:${group.label}`,
        label: group.label,
        children: group.items.map((item) => {
          const count = countOf(item, badges);
          return {
            key: item.key,
            label: item.label,
            extra:
              count > 0 ? (
                <span className="da-count" aria-label={`${count} à traiter`}>
                  {count > 99 ? '99+' : count}
                </span>
              ) : undefined,
          };
        }),
      })),
    [module, badges],
  );
}

/**
 * Redirection du garde d'authentification.
 *
 * En dev on force une navigation document (`window.location.replace`) au lieu de
 * `router.replace` : une navigation client déclenchée PENDANT une compilation à la
 * demande peut voir sa transition React abandonnée par le rebuild HMR qui suit la
 * compilation — l'utilisateur reste alors bloqué sur le spinner au tout premier
 * lancement, jusqu'à un rechargement manuel (Ctrl+F5). Une navigation document est
 * insensible à ce rebuild : elle recharge la page cible quoi qu'il arrive.
 *
 * En prod, `router.replace` : navigation client instantanée, aucune compilation en
 * jeu, donc aucun risque de transition avalée.
 */
function gotoAuth(router: ReturnType<typeof useRouter>, href: string) {
  if (process.env.NODE_ENV === 'development') {
    window.location.replace(href);
  } else {
    router.replace(href);
  }
}

/**
 * Rail des modules : la toile verte. Un bouton par module, son icône et son libellé court ;
 * le cumul des compteurs du module s'affiche sur le bouton, sans quoi quitter le module
 * (ou replier le panneau) masquerait l'alerte.
 */
function ModuleRail({
  modules,
  currentId,
  badges,
  onPick,
  footer,
}: {
  modules: NavModule[];
  currentId: string | undefined;
  badges: BadgeCounts | null;
  onPick: (id: string) => void;
  footer?: ReactNode;
}) {
  return (
    <nav className="da-rail" aria-label="Modules">
      {modules.map((module) => {
        const Glyph = icons[module.icon];
        const total = module.groups.reduce(
          (sum, group) => sum + group.items.reduce((s, item) => s + countOf(item, badges), 0),
          0,
        );
        const current = module.id === currentId;
        return (
          <button
            key={module.id}
            type="button"
            className="da-rail-btn"
            aria-current={current ? 'true' : undefined}
            aria-label={total > 0 ? `${module.label}, ${total} à traiter` : module.label}
            title={module.label}
            onClick={() => onPick(module.id)}
          >
            <Glyph size={20} strokeWidth={1.75} aria-hidden />
            {module.short}
            {total > 0 && (
              <span className="da-rail-count" aria-hidden>
                {total > 99 ? '99+' : total}
              </span>
            )}
          </button>
        );
      })}
      {footer}
    </nav>
  );
}

/** Auth guard + chrome applicatif responsive. Rend la route /login nue. */
export function AuthShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const screens = Grid.useBreakpoint();
  const isMobile = !screens.lg;

  const [ready, setReady] = useState(false);
  const [me, setMe] = useState<Me | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const isLogin = pathname === '/login';

  // Ensemble des menus autorisés (null tant que /auth/me n'a pas répondu ou si le
  // backend ne renvoie pas encore menuKeys => on n'applique aucun filtre).
  const allowed = useMemo(() => (me?.menuKeys ? new Set(me.menuKeys) : null), [me]);
  const [badges, setBadges] = useState<BadgeCounts | null>(null);
  const modules = useVisibleModules(allowed);

  // Module affiché dans le panneau. Initialisé sur celui de la route courante — sinon on
  // arriverait sur un panneau qui ne montre pas où l'on est. Cliquer un autre module du rail
  // FEUILLETTE ses écrans sans naviguer : on ne quitte l'écran courant qu'en choisissant le
  // suivant.
  const routeModuleId = placeOfPath(pathname)?.module.id;
  const [browsedId, setBrowsedId] = useState<string | undefined>(routeModuleId);

  // Navigation vers un autre module (lien direct, palette de commandes…) : le panneau suit.
  useEffect(() => {
    if (routeModuleId) setBrowsedId(routeModuleId);
  }, [routeModuleId, pathname]);

  // Module effectivement affiché : celui qu'on feuillette s'il est visible pour l'utilisateur,
  // sinon le premier auquel il a droit (écran hors menu, droits réduits).
  const panelModule = modules.find((m) => m.id === browsedId) ?? modules[0];
  const panelItems = usePanelItems(panelModule, badges);
  const selectedKey = activeItem(pathname)?.key ?? pathname;

  // Restaure l'état replié du panneau (desktop). Sans préférence enregistrée, un écran
  // étroit (< 1300 px) démarre panneau replié : les listes y tiennent alors sans défilement
  // horizontal. Ce choix par défaut n'est pas persisté — seul un clic de l'utilisateur l'est.
  useEffect(() => {
    const stored = window.localStorage.getItem(COLLAPSE_KEY);
    setCollapsed(stored === null ? window.innerWidth < 1300 : stored === '1');
  }, []);

  const setCollapsedPersisted = useCallback((next: boolean) => {
    window.localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0');
    setCollapsed(next);
  }, []);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((c) => {
      window.localStorage.setItem(COLLAPSE_KEY, c ? '0' : '1');
      return !c;
    });
  }, []);

  // Choix d'un module dans le rail. Panneau replié : le rail est la seule navigation visible,
  // le clic rouvre donc le panneau sur ce module au lieu de ne rien montrer.
  const pickModule = useCallback(
    (id: string) => {
      setBrowsedId(id);
      if (collapsed) setCollapsedPersisted(false);
    },
    [collapsed, setCollapsedPersisted],
  );

  // Auth guard (comportement conservé à l'identique).
  useEffect(() => {
    const token = typeof window !== 'undefined' ? window.localStorage.getItem('token') : null;
    if (isLogin) {
      if (token) gotoAuth(router, '/dashboards');
      return;
    }
    if (!token) {
      gotoAuth(router, '/login');
      return;
    }
    getMe()
      .then(setMe)
      .catch(() => undefined)
      .finally(() => setReady(true));
  }, [pathname, isLogin, router]);

  // Badges de menu (§04.7) : compteurs rafraîchis par polling une fois l'utilisateur connu.
  // Erreur = badges inchangés (dégradation silencieuse, comme la source qui retourne 0).
  const authenticated = me != null;
  useEffect(() => {
    if (isLogin || !authenticated) return;
    let cancelled = false;
    const tick = () =>
      getBadges()
        .then((b) => {
          if (!cancelled) setBadges(b);
        })
        .catch(() => undefined);
    void tick();
    const timer = window.setInterval(tick, BADGE_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [isLogin, authenticated]);

  // Raccourci global de la palette de commandes (⌘K / Ctrl+K).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Assistant : bouton, raccourci et panneau n'existent que si le menu `/assistant` est détenu (refus par défaut).
  const assistantEnabled = hasAssistantMenu(me?.menuKeys);
  const assistantContext = useMemo(() => pageContextFromPath(pathname), [pathname]);
  useEffect(() => {
    if (!assistantEnabled) setAssistantOpen(false);
  }, [assistantEnabled]);
  const toggleAssistant = useCallback(() => setAssistantOpen((o) => !o), []);
  useAssistantShortcut(assistantEnabled && !isLogin, toggleAssistant);

  const navigate = useCallback(
    (key: string) => {
      router.push(key);
      setDrawerOpen(false);
    },
    [router],
  );

  const logout = useCallback(() => {
    window.localStorage.removeItem('token');
    // L'assistant ne survit pas à la déconnexion : panneau fermé, état du chat (propre à l'utilisateur) détruit.
    setAssistantOpen(false);
    setMe(null);
    router.replace('/login');
  }, [router]);

  if (isLogin) return <>{children}</>;
  if (!ready) {
    // Écran d'attente : première surface vue à chaque session.
    return (
      <div
        style={{
          display: 'grid',
          placeItems: 'center',
          minHeight: '100vh',
          gap: 16,
          background: 'var(--ant-color-bg-layout, #eff4f0)',
        }}
      >
        <LogoIcon size={46} />
        <Spin />
      </div>
    );
  }

  // Panneau des écrans du module feuilleté. Le bandeau du logo est hors du conteneur qui
  // défile : il ne bouge pas, et l'ascenseur commence sous lui.
  const panel = (
    <div className="da-panel">
      <div className="da-panel-brand">
        <a onClick={() => navigate('/dashboards')} aria-label="Accueil" style={{ display: 'inline-flex' }}>
          <Logo height={26} />
        </a>
      </div>
      <nav className="da-panel-scroll" aria-label={panelModule?.label ?? 'Écrans'}>
        <Menu
          mode="inline"
          selectedKeys={[selectedKey]}
          items={panelItems}
          onClick={({ key }) => navigate(key)}
        />
      </nav>
    </div>
  );

  return (
    <Layout style={{ minHeight: '100vh' }} hasSider={!isMobile}>
      {!isMobile && (
        <aside className="da-nav">
          <ModuleRail
            modules={modules}
            // Panneau replié : aucun module n'est « ouvert », le rail désigne celui de l'écran courant.
            currentId={collapsed ? routeModuleId : panelModule?.id}
            badges={badges}
            onPick={pickModule}
            footer={<UserMenu me={me} onLogout={logout} variant="rail" />}
          />
          {!collapsed && panel}
        </aside>
      )}

      <Layout style={{ background: 'var(--ant-color-bg-layout, #eff4f0)', minWidth: 0 }}>
        <TopBar
          me={me}
          collapsed={collapsed}
          onToggleSider={toggleCollapsed}
          onOpenMenu={() => setDrawerOpen(true)}
          onOpenPalette={() => setPaletteOpen(true)}
          onLogout={logout}
          onOpenAssistant={assistantEnabled ? () => setAssistantOpen(true) : undefined}
        />
        <Content>
          <div className="da-page">{children}</div>
        </Content>
      </Layout>

      <Drawer
        placement="left"
        open={isMobile && drawerOpen}
        onClose={() => setDrawerOpen(false)}
        // Rail (80) + panneau (216) : la même navigation qu'au bureau, rangée dans le tiroir.
        width={296}
        styles={{
          body: { padding: 0, display: 'flex' },
          header: { display: 'none' },
        }}
      >
        <div className="da-nav da-nav-drawer">
          <ModuleRail
            modules={modules}
            currentId={panelModule?.id}
            badges={badges}
            onPick={setBrowsedId}
          />
          {panel}
        </div>
      </Drawer>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        allowedKeys={me?.menuKeys ?? null}
      />

      {assistantEnabled && (
        <AssistantDrawer
          key={me?.username}
          open={assistantOpen}
          onClose={() => setAssistantOpen(false)}
          pageContext={assistantContext}
        />
      )}
    </Layout>
  );
}
