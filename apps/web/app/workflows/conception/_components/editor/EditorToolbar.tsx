'use client';

import type { ReactNode } from 'react';
import { Button, Dropdown, Segmented } from 'antd';
import type { MenuProps } from 'antd';
import { icons, iconDefaults } from '../../../../theme/icons';
import type { EditorViewMode } from '../../../_lib/editor-state';

export type ToolbarBusy = 'save' | 'verify' | 'publish' | 'archive' | 'draft' | null;

export interface EditorToolbarProps {
  /** Mobile (< 768 px) : seul « Enregistrer » reste visible, le reste passe dans « Plus ». */
  compact: boolean;
  readOnly: boolean;
  /** La version ouverte est un brouillon. */
  isDraftVersion: boolean;
  definitionArchived: boolean;
  dirty: boolean;
  busy: ToolbarBusy;
  canPublish: boolean;
  /** Pourquoi « Publier » est inactif (affiché près des boutons et relié par aria-describedby). */
  publishBlockedReason: string | null;
  view: EditorViewMode;
  onView(view: EditorViewMode): void;
  onSave(): void;
  onVerify(): void;
  onPublish(): void;
  onCreateDraft(): void;
  onArchive(): void;
  onAutoLayout(): void;
}

const ico = (name: keyof typeof icons): ReactNode => {
  const Glyph = icons[name];
  return <Glyph {...iconDefaults} size={16} />;
};

/** Barre d'outils : boutons texte + icône ; les actions secondaires vivent dans le menu « Plus ». */
export function EditorToolbar(p: EditorToolbarProps) {
  const working = p.busy !== null;
  const saveDisabled = p.readOnly || !p.dirty || working;
  const verifyDisabled = p.readOnly || !p.isDraftVersion || working;
  const publishDisabled = !p.canPublish || working;

  // Éléments communs du menu « Plus ».
  const moreItems: NonNullable<MenuProps['items']> = [];
  if (p.compact) {
    moreItems.push(
      { key: 'verify', icon: ico('validated'), label: 'Vérifier', disabled: verifyDisabled },
      { key: 'publish', icon: ico('send'), label: 'Publier…', disabled: publishDisabled },
      { type: 'divider' },
    );
  }
  moreItems.push(
    {
      key: 'draft',
      icon: ico('edit'),
      label: 'Créer un brouillon à partir de cette version',
      // Pertinent seulement pour une version figée ; un workflow archivé n'accepte plus de brouillon.
      disabled: p.isDraftVersion || p.definitionArchived || working,
    },
    { key: 'layout', icon: ico('refresh'), label: 'Réorganiser automatiquement', disabled: p.readOnly || working },
    { type: 'divider' },
    {
      key: 'archive',
      icon: ico('archive'),
      label: 'Archiver le workflow',
      danger: true,
      disabled: p.definitionArchived || working,
    },
  );

  const onMore: MenuProps['onClick'] = ({ key }) => {
    if (key === 'verify') p.onVerify();
    else if (key === 'publish') p.onPublish();
    else if (key === 'draft') p.onCreateDraft();
    else if (key === 'layout') p.onAutoLayout();
    else if (key === 'archive') p.onArchive();
  };

  return (
    <div className="wfe-toolbar" role="toolbar" aria-label="Actions de l’éditeur">
      <div className="wfe-toolbar-group">
        <Button
          type="primary"
          icon={ico('document')}
          loading={p.busy === 'save'}
          disabled={saveDisabled}
          onClick={p.onSave}
        >
          Enregistrer le brouillon
        </Button>
        {!p.compact && (
          <>
            <Button
              icon={ico('validated')}
              loading={p.busy === 'verify'}
              disabled={verifyDisabled}
              onClick={p.onVerify}
            >
              Vérifier
            </Button>
            <Button
              icon={ico('send')}
              loading={p.busy === 'publish'}
              disabled={publishDisabled}
              onClick={p.onPublish}
              aria-describedby={p.publishBlockedReason ? 'wfe-publish-reason' : undefined}
            >
              Publier
            </Button>
          </>
        )}
        <Dropdown menu={{ items: moreItems, onClick: onMore }} trigger={['click']} placement="bottomLeft">
          <Button icon={ico('menu')} aria-haspopup="menu">
            Plus
          </Button>
        </Dropdown>
      </div>

      <Segmented<EditorViewMode>
        aria-label="Mode d’affichage"
        value={p.view}
        onChange={p.onView}
        options={[
          { value: 'graph', label: 'Vue graphique' },
          { value: 'list', label: 'Vue liste' },
        ]}
      />

      {p.publishBlockedReason && !p.readOnly && (
        <p id="wfe-publish-reason" className="wfe-hint wfe-toolbar-reason">
          Publication impossible : {p.publishBlockedReason}
        </p>
      )}
    </div>
  );
}
