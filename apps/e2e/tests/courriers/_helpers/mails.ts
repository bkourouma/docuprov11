/**
 * Aides de création / lecture de courriers par l'API.
 *
 * ─── Machine à états utile aux tests (lue dans `mails.service.ts` et `mail-inputations.service.ts`) ───
 *
 * Courrier = ligne `mail` : `mailType` (0 Arrivée, 1 Départ, 2 Interne), `status` (0 Rédaction,
 * 1 Rédigé, 2 Déchargé, 3 Traité, 4 Supprimé — jamais posé, cf. suppression logique), et des
 * DRAPEAUX indépendants : `valider`, `validationDG`, `validationDirection`, `decharge`,
 * `enregistrementReponse`, plus `dateTraited` (= « archivé / sorti des files en cours ») et
 * `isDeleted`. Les files sont des FILTRES sur ces champs, pas des étapes exclusives.
 *
 *  1. Enregistrement Arrivée (§05) `POST /courriers/arrivee` : `status=0`, `mailType=0`,
 *     `valider=false`, destinataire = RÔLE (`destinataireRoleId`), n° `nReference` sur 5 chiffres
 *     (max+1 global Arrivée/Interne si non fourni). `scannedDocumentId` → scan promu en document GED
 *     et marqué traité (`isTraite=true`, `mailId`). `enCopieUserGroupIds` → imputations type 17.
 *  2. Contrôle (§06) `GET /courriers/controle` : file PERSONNELLE du destinataire principal —
 *     `isDeleted=false`, `valider=false`, et (porteur du rôle destinataire OU acteur nommé).
 *     En sortie :
 *       - `POST /courriers/:id/valider` → `valider=true` (+ journal 1019, notification) ;
 *       - `POST /courriers/imputations` PAR le destinataire principal → auto-validation
 *         (`autoValiderOnImputation`) ; une imputation créée par un tiers (admin compris, s'il ne
 *         porte pas le rôle) NE valide PAS ;
 *       - `DELETE /courriers/:id` → `isDeleted=true` (statut inchangé), le courrier disparaît de
 *         toutes les files et `GET /courriers/:id` répond 404.
 *  3. Parapheur / Courriers Imputés (§08) `GET /courriers/parapheur` : file PERSONNELLE de l'imputé —
 *     au moins une imputation à lui, non traitée (`dateTreated=null`), de type ≠ 17 (En Copie).
 *     N'exige PAS `valider=true`. Sorties : `POST :id/imputations/lecture` (traite les types
 *     `suivi=true`, ex. 10 Pour Suivi, et passe Traité si toutes le sont), `POST :id/imputations/traiter`
 *     (traite tout + Traité + `dateTraited`), `POST :id/imputations/traiter-destinataire` (Validation).
 *     Soumission à validation : `POST /courriers/imputations/validation` (type 5 DG ou 14 Direction).
 *  4. Suivi (§09) `GET /courriers/suivi` : `dateTraited=null` dans le périmètre (MENU_SUIVI = tous,
 *     MENU_SUIVI_DC = ceux où l'utilisateur porte une imputation, aucun menu = vide).
 *  5. Validation (§10) `GET /courriers/validation-direction` : `valider=true` ET `dateTraited=null`
 *     (sans périmètre). `POST /courriers/validation-direction { mailIds }` → `validationDirection`,
 *     Traité, `dateTraited`, toutes les imputations traitées. `POST :id/validation-dg` → `validationDG`
 *     + imputation 10 « Pour Suivi » (+48 h) par porteur du rôle destinataire.
 *  6. Départ (§12) `POST /courriers/depart` : `mailType=1`, `status=1 Rédigé`, `dateDecharge=now`,
 *     émetteur = acteur courant ; n° par TYPE de départ. `parentMailId` → le parent est archivé
 *     (`dateTraited`). File `GET /courriers/depart` : Départs Traités ou en suivi ouvert.
 *  7. Décharge : `POST :id/decharge` (drapeau `decharge=true`, workflow §08) ≠ intégration de la
 *     décharge signée §13 `POST :id/integration-decharge { scannedDocumentId | documentId }` →
 *     document `decharge=true`, statut 2 Déchargé + `dateDecharge` + `dateTraited` (archivé).
 *     Lookup `GET /courriers/decharges-en-attente` : Départs sans document de décharge.
 *  8. Archivage `POST :id/archiver` (menus Parapheur/Validation) : `dateTraited=now`, statut inchangé.
 *
 * Hypothèses à vérifier en phase B :
 *  - `api.post/get` renvoient le JSON de la réponse ; `api.upload(path, { field, file, fields })`
 *    poste un multipart (`file` au format Playwright).
 *  - `arriveeImputee` se connecte EN TANT QUE `dest` (client `fetch` de `http.ts`) pour que
 *    l'imputation déclenche l'auto-validation et porte `createdBy = dest`. Le rôle de `dest` doit
 *    donc avoir l'un des menus `/courriers/controle`, `/courriers/parapheur` ou `/courriers/validation`.
 */
import type { ApiClient } from '../../../fixtures';
import type { CourrierActor } from './actors';
import { pdfUpload } from './files';
import { loginApi } from './http';
import { INPUTATION_TYPE } from './menus';
import { todayIso, uniqueSuffix } from './unique';

export interface MailRef {
  mailId: number;
  nReference: string | null;
  title: string;
}

function toRef(row: { mailId: number; nReference: string | null; title: string }): MailRef {
  return { mailId: row.mailId, nReference: row.nReference ?? null, title: row.title };
}

/** Retire les clés `undefined` : le corps JSON ne doit porter que ce que le test a fourni. */
function compact<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** `POST /courriers/arrivee` (menu Enregistrement). `date` défaut : aujourd'hui (UTC). */
export async function createArrivee(
  api: ApiClient,
  input: {
    title: string;
    destinataireRoleId: number;
    date?: string;
    externalEntityId?: number;
    mailNatureId?: number;
    mailObjetId?: number;
    confidentialiteId?: number;
    dateButoire?: string;
    reference?: string;
    description?: string;
    scannedDocumentId?: number;
    enCopieUserGroupIds?: number[];
  },
): Promise<MailRef> {
  const row = (await api.post(
    '/courriers/arrivee',
    compact({ ...input, date: input.date ?? todayIso() }),
  )) as { mailId: number; nReference: string | null; title: string };
  return toRef(row);
}

/** `POST /courriers/documents-scannes` (multipart, champ `file`, `machineName` facultatif). */
export async function uploadScan(
  api: ApiClient,
  opts?: { name?: string; machineName?: string },
): Promise<{ mailScannedDocumentId: number; fileName: string }> {
  const name = opts?.name ?? `scan-e2e-${uniqueSuffix()}.pdf`;
  const row = (await api.upload('/courriers/documents-scannes', {
    field: 'file',
    file: pdfUpload(name),
    ...(opts?.machineName ? { fields: { machineName: opts.machineName } } : {}),
  })) as { mailScannedDocumentId: number; fileName: string | null };
  return { mailScannedDocumentId: row.mailScannedDocumentId, fileName: row.fileName ?? name };
}

/** `GET /courriers/:id` — détail complet (imputations, documents, destinataire). 404 si supprimé. */
export async function getMail(api: ApiClient, mailId: number): Promise<any> {
  return api.get(`/courriers/${mailId}`);
}

/** `POST /courriers/imputations` (menus Contrôle, Parapheur ou Validation). */
export async function imputer(
  api: ApiClient,
  input: {
    mailId: number;
    userGroupId: number;
    mailInputationTypeId: number;
    instructions?: string;
    deadline?: string;
  },
): Promise<any> {
  return api.post('/courriers/imputations', compact(input));
}

/** `POST /courriers/depart` (menu Départ). Émetteur = acteur courant. `date` défaut : aujourd'hui. */
export async function createDepart(
  api: ApiClient,
  input: {
    title: string;
    mailDepartTypeId?: number;
    externalEntityId?: number;
    parentMailId?: number;
    scannedDocumentId?: number;
    date?: string;
  },
): Promise<MailRef> {
  const row = (await api.post(
    '/courriers/depart',
    compact({ ...input, date: input.date ?? todayIso() }),
  )) as { mailId: number; nReference: string | null; title: string };
  return toRef(row);
}

/**
 * Monte un courrier Arrivée jusqu'au parapheur d'un imputé : enregistrement (admin) adressé au rôle
 * de `dest`, puis imputation de `impute` PAR `dest` (type « Pour Suivi » par défaut), ce qui
 * auto-valide le contrôle (`valider=true`) et retire le courrier de la file Contrôle de `dest`.
 */
export async function arriveeImputee(
  api: ApiClient,
  opts: { prefix: string; dest: CourrierActor; impute: CourrierActor; typeId?: number },
): Promise<MailRef> {
  const mail = await createArrivee(api, {
    title: `${opts.prefix} courrier imputé ${uniqueSuffix()}`,
    destinataireRoleId: opts.dest.roleId,
  });
  const asDest = await loginApi(opts.dest.username, opts.dest.password);
  await asDest.post('/courriers/imputations', {
    mailId: mail.mailId,
    userGroupId: opts.impute.userGroupId,
    mailInputationTypeId: opts.typeId ?? INPUTATION_TYPE.pourSuivi,
  });
  return mail;
}
