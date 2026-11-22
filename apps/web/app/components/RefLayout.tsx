'use client';

import {
  cloneElement,
  useCallback,
  useId,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { App, Button, Card, Col, ConfigProvider, Drawer, Grid, Row, Space } from 'antd';
import { PageHeader } from './PageHeader';
import { EmptyState } from './EmptyState';
import { downloadExport } from '../lib/api';
import { icons, type IconName } from '../theme/icons';
import { fontSize, space } from '../theme/tokens';

/**
 * Patron commun des pages de référentiels : PageHeader + exports (Excel/PDF),
 * tableau pleine zone à gauche, carte « Nouvel élément » à droite (desktop) ou
 * en Drawer déclenché par un bouton « + » (mobile).
 *
 * Le formulaire est fourni via `renderForm(close)` : la page appelle `close()`
 * après une création réussie pour refermer le Drawer mobile.
 *
 * Le tableau court BORD À BORD dans sa carte, comme les listes de courriers : c'est le même
 * papier de registre. Ce qui l'accompagne (barre de lot, filtre, alerte, squelette, état
 * vide) garde sa gouttière — règles `.da-ref-card` de globals.css.
 *
 * `loadFailed` : la page signale que la lecture a échoué ET qu'elle n'a rien à montrer. La
 * carte dit alors l'échec et propose de réessayer, au lieu d'afficher « Ce référentiel est
 * vide » — un registre qui n'a pas pu être lu n'est pas un registre vide.
 */
export function RefLayout({
  icon,
  title,
  exportPath,
  exportFilename,
  tableTitle,
  table,
  formTitle,
  renderForm,
  tableSpan = 15,
  loadFailed = false,
  onRetry,
}: {
  icon: IconName;
  title: string;
  /** Endpoint d'export. Omis = pas de boutons Excel/PDF (référentiel sans export serveur). */
  exportPath?: string;
  exportFilename?: string;
  tableTitle: string;
  table: ReactNode;
  formTitle: string;
  renderForm: (close: () => void) => ReactNode;
  tableSpan?: number;
  /** La lecture a échoué et la page n'a aucune ligne à montrer. */
  loadFailed?: boolean;
  /** Relance la lecture depuis l'état d'échec ; la promesse rendue pilote l'attente du bouton. */
  onRetry?: () => void | Promise<void>;
}) {
  const { message } = App.useApp();
  const screens = Grid.useBreakpoint();
  const isWide = screens.lg;
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Relecture en cours depuis l'état d'échec : le bouton tourne, la carte ne reste pas muette.
  const [retrying, setRetrying] = useState(false);
  const retry = async () => {
    if (!onRetry) return;
    setRetrying(true);
    try {
      await onRetry();
    } finally {
      setRetrying(false);
    }
  };

  const onExport = async (format: 'xlsx' | 'pdf') => {
    if (!exportPath) return;
    const ok = await downloadExport(exportPath, format, exportFilename ?? 'export');
    if (!ok) message.error('Export impossible — réessayez.');
  };

  /**
   * Vide guidé à la place du « Aucune donnée » d'AntD. On passe par le
   * `renderEmpty` du ConfigProvider et non par `locale.emptyText` : la table est
   * un ReactNode opaque fourni par la page, le patron ne peut pas lui poser de
   * prop — et une page qui définit son propre `emptyText` reste prioritaire.
   * Mémorisé : une nouvelle identité invaliderait le contexte AntD à chaque
   * rendu et re-rendrait la table pour rien (ouverture du Drawer, par exemple).
   */
  const renderTableEmpty = useCallback(
    (componentName?: string) =>
      componentName === 'Table' ? (
        <EmptyState
          icon={icon}
          title="Ce référentiel est vide"
          action={
            !isWide ? (
              <Button
                type="primary"
                icon={<icons.add size={16} />}
                onClick={() => setDrawerOpen(true)}
              >
                Nouvel élément
              </Button>
            ) : undefined
          }
        />
      ) : undefined,
    [icon, formTitle, isWide],
  );

  return (
    <div>
      <PageHeader
        icon={icon}
        title={title}
        actions={
          <>
            {exportPath && (
              <>
                {/* Deux pictos distincts : les deux boutons étaient indiscernables
                    au coup d'œil. `icons.tsx` n'expose pas de picto « tableur »,
                    on oppose donc le téléchargement de données (Excel) au
                    fichier document (PDF). */}
                <Button icon={<icons.download size={16} />} onClick={() => void onExport('xlsx')}>
                  Excel
                </Button>
                <Button icon={<icons.document size={16} />} onClick={() => void onExport('pdf')}>
                  PDF
                </Button>
              </>
            )}
            {!isWide && (
              <Button
                type="primary"
                icon={<icons.add size={16} />}
                onClick={() => setDrawerOpen(true)}
              >
                Nouvel élément
              </Button>
            )}
          </>
        }
      />

      <Row gutter={[16, 16]} align="top">
        <Col xs={24} lg={isWide ? tableSpan : 24}>
          <ConfigProvider renderEmpty={renderTableEmpty}>
            <Card
              variant="outlined"
              title={tableTitle}
              className="da-ref-card"
              styles={{ body: { padding: 0 } }}
            >
              {loadFailed ? (
                <EmptyState
                  icon="alert"
                  title="Le référentiel n’a pas pu être chargé"
                  action={
                    onRetry ? (
                      <Button loading={retrying} onClick={() => void retry()}>
                        Réessayer
                      </Button>
                    ) : undefined
                  }
                />
              ) : (
                table
              )}
            </Card>
          </ConfigProvider>
        </Col>
        {isWide && (
          <Col lg={24 - tableSpan}>
            <Card variant="outlined" title={formTitle}>
              {renderForm(() => {})}
            </Card>
          </Col>
        )}
      </Row>

      {!isWide && (
        <Drawer
          title={formTitle}
          placement="right"
          // Largeur en CSS plutôt qu'en JS : la valeur précédente était lue une seule fois sur
          // `window.innerWidth` au rendu — elle ne suivait donc pas une rotation d'écran, et le
          // repli SSR (380) dépassait la fenêtre d'un téléphone de 360 le temps de l'hydratation.
          // `min()` fait le même calcul, en continu, et sans lire `window`.
          width="min(380px, calc(100vw - 24px))"
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
        >
          {renderForm(() => setDrawerOpen(false))}
        </Drawer>
      )}
    </div>
  );
}

/** Espace vertical standard pour les formulaires « Nouvel élément ». */
export function NewItemForm({ children }: { children: ReactNode }) {
  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      {children}
    </Space>
  );
}

/**
 * Champ étiqueté des formulaires « Nouvel élément » : un VRAI `<label>` associé
 * au champ, là où le patron simulait l'étiquette avec un `Typography.Text` (rien
 * d'annonçable au lecteur d'écran, et le clic sur le libellé ne donnait pas le
 * focus).
 *
 * L'identifiant est généré ici et injecté dans l'enfant : aucun appelant n'a à
 * inventer d'id unique, et un `id` déjà posé sur le champ est respecté.
 */
export function NewItemField({
  label,
  required = false,
  children,
}: {
  label: string;
  /** Ajoute l'astérisque visuelle et `aria-required` sur le champ. */
  required?: boolean;
  // `aria-required` suit le type `Booleanish` des attributs ARIA de React : le
  // restreindre à `boolean` rendrait les props d'Input/TextArea non assignables.
  children: ReactElement<{ id?: string; 'aria-required'?: boolean | 'true' | 'false' }>;
}) {
  const generatedId = useId();
  const fieldId = children.props.id ?? generatedId;

  return (
    <div>
      <label
        htmlFor={fieldId}
        style={{
          display: 'block',
          marginBottom: space.sm,
          fontSize: fontSize.base,
          color: 'var(--ant-color-text)',
        }}
      >
        {label}
        {required && (
          <span aria-hidden style={{ marginLeft: 4, color: 'var(--ant-color-error)' }}>
            *
          </span>
        )}
      </label>
      {cloneElement(children, { id: fieldId, 'aria-required': required || undefined })}
    </div>
  );
}
