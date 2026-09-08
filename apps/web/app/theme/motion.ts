/**
 * Primitives de mouvement réutilisables (librairie `motion`).
 *
 * Philosophie : le mouvement sert la compréhension (continuité, feedback,
 * hiérarchie), jamais la décoration. La réduction de mouvement est gérée
 * globalement par <MotionConfig reducedMotion="user"> (voir Providers) : on
 * peut donc utiliser des transforms ici sans casser l'accessibilité.
 */
import type { Variants, Transition } from 'motion/react';
import { motion as tokens } from './tokens';

export const easeOut = tokens.ease.out;
export const easeInOut = tokens.ease.inOut;

export const tMicro: Transition = { duration: tokens.duration.micro, ease: easeOut };
export const tStandard: Transition = { duration: tokens.duration.standard, ease: easeOut };
export const tEnter: Transition = { duration: tokens.duration.enter, ease: easeOut };
export const tSpring: Transition = tokens.spring;

/** Entrée douce vers le haut — cartes, sections, contenu. */
export const fadeUp: Variants = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: tEnter },
};

/** Fondu simple — squelette → contenu, panneaux. */
export const fade: Variants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: tStandard },
};

/** Conteneur de liste : orchestre l'apparition échelonnée (stagger subtil). */
export const staggerContainer: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: tokens.stagger, delayChildren: 0.04 } },
};

/** Item de liste/tableau, à utiliser dans un staggerContainer. */
export const staggerItem: Variants = {
  hidden: { opacity: 0, y: 6 },
  show: { opacity: 1, y: 0, transition: tStandard },
};

/** Puce de filtre — entrée/sortie avec ressort, compatible layout animation. */
export const chip: Variants = {
  hidden: { opacity: 0, scale: 0.8 },
  show: { opacity: 1, scale: 1, transition: tSpring },
  exit: { opacity: 0, scale: 0.8, transition: tMicro },
};

/** Carte/élément cliquable — retour tactile au survol/press. */
export const pressable = {
  whileHover: { y: -2, transition: tMicro },
  whileTap: { scale: 0.985, transition: { duration: 0.08 } },
};

/** Entrée de modale (l'overlay/scale réel est géré par AntD ; ceci sert au contenu sur-mesure). */
export const modalContent: Variants = {
  hidden: { opacity: 0, y: 12, scale: 0.98 },
  show: { opacity: 1, y: 0, scale: 1, transition: { duration: tokens.duration.enter, ease: easeOut } },
};
