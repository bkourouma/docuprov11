'use client';

import { usePathname } from 'next/navigation';
import { Avatar, Button, Dropdown, Grid, Typography, type MenuProps } from 'antd';
import { icons } from '../theme/icons';
import { radii } from '../theme/tokens';
import { activeItem } from './nav';
import { LogoIcon } from './BrandMark';
import { NotificationsBell } from './NotificationsBell';

interface Me {
  username: string;
  fullName: string | null;
  isAdmin: boolean;
}

function initials(me: Me | null): string {
  const base = me?.fullName || me?.username || '?';
  const parts = base.trim().split(/\s+/);
  return (parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '');
}

/**
 * Barre supérieure « Plus Admin » : bleu roi plein CONSTANT entre les thèmes
 * (îlot `--da-topbar-*`, PRD relook §4.4), bouton de repli, titre de la page,
 * recherche globale (palette ⌘K), cloche, menu utilisateur.
 *
 * Le thème sombre n'est pas proposé : sa bascule a été retirée de la barre à la
 * demande de l'utilisateur, l'application reste en clair (cf. `Providers`).
 *
 * Le bouton de repli est un bouton texte discret, identique aux autres actions de
 * la barre : la languette rose #ff0854 de la §4.4 (« signature n°2 ») a été retirée
 * à la demande de l'utilisateur.
 *
 * Les popovers (cloche, menu utilisateur) sont portalés hors de l'îlot et
 * restent rendus sous le thème ambiant.
 */
export function TopBar({
  me,
  collapsed,
  onToggleSider,
  onOpenMenu,
  onOpenPalette,
  onLogout,
}: {
  me: Me | null;
  /** État replié de la sidebar (desktop) — pilote le libellé de la languette. */
  collapsed: boolean;
  onToggleSider: () => void;
  onOpenMenu: () => void;
  onOpenPalette: () => void;
  onLogout: () => void;
}) {
  const pathname = usePathname();
  const screens = Grid.useBreakpoint();
  const isMobile = !screens.lg;

  const current = activeItem(pathname);
  const Search = icons['search'];
  // Desktop : le glyphe dit dans quel sens le clic agit (replier / déplier). Mobile : hamburger.
  const Toggle = isMobile ? icons['menu'] : collapsed ? icons['expand'] : icons['collapse'];

  const userMenu: MenuProps['items'] = [
    {
      key: 'who',
      disabled: true,
      label: (
        <div style={{ padding: '2px 0' }}>
          <div style={{ fontWeight: 600 }}>{me?.fullName ?? me?.username ?? '—'}</div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {me?.username}
            {me?.isAdmin ? ' · admin' : ''}
          </Typography.Text>
        </div>
      ),
    },
    { type: 'divider' },
    {
      key: 'logout',
      icon: <icons.logout size={16} strokeWidth={1.75} />,
      label: 'Déconnexion',
      onClick: onLogout,
    },
  ];

  return (
    <header
      className="da-topbar"
      style={{
        height: 60,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '0 16px',
        position: 'sticky',
        top: 0,
        zIndex: 20,
      }}
    >
      {/* Repli de la sidebar (desktop) / ouverture du drawer (mobile). */}
      <Button
        type="text"
        aria-label={
          isMobile
            ? 'Ouvrir le menu'
            : collapsed
              ? 'Déplier la barre latérale'
              : 'Replier la barre latérale'
        }
        icon={<Toggle size={20} strokeWidth={1.75} />}
        onClick={isMobile ? onOpenMenu : onToggleSider}
      />

      {isMobile && <LogoIcon size={26} />}

      {/*
        Le titre absorbe l'espace disponible (`flex: 1 1 auto`) et peut RÉTRÉCIR
        (`minWidth: 0`). En mobile il n'est PAS affiché — la place est trop courte,
        et l'écran courant est déjà signalé par l'item actif du tiroir de navigation —
        mais le bloc reste en place pour pousser les actions vers la droite.
      */}
      <div style={{ minWidth: 0, flex: '1 1 auto', overflow: 'hidden' }}>
        {!isMobile && (
          <span
            style={{
              // Titre : blanc en clair, atténué #b9c0d4 en sombre (5,09:1 sur bleu roi).
              color: 'var(--da-on-topbar-muted)',
              fontSize: 16,
              fontWeight: 600,
              display: 'block',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {current?.label ?? 'Docu-Archives'}
          </span>
        )}
      </div>

      {/*
        Déclencheur de recherche globale. Le faux champ « Rechercher… » ne tient pas sur un
        téléphone (240 px minimum), mais le masquer purement et simplement — ce qui était le cas
        — rendait la recherche globale INATTEIGHABLE en mobile : le seul autre point d'entrée est
        le raccourci Ctrl+K, qu'un téléphone n'a pas. On conditionne donc la FORME, pas la
        présence : bouton-icône sous 992 px, faux champ au-dessus.
      */}
      {isMobile ? (
        <button
          onClick={onOpenPalette}
          aria-label="Recherche globale"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            // 44 px : seuil de cible tactile retenu par la définition de terminé. Ce bouton est
            // un <button> nu (pas un `.ant-btn`), la règle de `globals.css` ne l'atteint pas.
            width: 44,
            height: 44,
            flex: 'none',
            border: 'none',
            background: 'transparent',
            color: 'var(--da-on-topbar)',
            cursor: 'pointer',
          }}
        >
          <Search size={20} strokeWidth={1.75} />
        </button>
      ) : (
        <button
          onClick={onOpenPalette}
          aria-label="Recherche globale (Ctrl+K)"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            height: 36,
            padding: '0 10px 0 12px',
            minWidth: 240,
            border: '1px solid rgba(255, 255, 255, 0.35)',
            // Déclencheur dessiné à la main : il imite un champ, il en suit donc le rayon.
            borderRadius: radii.field,
            background: 'rgba(255, 255, 255, 0.12)',
            color: 'var(--da-on-topbar)',
            cursor: 'pointer',
          }}
        >
          <Search size={16} strokeWidth={1.75} />
          <span style={{ flex: 1, textAlign: 'left', fontSize: 13, fontWeight: 400 }}>
            Rechercher…
          </span>
          <kbd
            style={{
              fontFamily: 'var(--font-geist-mono, monospace)',
              fontSize: 11,
              padding: '2px 6px',
              borderRadius: 4,
              border: '1px solid rgba(255, 255, 255, 0.35)',
              background: 'transparent',
              color: 'var(--da-on-topbar)',
            }}
          >
            Ctrl K
          </kbd>
        </button>
      )}

      <NotificationsBell />

      <Dropdown menu={{ items: userMenu }} trigger={['click']} placement="bottomRight">
        <button
          aria-label="Menu utilisateur"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
            padding: '4px 6px',
            // Bouton dessiné à la main, voisin des boutons AntD de la barre : même rayon.
            borderRadius: radii.field,
          }}
        >
          <Avatar
            size={32}
            style={{
              background: 'var(--da-on-topbar)',
              color: 'var(--da-topbar-bg)',
              fontSize: 13,
              fontWeight: 600,
            }}
          >
            {initials(me).toUpperCase() || '?'}
          </Avatar>
          {!isMobile && (
            <span style={{ textAlign: 'left', lineHeight: 1.2 }}>
              <span
                style={{
                  display: 'block',
                  fontSize: 13,
                  fontWeight: 600,
                  color: 'var(--da-on-topbar)',
                }}
              >
                {me?.fullName ?? me?.username ?? '—'}
              </span>
              {me?.isAdmin && (
                <span style={{ fontSize: 11, color: 'var(--da-on-topbar-muted)' }}>admin</span>
              )}
            </span>
          )}
        </button>
      </Dropdown>
    </header>
  );
}
