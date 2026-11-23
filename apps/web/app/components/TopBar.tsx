'use client';

import { usePathname } from 'next/navigation';
import { Button, Grid } from 'antd';
import { icons } from '../theme/icons';
import { radii } from '../theme/tokens';
import { OFF_MENU_TITLES, placeOfPath } from './nav';
import { LogoIcon } from './BrandMark';
import { NotificationsBell } from './NotificationsBell';
import { UserMenu, type ShellUser } from './UserMenu';

/**
 * Barre supérieure « Registre » : posée sur le fond de page, un filet pour seule limite.
 * Elle dit OÙ l'on est (fil d'Ariane module / geste / écran) et donne la recherche globale
 * (palette Ctrl+K), l'assistant et la cloche.
 *
 * Le menu utilisateur vit au pied du rail des modules sur un poste de bureau ; il ne revient
 * ici qu'en mobile, où le rail est rangé dans le tiroir de navigation.
 *
 * Le thème sombre n'est pas proposé : l'application reste en clair (cf. `Providers`).
 * Les popovers (cloche, menu utilisateur) sont portalés hors de la barre.
 */
export function TopBar({
  me,
  collapsed,
  onToggleSider,
  onOpenMenu,
  onOpenPalette,
  onLogout,
  onOpenAssistant,
}: {
  me: ShellUser | null;
  /** Panneau des écrans replié (poste de bureau) — pilote le libellé et le glyphe du bouton. */
  collapsed: boolean;
  onToggleSider: () => void;
  onOpenMenu: () => void;
  onOpenPalette: () => void;
  onLogout: () => void;
  /** Ouvre l'assistant ; fourni seulement si l'utilisateur détient le menu `/assistant` (sinon pas de bouton). */
  onOpenAssistant?: () => void;
}) {
  const pathname = usePathname();
  const screens = Grid.useBreakpoint();
  const isMobile = !screens.lg;

  const place = placeOfPath(pathname);
  const Search = icons['search'];
  // Desktop : le glyphe dit dans quel sens le clic agit (replier / déplier). Mobile : hamburger.
  const Toggle = isMobile ? icons['menu'] : collapsed ? icons['expand'] : icons['collapse'];

  return (
    <header
      className="da-topbar"
      style={{
        height: 56,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '0 16px',
        position: 'sticky',
        top: 0,
        zIndex: 20,
      }}
    >
      {/* Repli du panneau des écrans (desktop) / ouverture du tiroir (mobile). */}
      <Button
        type="text"
        aria-label={
          isMobile
            ? 'Ouvrir le menu'
            : collapsed
              ? 'Déplier le panneau des écrans'
              : 'Replier le panneau des écrans'
        }
        icon={<Toggle size={20} strokeWidth={1.75} />}
        onClick={isMobile ? onOpenMenu : onToggleSider}
      />

      {/* Le logo vit dans le panneau des écrans : il revient ici quand celui-ci n'est pas à
          l'écran (mobile, ou panneau replié), pour que la marque ne disparaisse jamais. */}
      {(isMobile || collapsed) && <LogoIcon size={26} />}

      {/*
        Le fil d'Ariane absorbe l'espace disponible (`flex: 1 1 auto`) et peut RÉTRÉCIR
        (`minWidth: 0`). En mobile il n'est PAS affiché — la place est trop courte, et l'écran
        courant est déjà signalé dans le tiroir de navigation — mais le bloc reste en place
        pour pousser les actions vers la droite.
      */}
      <div style={{ minWidth: 0, flex: '1 1 auto', overflow: 'hidden' }}>
        {!isMobile && (
          <nav className="da-crumbs" aria-label="Emplacement dans l’application">
            {place ? (
              <>
                <span>{place.module.label}</span>
                <span className="da-crumb-sep" aria-hidden>
                  /
                </span>
                <span>{place.group.label}</span>
                <span className="da-crumb-sep" aria-hidden>
                  /
                </span>
                <span className="da-crumb-here" aria-current="page">
                  {place.item.label}
                </span>
              </>
            ) : (
              <span className="da-crumb-here" aria-current="page">
                {OFF_MENU_TITLES[pathname] ?? 'DocuPro'}
              </span>
            )}
          </nav>
        )}
      </div>

      {/*
        Déclencheur de recherche globale. Le faux champ ne tient pas sur un téléphone, mais le
        masquer purement et simplement rendrait la recherche globale INATTEIGNABLE en mobile : le
        seul autre point d'entrée est le raccourci Ctrl+K, qu'un téléphone n'a pas. On conditionne
        donc la FORME, pas la présence : bouton-icône sous 992 px, faux champ au-dessus.
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
          aria-label="Aller à un écran (Ctrl+K)"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            height: 34,
            padding: '0 8px 0 12px',
            minWidth: 300,
            flex: 'none',
            // Déclencheur dessiné à la main : il imite un champ, il en suit donc la bordure de
            // contrôle (3,4:1) et le rayon.
            border: '1px solid var(--da-topbar-field-line)',
            borderRadius: radii.field,
            background: 'var(--da-topbar-field)',
            color: 'var(--da-on-topbar-muted)',
            fontFamily: 'inherit',
            cursor: 'pointer',
          }}
        >
          <Search size={16} strokeWidth={1.75} />
          <span style={{ flex: 1, textAlign: 'left', fontSize: 13 }}>Aller à un écran</span>
          <kbd
            style={{
              fontFamily: 'inherit',
              fontSize: 11,
              fontWeight: 600,
              padding: '2px 6px',
              borderRadius: 4,
              border: '1px solid var(--da-topbar-line)',
              background: 'var(--da-topbar-bg)',
              color: 'var(--da-on-topbar)',
            }}
          >
            Ctrl K
          </kbd>
        </button>
      )}

      {onOpenAssistant && (
        <Button
          type="text"
          aria-label="Ouvrir l’assistant (Alt+Maj+A)"
          title="Assistant (Alt+Maj+A)"
          icon={<icons.sparkle size={20} strokeWidth={1.75} />}
          onClick={onOpenAssistant}
        />
      )}

      <NotificationsBell />

      {isMobile && <UserMenu me={me} onLogout={onLogout} variant="bar" />}
    </header>
  );
}
