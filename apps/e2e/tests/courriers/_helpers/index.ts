/** Réexport des aides du module Docu-Courriers (signatures figées : voir le brief commun). */
export * from './menus';
export * from './actors';
export * from './files';
export * from './referentials';
export * from './mails';
export * from './ui';
export { apiBaseUrl, loginApi, HttpError, type MiniApi } from './http';
export { uniqueSuffix, slug, todayIso } from './unique';
export { default as seedCourriers } from './global-seed';
