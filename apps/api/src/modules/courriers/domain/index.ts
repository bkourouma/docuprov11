// Domaine métier PUR de Docu-Courriers (phase B) : aucune dépendance NestJS/Prisma.
// Machine à états, règles de traitement, files de travail, numérotation, dérivations.
export * from './mail-status';
export * from './auto-treatment';
export * from './queues';
export * from './nreference';
export * from './organigramme';
export * from './label-normalisation';
export * from './fiche-imputation';
export * from './mail-scope';
// Tableau de bord (lot D1) : sémantique des KPI isolée et testée avant toute requête/UI.
export * from './dashboard-archivage';
export * from './dashboard-buckets';
export * from './dashboard-sla';
export * from './dashboard-delta';
export * from './top-n';
