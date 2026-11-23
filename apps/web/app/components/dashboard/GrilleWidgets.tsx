'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Button, Tooltip, Typography } from 'antd';
import {
  ResponsiveGridLayout,
  useContainerWidth,
  type Layout,
  type ResponsiveLayouts,
} from 'react-grid-layout';
import { icons, iconDefaults } from '../../theme/icons';
import { EmptyState } from '../EmptyState';
import { fontSize, radii } from '../../theme/tokens';

import 'react-grid-layout/css/styles.css';

/**
 * Grille de tableau de bord personnalisable (react-grid-layout v2, API à hooks — `WidthProvider`
 * appartient à l'entrée `legacy` et n'est pas repris ici).
 *
 * **Partagée entre Docu-Courriers et Docu-Archives.** Elle ne connaît ni les widgets ni leurs
 * données : le module appelant fournit un contexte opaque `ctx` et la fonction `rendre` qui
 * transforme un identifiant en vue. La grille ne gère que le placement, l'édition et la remontée
 * des positions — ce qui évite d'entretenir deux copies d'une mécanique dont les subtilités sont
 * coûteuses (cf. le point de rupture ci-dessous).
 *
 * **Une seule grille, sur 12 colonnes, à toutes les largeurs.** C'est le point important, et il
 * corrige un bug de fond : la grille était auparavant déclinée en quatre points de rupture
 * (`lg`/`md`/`sm`/`xs`, 12/12/6/4 colonnes) alors que l'agencement enregistré, lui, n'en a jamais
 * eu qu'un. Or la bibliothèque range les déplacements sous le point de rupture COURANT
 * (`layouts[breakpoint]`) et laisse les autres intacts : relire `layouts.lg` en dur, comme on le
 * faisait, ne remontait donc RIEN dès que la grille n'était pas sur `lg` — un portable 1440 y
 * suffit, une fois le menu latéral (264 px) et les gouttières (64 px) déduits, le conteneur tombe
 * à ~1100 px, soit `md`. L'utilisateur réorganisait son tableau de bord, cliquait
 * « Enregistrer », et l'agencement d'ORIGINE était réécrit tel quel.
 *
 * Supprimer les points de rupture supprime la classe entière de défauts : ce qui est composé est
 * exactement ce qui est enregistré, puis exactement ce qui est réaffiché, quelle que soit la
 * taille de l'écran. La grille ne se réorganise plus en cours de route — elle se contente de
 * rétrécir, la largeur des colonnes étant dérivée du conteneur mesuré.
 *
 * Contrepartie assumée : sur un écran étroit, une mise en page composée côte à côte le reste, au
 * lieu de s'empiler d'elle-même. Elle demeure bornée par les `minW` du catalogue, et les
 * agencements livrés placent l'essentiel des widgets sur 12 colonnes — l'empilement y est donc
 * déjà le comportement par défaut.
 */
const COLONNES_PERSISTEES = 12;
/** Point de rupture unique : `0` le rend toujours actif, quelle que soit la largeur mesurée. */
const RUPTURE = 'base';
const POINTS_DE_RUPTURE = { [RUPTURE]: 0 } as const;
const COLONNES = { [RUPTURE]: COLONNES_PERSISTEES } as const;
const HAUTEUR_LIGNE = 30;
const MARGE: readonly [number, number] = [16, 16];
/** Classe du conteneur : elle borne les correctifs de style ci-dessous à cette grille. */
const CLASSE_GRILLE = 'da-grille-widgets';

/**
 * Correctifs de la feuille livrée par react-grid-layout, qui code deux valeurs hors palette :
 * un fantôme de placement `background: red` et des poignées de redimensionnement en
 * `rgba(0,0,0,.4)`, invisibles sur fond sombre. On ne redéfinit que les couleurs et le rayon —
 * la géométrie et la règle « poignée révélée au survol » de la bibliothèque restent en place,
 * c'est ce qui les garde discrètes. React 19 hisse et déduplique cette feuille via `href`.
 */
const CORRECTIFS_GRILLE = `
.${CLASSE_GRILLE} .react-grid-item.react-grid-placeholder {
  background: var(--ant-color-primary);
  opacity: 0.12;
  border-radius: ${radii.card}px;
}
.${CLASSE_GRILLE} .react-grid-item > .react-resizable-handle::after {
  border-right-color: var(--ant-color-text-quaternary);
  border-bottom-color: var(--ant-color-text-quaternary);
}
.${CLASSE_GRILLE} .react-grid-item:hover > .react-resizable-handle::after {
  border-right-color: var(--ant-color-primary);
  border-bottom-color: var(--ant-color-primary);
}
`;

/** Position d'un widget dans la grille — la seule chose qui soit persistée, avec son id. */
export interface PlacementWidget {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Widget placé, enrichi des métadonnées du catalogue serveur (jamais du JSON stocké). */
export interface WidgetPlace extends PlacementWidget {
  titre: string;
  minW: number;
  minH: number;
}

export function GrilleWidgets<Ctx>({
  widgets,
  ctx,
  edition,
  onLayoutChange,
  onRetirer,
  rendre,
  connu,
}: {
  widgets: WidgetPlace[];
  ctx: Ctx;
  edition: boolean;
  onLayoutChange: (placements: PlacementWidget[]) => void;
  onRetirer: (id: string) => void;
  /** Vue d'un widget. Le module appelant est seul à connaître ses données. */
  rendre: (id: string, ctx: Ctx) => ReactNode;
  /** L'identifiant est-il rendu par CETTE version du frontend ? */
  connu: (id: string) => boolean;
}) {
  // La v2 exige une largeur explicite : ce hook mesure le conteneur et la fournit.
  const { width, mounted, containerRef } = useContainerWidth();

  /**
   * Les graphiques (G2, `autoFit`) ne se recalent que sur l'évènement `resize` de la FENÊTRE.
   * Or la grille change de largeur sans que la fenêtre bouge : à la première mesure (le hook
   * part de 1280 px), puis à chaque repli ou dépli du panneau de navigation. Sans ce relais, un
   * graphique monté trop large reste rogné à droite. On relaie donc tout changement de largeur
   * en `resize`, une fois la transition de la grille terminée (200 ms).
   */
  useEffect(() => {
    if (!mounted || width <= 0) return;
    const timer = window.setTimeout(() => window.dispatchEvent(new Event('resize')), 260);
    return () => window.clearTimeout(timer);
  }, [mounted, width]);

  /**
   * Mode compact : sous 768 px, on SORT de react-grid-layout et on empile les widgets.
   *
   * Sur la grille de 12 colonnes, un widget de 6 colonnes tombe à ~156 px de large sur un
   * écran de 360 — inexploitable pour un graphique. L'empilement leur rend toute la largeur.
   *
   * **RGL n'est alors PAS MONTÉ.** C'est la garantie qui compte : il ne peut émettre aucun
   * `onLayoutChange`, donc l'agencement 12 colonnes enregistré par l'utilisateur ne peut pas
   * être écrasé depuis un téléphone. Le bug documenté en tête de ce fichier venait exactement
   * de là — une grille qui se réorganise et remonte des positions qui ne sont pas celles que
   * l'utilisateur a composées.
   *
   * Contrepartie assumée (arbitrage validé) : ni glissement ni redimensionnement sous 768 px.
   * L'ajout, le retrait et l'enregistrement continuent de fonctionner.
   *
   * `matchMedia` plutôt que la largeur mesurée du conteneur : celle-ci n'est pas monotone au
   * passage du palier (le padding de `.da-page` passe de 16 à 27 px à 768), on ne peut donc
   * pas en déduire un seuil fiable. Posé dans un effet, jamais dans l'initialiseur d'état :
   * lire `window` au rendu créerait un écart d'hydratation.
   */
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const sync = () => setCompact(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  const layouts: ResponsiveLayouts<string> = useMemo(
    () => ({
      [RUPTURE]: widgets.map((w) => ({
        i: w.id,
        x: w.x,
        y: w.y,
        w: w.w,
        h: w.h,
        minW: w.minW,
        minH: w.minH,
        // Hors édition, rien ne bouge : un glissement accidentel ne doit pas modifier
        // silencieusement une mise en page que l'utilisateur croit figée.
        static: !edition,
      })),
    }),
    [widgets, edition],
  );

  if (widgets.length === 0) {
    return <EmptyState icon="analytics" title="Aucun widget affiché" />;
  }

  if (compact) {
    // Ordre de lecture de la grille : de haut en bas, puis de gauche à droite. La hauteur
    // reprend la formule de RGL (lignes + gouttières) pour que chaque widget garde la taille
    // que son auteur lui a donnée.
    const ordre = [...widgets].sort((a, b) => a.y - b.y || a.x - b.x);
    return (
      <div
        className={CLASSE_GRILLE}
        style={{ display: 'flex', flexDirection: 'column', gap: MARGE[1] }}
      >
        {ordre.map((w) => (
          <div
            key={w.id}
            style={{ height: w.h * HAUTEUR_LIGNE + (w.h - 1) * MARGE[1], overflow: 'hidden' }}
          >
            <CadreWidget
              widget={w}
              ctx={ctx}
              edition={edition}
              onRetirer={onRetirer}
              rendre={rendre}
              connu={connu}
            />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div ref={containerRef} className={CLASSE_GRILLE} style={{ width: '100%' }}>
      <style href="da-grille-widgets" precedence="default">
        {CORRECTIFS_GRILLE}
      </style>
      {/* Tant que le conteneur n'est pas mesuré, une largeur nulle empilerait tous les widgets
          au même endroit le temps d'une image. */}
      {mounted && width > 0 && (
        <ResponsiveGridLayout
          width={width}
          layouts={layouts}
          breakpoints={POINTS_DE_RUPTURE}
          cols={COLONNES}
          rowHeight={HAUTEUR_LIGNE}
          margin={MARGE}
          containerPadding={[0, 0]}
          dragConfig={{
            enabled: edition,
            // Poignée dédiée : sans elle, tout clic dans un widget (un onglet, un lien) amorcerait
            // un glissement et l'écran deviendrait inutilisable en mode édition.
            handle: '.tdb-poignee',
          }}
          resizeConfig={{ enabled: edition }}
          onLayoutChange={(courant: Layout) => {
            if (!edition) return;
            // `courant` EST la disposition qui vient de changer. La lire directement, au lieu de
            // rouvrir `layouts.lg` en dur, est tout l'objet du correctif : il n'existe plus qu'un
            // point de rupture, donc ces positions sont TOUJOURS celles de la grille enregistrée.
            if (courant.length === 0) return;
            onLayoutChange(courant.map((l) => ({ id: l.i, x: l.x, y: l.y, w: l.w, h: l.h })));
          }}
        >
          {widgets.map((w) => (
            <div key={w.id} style={{ overflow: 'hidden' }}>
              <CadreWidget
                widget={w}
                ctx={ctx}
                edition={edition}
                onRetirer={onRetirer}
                rendre={rendre}
                connu={connu}
              />
            </div>
          ))}
        </ResponsiveGridLayout>
      )}
    </div>
  );
}

function CadreWidget<Ctx>({
  widget,
  ctx,
  edition,
  onRetirer,
  rendre,
  connu,
}: {
  widget: WidgetPlace;
  ctx: Ctx;
  edition: boolean;
  onRetirer: (id: string) => void;
  rendre: (id: string, ctx: Ctx) => ReactNode;
  connu: (id: string) => boolean;
}) {
  const Deplacer = icons.expand;
  const Fermer = icons.close;

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* En-tête toujours visible (identifie le widget dans la grille) ; en mode édition, cette
          même zone devient la poignée de glissement + le bouton de retrait. */}
      <div
        className={edition ? 'tdb-poignee' : undefined}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          padding: edition ? '4px 8px' : '0 2px',
          marginBottom: edition ? 4 : 10,
          borderRadius: radii.base,
          background: edition ? 'var(--ant-color-fill-quaternary)' : 'transparent',
          border: edition ? '1px dashed var(--ant-color-border)' : 'none',
          cursor: edition ? 'move' : 'default',
        }}
      >
        {edition ? (
          <Tooltip title="Glisser pour déplacer">
            <span
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                flex: 1,
                minWidth: 0,
                color: 'var(--ant-color-text-tertiary)',
              }}
            >
              <Deplacer {...iconDefaults} size={14} />
              <Typography.Text style={{ fontSize: fontSize.xs }} ellipsis>
                {widget.titre}
              </Typography.Text>
            </span>
          </Tooltip>
        ) : (
          <Typography.Text
            strong
            style={{
              fontSize: fontSize.sm,
              color: 'var(--ant-color-text-secondary)',
              flex: 1,
              minWidth: 0,
            }}
            ellipsis
          >
            {widget.titre}
          </Typography.Text>
        )}
        {edition && (
          <Tooltip title="Retirer du tableau de bord">
            <Button
              type="text"
              size="small"
              aria-label={`Retirer ${widget.titre}`}
              onClick={() => onRetirer(widget.id)}
              icon={<Fermer {...iconDefaults} size={14} />}
            />
          </Tooltip>
        )}
      </div>

      {/* Défilement VERTICAL seulement. Les zones composent leurs tuiles avec `Row gutter`, dont
          Ant Design implémente les gouttières par une marge négative (`margin-inline: -8px`) : en
          `overflow: auto`, ces 8 px de débordement suffisaient à faire apparaître une barre de
          défilement horizontale sous CHAQUE widget, pour un contenu qui tient pourtant en largeur
          (les colonnes compensent la marge par leur propre padding — rien n'est rogné en la
          masquant). Le contenu réellement trop large reste défilable : les tableaux Ant Design
          gèrent leur propre `.ant-table-body`, qui n'est pas concerné par cette règle. */}
      <div style={{ flex: 1, minHeight: 0, overflowX: 'hidden', overflowY: 'auto' }}>
        {connu(widget.id) ? (
          rendre(widget.id, ctx)
        ) : (
          // Backend plus récent que le frontend déployé : on le dit au lieu de rendre un trou.
          <EmptyState compact icon="alert" title="Widget non reconnu" />
        )}
      </div>
    </div>
  );
}
