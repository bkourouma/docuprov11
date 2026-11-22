'use client';

import '@ant-design/v5-patch-for-react-19';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Badge, Drawer, Grid, Layout, Menu, Spin, type MenuProps } from 'antd';
import { getBadges, type BadgeCounts } from '../lib/courriers';
import { getMe, type Me } from '../lib/auth';
import { icons } from '../theme/icons';
import { NAV, activeItem } from './nav';
import { Logo, LogoIcon } from './BrandMark';
import { TopBar } from './TopBar';
import { CommandPalette } from './CommandPalette';
import dynamic from 'next/dynamic';
import { hasAssistantMenu } from './assistant/_lib/access';
import { pageContextFromPath } from './assistant/_lib/page-context';
import { useAssistantShortcut } from './assistant/useAssistantShortcut';

// Panneau de l'assistant : chargé à la demande, côté client seulement (jamais pour qui n'a pas le menu).
const AssistantDrawer = dynamic(() => import('./assistant/AssistantDrawer').then((m) => m.AssistantDrawer), {
  ssr: false,
});

const { Sider, Content } = Layout;

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

/** Clé d'accordéon d'une section (préfixée : ne doit jamais collisionner avec une route). */
const sectionKey = (label: string) => `section:${label}`;

/** Section de NAV contenant une route donnée — sert à ouvrir la bonne au chargement. */
function sectionOf(pathname: string): string | null {
  const item = activeItem(pathname);
  if (!item) return null;
  return NAV.find((s) => s.items.some((i) => i.key === item.key))?.label ?? null;
}

/**
 * Items de menu AntD construits depuis la config de navigation centrale,
 * filtrés selon les menus autorisés (`allowed`). `null` = aucun filtrage.
 * Le tableau de bord (« /dashboards ») reste toujours visible ; les sections vides sont masquées.
 *
 * Chaque section est un accordéon (sous-menu repliable) et non plus un groupe plat.
 * Les entrées de §04.7 portent leur compteur ; un compteur nul n'affiche rien. Le compteur est
 * aussi **cumulé sur le titre de la section quand elle est fermée** : sans cela, replier
 * « Docu-Courriers » masquerait l'alerte, ce qui viderait les badges de leur raison d'être.
 * L'affichage du cumul est piloté par `openKeys` (état React) et non en CSS : AntD v5 empile ses
 * règles dans des `@layer`, où un `opacity` maison se fait écraser sans qu'on voie lequel gagne.
 */
function useMenuItems(
  allowed: Set<string> | null,
  badges: BadgeCounts | null,
  openKeys: string[],
  collapsed: boolean,
): MenuProps['items'] {
  return useMemo(
    () =>
      NAV.map((section) => {
        const visible = section.items.filter(
          (item) =>
            !allowed ||
            item.key === '/dashboards' ||
            allowed.has(item.key) ||
            item.altKeys?.some((k) => allowed.has(k)),
        );
        if (visible.length === 0) return null;

        const children = visible.map((item) => {
          const Glyph = icons[item.icon];
          const badgeKey = BADGE_KEY_BY_MENU[item.key];
          const count = badgeKey && badges ? badges[badgeKey] : 0;
          return {
            key: item.key,
            icon: <Glyph size={18} strokeWidth={1.75} />,
            // Le libellé reste une CHAÎNE, compteur ou pas : un élément React à la place faisait
            // disparaître le texte dans le popup de la barre repliée (seule l'icône restait), et
            // seules les entrées à compteur non nul étaient touchées. Le compteur passe par `extra`,
            // le mécanisme prévu par AntD pour l'aligner à droite dans tous les modes.
            label: item.label,
            extra:
              count > 0 ? (
                <Badge count={count} overflowCount={99} color="var(--ant-color-primary, #0033c4)" />
              ) : undefined,
          };
        });

        const total = visible.reduce((sum, item) => {
          const badgeKey = BADGE_KEY_BY_MENU[item.key];
          return sum + (badgeKey && badges ? badges[badgeKey] : 0);
        }, 0);

        const key = sectionKey(section.label);
        const SectionGlyph = icons[section.icon];
        return {
          key,
          // L'icône est ce qui reste visible barre repliée : AntD masque le libellé UNIQUEMENT
          // s'il suit une icône (`.ant-menu-item-icon + span`). Sans elle, les titres de section
          // débordaient du rail de 76 px, tronqués en « Docu-A », « Paramé »…
          // Le libellé masqué emporte le cumul des compteurs : repliée, il repasse en pastille
          // sur l'icône, sans quoi replier la barre masquerait l'alerte.
          icon:
            collapsed && total > 0 ? (
              <Badge dot offset={[1, 1]} color="var(--ant-color-primary, #0033c4)">
                <SectionGlyph size={18} strokeWidth={1.75} />
              </Badge>
            ) : (
              <SectionGlyph size={18} strokeWidth={1.75} />
            ),
          // Cumul affiché seulement section fermée : ouverte, les compteurs des entrées suffisent.
          label: (
            <MenuSectionLabel label={section.label} total={openKeys.includes(key) ? 0 : total} />
          ),
          children,
        };
      }).filter((s): s is NonNullable<typeof s> => s !== null),
    [allowed, badges, openKeys, collapsed],
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
 * Bandeau du logo, en tête de la barre latérale et du drawer.
 *
 * `flex: none` : il est hors du conteneur qui défile (cf. `SIDER_SCROLL`), donc il ne bouge
 * pas ET la barre de défilement ne le traverse pas — elle commence sous lui.
 */
function SiderBrand({ collapsed, onHome }: { collapsed?: boolean; onHome: () => void }) {
  return (
    <div
      style={{
        flex: 'none',
        height: 60,
        display: 'flex',
        alignItems: 'center',
        padding: collapsed ? 0 : '0 20px',
        justifyContent: collapsed ? 'center' : 'flex-start',
        background: 'var(--ant-color-bg-container, #fff)',
      }}
    >
      <a onClick={onHome} aria-label="Accueil" style={{ display: 'inline-flex' }}>
        {collapsed ? <LogoIcon size={32} /> : <Logo height={26} />}
      </a>
    </div>
  );
}

/**
 * Conteneur défilant du menu : SEULE partie de la barre latérale qui défile, pour que
 * l'ascenseur ne remonte pas dans le bandeau du logo. `minHeight: 0` est indispensable — sans
 * lui, un enfant flex refuse de rétrécir sous sa hauteur de contenu et rien ne défile.
 */
const SIDER_SCROLL = {
  flex: '1 1 auto',
  minHeight: 0,
  overflowY: 'auto',
  paddingBlock: 8,
} as const;

/** Titre de section + cumul des compteurs de ses entrées (0 = rien affiché). */
function MenuSectionLabel({ label, total }: { label: string; total: number }) {
  return (
    <span
      style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}
    >
      {label}
      {total > 0 && (
        <Badge count={total} overflowCount={99} color="var(--ant-color-primary, #0033c4)" />
      )}
    </span>
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

  // Accordéon : une seule section ouverte à la fois. Initialisée sur la section de la route
  // courante — sinon on arriverait sur un menu entièrement replié, sans voir où l'on est.
  const [openKeys, setOpenKeys] = useState<string[]>(() => {
    const s = sectionOf(pathname);
    return s ? [sectionKey(s)] : [];
  });

  // Repliée, la barre n'affiche aucun libellé : le cumul doit rester visible, donc on considère
  // toutes les sections comme fermées.
  const menuItems = useMenuItems(allowed, badges, collapsed ? [] : openKeys, collapsed);

  // Navigation vers une autre section (lien direct, palette de commandes…) : on l'ouvre.
  useEffect(() => {
    const s = sectionOf(pathname);
    if (s) setOpenKeys([sectionKey(s)]);
  }, [pathname]);

  // Ne garde que la dernière section ouverte : c'est ce qui fait l'accordéon. La ref évite de
  // recréer le callback (et de re-rendre le menu) à chaque ouverture.
  const openKeysRef = useRef<string[]>(openKeys);
  openKeysRef.current = openKeys;
  const onOpenChange = useCallback((keys: string[]) => {
    const opened = keys.find((k) => !openKeysRef.current.includes(k));
    setOpenKeys(opened ? [opened] : []);
  }, []);
  const selectedKey = activeItem(pathname)?.key ?? pathname;

  // Restaure l'état replié de la barre latérale (desktop).
  useEffect(() => {
    setCollapsed(window.localStorage.getItem(COLLAPSE_KEY) === '1');
  }, []);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((c) => {
      window.localStorage.setItem(COLLAPSE_KEY, c ? '0' : '1');
      return !c;
    });
  }, []);

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
    // Écran d'attente : première surface vue à chaque session (PRD relook §4.4).
    return (
      <div
        style={{
          display: 'grid',
          placeItems: 'center',
          minHeight: '100vh',
          gap: 16,
          background: 'var(--ant-color-bg-layout, #f8f9fb)',
        }}
      >
        <LogoIcon size={46} />
        <Spin />
      </div>
    );
  }

  const menu = (
    <Menu
      mode="inline"
      // Indentation des sous-menus : le défaut (24px, doublé au niveau 2) pousse les entrées
      // trop à droite et fait déborder libellés et compteurs hors de la barre (264px).
      inlineIndent={12}
      selectedKeys={[selectedKey]}
      // Repliée, la barre affiche les sections en popup : `openKeys` ne s'y applique pas et AntD
      // gère l'ouverture au survol. On ne le pilote donc qu'en mode déplié.
      {...(collapsed ? {} : { openKeys, onOpenChange })}
      items={menuItems}
      onClick={({ key }) => navigate(key)}
      // Aucun paddingInline : l'item actif « rempli » court d'un bord à l'autre
      // de la barre (signature n°3 Plus Admin, Menu.itemMarginInline: 0).
      style={{ borderInlineEnd: 0, background: 'transparent' }}
    />
  );

  return (
    <Layout style={{ minHeight: '100vh' }}>
      {!isMobile && (
        <Sider
          theme="light"
          // `da-sider` : passe `.ant-layout-sider-children` en colonne flex (globals.css), sans
          // quoi le bandeau et le menu ne peuvent pas se partager la hauteur.
          className="da-sider"
          // 260 px : largeur Plus Admin (PRD relook §4.4). Le repli se pilote
          // depuis la languette de la top bar (signature n°2), plus de bouton ici.
          width={260}
          collapsedWidth={76}
          collapsed={collapsed}
          style={{
            position: 'sticky',
            top: 0,
            height: '100vh',
            // Le défilement appartient au conteneur du menu, pas à la barre.
            overflow: 'hidden',
            borderInlineEnd: '1px solid var(--ant-color-border, #e4e9f0)',
            background: 'var(--ant-color-bg-container, #fff)',
          }}
        >
          <SiderBrand collapsed={collapsed} onHome={() => navigate('/dashboards')} />
          <div style={SIDER_SCROLL}>{menu}</div>
        </Sider>
      )}

      <Layout style={{ background: 'var(--ant-color-bg-layout, #f8f9fb)' }}>
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
        width={260}
        styles={{
          body: { padding: 0, display: 'flex', flexDirection: 'column' },
          header: { display: 'none' },
        }}
      >
        <SiderBrand onHome={() => navigate('/dashboards')} />
        <div style={SIDER_SCROLL}>{menu}</div>
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
