// Domaine métier PUR de Docu-Archives : aucune dépendance NestJS/Prisma.
export * from './dua';
export * from './lending-scope';

// Normalisation des libellés de référentiel : la règle est UNE (`lower(replace(label,' ',''))`,
// miroir des index SQL uniques partiels), elle a été écrite pour Docu-Courriers et vaut telle
// quelle ici. On la ré-exporte plutôt que de la dupliquer — une seconde copie dériverait, et la
// divergence se paierait en 500 (violation de contrainte) au lieu d'un 409 lisible.
export { findLabelConflict, labelDedupKey, normaliseLabel } from '../../courriers/domain/label-normalisation';
