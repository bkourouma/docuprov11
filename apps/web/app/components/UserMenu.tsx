'use client';

import { cloneElement, type CSSProperties, type ReactElement } from 'react';
import { useRouter } from 'next/navigation';
import { Avatar, Divider, Dropdown, theme, type MenuProps } from 'antd';
import { icons } from '../theme/icons';

export interface ShellUser {
  username: string;
  fullName: string | null;
  isAdmin: boolean;
}

function initials(me: ShellUser | null): string {
  const base = me?.fullName || me?.username || '?';
  const parts = base.trim().split(/\s+/);
  return (parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '');
}

/**
 * Menu utilisateur : pastille aux initiales ouvrant l'identité, « Mon profil » et la
 * déconnexion. Deux emplacements, un seul composant :
 * - `rail` : au pied du rail des modules (poste de bureau) ;
 * - `bar` : dans la barre supérieure (mobile, où le rail vit dans le tiroir de navigation).
 *
 * L'identité est un EN-TÊTE du panneau, pas une entrée de menu désactivée : une entrée
 * désactivée prend l'encre grisée d'AntD (2,1:1 sur blanc), illisible pour ce qui est
 * justement l'information du panneau. L'en-tête est à l'encre, le nom d'utilisateur en
 * secondaire.
 */
export function UserMenu({
  me,
  onLogout,
  variant,
}: {
  me: ShellUser | null;
  onLogout: () => void;
  variant: 'rail' | 'bar';
}) {
  const router = useRouter();
  const { token } = theme.useToken();
  const onRail = variant === 'rail';
  const name = me?.fullName ?? me?.username ?? '—';

  const items: MenuProps['items'] = [
    {
      key: 'profile',
      icon: <icons.users size={16} strokeWidth={1.75} />,
      label: 'Mon profil',
      onClick: () => router.push('/profil'),
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
    <Dropdown
      menu={{ items }}
      trigger={['click']}
      placement={onRail ? 'topLeft' : 'bottomRight'}
      dropdownRender={(menu) => (
        <div
          style={{
            minWidth: 208,
            background: token.colorBgElevated,
            borderRadius: token.borderRadiusLG,
            boxShadow: token.boxShadowSecondary,
          }}
        >
          <div style={{ padding: '12px 16px 10px' }}>
            <div style={{ fontWeight: 600, color: token.colorText }}>{name}</div>
            {me?.username && (
              <div style={{ fontSize: 12, color: token.colorTextSecondary }}>
                {me.username}
                {me.isAdmin ? ' · admin' : ''}
              </div>
            )}
          </div>
          <Divider style={{ margin: 0 }} />
          {/* Le menu garde son comportement (clavier, focus) ; seule son ombre propre est
              retirée, le panneau qui l'enveloppe la porte déjà. */}
          {cloneElement(menu as ReactElement<{ style?: CSSProperties }>, {
            style: { boxShadow: 'none', background: 'transparent' },
          })}
        </div>
      )}
    >
      <button
        aria-label={`Menu utilisateur : ${name}`}
        className={onRail ? 'da-rail-user' : 'da-bar-user'}
      >
        <Avatar
          size={onRail ? 36 : 32}
          style={{
            background: onRail ? 'var(--da-rail-hover)' : 'var(--da-topbar-avatar-bg)',
            color: onRail ? '#ffffff' : 'var(--da-topbar-avatar-fg)',
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          {initials(me).toUpperCase() || '?'}
        </Avatar>
      </button>
    </Dropdown>
  );
}
