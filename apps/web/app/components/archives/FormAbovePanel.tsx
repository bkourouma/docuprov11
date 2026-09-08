'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { Button, Card } from 'antd';
import { icons } from '../../theme/icons';

/**
 * Motif « formulaire au-dessus » — SECOND motif officiel des écrans de paramétrage
 * (specs/002-relook/plan.md, arbitrage n°7), à côté de `RefLayout` (table à gauche,
 * formulaire étroit à droite).
 *
 * Il existe parce que certains paramétrages ont un formulaire LARGE — plusieurs
 * champs par ligne — qui ne tient pas dans la colonne latérale de `RefLayout` :
 * paramétrage des types, cycles de vie. Le déclencheur est posé sous le titre et
 * aligné à droite (demande explicite), pas dans `PageHeader.actions`.
 *
 * Le panneau porte l'ancre de défilement : quand une ligne du tableau est chargée
 * dans le formulaire, celui-ci s'ouvre plus haut dans la page, hors du champ de
 * vision si l'utilisateur avait fait défiler. `focusSignal` sert à réclamer un
 * défilement même quand le panneau est DÉJÀ ouvert (clic sur une deuxième ligne),
 * cas où l'ouverture seule ne change pas d'état.
 */
export function FormAbovePanel({
  open,
  onToggle,
  triggerLabel,
  title,
  focusSignal = 0,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  /** Libellé du bouton à l'état fermé (« Nouvelle règle »…) ; ouvert, il dit « Fermer ». */
  triggerLabel: string;
  title: string;
  /** Incrémenté par l'écran à chaque chargement de ligne, pour re-déclencher le défilement. */
  focusSignal?: number;
  children: ReactNode;
}) {
  const anchor = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    // Différé d'un tour de boucle : l'ancre n'est remontée qu'après le rendu.
    const id = window.setTimeout(() => {
      // Le défilement animé est un mouvement comme un autre : sous
      // `prefers-reduced-motion`, on saute directement à destination.
      const reduit = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      anchor.current?.scrollIntoView({ behavior: reduit ? 'auto' : 'smooth', block: 'start' });
    }, 0);
    return () => window.clearTimeout(id);
  }, [open, focusSignal]);

  return (
    <>
      <div ref={anchor} style={{ marginBottom: 16, display: 'flex', justifyContent: 'flex-end' }}>
        <Button
          type="primary"
          icon={open ? <icons.close size={16} /> : <icons.add size={16} />}
          onClick={onToggle}
        >
          {open ? 'Fermer' : triggerLabel}
        </Button>
      </div>

      {open && (
        <Card title={title} style={{ marginBottom: 16 }}>
          {children}
        </Card>
      )}
    </>
  );
}
