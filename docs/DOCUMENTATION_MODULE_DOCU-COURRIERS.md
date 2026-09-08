# Documentation complète — Module **Docu‑Courriers** (DocuPro SENAT)

> **Objet.** Ce document décrit **exhaustivement**, dans un seul fichier, le module de gestion du courrier **Docu‑Courriers** : chaque écran (rôle métier, permissions, champs d'interface, service applicatif, DTOs, **tables & colonnes**, règles de gestion et transitions de statut). Objectif : permettre la **ré‑implémentation du module dans une autre stack**, page par page, fonctionnalité par fonctionnalité.
>
> **Fiabilité.** Chaque section a été rédigée à partir du **code source** (contrôleur MVC + vue Razor + JavaScript + service applicatif + DTOs + entité EF Core), puis **vérifiée par une passe adverse** relisant les sources pour corriger toute propriété/colonne manquante ou tout écart. La **source de vérité reste le code** aux chemins cités.
>
> **Stack d'origine** (mentionnée pour situer le comportement, à ne PAS reporter telle quelle) : ASP.NET Zero / ABP, MVC (Area `App`), EF Core / SQL Server, multi‑tenant (`IMayHaveTenant`).

---

## Stack source (ce qui est porté)

| Aspect | Détail |
|---|---|
| Framework applicatif | ASP.NET Zero / ABP (ASP.NET Boilerplate), MVC (jQuery), Area `App` |
| Persistance | EF Core (SQL Server), entités ABP `Entity` / `CreationAuditedEntity` / `FullAuditedEntity`, multi‑tenant via `IMayHaveTenant` |
| Présentation | Vues Razor `.cshtml` + scripts `wwwroot/js/*.js` (écrans workflow) ou `wwwroot/view-resources/Areas/App/Views/<Vue>/*.js` (écrans CRUD RadTool), grilles Syncfusion / DataTables |
| Autorisation | Permissions ABP (`AppPermissions`), menus (`AppNavigationProvider`) |
| Intégration scan | Services Windows externes (dépôt des fichiers numérisés) + endpoint de réception → voir §01 et §07 |

---

## Le processus en un coup d'œil

```
                  ┌─────────────────────── FLUX ARRIVÉE ───────────────────────┐
  [Scan]          │                                                            │
 Documents        ▼                                                            ▼
 scannés (07) → Enregistrement (05) → Courriers Arrivés / Contrôle (06) → Imputation /
                                                                       Parapheur (08)
                                                                            │
                                                                            ▼
                                        Suivi (09) → Validation (10) → Décharge / Intégration (13) → Archivage
                  ┌─────────────────────── FLUX DÉPART ────────────────────────┐
 Documents        │                                                            │
 scannés (07) → Courrier de Départ (12) ──────────────────────────────────────┘
  Recherche multicritères (11) = transverse à tout le cycle
```

États du courrier (`MailStatus`) : `Redaction(0) → Rédigé(1) → Déchargé(2) → Traité(3)`, plus `Supprimé(4)`. Détails et déclencheurs en **§03**.

---

## Sommaire

**Références transverses**
- **01.** Vue d'ensemble & architecture
- **02.** Modèle de données & énumérations — *toutes les tables + colonnes*
- **03.** Workflow / cycle de vie du courrier
- **04.** Permissions & rôles

**Écrans — menu Docu‑Courriers**
- **05.** Enregistrement — `/App/AddMail`
- **06.** Courriers Arrivés (Contrôle) — `/App/Controle`
- **07.** Documents scannés — `/App/DocumentsScannes`
- **08.** Courriers Imputés (Parapheur Électronique) — `/App/ParapheurElectronique`
- **09.** Suivi des Courriers — `/App/SuiviCourriers`
- **10.** Validation — `/App/Validation`
- **11.** Recherche Multicritères — `/App/ResearchMultiCriteriaCourrier`
- **12.** Courrier de Départ — `/App/CourrierDepart`
- **13.** Intégration Décharge — `/App/IntegrationDecharge`

**Écrans — menu Paramétrage Docu‑Courriers**
- **14.** Organigrammes — `/App/Organigrammes`
- **15.** Gestion organisationnelle — `/App/RoleOrganigramme`
- **16.** Types d'entités externes — `/App/ExternalEntityTypes`
- **17.** Entités externes — `/App/ExternalEntities`
- **18.** Type d'Imputation — `/App/MailInputationTypes`
- **19.** Types de Courrier — `/App/MailDepartTypes`

> Astuce navigation : chaque section commence par son titre `## NN.` (ex. rechercher « ## 05. » pour l'écran Enregistrement).

---


## 01. Vue d'ensemble & architecture

> Document d'entrée pour un **ré-implémenteur** du module **Docu-Courriers** de DocuPro (SENAT). Il décrit le rôle du module, son découpage en couches ASP.NET Zero / ABP, la liste exhaustive des écrans (avec route + permission), les services applicatifs `MailBase`, et les services externes d'intégration scan et jobs de rappel. Les fiches détaillées par écran sont numérotées 04 à 19 (voir §3).

---

### 1. Rôle du module et périmètre

Le module **Docu-Courriers** gère le **cycle de vie du courrier** d'une institution : réception (**Arrivée**), émission (**Départ**) et circulation interne (**Interne**). Il couvre l'enregistrement du courrier, sa numérisation (scan), son imputation (routage vers des agents / unités de l'organigramme), sa validation hiérarchique (parapheur électronique, validation Direction / DG), la décharge, le suivi et l'archivage des courriers traités, ainsi que la recherche multicritère.

L'application est un monolithe **ASP.NET Zero / ABP** :
- **MVC** (Razor + jQuery/DataTables), zone (Area) `App` ;
- **EF Core** (SQL Server) via `DocuProDbContext` ;
- **Multi-tenant** : l'entité pivot `Mail` et les entités liées implémentent `IMayHaveTenant` (filtre tenant ABP actif).

La distinction Arrivée / Départ / Interne est portée par l'énumération **`MailType`** (`Arrivée`=0, `Départ`=1, `Interne`=2), colonne `Mail.MailType`. L'avancement du courrier est porté par **`MailStatus`** (`Redaction`=0, `Rédigé`=1, `Déchargé`=2, `Traité`=3, `Supprimé`=4), colonne `Mail.MailStatus`, complétée par des drapeaux booléens (`Valider`, `ValidationDirection`, `ValidationDG`, `EnregistrementReponse`, `Decharge`) et des dates (`DateEnregistrementCourrier`, `DateFollowUp`, `DateDecharge`, `DateTraited`, `DateButoire`). Réf. : `src/DocuPro.Core.Shared/Helpers/Enums.cs`, `src/DocuPro.Core/MailBase/Mail.cs`.

---

### 2. Découpage en couches ABP (emplacements)

| Couche ABP | Projet / dossier | Contenu du module Courriers |
|---|---|---|
| **Domaine / Core** | `src/DocuPro.Core/MailBase/` | Entités (tables) : `Mail.cs`, `MailInputation.cs`, `MailInputationType.cs`, `MailDocument.cs`, `MailControle.cs`, `MailComments.cs`, `MailObjet.cs`, `MailNature.cs`, `MailType.cs` (contient `MailDepartType`). Entités liées hors dossier : `Organigramme`, `ExternalEntity`/`ExternalEntityType`, `Confidentialites`, `DocumentScanne` (dans `CommonEntities`/`DocumentBase`). |
| **Core partagé** | `src/DocuPro.Core.Shared/Helpers/Enums.cs` | Énumérations partagées : `MailStatus`, `MailType`, `Privileges`. |
| **Application** | `src/DocuPro.Application/MailBase/` | Implémentations des AppServices (`MailsAppService`, `MailInputationsAppService`, …), service de domaine `MailStatusService`, import/export Excel (`Importing/`, `Exporting/`). Jobs de rappel dans `src/DocuPro.Application/Notifications/`. |
| **Application.Shared** | `src/DocuPro.Application.Shared/MailBase/` | Interfaces de service (`IMailsAppService`, …) et DTOs (`Dtos/`). |
| **EntityFrameworkCore** | `src/DocuPro.EntityFrameworkCore/EntityFrameworkCore/DocuProDbContext.cs` | `DbSet<>` et mapping : `Mails`, `MailInputations`, `MailInputationTypes`, `MailDocuments`, `MailControles`, `MailCommentses`, `MailObjets`, `MailNatures`, `MailTypes` (→ `MailDepartType`), `Organigrammes`, `ExternalEntities`, `ExternalEntityTypes`, `Confidentialiteses`, `DocumentScannes`. Migrations dans `Migrations/`. |
| **Web.Mvc** | `src/DocuPro.Web.Mvc/Areas/App/` | Contrôleurs `Controllers/DocuCourriers/*` et `Controllers/Parametrages/*` (+ `MailObjetsController`, `MailTypesController`, `MailControlesController` à la racine `Controllers/`) ; vues `Views/<Vue>/*.cshtml` ; scripts `wwwroot/js/*.js` et `wwwroot/view-resources/Areas/App/Views/<Vue>/*.js`. Menu : `Areas/App/Startup/AppNavigationProvider.cs`. API scan hors zone : `Controllers/ScannedDocumentUploadController.cs`, service `Services/WiaScannerService.cs`. |

Toutes les classes de contrôleur du module héritent de `DocuProControllerBase` et sont décorées `[Area("App")]`, d'où les routes de forme `App/<Controller>` (ex. `App/AddMail`).

---

### 3. Liste de TOUS les écrans du module (route + permission)

Seules les entrées **actives** (non commentées) de `AppNavigationProvider.cs` sont listées. La colonne « Fiche » renvoie au document détaillé correspondant. Toutes les entrées de menu (sauf `DocumentsScannes`) exigent `requiresAll: true` : **la permission de page ET la permission de menu** sont requises.

#### 3.1 Menu « Docu-Courriers » (`Menus_DocuCourriers`)

| Fiche | Écran (libellé) | Route | Permission(s) (page + menu) | Contrôleur | Badge |
|---|---|---|---|---|---|
| **04** | Ajouter un courrier (AddMail) | `App/AddMail` | `Pages_AddMail_Access` + `Menus_Docu_Courriers_AddMail` | `DocuCourriers/AddMailController.cs` | — |
| **05** | Contrôle (Controle) | `App/Controle` | `Pages_Controle_Access` + `Menus_Docu_Courriers_Controle` | `DocuCourriers/ControleController.cs` | `controle` |
| **06** | Parapheur électronique | `App/ParapheurElectronique` | `Pages_ParapheurElectronique_Access` + `Menus_Docu_Courriers_ParapheurElectronique` | `DocuCourriers/ParapheurElectroniqueController.cs` | `parapheur` |
| **07** | Validation | `App/Validation` | `Pages_Validation_Access` + `Menus_Docu_Courriers_Validation` | `DocuCourriers/ValidationController.cs` | `validation` |
| **08** | Intégration décharge | `App/IntegrationDecharge` | `Pages_IntegrationDecharge_Access` + `Menus_Docu_Courriers_IntegrationDecharge` | `DocuCourriers/IntegrationDechargeController.cs` | `integrationDecharge` |
| **09** | Suivi des courriers | `App/SuiviCourriers` | `Pages_SuiviPermanentCourrier_Access` **ou** `Pages_DC_SuiviCourrier_Access` **ou** `Menus_Docu_Courriers_SuiviPermanentCourrier` **ou** `Menus_Docu_Courriers_DC_SuiviCourrier` (OU logique, `requiresAll` absent) | `DocuCourriers/SuiviCourriersController.cs` (`[AbpMvcAuthorize(Pages_SuiviPermanentCourrier_Access, Pages_DC_SuiviCourrier_Access)]`) | `suiviCourriers` |
| **10** | Courrier départ | `App/CourrierDepart` | `Pages_CourrierDepart_Access` + `Menus_Docu_Courriers_CourrierDepart` | `DocuCourriers/CourrierDepartController.cs` | — |
| **11** | Documents scannés | `App/DocumentsScannes` | `Menus_Docu_Courriers_DocumentsScannes` (menu seul) | `DocuCourriers/DocumentsScannesController.cs` | — |
| **12** | Recherche multicritère courrier | `App/ResearchMultiCriteriaCourrier` | `Pages_ResearchMultiCriteriaCourrier_Access` + `Menus_Docu_Courriers_ResearchMultiCriteriaCourrier` | `DocuCourriers/ResearchMultiCriteriaCourrierController.cs` | — |

> Remarque : le libellé de menu de l'écran 12 est `RechercheMultiCretereCourrier` mais l'URL et le contrôleur sont `ResearchMultiCriteriaCourrier`.

#### 3.2 Menu « Paramétrage » (`Menus_MailSettings`)

| Fiche | Écran (libellé) | Route | Permission(s) (page + menu) | Contrôleur |
|---|---|---|---|---|
| **13** | Organigrammes | `App/Organigrammes` | `Pages_Organigrammes_Access` + `Menus_Mail_Settings_Organigrammes` | `Parametrages/OrganigrammesController.cs` |
| **14** | Rôle-Organigramme | `App/RoleOrganigramme` | `Pages_RoleOrganigramme_Access` + `Menus_Mail_Settings_RoleOrganigramme` | `Parametrages/RoleOrganigrammeController.cs` |
| **15** | Types d'entités externes | `App/ExternalEntityTypes` | `Pages_ExternalEntityTypes_Access` + `Menus_Mail_Settings_ExternalEntityTypes` | `Parametrages/ExternalEntityTypesController.cs` |
| **16** | Entités externes | `App/ExternalEntities` | `Pages_ExternalEntities_Access` + `Menus_Mail_Settings_ExternalEntities` | `Parametrages/ExternalEntitiesController.cs` |
| **17** | Types d'imputation | `App/MailInputationTypes` | `Pages_MailInputationTypes_Access` + `Menus_Mail_Settings_MailInputationTypes` | `Parametrages/MailInputationTypesController.cs` |
| **18** | Types de courrier départ | `App/MailDepartTypes` | `Pages_MailTypes_Access` + `Menus_Mail_Settings_MailTypes` | `Parametrages/MailDepartTypesController.cs` |

> Remarque : le `AppPageNames` de l'écran 18 est `MailTypes` mais le libellé, l'URL et le contrôleur sont `MailDepartTypes`. La permission de page réutilisée est `Pages_MailTypes_Access`.

- **Fiche 19** — proposée pour les **services externes d'intégration scan et jobs de rappel** (voir §5), qui n'ont pas d'entrée de menu propre mais conditionnent le flux « scan → Documents scannés → enregistrement du courrier » et les notifications d'échéance.

> Les numéros de fiche 04-19 sont l'ordonnancement retenu par cette documentation ; ils couvrent l'intégralité des 15 écrans + 1 fiche services.

**Contrôleurs `DocuCourriers` présents mais SANS entrée de menu active** (fonctionnalités désactivées/commentées ou secondaires, hors périmètre des fiches ci-dessus) : `AutoMailController`, `EnregistrementReponseController`, `DechargeController`, `GuichetUniqueController`, `ValidationDGController`, `ValidationMasseCourriersController`, `ArchivesCourriersTraitesController`, `ListOfMailsController`, `SuiviCourrierDepartController`, `IntegrationCourrierDepartController`, `CourriersScannesController`, `MailTabsController`, `MailViewerController`, `DownloadFileController`, `RechercheRAGController`. À documenter seulement si le ré-implémenteur réactive ces flux.

---

### 4. AppServices principaux (MailBase) et responsabilités

Implémentations : `src/DocuPro.Application/MailBase/` ; interfaces : `src/DocuPro.Application.Shared/MailBase/`. Sauf mention contraire, chaque AppService hérite de `DocuProAppServiceBase` et est décoré au niveau classe `[AbpAuthorize(AppPermissions.StandardUser)]` (autorisation fine surtout portée par les contrôleurs MVC).

| Service (impl.) | Interface | Autorisation classe | Responsabilité |
|---|---|---|---|
| `MailsAppService` | `IMailsAppService` | `StandardUser` | **Service pivot du courrier.** CRUD `Mail` ; workflow de validation (`ValidationDirection`, `UpdateValidationDG`, `UpdateValidationDirectionBatch`, `EnregistrementReponse`, `ValiderMailControle`), décharge (`DechargeCourrier`), archivage (`ArchiverCourrier`), requêtes parapheur (`GetParapheurSuiviCourriers`, `GetParapheurDecharge`, `GetParapheurCourrierValide`, `GetParapheurGuichetUnique`, `GetCourrierValidationDG`), courriers départ (`GetDepartMailsByMailDepartTypeId`), archives traitées (`GetArchivesCourriersTraités`), et jeux de reporting sur les courriers Arrivée (`GetLateProcessedIncomingMailsAsync`, `GetNonProcessedIncomingMailsAsync`, `GetIncomingMailsAsync`, …). |
| `MailInputationsAppService` | `IMailInputationsAppService` | `StandardUser` | **Imputations** (routage d'un courrier vers des utilisateurs/unités). CRUD (`CreateOrEdit`, `Delete`, `GetAll`, `GetMailInputationForView/Edit`), mise à jour du statut courrier depuis les imputations (`UpdateMailStatus`, `UpdateImputation`), validation automatique (`ValidationAutomatiqueMail`), lecture des imputations courantes (`GetCurrentInputations`, `GetCurrentIdsOfInputations`, `GetAllValidationFromMailId`), créateurs d'imputation (`GetImputationCreatorsForUser`), export Excel, lookups. |
| `MailStatusService` | `IMailStatusService` (`IDomainService`, hérite `DomainService`) | — (service de domaine) | **Transitions de statut** : `UpdateMailStatusAsync(mailId, status)` et surcharge avec `dateDecharge` (positionne `DateTraited` si `Traité`) ; `CheckAllInputationsProcessedAsync` ; `ProcessAutomaticValidationAsync`. Centralise la logique d'avancement `MailStatus`. |
| `MailDocumentsAppService` | `IMailDocumentsAppService` | `StandardUser` | **Liaison courrier ↔ document** (fichier scanné/PDF). CRUD, lookups (`GetAllMailForLookupTable`, `GetAllDocumentForLookupTable`), `GetFirstDocumentIdAsync(mailId)`, export Excel. |
| `MailControlesAppService` | `IMailControlesAppService` | `StandardUser` | **Contrôles de courrier** (poste de contrôle). CRUD, `GetUserMailControle(userId)`, lookups utilisateurs, export Excel. |
| `MailCommentsesAppService` | `IMailCommentsesAppService` | `StandardUser` | **Commentaires** attachés à un courrier. CRUD + lookups. |
| `MailObjetsAppService` | `IMailObjetsAppService` | `StandardUser` | **Référentiel objets de courrier** (`MailObjet`). CRUD + export Excel. |
| `MailNaturesAppService` | `IMailNaturesAppService` | `StandardUser` | **Référentiel natures de courrier** (`MailNature`). CRUD + export Excel. |
| `MailInputationTypesAppService` | `IMailInputationTypesAppService` | `StandardUser` | **Référentiel types d'imputation** (`MailInputationType`). CRUD, import/export Excel. |
| `MailDepartTypesAppService` (fichier `MailTypesAppService.cs`) | `IMailDepartTypesAppService` | `StandardUser` | **Référentiel types de courrier départ** (`MailDepartType`). CRUD + export Excel. |

> `IMailSequencesAppService` existe dans `Application.Shared` (avec ses DTOs `MailSequenceDto`, `CreateOrEditMailSequenceDto`, …) mais **aucune implémentation `MailSequencesAppService` n'a été trouvée dans `DocuPro.Application/MailBase/`** (numérotation de séquence non déterminée dans la source lue).

---

### 5. Services externes d'intégration scan & jobs de rappel

#### 5.1 Chaîne de numérisation (scan)

Trois briques distinctes composent la chaîne « scanner → serveur → écran Documents scannés » :

| Composant | Emplacement | Type | Rôle |
|---|---|---|---|
| **DocuPro.ScannerService** | `src/DocuPro.ScannerService/` (`Program.cs`, `Worker.cs`) | Windows Service .NET 9, `BackgroundService`, packages **NAPS2 SDK/ESCL** | Tourne sur le **poste client**. Détecte les scanners locaux (WIA, TWAIN, ESCL) et les **partage via le protocole ESCL** sur `http://localhost:9801+` (plage NAPS2 9801-9850, `EsclSecurityPolicy.ServerAllowAnyOrigin`), pour que le navigateur pilote le scan directement. **N.B. : ce projet est présent sur le disque mais n'est pas référencé dans `DocuPro.Web.sln`.** |
| **DocuPro.ScannedFolderUploadService** | `src/DocuPro.ScannedFolderUploadService/` (`Program.cs`, `ScannedFolderUploadWorker.cs`) | Windows Service .NET 8, `BackgroundService` (dans la solution) | Surveille un **dossier local** (`ScannedFolderUpload:WatchFolderPath`) via `FileSystemWatcher` ; pour chaque scan (`.pdf/.jpg/.jpeg/.png/.tiff/.tif/.bmp`), l'envoie en `multipart/form-data` (`file` + `machineName`) à `POST {ServerBaseUrl}/api/ScannedDocumentUpload/Upload` avec l'en-tête `X-Api-Key`. Succès → suppression du fichier ; échec → déplacement vers sous-dossier `Error`. |
| **ScannedDocumentUploadController** | `src/DocuPro.Web.Mvc/Controllers/ScannedDocumentUploadController.cs` | API MVC (`[Route("api/[controller]")]`, `[ApiController]`, `[AllowAnonymous]`, `[IgnoreAntiforgeryToken]`) | **Réception côté serveur.** `POST Upload(file, machineName)` : valide `X-Api-Key` (`ScannedFolderUpload:ApiKey`), impersonne un utilisateur (`ScannedFolderUpload:ImpersonateUserId`/`ImpersonateTenantId`, ou 1er utilisateur du rôle `DefaultMailDestinataire`), stocke le fichier sous `App_Data\ScannedDocuments\<TenantId|Host>\`, puis **insère une ligne `DocumentScanne`** (`FileName`, `FilePath`, `DateScanned`, `MachineName`, `IsTraite=false`). Le document reste à traiter via l'écran **Documents scannés** (fiche 11) → enregistrement du courrier. |
| **WiaScannerService** | `src/DocuPro.Web.Mvc/Services/WiaScannerService.cs` | Service serveur (helper) | Pilotage WIA côté serveur : `GetScannersAsync()`, `GetScanners()`, `GetScannerFiles()`, `ScanWithScannerAsync()`. Utilisé par les actions de scan de `AddMailController` (`ListScanners`, `ScanDocument`, …). |

#### 5.2 Jobs de rappel (Hangfire)

Les rappels s'appuient sur **Hangfire** (`RecurringJob`) enregistré au démarrage : `src/DocuPro.Web.Mvc/Startup/Startup.cs` (≈ l. 340-353). Services et jobs dans `src/DocuPro.Application/Notifications/`.

| Job / Service | Emplacement | Cron | Rôle |
|---|---|---|---|
| `MailReminderJob` → `MailReminderService` | `Notifications/MailReminderJob.cs`, `Notifications/MailReminderService.cs` | `"10 13 * * *"` (13h10 quotidien), clé `mail-reminder-datebutoire` | Rappels d'**échéance courrier** (`Mail.DateButoire`). Sélectionne les courriers `DateButoire != null`, `DateTraited == null`, `Valider == true`, puis notifie le `DestinataireExpediteur` selon le nombre de jours restants (paliers 7 / 3 / 1 / 0, et retards -1 à -3) via `IAppNotifier.RappelDateButoireAsync(...)` (« PREMIÈRE_ALERTE », « RAPPEL », « DERNIÈRE_CHANCE », « URGENCE », « RETARD »). Exécuté sous `TenantId = 1` fixé. |
| `MailInputationReminderJob` → `MailInputationReminderService` | `Notifications/MailInputationReminderJob.cs`, `Notifications/MailInputationReminderService.cs` | `"* * * * *"` (chaque minute), clé `mail-inputation-reminder-deadline` | Rappels de **deadline d'imputation** (`MailInputation.Deadline`). Sélectionne les imputations non traitées (`DateTreated == null`) dont la deadline tombe dans la fenêtre d'alerte (config `DelaisAlerte`, défaut 48h) et non renotifiées depuis `DelaisAlerteInterval` (défaut 6h). Notifie l'utilisateur imputé (`UserId`) et le créateur (`CreatorUserId`) via `IAppNotifier.RappelMailInputationDeadlineAsync(...)`, puis met à jour `MailInputation.LastReminderSent`. Exécuté sous `TenantId = 1` fixé. |

> Autre job récurrent voisin (hors courriers) : `DocumentExpirationJob` (`"50 16 * * *"`). Le projet **`DocuMediaWorkerService`** figure dans la solution mais est marqué supprimé (`D`) dans l'état git courant ; il ne fait pas partie du périmètre actif.

---

### 6. Repères de fichiers (rappel)

- Menu / navigation : `src/DocuPro.Web.Mvc/Areas/App/Startup/AppNavigationProvider.cs`
- Permissions : `src/DocuPro.Core/Authorization/AppPermissions.cs`, `AppAuthorizationProvider.cs`
- Énumérations : `src/DocuPro.Core.Shared/Helpers/Enums.cs`
- Entité pivot : `src/DocuPro.Core/MailBase/Mail.cs`
- DbContext : `src/DocuPro.EntityFrameworkCore/EntityFrameworkCore/DocuProDbContext.cs`
- AppServices Courriers : `src/DocuPro.Application/MailBase/`
- Interfaces & DTOs : `src/DocuPro.Application.Shared/MailBase/`
- Contrôleurs : `src/DocuPro.Web.Mvc/Areas/App/Controllers/DocuCourriers/` et `.../Controllers/Parametrages/`
- Services scan : `src/DocuPro.ScannerService/`, `src/DocuPro.ScannedFolderUploadService/`, `src/DocuPro.Web.Mvc/Controllers/ScannedDocumentUploadController.cs`, `src/DocuPro.Web.Mvc/Services/WiaScannerService.cs`
- Jobs de rappel : `src/DocuPro.Application/Notifications/` + enregistrement dans `src/DocuPro.Web.Mvc/Startup/Startup.cs`


---


## 02. Modèle de données & énumérations

Ce document décrit le référentiel de données du module **Docu-Courriers** (DocuPro SENAT) : les énumérations partagées, la structure exacte de chaque table (colonnes, types CLR, nullabilité, PK/FK), et le schéma relationnel. Toutes les informations sont extraites du code source ; les chemins de fichiers sont cités.

Stack : ASP.NET Zero / ABP, EF Core, multi-tenant (`IMayHaveTenant`). Les entités héritent de classes de base ABP qui apportent la clé primaire et les colonnes d'audit (voir § « Conventions de base »).

---

### Conventions de base (colonnes héritées ABP)

Les colonnes suivantes ne sont **pas** déclarées dans les entités mais proviennent des classes de base ABP. Elles s'ajoutent à chaque table selon la base héritée.

**`FullAuditedEntity`** (PK entière par défaut) — utilisée par la quasi-totalité des entités du module :

| Colonne | Type CLR | Nullable | Rôle |
|---|---|---|---|
| `Id` | `int` | Non | **PK**, auto-incrément |
| `CreationTime` | `DateTime` | Non | Date de création |
| `CreatorUserId` | `long?` | Oui | Utilisateur créateur |
| `LastModificationTime` | `DateTime?` | Oui | Date de dernière modification |
| `LastModifierUserId` | `long?` | Oui | Dernier modificateur |
| `IsDeleted` | `bool` | Non | Suppression logique (soft delete) |
| `DeleterUserId` | `long?` | Oui | Utilisateur ayant supprimé |
| `DeletionTime` | `DateTime?` | Oui | Date de suppression logique |

**`CreationAuditedEntity`** (PK entière) — utilisée uniquement par `DocumentScanne` :

| Colonne | Type CLR | Nullable | Rôle |
|---|---|---|---|
| `Id` | `int` | Non | **PK**, auto-incrément |
| `CreationTime` | `DateTime` | Non | Date de création |
| `CreatorUserId` | `long?` | Oui | Utilisateur créateur |

**`IMayHaveTenant`** ajoute la colonne `TenantId` (`int?`, nullable) sur toutes les entités du module ; un index sur `TenantId` est créé pour la plupart d'entre elles dans `OnModelCreating` (voir `DocuProDbContext.cs`).

Dans les tableaux ci-dessous, seules les colonnes **déclarées explicitement** dans l'entité sont listées (dont `TenantId`). Sauf mention contraire, chaque table possède aussi les colonnes d'audit `FullAuditedEntity` ci-dessus.

Sources : `src/DocuPro.EntityFrameworkCore/EntityFrameworkCore/DocuProDbContext.cs`, entités sous `src/DocuPro.Core/`.

---

### 1. Énumérations

Fichier : `src/DocuPro.Core.Shared/Helpers/Enums.cs` (namespace `DocuPro.CommonEntities.Helpers`).

#### 1.1 `MailStatus` — statut / cycle de vie d'un courrier

Déclarée sans valeurs explicites : l'index est implicite (0,1,2,3,4). Stockée en base sous forme d'entier (`int`).

| Valeur | Index | Signification métier |
|---|---|---|
| `Redaction` | 0 | Courrier en cours de rédaction (état initial) |
| `Rédigé` | 1 | Courrier rédigé / enregistré |
| `Déchargé` | 2 | Courrier déchargé (accusé de réception / transmission) |
| `Traité` | 3 | Courrier traité (clôturé) |
| `Supprimé` | 4 | Courrier marqué supprimé |

#### 1.2 `MailType` — sens / type de circulation du courrier

Déclarée sans valeurs explicites : index implicite (0,1,2). Stockée en `int`.

| Valeur | Index | Signification métier |
|---|---|---|
| `Arrivée` | 0 | Courrier entrant |
| `Départ` | 1 | Courrier sortant |
| `Interne` | 2 | Courrier interne |

#### 1.3 `Privileges` — niveau de privilège d'un rôle sur le contrôle courrier

Valeurs **explicites**. Chaque membre porte un attribut `[Description]` (récupérable via `EnumExtensions.GetDescription`). Utilisée par `MailControle.Priviledges` (valeur par défaut `FullControl`). Stockée en `int`.

| Valeur | Index | `[Description]` (libellé exact du code) |
|---|---|---|
| `None` | 0 | `Controle Courrier` |
| `Read` | 1 | `ValidationDG` |
| `Admin` | 2 | `Signature` |
| `FullControl` | 3 | `Contrôle total` |

Note : les libellés `[Description]` ne correspondent pas sémantiquement au nom du membre (ex. `None` → « Controle Courrier ») ; ils sont reproduits tels quels depuis la source.

#### 1.4 Énumérations connexes (contexte)

Déclarées dans le même fichier, référencées par des tables voisines du module :

- **`DocumentStates`** : `NonArchive`(0), `Archived`(1), `Restricted`(2), `Deleted`(3), `VideoCodage`(4). Utilisée par `Document.DocumentState`.
- **`DataType`** : `Null`(0), `String`(1), `Integer`(2), `Date`(3), `Text`(4), `Boolean`(5), `List`(6).
- **`DocumentVersionStates`**, **`EnumSecurityLevel`**, **`FileTypeEnum`** : hors périmètre direct du référentiel courrier.

---

### 2. Tables du module — colonnes déclarées

Pour chaque table : nom SQL `[Table("…")]`, entité, base ABP, fichier source. Les colonnes d'audit héritées (§ Conventions) sont sous-entendues et non répétées.

#### 2.1 `Mails` — entité pivot du module

Entité `Mail` (`FullAuditedEntity`, `IMayHaveTenant`, `[Audited]`). Source : `src/DocuPro.Core/MailBase/Mail.cs`. Index : `TenantId`.

| Colonne | Type CLR | Nullable | PK/FK | Description |
|---|---|---|---|---|
| `Id` | `int` | Non | PK | Identifiant courrier |
| `TenantId` | `int?` | Oui | | Tenant |
| `Title` | `string` | Non (`[Required]`) | | Objet / titre du courrier |
| `Date` | `DateTime` | Non (`[Required]`) | | Date du courrier |
| `Description` | `string` | Oui | | Description libre |
| `Reference` | `string` | Oui | | Référence |
| `MailType` | `MailType` (enum→int) | Non | | Sens (Arrivée/Départ/Interne) |
| `MailStatus` | `MailStatus` (enum→int) | Non | | Statut / cycle de vie |
| `NReference` | `string` | Oui | | Numéro de référence |
| `DateFollowUp` | `DateTime?` | Oui | | Date de suivi (début) |
| `EndDateFollowUp` | `DateTime?` | Oui | | Date de fin de suivi |
| `DateDecharge` | `DateTime?` | Oui | | Date de décharge |
| `DateTraited` | `DateTime?` | Oui | | Date de traitement |
| `DateButoire` | `DateTime?` | Oui | | Date butoir / échéance |
| `DateEnregistrementCourrier` | `DateTime?` | Oui | | Date d'enregistrement du courrier |
| `DestinataireExpediteur` | `long` | Non | FK → `User` (`AbpUsers.Id`) | Destinataire/expéditeur (nav. `DestinataireExpediteurFk`) |
| `MailNatureId` | `int?` | Oui | FK → `MailNatures` | Nature (nav. `MailNatureFk`) |
| `ConfidentialitesId` | `int?` | Oui | FK → `Confidentialiteses` | Niveau de confidentialité (nav. `ConfidentialitesFk`) |
| `ExternalEntityId` | `int` | Non | FK → `ExternalEntities` | Entité externe (nav. `ExternalEntityFk`) |
| `MailParent` | `int?` | Oui | FK → `Mails` (auto-réf.) | Courrier parent (nav. `MailParentFk`) |
| `MailObjetId` | `int?` | Oui | FK → `MailObjets` | Objet type (nav. `MailObjetFk`) |
| `OrganigrammeId` | `int?` | Oui | FK → `Organigrammes` | Rattachement organisationnel (nav. `OrganigrammeFk`) |
| `MailDepartTypeId` | `int?` | Oui | FK → `MailTypes` | Type de départ (nav. `MailDepartTypeFk`, entité `MailDepartType`) |
| `Valider` | `bool` | Non (défaut `false`) | | Drapeau : validé |
| `ValidationDirection` | `bool` | Non (défaut `false`) | | Drapeau : validation direction |
| `ValidationDG` | `bool` | Non (défaut `false`) | | Drapeau : validation DG |
| `EnregistrementReponse` | `bool` | Non (défaut `false`) | | Drapeau : réponse enregistrée |
| `Decharge` | `bool` | Non (défaut `false`) | | Drapeau : déchargé |

#### 2.2 `MailControles` — privilèges de contrôle par rôle

Entité `MailControle` (`FullAuditedEntity`, `IMayHaveTenant`). Source : `src/DocuPro.Core/MailBase/MailControle.cs`. Index : `TenantId`.

| Colonne | Type CLR | Nullable | PK/FK | Description |
|---|---|---|---|---|
| `Id` | `int` | Non | PK | Identifiant |
| `TenantId` | `int?` | Oui | | Tenant |
| `RoleId` | `int?` | Oui | FK → `AbpRoles` (`Role`) | Rôle concerné (nav. `RoleFk`) |
| `Priviledges` | `Privileges` (enum→int) | Non (défaut `FullControl`) | | Niveau de privilège (orthographe source : `Priviledges`) |

#### 2.3 `MailInputations` — imputations (affectation d'un courrier à un utilisateur)

Entité `MailInputation` (`FullAuditedEntity`, `IMayHaveTenant`, `[Audited]`). Source : `src/DocuPro.Core/MailBase/MailInputation.cs`. Index : `TenantId`.

| Colonne | Type CLR | Nullable | PK/FK | Description |
|---|---|---|---|---|
| `Id` | `int` | Non | PK | Identifiant |
| `TenantId` | `int?` | Oui | | Tenant |
| `Instructions` | `string` | Oui | | Instructions de traitement |
| `Deadline` | `DateTime?` | Oui | | Échéance |
| `DateTreated` | `DateTime?` | Oui | | Date de traitement |
| `LastReminderSent` | `DateTime?` | Oui | | Date du dernier rappel envoyé |
| `SendsSMS` | `bool` | Non | | Envoi SMS activé |
| `MailInputationTypeId` | `int` | Non | FK → `MailInputationTypes` | Type d'imputation (nav. `MailInputationTypeFk`) |
| `UserId` | `long` | Non | FK → `AbpUsers` (`User`) | Utilisateur imputé (nav. `UserFk`) |
| `MailId` | `int` | Non | FK → `Mails` | Courrier (nav. `MailFk`) |

#### 2.4 `MailInputationTypes` — types d'imputation (référentiel)

Entité `MailInputationType` (`FullAuditedEntity`, `IMayHaveTenant`). Source : `src/DocuPro.Core/MailBase/MailInputationType.cs`. Index : `TenantId`.

| Colonne | Type CLR | Nullable | PK/FK | Description |
|---|---|---|---|---|
| `Id` | `int` | Non | PK | Identifiant |
| `TenantId` | `int?` | Oui | | Tenant |
| `Name` | `string` | Oui | | Libellé du type |
| `Suivi` | `bool` | Non (défaut `false`) | | Indique si le type déclenche un suivi |

#### 2.5 `MailCommentses` — commentaires de courrier

Entité `MailComments` (`FullAuditedEntity`, `IMayHaveTenant`, `[Audited]`). Nom de table (pluriel ABP) : **`MailCommentses`**. Source : `src/DocuPro.Core/MailBase/MailComments.cs`. Index : `TenantId`.

| Colonne | Type CLR | Nullable | PK/FK | Description |
|---|---|---|---|---|
| `Id` | `int` | Non | PK | Identifiant |
| `TenantId` | `int?` | Oui | | Tenant |
| `Comments` | `string` | Non (`[Required]`) | | Contenu du commentaire |
| `UserId` | `long` | Non | FK → `AbpUsers` (`User`) | Auteur (nav. `UserFk`) |
| `MailId` | `int` | Non | FK → `Mails` | Courrier (nav. `MailFk`) |

#### 2.6 `MailDocuments` — liaison courrier ↔ document

Entité `MailDocument` (`FullAuditedEntity`, `IMayHaveTenant`, `[Audited]`). Source : `src/DocuPro.Core/MailBase/MailDocument.cs`. Index : `TenantId`.

| Colonne | Type CLR | Nullable | PK/FK | Description |
|---|---|---|---|---|
| `Id` | `int` | Non | PK | Identifiant |
| `TenantId` | `int?` | Oui | | Tenant |
| `Decharge` | `bool` | Non (`[Required]`) | | Indique si ce document est un document de décharge |
| `MailId` | `int` | Non | FK → `Mails` | Courrier (nav. `MailFk`) |
| `DocumentId` | `int` | Non | FK → `Documents` | Document lié (nav. `DocumentFk`) |

#### 2.7 `MailObjets` — objets types de courrier (référentiel + durées de suivi)

Entité `MailObjet` (`FullAuditedEntity`, `IMayHaveTenant`). Source : `src/DocuPro.Core/MailBase/MailObjet.cs`. Index : `TenantId`.

| Colonne | Type CLR | Nullable | PK/FK | Description |
|---|---|---|---|---|
| `Id` | `int` | Non | PK | Identifiant |
| `TenantId` | `int?` | Oui | | Tenant |
| `Name` | `string` | Non (`[Required]`) | | Libellé de l'objet |
| `DureeSuiviExterne` | `int` | Non | | Durée de suivi externe (jours) |
| `DureeSuiviInterne` | `int` | Non | | Durée de suivi interne (jours) |

#### 2.8 `MailNatures` — natures de courrier (référentiel)

Entité `MailNature` (`FullAuditedEntity`, `IMayHaveTenant`). Source : `src/DocuPro.Core/MailBase/MailNature.cs`. Index : `TenantId`.

| Colonne | Type CLR | Nullable | PK/FK | Description |
|---|---|---|---|---|
| `Id` | `int` | Non | PK | Identifiant |
| `TenantId` | `int?` | Oui | | Tenant |
| `Name` | `string` | Non (`[Required]`) | | Libellé de la nature |

#### 2.9 `MailTypes` (entité `MailDepartType`) — types de départ (référentiel)

**Point d'attention** : il n'existe **pas** d'entité C# nommée `MailType` (« MailType » n'existe que comme *énumération*, § 1.2). L'entité de référentiel s'appelle `MailDepartType` mais est mappée à la table SQL **`MailTypes`** et exposée par le `DbSet<MailDepartType> MailTypes`. Source : `src/DocuPro.Core/MailBase/MailType.cs` (`FullAuditedEntity`, `IMayHaveTenant`). Index : `TenantId`.

| Colonne | Type CLR | Nullable | PK/FK | Description |
|---|---|---|---|---|
| `Id` | `int` | Non | PK | Identifiant |
| `TenantId` | `int?` | Oui | | Tenant |
| `name` | `string` | Non (`[Required]`) | | Libellé du type de départ (nom de propriété en minuscule : `name`) |

#### 2.10 `ExternalEntities` — entités externes (correspondants)

Entité `ExternalEntity` (`FullAuditedEntity`, `IMayHaveTenant`, `[Audited]`). Source : `src/DocuPro.Core/CommonEntities/ExternalEntity.cs`. Index : `TenantId`.

| Colonne | Type CLR | Nullable | PK/FK | Description |
|---|---|---|---|---|
| `Id` | `int` | Non | PK | Identifiant |
| `TenantId` | `int?` | Oui | | Tenant |
| `Name` | `string` | Non (`[Required]`) | | Nom de l'entité externe |
| `Email` | `string` | Oui | | Adresse e-mail |
| `Telephone` | `string` | Oui | | Téléphone |
| `ExternalEntityTypeId` | `int?` | Oui | FK → `ExternalEntityTypes` | Type d'entité externe (nav. `ExternalEntityTypeFk`) |

#### 2.11 `ExternalEntityTypes` — types d'entités externes (référentiel)

Entité `ExternalEntityType` (`FullAuditedEntity`, `IMayHaveTenant`). Source : `src/DocuPro.Core/CommonEntities/ExternalEntityType.cs`. Index : `TenantId`.

| Colonne | Type CLR | Nullable | PK/FK | Description |
|---|---|---|---|---|
| `Id` | `int` | Non | PK | Identifiant |
| `TenantId` | `int?` | Oui | | Tenant |
| `Name` | `string` | Non (`[Required]`) | | Libellé du type |

#### 2.12 `ExternalEntityCustomProperties` — propriétés personnalisées (définition)

Entité `ExternalEntityCustomProperty` (`FullAuditedEntity`, `IMayHaveTenant`). Source : `src/DocuPro.Core/CommonEntities/ExternalEntityCustomProperty.cs`. Index : `TenantId`.

| Colonne | Type CLR | Nullable | PK/FK | Description |
|---|---|---|---|---|
| `Id` | `int` | Non | PK | Identifiant |
| `TenantId` | `int?` | Oui | | Tenant |
| `Name` | `string` | Non (`[Required]`) | | Nom de la propriété personnalisée |

#### 2.13 `ExternalEntityCustomValues` — valeurs des propriétés personnalisées

Entité `ExternalEntityCustomValue` (`FullAuditedEntity`, `IMayHaveTenant`, `[Audited]`). Source : `src/DocuPro.Core/CommonEntities/ExternalEntityCustomValue.cs`. Index : `TenantId`.

| Colonne | Type CLR | Nullable | PK/FK | Description |
|---|---|---|---|---|
| `Id` | `int` | Non | PK | Identifiant |
| `TenantId` | `int?` | Oui | | Tenant |
| `Value` | `string` | Non (`[Required]`) | | Valeur saisie |
| `ExternalEntityTypeId` | `int` | Non | FK → `ExternalEntityTypes` | Type (nav. `ExternalEntityTypeFk`) |
| `ExternalEntityCustomPropertyId` | `int` | Non | FK → `ExternalEntityCustomProperties` | Propriété (nav. `ExternalEntityCustomPropertyFk`) |
| `ExternalEntityId` | `int` | Non | FK → `ExternalEntities` | Entité externe (nav. `ExternalEntityFk`) |

#### 2.14 `Organigrammes` — organigramme hiérarchique

Entité `Organigramme` (`FullAuditedEntity`, `IMayHaveTenant`). Source : `src/DocuPro.Core/CommonEntities/Organigramme.cs`. Index : `TenantId`.

| Colonne | Type CLR | Nullable | PK/FK | Description |
|---|---|---|---|---|
| `Id` | `int` | Non | PK | Identifiant |
| `TenantId` | `int?` | Oui | | Tenant |
| `Name` | `string` | Non (`[Required]`) | | Nom du nœud (service/direction) |
| `ParentId` | `int?` | Oui | FK → `Organigrammes` (auto-réf.) | Nœud parent (nav. `ParentFk`) — arborescence |

#### 2.15 Assignation Rôle ↔ Organigramme (pas de table dédiée)

**Il n'existe pas de table `RoleOrganigramme`.** L'« assignation rôle-organigramme » du menu Paramétrage est matérialisée par une **colonne ajoutée à l'entité ABP `Role`** (table `AbpRoles`). Source : `src/DocuPro.Core/Authorization/Roles/Role.cs`. Le service `RoleOrganigrammeAssignmentAppService` (`src/DocuPro.Application/CommonEntities/`) lit/écrit uniquement cette colonne ; le DTO `RoleOrganigrammeAssignmentDto` (`src/DocuPro.Application.Shared/CommonEntities/Dtos/RoleOrganigrammeAssignmentDto.cs`) n'est pas persisté.

Colonnes concernées sur `AbpRoles` (ajouts applicatifs uniquement) :

| Colonne | Type CLR | Nullable | PK/FK | Description |
|---|---|---|---|---|
| `OrganigrammeId` | `int?` | Oui | FK → `Organigrammes` | Organigramme assigné au rôle (nav. `OrganigrammeFk`) |

(Le reste de `AbpRoles` provient du framework ABP : `Id` int PK, `TenantId`, `Name`, `DisplayName`, `IsStatic`, `IsDefault`, colonnes d'audit, etc.)

#### 2.16 `Confidentialiteses` — niveaux de confidentialité (référentiel)

Entité `Confidentialites` (`FullAuditedEntity`, `IMayHaveTenant`). Nom de table (pluriel ABP) : **`Confidentialiteses`**. Source : `src/DocuPro.Core/CommonEntities/Confidentialites.cs`. Index : `TenantId`.

| Colonne | Type CLR | Nullable | PK/FK | Description |
|---|---|---|---|---|
| `Id` | `int` | Non | PK | Identifiant |
| `TenantId` | `int?` | Oui | | Tenant |
| `Name` | `string` | Non (`[Required]`) | | Libellé du niveau de confidentialité |

#### 2.17 `DocumentScannes` — documents scannés en attente d'enregistrement

Entité `DocumentScanne` — **base `CreationAuditedEntity`** (pas de soft-delete ni de colonnes de modification), `IMayHaveTenant`. Source : `src/DocuPro.Core/DocumentBase/DocumentScanne.cs`. Index : `TenantId` **et** `IsTraite` (deux index déclarés dans `OnModelCreating`).

| Colonne | Type CLR | Nullable | PK/FK | Description |
|---|---|---|---|---|
| `Id` | `int` | Non | PK | Identifiant |
| `TenantId` | `int?` | Oui | | Tenant |
| `FileName` | `string` | Oui | | Nom du fichier (ex : `Document.pdf`) |
| `FilePath` | `string` | Oui | | Chemin relatif/physique du fichier stocké |
| `DateScanned` | `DateTime` | Non | | Date/heure du dépôt |
| `MachineName` | `string` | Oui | | Poste client émetteur |
| `IsTraite` | `bool` | Non | | `true` une fois enregistré comme courrier (Mail + Document) |
| `MailId` | `int?` | Oui | (référence logique → `Mails`, pas de nav.) | Courrier créé lors de l'enregistrement |
| `DocumentId` | `int?` | Oui | (référence logique → `Documents`, pas de nav.) | Document créé lors de l'enregistrement |

Note : `MailId` / `DocumentId` sont de simples entiers sans propriété de navigation `[ForeignKey]` — liaison logique, non contrainte au niveau EF.

#### 2.18 `Documents` — documents (colonnes clés)

Entité `Document` (`FullAuditedEntity`, `IMayHaveTenant`, `[Audited]`). Source : `src/DocuPro.Core/DocumentBase/Document.cs`. Index : `TenantId`. Colonnes clés du point de vue du module courrier :

| Colonne | Type CLR | Nullable | PK/FK | Description |
|---|---|---|---|---|
| `Id` | `int` | Non | PK | Identifiant document |
| `TenantId` | `int?` | Oui | | Tenant |
| `Description` | `string` | Oui | | Description |
| `DocumentDate` | `DateTime` | Non | | Date du document |
| `DocumentState` | `DocumentStates` (enum→int) | Non | | État (NonArchive/Archived/…) |
| `Hash` | `byte[]` | Oui | | Empreinte (hash) |
| `Signature` | `byte[]` | Oui | | Signature électronique |
| `TimeStamp` | `byte[]` | Oui | | Horodatage |
| `DateLastVerified` | `DateTime?` | Oui | | Date de dernière vérification |
| `DocumentTypeId` | `int` | Non | FK → `DocumentTypes` | Type de document (nav. `DocumentTypeFk`) |
| `DossierId` | `int?` | Oui | FK → `Dossiers` | Dossier (nav. `DossierFk`) |
| `ClassificationId` | `int?` | Oui | FK → `Classifications` | Classification (nav. `ClassificationFk`) |
| `ConfidentialitesId` | `int?` | Oui | FK → `Confidentialiteses` | Confidentialité (nav. `ConfidentialitesFk`) |
| `DocumentVersions` | `ICollection<DocumentVersion>` | — | Nav. inverse → `DocumentVersions` | Versions du document (collection) |

---

### 3. Schéma relationnel (textuel)

Notation : `A --(cardinalité)--> B` signifie « A référence B via une FK ». `1` = une, `0..1` = optionnelle, `*` = plusieurs.

#### 3.1 Autour de `Mails` (entité pivot)

```
Mails *--0..1--> MailNatures        (MailNatureId, nullable)
Mails *--0..1--> Confidentialiteses (ConfidentialitesId, nullable)
Mails *--1-----> ExternalEntities   (ExternalEntityId, requis)
Mails *--0..1--> MailObjets         (MailObjetId, nullable)
Mails *--0..1--> Organigrammes      (OrganigrammeId, nullable)
Mails *--0..1--> MailTypes          (MailDepartTypeId → entité MailDepartType, nullable)
Mails *--1-----> AbpUsers           (DestinataireExpediteur, long, requis)
Mails *--0..1--> Mails              (MailParent, auto-référence : fil / réponse)
```

#### 3.2 Éléments liés à un courrier (enfants de `Mails`)

```
MailInputations   *--1--> Mails               (MailId)
MailInputations   *--1--> MailInputationTypes (MailInputationTypeId)
MailInputations   *--1--> AbpUsers            (UserId, long)

MailCommentses    *--1--> Mails               (MailId)
MailCommentses    *--1--> AbpUsers            (UserId, long)

MailDocuments     *--1--> Mails               (MailId)
MailDocuments     *--1--> Documents           (DocumentId)
```

`MailDocuments` est la table de jonction **N-N** entre `Mails` et `Documents` (plusieurs documents par courrier, un document réutilisable ; drapeau `Decharge` par liaison).

#### 3.3 Contrôle & privilèges

```
MailControles     *--0..1--> AbpRoles         (RoleId)   [privilège: enum Privileges]
```

#### 3.4 Entités externes et propriétés personnalisées

```
ExternalEntities            *--0..1--> ExternalEntityTypes        (ExternalEntityTypeId)

ExternalEntityCustomValues  *--1--> ExternalEntities              (ExternalEntityId)
ExternalEntityCustomValues  *--1--> ExternalEntityTypes          (ExternalEntityTypeId)
ExternalEntityCustomValues  *--1--> ExternalEntityCustomProperties (ExternalEntityCustomPropertyId)
```

`ExternalEntityCustomValues` matérialise le pattern EAV (Entity-Attribute-Value) : une valeur = (entité externe × propriété × type).

#### 3.5 Organisation & rôles

```
Organigrammes  *--0..1--> Organigrammes  (ParentId, auto-référence : arborescence)
AbpRoles       *--0..1--> Organigrammes  (OrganigrammeId : « assignation rôle-organigramme »)
```

#### 3.6 Documents & scans

```
Documents        *--1-----> DocumentTypes      (DocumentTypeId)
Documents        *--0..1--> Dossiers           (DossierId)
Documents        *--0..1--> Classifications    (ClassificationId)
Documents        *--0..1--> Confidentialiteses (ConfidentialitesId)
Documents        1---*----> DocumentVersions   (collection de versions)

DocumentScannes  ...........> Mails      (MailId, référence logique, sans contrainte FK EF)
DocumentScannes  ...........> Documents  (DocumentId, référence logique, sans contrainte FK EF)
```

Le flux de dématérialisation : un `DocumentScanne` (déposé par le service de scan) est transformé, lors de « Enregistrer le courrier », en un `Mail` + un `Document` (liés par un `MailDocument`) ; `DocumentScanne.IsTraite` passe à `true` et `MailId`/`DocumentId` sont renseignés.

#### 3.7 Référentiels autonomes (pas de FK entrante depuis le module au-delà de ce qui précède)

`MailNatures`, `MailObjets`, `MailInputationTypes`, `MailTypes` (MailDepartType), `Confidentialiteses`, `ExternalEntityTypes` : tables de paramétrage alimentées via le menu **Paramétrage (MailSettings)**.

---

### 4. Récapitulatif tables ↔ DbSet ↔ fichier

Source des `DbSet` : `src/DocuPro.EntityFrameworkCore/EntityFrameworkCore/DocuProDbContext.cs`.

| Table SQL | Entité | `DbSet` | Fichier entité |
|---|---|---|---|
| `Mails` | `Mail` | `Mails` | `src/DocuPro.Core/MailBase/Mail.cs` |
| `MailControles` | `MailControle` | `MailControles` | `src/DocuPro.Core/MailBase/MailControle.cs` |
| `MailInputations` | `MailInputation` | `MailInputations` | `src/DocuPro.Core/MailBase/MailInputation.cs` |
| `MailInputationTypes` | `MailInputationType` | `MailInputationTypes` | `src/DocuPro.Core/MailBase/MailInputationType.cs` |
| `MailCommentses` | `MailComments` | `MailCommentses` | `src/DocuPro.Core/MailBase/MailComments.cs` |
| `MailDocuments` | `MailDocument` | `MailDocuments` | `src/DocuPro.Core/MailBase/MailDocument.cs` |
| `MailObjets` | `MailObjet` | `MailObjets` | `src/DocuPro.Core/MailBase/MailObjet.cs` |
| `MailNatures` | `MailNature` | `MailNatures` | `src/DocuPro.Core/MailBase/MailNature.cs` |
| `MailTypes` | `MailDepartType` | `MailTypes` | `src/DocuPro.Core/MailBase/MailType.cs` |
| `ExternalEntities` | `ExternalEntity` | `ExternalEntities` | `src/DocuPro.Core/CommonEntities/ExternalEntity.cs` |
| `ExternalEntityTypes` | `ExternalEntityType` | `ExternalEntityTypes` | `src/DocuPro.Core/CommonEntities/ExternalEntityType.cs` |
| `ExternalEntityCustomProperties` | `ExternalEntityCustomProperty` | `ExternalEntityCustomProperties` | `src/DocuPro.Core/CommonEntities/ExternalEntityCustomProperty.cs` |
| `ExternalEntityCustomValues` | `ExternalEntityCustomValue` | `ExternalEntityCustomValues` | `src/DocuPro.Core/CommonEntities/ExternalEntityCustomValue.cs` |
| `Organigrammes` | `Organigramme` | `Organigrammes` | `src/DocuPro.Core/CommonEntities/Organigramme.cs` |
| `AbpRoles` (colonne `OrganigrammeId`) | `Role` | (ABP `Roles`) | `src/DocuPro.Core/Authorization/Roles/Role.cs` |
| `Confidentialiteses` | `Confidentialites` | `Confidentialiteses` | `src/DocuPro.Core/CommonEntities/Confidentialites.cs` |
| `DocumentScannes` | `DocumentScanne` | `DocumentScannes` | `src/DocuPro.Core/DocumentBase/DocumentScanne.cs` |
| `Documents` | `Document` | `Documents` | `src/DocuPro.Core/DocumentBase/Document.cs` |

---

### 5. Points d'attention pour une ré-implémentation

- **Pluriels ABP** : les noms de tables générés diffèrent parfois du nom d'entité — `MailCommentses` (entité `MailComments`), `Confidentialiteses` (entité `Confidentialites`), `MailTypes` (entité `MailDepartType`).
- **`MailType` ambigu** : le nom `MailType` désigne l'**énumération** (§1.2) ; la **table** de référentiel des types de départ est `MailTypes` mappée par l'entité `MailDepartType`.
- **Orthographes littérales à respecter** : `Priviledges` (propriété de `MailControle`), `DateButoire`, `DateTraited`, `MailDepartType.name` (minuscule), `DcomentAccessInquiries` (DbSet).
- **`RoleOrganigramme` n'est pas une table** : c'est la colonne `OrganigrammeId` sur `AbpRoles`.
- **Énumérations stockées en entier** : `MailStatus`, `MailType`, `Privileges`, `DocumentStates` sont persistées comme `int` (index de l'énumération).
- **`DocumentScanne`** est la seule entité du module en `CreationAuditedEntity` (pas de soft-delete) et la seule avec un index métier supplémentaire (`IsTraite`).
- **Multi-tenant** : toutes les tables du module portent `TenantId` (`int?`) avec index ; le filtre `IMayHaveTenant` s'applique automatiquement (ABP).


---


## 03. Workflow / cycle de vie du courrier

### Rôle métier

Le module Docu-Courriers gère le cycle de vie complet d'un courrier (`Mail`) depuis son **enregistrement** au bureau d'ordre jusqu'à son **archivage** définitif. L'état d'un courrier n'est **pas** porté par un seul champ : il résulte de la combinaison de l'énumération `MailStatus`, de **cinq drapeaux booléens** (`Valider`, `ValidationDirection`, `ValidationDG`, `EnregistrementReponse`, `Decharge`) et de **six dates** (`DateEnregistrementCourrier`, `DateFollowUp`, `EndDateFollowUp`, `DateDecharge`, `DateTraited`, `DateButoire`). Chaque écran du parcours fait basculer un ou plusieurs de ces champs. Le comportement diffère selon `MailType` (`Arrivée`, `Départ`, `Interne`).

Fichiers de référence lus pour ce chapitre :
- Entité pivot : `src/DocuPro.Core/MailBase/Mail.cs`
- Entités liées : `src/DocuPro.Core/MailBase/MailInputation.cs`, `src/DocuPro.Core/MailBase/MailInputationType.cs`, `src/DocuPro.Core.Shared/MailBase/MailInputationTypeConsts.cs`
- Énumérations : `src/DocuPro.Core.Shared/Helpers/Enums.cs`
- Service domaine de statut : `src/DocuPro.Application/MailBase/MailStatusService.cs`
- Services applicatifs : `src/DocuPro.Application/MailBase/MailsAppService.cs`, `src/DocuPro.Application/MailBase/MailInputationsAppService.cs`
- DTO d'écriture : `src/DocuPro.Application.Shared/MailBase/Dtos/CreateOrEditMailDto.cs`
- Contrôleurs du parcours : `src/DocuPro.Web.Mvc/Areas/App/Controllers/DocuCourriers/{AddMailController,MailViewerController,MailTabsController,ValidationController,ValidationMasseCourriersController,CourrierDepartController,IntegrationCourrierDepartController,IntegrationDechargeController}.cs`
- Notifications : `src/DocuPro.Core/Notifications/IAppNotifier.cs`, `src/DocuPro.Core/Notifications/AppNotifier.cs`
- Rappels planifiés : `src/DocuPro.Application/Notifications/{MailReminderService,MailReminderJob,MailInputationReminderService,MailInputationReminderJob}.cs`, enregistrement des jobs dans `src/DocuPro.Web.Mvc/Startup/Startup.cs`
- Liaison document scanné : `src/DocuPro.Application/DocumentBase/DocumentScannesAppService.cs`

---

### 1) Machine à états `MailStatus`

`MailStatus` est défini dans `src/DocuPro.Core.Shared/Helpers/Enums.cs` :

| Valeur | Nom | Signification observée dans le code |
|---|---|---|
| 0 | `Redaction` | État initial de **tout** courrier créé (le DTO `CreateOrEditMailDto.MailStatus` n'est pas renseigné à l'enregistrement Arrivée → valeur par défaut de l'enum = 0). Reste l'état des courriers **Arrivée** pendant tout le traitement. |
| 1 | `Rédigé` | Positionné pour les courriers **Départ** (réponse rédigée / intégrée). |
| 2 | `Déchargé` | Positionné lors de l'intégration de la décharge signée (écran 13). |
| 3 | `Traité` | Positionné lorsque toutes les imputations d'un courrier Arrivée sont traitées (ou traitement forcé). |
| 4 | `Supprimé` | **Déclaré dans l'enum mais jamais affecté par le code lu.** La suppression passe par le soft-delete ABP (`FullAuditedEntity.IsDeleted`), pas par ce statut. |

> Important : le cheminement « Redaction → Rédigé → Déchargé → Traité » n'est **pas** une chaîne linéaire unique dans le code. `MailStatus` **bifurque selon `MailType`**. Pour les courriers Arrivée, l'avancement réel est surtout tracé par les **drapeaux** et les **dates** (notamment `DateTraited`), tandis que `MailStatus` reste souvent à `Redaction`. Les requêtes le confirment : `MailsAppService.cs` filtre systématiquement `e.MailStatus != MailStatus.Redaction || e.MailType == MailType.Arrivée` (lignes 2974, 3165) — c.-à-d. un courrier Arrivée reste visible même en `Redaction`.

#### Transitions et déclencheurs

| Transition | Déclencheur (écran / action) | Méthode(s) + fichier | Effets exacts |
|---|---|---|---|
| (création) → `Redaction` | Enregistrement d'un courrier Arrivée (écran 05) | `AddMailController.Add(...)` → `MailsAppService.CreateOrEdit` → `Create` (`MailsAppService.cs:3551`, `:3567`) | `MailStatus` par défaut = `Redaction` ; `Valider=false` ; `DateEnregistrementCourrier` = valeur du formulaire. |
| → `Rédigé` (+ `DateDecharge`) | Création d'un courrier Départ (écran 12) | `CourrierDepartController.cs:244` → `MailsAppService.UpdateMailStatus(id, MailStatus.Rédigé, DateTime.Now)` (surcharge 3 args, `MailsAppService.cs:1158`) | `MailStatus=Rédigé` **et `DateDecharge=Now`** (effet de bord : la surcharge à 3 args écrit toujours `DateDecharge`, quel que soit le statut). |
| → `Rédigé` (+ `DateDecharge`) | Intégration d'un document de réponse sur un courrier Départ | `IntegrationCourrierDepartController.cs:68` → `MailsAppService.UpdateMailStatus(mailId, MailStatus.Rédigé, DateTime.Now)` | Idem ci-dessus. |
| → `Traité` (+ `DateTraited`) | « Marquer traité » depuis le parapheur (écran 08) | `MailViewerController.Treated` (`:190`) → `MailInputationsAppService.UpdateMailStatus(mailId)` (`MailInputationsAppService.cs:171`) | Marque **toutes** les imputations non traitées (`DateTreated=Now`), journalise, puis `MailStatusService.UpdateMailStatusAsync(mailId, Traité)` → `MailStatus=Traité`, `DateTraited=Now`. |
| → `Traité` (+ `DateTraited`) automatique | Ouverture / lecture d'un courrier | `MailViewerController.Index`/`ValidationAutomatiqueLecture` → `MailInputationsAppService.ValidationAutomatiqueMail` → `MailStatusService.ProcessAutomaticValidationAsync` (`MailStatusService.cs:65`) | Traite automatiquement les imputations dont le **type a `Suivi=true`** (`MailInputationType.Suivi`) ; si **toutes** les imputations sont alors traitées (`CheckAllInputationsProcessedAsync`), bascule `MailStatus=Traité`, `DateTraited=Now`. |
| → `Déchargé` (+ `DateDecharge`) | Intégration de la décharge signée (écran 13) | `IntegrationDechargeController.cs:132` → `MailsAppService.UpdateMailStatus(mailId, MailStatus.Déchargé)` (surcharge 2 args, `MailsAppService.cs:1178`) | `MailStatus=Déchargé` **et** `DateDecharge=Now` (la surcharge 2 args stampe `DateDecharge` quand `status==Déchargé`). Suivi immédiatement de `ArchiverCourrier(mailId)` → `DateTraited=Now` (`IntegrationDechargeController.cs:133`). |
| (marquage « traité/archivé » sans changer `MailStatus`) | Archivage service courrier (écran 08) / archivage du courrier parent | `MailTabsController.ArchiverCourrier` (`:406`) et `CourrierDepartController.cs:259` → `MailsAppService.ArchiverCourrier(mailId)` (`MailsAppService.cs:376`) | Positionne **uniquement `DateTraited=Now`** ; `MailStatus` **inchangé**. Utilisé pour retirer le courrier des files « en cours » (filtre `DateTraited == null`). |

Les deux surcharges de `UpdateMailStatus` (dans `MailsAppService.cs`) et les deux de `UpdateMailStatusAsync` (dans `MailStatusService.cs`) sont récapitulées ci-dessous car leur comportement sur les dates diffère :

| Méthode | Fichier:ligne | `MailStatus` | `DateTraited` | `DateDecharge` |
|---|---|---|---|---|
| `UpdateMailStatus(id, status)` | `MailsAppService.cs:1178` | = `status` | = `Now` **si** `status==Traité` | = `Now` **si** `status==Déchargé` |
| `UpdateMailStatus(id, status, dateDecharge)` | `MailsAppService.cs:1158` | = `status` | inchangé | = `dateDecharge` (**toujours**) |
| `UpdateMailStatusAsync(id, status)` | `MailStatusService.cs:34` | = `status` | = `Now` **si** `status==Traité` | inchangé |
| `UpdateMailStatusAsync(id, status, dateDecharge)` | `MailStatusService.cs:47` | = `status` | inchangé | = `dateDecharge` |

---

### 2) Rôle des drapeaux booléens

Tous déclarés dans `src/DocuPro.Core/MailBase/Mail.cs` (lignes 221-225), défaut `false`. Ils servent de **portes (gates)** entre les files de travail : les requêtes des écrans filtrent sur ces booléens plutôt que sur `MailStatus`.

| Drapeau | Passe à `true` via | Fichier:ligne | Signification / effet sur les files |
|---|---|---|---|
| `Valider` | `MailsAppService.ValiderMailControle(mailId)` | `MailsAppService.cs:902` ; appelé par `MailViewerController.ValiderMail` (`:148`, écran Contrôle 06) **et** par `MailTabsController.AddImputation` (`:2116`, après création des imputations) | Courrier « contrôlé/validé bureau d'ordre ». Tant que `Valider=false`, le courrier reste dans la file **Contrôle** (`MailsAppService.cs:2975` filtre `Valider == false`). Une fois `true`, il devient visible en Parapheur/Validation (`:3165` filtre `Valider == true`). Déclenche aussi une notification d'imputation principale. |
| `ValidationDirection` | `MailsAppService.UpdateValidationDirectionBatch(mailIds, true)` | `MailsAppService.cs:446` ; appelé par `ValidationController.ValidationCourrier` (`:258`, écran Validation 10) | Validation par la Direction. La file de l'écran Validation (`MailsAppService.ValidationDirection`, `:223`) liste les courriers `DateTraited==null && Valider==true && ValidationDirection==false`. |
| `ValidationDG` | `MailsAppService.UpdateValidationDG(mailId, true)` | `MailsAppService.cs:407` ; appelé par `MailTabsController` (`:657`, action Validation DG) | Validation par la Direction Générale. La file `GetCourrierValidationDG` (`:528`) liste les courriers `Valider==true` ayant une imputation de type **5 (Validation DG)** non traitée (`DateTreated==null`). |
| `EnregistrementReponse` | `MailsAppService.EnregistrementReponse(mailId)` | `MailsAppService.cs:345` ; appelé par `MailTabsController.TransfertGuichetUnique` (`:372`) | Marque « réponse enregistrée / transfert Guichet Unique ». |
| `Decharge` | `MailsAppService.DechargeCourrier(mailId)` | `MailsAppService.cs:298` ; appelé par `MailTabsController.DechargeCourrier` (`:318`) | Marque le courrier comme déchargé (distinct du **statut** `Déchargé`). Utilisé dans la projection Départ (`MailsAppService.cs:1261`). |

> Note : `Valider`, `Decharge` et `EnregistrementReponse` sont des bascules simples via `_mailRepository.UpdateAsync`. Chaque bascule vide les caches `MailsCache`, `ParapheurCache`, `CourrierDepartCache`.

---

### 3) Rôle des dates

Portées par `Mail` (`src/DocuPro.Core/MailBase/Mail.cs:30-35`). Écriture initiale via `CreateOrEditMailDto` (`src/DocuPro.Application.Shared/MailBase/Dtos/CreateOrEditMailDto.cs`) puis mutations par les méthodes de workflow.

| Date | Type | Écrite par | Rôle |
|---|---|---|---|
| `DateEnregistrementCourrier` | `DateTime?` | Formulaire d'enregistrement → `CreateOrEditMailDto.DateEnregistrementCourrier` → `Create` (`AddMailController.cs:371`) | Date/heure de prise en charge au bureau d'ordre. Affichée dans les files Parapheur/Suivi. |
| `Date` | `DateTime` (Required) | Formulaire → DTO | Date propre du courrier (date du document). |
| `DateFollowUp` | `DateTime?` | `CreateOrEditMailDto.DateFollowUp` (formulaire) | Date de suivi/relance. Sert de filtre « en retard » dans les stats (`MailsAppService.cs:2494,2661,2832`) et pour la file Courrier Départ (`:1229` : `DateFollowUp != null && EndDateFollowUp == null`). |
| `EndDateFollowUp` | `DateTime?` | **Aucune écriture trouvée dans le code lu** (absente de `CreateOrEditMailDto`). Uniquement lue (fin de suivi) : `MailsAppService.cs:1229`. | Marqueur de clôture du suivi ; en pratique non alimenté par les flux examinés. |
| `DateDecharge` | `DateTime?` | Surcharges `UpdateMailStatus` (voir §1). Stampée à `Now` au passage `Déchargé`, et — par effet de bord — au passage `Rédigé` d'un Départ. | Date de décharge. Pour les courriers **Départ**, `MailStats.cs:2676,2683` l'utilise comme **date d'archivage**. |
| `DateTraited` | `DateTime?` | `ArchiverCourrier` (`:387`), `UpdateMailStatus(...,Traité)`, `MailStatusService` (`:41`) | Marque le courrier **traité/archivé** (Arrivée). Le filtre `DateTraited == null` définit les files « à traiter ». Pour l'Arrivée, `MailStats.cs:2683` utilise `DateTraited` comme date d'archivage. |
| `DateButoire` | `DateTime?` | `CreateOrEditMailDto.DateButoire` (mappée explicitement dans `Create`/`Update`, `MailsAppService.cs:3577,3668`) | Échéance de traitement. **Base des rappels** `MailReminderJob` (voir §5). Une méthode `CalculateDateButoire` existe (`AddMailController.cs:253`) mais son appel est commenté (`:365,380`). |

Dates au niveau **imputation** (`MailInputation`, `src/DocuPro.Core/MailBase/MailInputation.cs`) impliquées dans le workflow :
- `Deadline` (`DateTime?`) : échéance d'une imputation ; base des rappels `MailInputationReminderJob`.
- `DateTreated` (`DateTime?`) : `null` = imputation non traitée. Le passage global du courrier à `Traité` dépend de « toutes les imputations `DateTreated != null` » (`MailStatusService.CheckAllInputationsProcessedAsync`, `:56`).
- `LastReminderSent` (`DateTime?`) : anti-spam des rappels (voir §5).

---

### 4) Parcours par écran (flux Arrivée)

Le tableau suit un courrier **Arrivée** de l'enregistrement à l'archivage. Les numéros d'écran reprennent ceux du brief.

| # | Écran (route) | Action utilisateur | Endpoint / méthode | Mutations d'état |
|---|---|---|---|---|
| 05 | Enregistrement (`/App/AddMail`) | Enregistrer un courrier + joindre le scan | `AddMailController.Add` (`:279`) → `MailsAppService.CreateOrEdit` → `Create` | Crée `Mail` : `MailStatus=Redaction`, `MailType=Arrivée`, `Valider=false`, `DateEnregistrementCourrier` renseignée. Crée le `MailDocument`, marque le scan traité (`MarkAsProcessed`), crée les imputations « En Copie » (type **17**) pour les rôles sélectionnés. |
| 06 | Contrôle / Courriers Arrivés (`/App/Controle`) | Contrôler et valider le courrier | `MailViewerController.ValiderMail` (`:143`) → `MailsAppService.ValiderMailControle` (`:902`) | `Valider=true`. Notification d'imputation principale au destinataire. Le courrier quitte la file Contrôle. |
| 08 | Imputation / Parapheur (`/App/ParapheurElectronique`) | Imputer à des agents | `MailTabsController.AddImputation` (`:2066`) → `MailInputationsAppService.CreateOrEdit` (par utilisateur) puis `ValiderMailControle` (`:2116`) | Crée une `MailInputation` par destinataire (type, `Instructions`, `Deadline`). Notification `ImputationAssigneeAsync`. (Ré)affirme `Valider=true`. |
| 08 | Parapheur — lecture par l'agent | Ouvrir le courrier | `MailViewerController.Index` (`:218`) → `ValidationAutomatiqueMail` → `ProcessAutomaticValidationAsync` | Les imputations de type `Suivi=false`… (en réalité `Suivi=true`, cf. code `MailStatusService.cs:79`) sont marquées traitées auto ; si toutes traitées → `MailStatus=Traité`, `DateTraited=Now`. |
| 08 | Parapheur — traitement manuel | « Marquer comme traité » | `MailViewerController.Treated` (`:190`) → `MailInputationsAppService.UpdateMailStatus` (`:171`) | Toutes imputations `DateTreated=Now` ; `MailStatus=Traité`, `DateTraited=Now`. |
| 08 | Parapheur — soumission validation | Soumettre à Direction/DG | `MailTabsController.AddValidationImputation` (`:708`) | Crée des imputations de validation : type **5** si rôle DG, sinon type **14** (Direction), `Deadline=+48h`. Notification `SoumissionValidationAsync`. |
| 08 | Parapheur — Validation DG | Valider (DG) | `MailTabsController` action DG (`:657`) → `UpdateValidationDG(mailId,true)` | `ValidationDG=true`, crée une imputation « Pour Suivi » (type **10**, `+48h`) au dernier imputé/destinataire, notifications `ValidationDGNotificationAsync` / `ValidationDGAssignmentAsync`. |
| 09 | Suivi (`/App/SuiviCourriers`) | Consulter/relancer | `MailsAppService.GetParapheurSuiviCourriers` (`:149`) | Lecture seule : liste des courriers `DateTraited==null` avec échéances (« moi » / « dernière imputation »). Aucune mutation. |
| 10 | Validation (`/App/Validation`) | Valider par la Direction (lot) | `ValidationController.ValidationCourrier` (`:227`) → `UpdateValidationDirectionBatch(ids,true)` | `ValidationDirection=true` sur chaque courrier. Notification `ValidationDirectionCourrierAsync`. File source : `Valider==true && ValidationDirection==false && DateTraited==null`. |
| 08 | Transfert Guichet Unique | Enregistrer la réponse | `MailTabsController.TransfertGuichetUnique` (`:352`) → `EnregistrementReponse(mailId)` | `EnregistrementReponse=true`. Notification `TransfertGuichetUniqueAsync`. |
| 08/13 | Décharge (`/App/Decharge`) | Décharger le courrier | `MailTabsController.DechargeCourrier` (`:… → :318`) → `DechargeCourrier(mailId)` | `Decharge=true`. Notification `DechargeCourriersAsync`. |
| 13 | Intégration Décharge (`/App/IntegrationDecharge`) | Intégrer la décharge signée | `IntegrationDechargeController.IntegrerDecharge` (`:… → :132`) | Joint le document (`Decharge=true`), `MailStatus=Déchargé` + `DateDecharge=Now`, puis `ArchiverCourrier` → `DateTraited=Now`. Notification `NotificationIntegrationDechargeAsync`. Marque le scan `MarkAsProcessed`. |
| — | Archivage | Archiver (service courrier) | `MailTabsController.ArchiverCourrier` (`:406`) → `ArchiverCourrier(mailId)` | `DateTraited=Now` (statut inchangé). Notification `ArchiverCourrierAsync`. Le courrier disparaît des files « en cours ». |

Validation en masse : `ValidationMasseCourriersController` (`:213-216`) traite un lot en appelant `MailInputationsAppService.UpdateImputation(mailId, userId)` pour marquer les imputations de validation traitées (`DateTreated=Now`) sans changer directement `MailStatus`.

#### Flux Départ (écran 12, `/App/CourrierDepart`)

- Création : `CourrierDepartController` (`:157`, `:358`) crée un `Mail` avec `MailType=Départ`, joint le document, puis `UpdateMailStatus(id, Rédigé, DateTime.Now)` → `MailStatus=Rédigé` **et `DateDecharge=Now`** (`:244`).
- Si le Départ est une **réponse** à un courrier parent (`MailId` fourni) : le parent est archivé via `ArchiverCourrier(MailId)` → `DateTraited=Now` (`:259`).
- Notification `NotificationCourrierDepartAsync(newMailId, parentId)` (`:272`).
- Intégration ultérieure d'un document sur un Départ : `IntegrationCourrierDepartController.IntegrerMailDocument` (`:50`) rejoue `UpdateMailStatus(mailId, Rédigé, DateTime.Now)` (`:68`).
- Files Départ : `MailsAppService.GetAllCourrierDepart` (`:1208`) liste `MailType==Départ && (MailStatus==Traité || (DateFollowUp!=null && EndDateFollowUp==null))`. La date d'archivage retenue pour un Départ est `DateDecharge` (`MailStats.cs:2683`).

#### Flux Interne (`MailType.Interne`)

`MailType.Interne` (valeur 2) existe et est traité comme une variante de type : il apparaît dans les filtres de recherche (`MailsAppService.cs:1474`), les stats et le badge menu. **Aucun contrôleur/flux dédié spécifique à l'Interne** n'a été trouvé dans le code lu ; un courrier Interne suit donc la même mécanique d'états (drapeaux + dates) que l'Arrivée, sans écran propre distinct. À confirmer côté écrans si un parcours Interne spécifique existe hors du périmètre lu.

---

### 5) Notifications et rappels

#### Notifications événementielles (temps réel)

Interface `src/DocuPro.Core/Notifications/IAppNotifier.cs`, implémentation `src/DocuPro.Core/Notifications/AppNotifier.cs`. Chaque notification est émise depuis le contrôleur/service au moment de la transition correspondante.

| Notification (`IAppNotifier`) | Émise à l'étape | Point d'appel |
|---|---|---|
| `NotificationEnregistrementCourrierAsync` | Enregistrement (05) | `AddMailController.cs:518` |
| `MailImputationPrincipaleAsync` | Validation contrôle (`Valider=true`) | `MailsAppService.cs:932` (dans `ValiderMailControle`) |
| `ImputationAssigneeAsync` | Imputation à un agent (08) | `MailTabsController.cs:2100` |
| `MailInputationAsync` | Création d'imputation (générique) | déclaré dans `IAppNotifier.cs:34` |
| `SoumissionValidationAsync` | Soumission pour validation (08) | `MailTabsController.cs:757` |
| `ValidationDGNotificationAsync` / `ValidationDGAssignmentAsync` | Validation DG (08) | `MailTabsController.cs:663,669,674` |
| `ValidationDirectionCourrierAsync` | Validation Direction (10) | `ValidationController.cs:266` |
| `TransfertGuichetUniqueAsync` | Enregistrement réponse (08) | `MailTabsController.cs:375` |
| `DechargeCourriersAsync` | Décharge (`Decharge=true`) | `MailTabsController.cs:321` |
| `ArchiverCourrierAsync` | Archivage service courrier | `MailTabsController.cs:458` |
| `NotificationCourrierDepartAsync` | Création courrier Départ (12) | `CourrierDepartController.cs:272` |
| `NotificationIntegrationDechargeAsync` | Intégration décharge (13) | `IntegrationDechargeController.cs:138` |
| `RappelDateButoireAsync` | Rappel échéance courrier (job) | `MailReminderService.cs:284-324` |
| `RappelMailInputationDeadlineAsync` | Rappel échéance imputation (job) | `MailInputationReminderService.cs:129,142` |

#### Rappels planifiés (Hangfire)

Enregistrés dans `src/DocuPro.Web.Mvc/Startup/Startup.cs` (lignes 329-361) :

| Job (id Hangfire) | Cron | Service exécuté | Cible | Règles |
|---|---|---|---|---|
| `mail-reminder-datebutoire` | `10 13 * * *` (13h10/jour) | `MailReminderService.ExecuterRappelsAsync` (`MailReminderJob.cs`) | Courriers `DateButoire != null && DateTraited == null && Valider == true` | Envoie `RappelDateButoireAsync` au `DestinataireExpediteur` selon jours restants : 7 → `PREMIÈRE_ALERTE`, 3 → `RAPPEL`, 1 → `DERNIÈRE_CHANCE`, 0 → `URGENCE`, -1/-2/-3 → `RETARD` (`MailReminderService.cs:281-336`). |
| `mail-inputation-reminder-deadline` | `* * * * *` (chaque minute) | `MailInputationReminderService.ExecuterRappelsAsync` (`MailInputationReminderJob.cs`) | Imputations `Deadline != null && DateTreated == null`, `Deadline` dans la fenêtre d'alerte (`DelaisAlerte`, défaut **48h**), `Deadline >= now`, et `LastReminderSent` ≥ intervalle (`DelaisAlerteInterval`, défaut **6h**) | Envoie `RappelMailInputationDeadlineAsync` à **l'agent imputé** (`UserId`) **et** au **créateur** (`CreatorUserId`) ; met à jour `LastReminderSent=Now` (`MailInputationReminderService.cs:79-156`). |
| `check-document-expiring-accesses` | `50 16 * * *` (16h50/jour) | `DocumentExpirationJob` | Accès documents (hors périmètre courrier) | Expirations d'accès aux documents ; mentionné pour complétude. |

Paramètres de configuration lus : `DelaisAlerte` (heures, défaut 48) et `DelaisAlerteInterval` (heures, défaut 6) dans `MailInputationReminderService.cs:63,67`.

---

### 6) Effets de bord transverses

- **Invalidation de cache** : la quasi-totalité des mutations d'état vident `MailsCache`, `ParapheurCache`, `CourrierDepartCache` (`ClearAsync`). Toute réimplémentation doit prévoir une invalidation de cache équivalente après chaque transition.
- **Liaison document scanné** : à l'enregistrement (05), au Départ (12) et à l'intégration décharge (13), `DocumentScannesAppService.MarkAsProcessed(id, mailId, documentId)` (`src/DocuPro.Application/DocumentBase/DocumentScannesAppService.cs:85`) positionne `IsTraite=true` et rattache le scan au courrier/document, ce qui le retire de la file « Documents scannés ».
- **Types d'imputation spéciaux (identifiants en dur / config)** : **5** = Validation DG (`_mailInputationTypeValidationId`, clé de config `MailInputationTypeValidationId`, défaut 5) ; **14** = Validation Direction ; **10** = Pour Suivi (`_mailInputationTypePourSuiviId ?? 10`) ; **17** = En Copie (`MailInputationTypeConsts.EnCopie`). Le drapeau `MailInputationType.Suivi` (bool) détermine si une imputation est traitée automatiquement à la lecture.
- **Journalisation d'audit** : chaque action majeure appelle `ICustomAuditLogsesAppService.AddLog(...)` avec un code d'action (ex. contrôle=1019, décharge=1015, validation DG=1017, soumission validation=1018, enregistrement réponse=1021, déliaison=1014).
- **Multi-tenant** : `Mail` et `MailInputation` implémentent `IMayHaveTenant` ; `TenantId` est renseigné à la création si `AbpSession.TenantId != null`. `GetCourrierValidationDG` (`MailsAppService.cs:530`) et `DocumentScannesAppService` désactivent explicitement le filtre `MayHaveTenant` (`IgnoreQueryFilters()` / `DisableFilter(AbpDataFilters.MayHaveTenant)`).
- **Anomalies/quirks à connaître pour la ré-implémentation** :
  1. `UpdateMailStatus(id, status, dateDecharge)` écrit **toujours** `DateDecharge`, y compris au passage `Rédigé` d'un Départ — d'où un `DateDecharge` non nul sur des courriers non déchargés.
  2. `MailStatusService.ProcessAutomaticValidationAsync` (`:79`) auto-traite les imputations dont le type a `Suivi == true`, alors que le commentaire du code dit l'inverse (« pas de suivi »). Le comportement effectif suit le code (`Suivi == true`).
  3. Le statut `Supprimé` n'est jamais affecté (soft-delete ABP à la place).
  4. `EndDateFollowUp` n'est écrit par aucun flux lu (seulement lu comme filtre).


---


## 04. Permissions & rôles

> Section extraite du code source existant (à réimplémenter à l'identique). Sources de vérité :
> - Constantes : `src/DocuPro.Core.Shared/Authorization/AppPermissions.cs`
> - Arbre de définition : `src/DocuPro.Core/Authorization/AppAuthorizationProvider.cs`
> - Menu & badges : `src/DocuPro.Web.Mvc/Areas/App/Startup/AppNavigationProvider.cs`
> - Compteurs de badges : `src/DocuPro.Application/Services/MenuBadgeAppService.cs`
> - Endpoints badges : `src/DocuPro.Web.Mvc/Areas/App/Controllers/Utilities/MenuBadgesController.cs`
> - Rendu client badges : `src/DocuPro.Web.Mvc/wwwroot/view-resources/Areas/App/Views/Layout/menu-badges.js`

### 4.1 Conventions

Le module s'appuie sur le système d'autorisation ABP. Trois niveaux se combinent :

- **Menu** (`Menus.*`) : autorise l'affichage d'une entrée (ou d'un groupe) dans la navigation latérale.
- **Page** (`Pages.<Ecran>` + `Pages.<Ecran>.Access`) : autorise l'accès à un écran (contrôleur/vue).
- **Action** (`Pages.<Entité>.Create` / `.Edit` / `.Delete`) : autorise une opération CRUD sur une entité.

La plupart des écrans du menu Docu-Courriers sont protégés par une dépendance **`requiresAll: true`** combinant la permission de menu ET la permission `.Access` de la page (ex. `AddMail` exige `Pages_AddMail_Access` **et** `Menus_Docu_Courriers_AddMail`). Les cas notables sont signalés dans la colonne Description.

### 4.2 Groupes de menu (racines)

| Permission (constante) | Écran / menu associé | Type | Description |
|---|---|---|---|
| `Menus` | (racine technique) | Menu | Permission racine « Menus » ; parent implicite des menus custom. |
| `StandardUser` | — | Page | Marqueur « utilisateur standard » (permission libre, sans écran dédié). |
| `Menus_DocuCourriers` | Groupe « Docu-Courriers » | Menu | Groupe racine du module courrier ; conditionne l'affichage de tout le sous-menu. |
| `Menus_MailSettings` | Groupe « Paramétrage Docu-Courriers » | Menu | Groupe racine des écrans de paramétrage (entités externes, types, organigrammes). |
| `CourrierSuperUser` | — | Page | **Désactivée** (commentée dans `AppPermissions.cs` et `AppAuthorizationProvider.cs`). Historiquement utilisée pour Contrôle / Validation DG / Validation de masse. À prévoir si le rôle « super-utilisateur courrier » doit être réactivé. |

### 4.3 Entrées de menu Docu-Courriers (enfants de `Menus_DocuCourriers`)

| Permission (constante) | Écran / menu associé | Type | Description |
|---|---|---|---|
| `Menus_Docu_Courriers_AddMail` | Ajouter un courrier (`App/AddMail`) | Menu | Menu de l'écran d'enregistrement/arrivée de courrier. Combinée à `Pages_AddMail_Access` (requiresAll). |
| `Menus_Docu_Courriers_Controle` | Contrôle (`App/Controle`) | Menu | Menu de l'écran de contrôle. Combinée à `Pages_Controle_Access`. **Badge `controle`**. |
| `Menus_Docu_Courriers_DocumentsScannes` | Documents scannés (`App/DocumentsScannes`) | Menu | Menu des documents scannés (seule permission requise pour cette entrée). |
| `Menus_Docu_Courriers_ParapheurElectronique` | Parapheur électronique (`App/ParapheurElectronique`) | Menu | Menu du parapheur. Combinée à `Pages_ParapheurElectronique_Access` (requiresAll). **Badge `parapheur`**. |
| `Menus_Docu_Courriers_SuiviPermanentCourrier` | Suivi des courriers (`App/SuiviCourriers`) | Menu | Une des permissions du menu « Suivi ». **Badge `suiviCourriers`**. |
| `Menus_Docu_Courriers_DC_SuiviCourrier` | Suivi des courriers (`App/SuiviCourriers`) | Menu | Autre permission du menu « Suivi » (l'entrée s'affiche si l'une des 4 permissions Suivi est accordée). |
| `Menus_Docu_Courriers_Validation` | Validation (`App/Validation`) | Menu | Menu de validation direction. Combinée à `Pages_Validation_Access` (requiresAll). **Badge `validation`**. |
| `Menus_Docu_Courriers_ResearchMultiCriteriaCourrier` | Recherche multicritères (`App/ResearchMultiCriteriaCourrier`) | Menu | Menu recherche multicritères. Combinée à `Pages_ResearchMultiCriteriaCourrier_Access` (requiresAll). |
| `Menus_Docu_Courriers_CourrierDepart` | Courrier départ (`App/CourrierDepart`) | Menu | Menu courrier départ. Combinée à `Pages_CourrierDepart_Access` (requiresAll). |
| `Menus_Docu_Courriers_IntegrationDecharge` | Intégration décharge (`App/IntegrationDecharge`) | Menu | Menu intégration des décharges. Combinée à `Pages_IntegrationDecharge_Access` (requiresAll). **Badge `integrationDecharge`**. |
| `Menus_Docu_Courriers_ArchivesCourriersTraites` | Archives courriers traités | Menu | Menu des archives de courriers traités (entrée nav actuellement commentée, permission définie). |
| `Menus_Docu_Courriers_ListOfMails` | Liste des courriers | Menu | Permission définie ; entrée nav commentée. |
| `Menus_Docu_Courriers_RechercheMultiCretereCourrier` (+ `_Access`) | Recherche multicritères (variante) | Menu | Ancienne clé de recherche multicritères ; l'écran actif utilise `ResearchMultiCriteriaCourrier`. Conservée pour compat. |
| `Menus_Docu_Courriers_IntegrationCourrierDepart` | Intégration courrier départ | Menu | Permission définie ; entrée nav commentée. Voir `Pages_IntegrationCourrierDepart_Access`. |
| `Menus_Docu_Courriers_SuiviCourrierDepart` | Suivi courrier départ | Menu | Permission définie ; entrée nav commentée. Voir `Pages_SuiviCourrierDepart_Access`. |

### 4.4 Permissions de page (écrans + `.Access`)

| Permission (constante) | Écran / menu associé | Type | Description |
|---|---|---|---|
| `Pages_AddMail` / `Pages_AddMail_Access` | AddMailController (`App/AddMail`) | Page | Accès à l'écran d'ajout/arrivée de courrier. |
| `Pages_Controle` / `Pages_Controle_Access` | ControleController (`App/Controle`) | Page | Accès à l'écran de contrôle des courriers. |
| `Pages_Controle_Access_New` | ControleController (nouvelle logique) | Page | Variante d'accès Contrôle (« New »), définie mais non montée dans l'arbre du provider. |
| `Pages_ParapheurElectronique` / `Pages_ParapheurElectronique_Access` | ParapheurElectroniqueController | Page | Accès au parapheur électronique. |
| `Pages_Validation` / `Pages_Validation_Access` | ValidationController (`App/Validation`) | Page | Accès à l'écran de validation direction. |
| `Pages_ResearchMultiCriteriaCourrier` / `Pages_ResearchMultiCriteriaCourrier_Access` | ResearchMultiCriteriaCourrierController | Page | Accès à la recherche multicritères courrier. |
| `Pages_CourrierDepart` / `Pages_CourrierDepart_Access` | CourrierDepartController | Page | Accès à l'écran courrier départ. |
| `Pages_IntegrationDecharge` / `Pages_IntegrationDecharge_Access` | IntegrationDechargeController | Page | Accès à l'intégration des décharges. |
| `Pages_DocumentsScannes` / `Pages_DocumentsScannes_Access` | DocumentsScannesController | Page | Accès à l'écran documents scannés (le menu n'exige que `Menus_Docu_Courriers_DocumentsScannes`). |
| `Pages_IntegrationCourrierDepart` / `Pages_IntegrationCourrierDepart_Access` | IntegrationCourrierDepartController | Page | Accès à l'intégration courrier départ (écran/menu commenté). |
| `Pages_SuiviCourrierDepart` / `Pages_SuiviCourrierDepart_Access` | SuiviCourrierDepartController | Page | Accès au suivi courrier départ (menu commenté). |
| `Pages_SuiviPermanentCourrier` / `Pages_SuiviPermanentCourrier_Access` | Suivi permanent (`App/SuiviCourriers`) | Page | Accès au suivi permanent des courriers. |
| `Pages_DC_SuiviCourrier` / `Pages_DC_SuiviCourrier_Access` | DC Suivi courrier (`App/SuiviCourriers`) | Page | Accès à la variante « DC » du suivi courrier ; parent menu `Menus_Docu_Courriers_DC_SuiviCourrier`. |
| `Pages_ArchivesCourriersTraites` / `Pages_ArchivesCourriersTraites_Access` | ArchivesCourriersTraitésController | Page | Accès aux archives de courriers traités. |
| `Pages_ListOfMails` / `Pages_ListOfMails_Access` | ListOfMailsController | Page | Accès à la liste des courriers (écran/menu commenté). |
| `Pages_GuichetUnique` / `Pages_GuichetUnique_Access` | GuichetUniqueController | Page | Accès au guichet unique (écran/menu commenté). |
| `Pages_Decharge` / `Pages_Decharge_Access` | DechargeController | Page | Accès à l'écran décharge (menu commenté). |
| `Pages_Standard_Courrier` / `Pages_Standard_Courrier_Access` | Standard/Enregistrement réponse | Page | Accès à l'enregistrement de réponse « courrier standard » (menu commenté). |
| `Pages_Service_Courrier` / `Pages_Service_Courrier_Access` | Service courrier | Page | Accès à l'écran « service courrier » (menu commenté). |
| `Pages_MailNatures` / `Pages_MailNatures_Access` | MailNaturesController | Page | Accès aux natures de courrier (menu commenté). |

### 4.5 Paramétrage Docu-Courriers (enfants de `Menus_MailSettings`)

Chaque entrée du menu paramétrage exige `requiresAll: true` (`Pages_*_Access` **+** `Menus_Mail_Settings_*`).

| Permission (constante) | Écran / menu associé | Type | Description |
|---|---|---|---|
| `Menus_Mail_Settings_Organigrammes` | Organigrammes (`App/Organigrammes`) | Menu | Menu de gestion des organigrammes. |
| `Pages_Organigrammes` / `Pages_Organigrammes_Access` | OrganigrammesController | Page | Accès à l'écran organigrammes. |
| `Menus_Mail_Settings_RoleOrganigramme` | Rôles d'organigramme (`App/RoleOrganigramme`) | Menu | Menu de gestion des rôles dans l'organigramme. |
| `Pages_RoleOrganigramme` / `Pages_RoleOrganigramme_Access` | RoleOrganigrammeController | Page | Accès à l'écran rôles d'organigramme. |
| `Menus_Mail_Settings_ExternalEntityTypes` | Types d'entités externes (`App/ExternalEntityTypes`) | Menu | Menu des types d'entités externes. |
| `Pages_ExternalEntityTypes` / `Pages_ExternalEntityTypes_Access` | ExternalEntityTypesController | Page | Accès à l'écran types d'entités externes. |
| `Pages_ExternalEntityTypes_Create` / `_Edit` / `_Delete` | Types d'entités externes | Action | Créer / éditer / supprimer un type d'entité externe. |
| `Menus_Mail_Settings_ExternalEntities` | Entités externes (`App/ExternalEntities`) | Menu | Menu des entités externes (expéditeurs/destinataires). |
| `Pages_ExternalEntities` / `Pages_ExternalEntities_Access` | ExternalEntitiesController | Page | Accès à l'écran entités externes. |
| `Pages_ExternalEntities_Create` / `_Edit` / `_Delete` | Entités externes | Action | Créer / éditer / supprimer une entité externe. |
| `Menus_Mail_Settings_MailInputationTypes` | Types d'imputation (`App/MailInputationTypes`) | Menu | Menu des types d'imputation de courrier. |
| `Pages_MailInputationTypes` / `Pages_MailInputationTypes_Access` | MailInputationTypesController | Page | Accès à l'écran types d'imputation. |
| `Pages_MailInputationTypes_Create` / `_Edit` / `_Delete` | Types d'imputation | Action | Créer / éditer / supprimer un type d'imputation. |
| `Menus_Mail_Settings_MailTypes` | Types de courrier départ (`App/MailDepartTypes`) | Menu | Menu des types de courrier (départ). |
| `Pages_MailTypes` / `Pages_MailTypes_Access` | MailTypesController (`App/MailDepartTypes`) | Page | Accès à l'écran types de courrier. |
| `Pages_MailTypes_Create` / `_Edit` / `_Delete` | Types de courrier | Action | Créer / éditer / supprimer un type de courrier. |
| `Menus_MailSettings_Organigrammes` | (constante « Menus_MailSettings_Organigrammes ») | Menu | Constante définie mais non rattachée à l'arbre ni au menu (héritage). |

### 4.6 Actions CRUD sur les entités courrier

Permissions d'action rattachées à `Pages` dans le provider, utilisées par les app services du module.

| Permission (constante) | Entité / écran | Type | Description |
|---|---|---|---|
| `Pages_Mails` | Mail | Page | Permission racine « Mails » (utilisée notamment par `MenuBadgeAppService` et les app services courrier). |
| `Pages_Mails_Create` / `_Edit` / `_Delete` | Mail | Action | Créer / éditer / supprimer un courrier. |
| `Pages_MailInputations` | MailInputation | Page | Racine des imputations de courrier. |
| `Pages_MailInputations_Create` / `_Edit` / `_Delete` | MailInputation | Action | Créer / éditer / supprimer une imputation. |
| `Pages_MailDocuments` | MailDocument | Page | Racine des documents de courrier (pièces, décharges). |
| `Pages_MailDocuments_Create` / `_Edit` / `_Delete` | MailDocument | Action | Créer / éditer / supprimer un document de courrier. |
| `Pages_MailCommentses` | MailComments | Page | Racine des commentaires de courrier. |
| `Pages_MailCommentses_Create` / `_Edit` / `_Delete` | MailComments | Action | Créer / éditer / supprimer un commentaire. |
| `Pages_MailControles` | MailControle | Page | Racine des contrôles de courrier. |
| `Pages_MailControles_Create` / `_Edit` / `_Delete` | MailControle | Action | Créer / éditer / supprimer un contrôle. |
| `Pages_MailObjets` | MailObjet | Page | Racine des objets de courrier. |
| `Pages_MailObjets_Create` / `_Edit` / `_Delete` | MailObjet | Action | Créer / éditer / supprimer un objet de courrier. |
| `Pages_MailSequences` | MailSequence | Page | Racine des séquences de numérotation courrier. |
| `Pages_MailSequences_Create` / `_Edit` / `_Delete` | MailSequence | Action | Créer / éditer / supprimer une séquence. |
| `Pages_Administration_Organigrammes` | Organigramme (Administration) | Page | Organigrammes sous le menu Administration (distinct du paramétrage courrier). |
| `Pages_Administration_Organigrammes_Create` / `_Edit` / `_Delete` | Organigramme (Administration) | Action | Créer / éditer / supprimer un organigramme. |
| `Pages_ExternalEntityCustomProperties` (+ `_Create`/`_Edit`/`_Delete`) | Propriétés custom d'entité externe | Page/Action | Gestion des propriétés personnalisées des entités externes. |
| `Pages_ExternalEntityCustomValues` (+ `_Create`/`_Edit`/`_Delete`) | Valeurs custom d'entité externe | Page/Action | Gestion des valeurs personnalisées des entités externes. |

> Remarque : il n'existe **pas** de permission `CourrierSuperUser` active. La constante et son enregistrement dans le provider sont commentés ; les menus qui la référençaient (Contrôle, ValidationDG, Validation de masse) sont désormais protégés par les couples `Pages_*_Access` + `Menus_Docu_Courriers_*`.

### 4.7 Badges de menu (compteurs temps quasi-réel)

Les badges affichent un compteur sur certaines entrées du menu Docu-Courriers. Le rattachement se fait via `customData: new { badgeKey = "…" }` dans `AppNavigationProvider.cs`, rendu en attribut HTML `data-badge-key="…"` par le composant `_UserMenuItem.cshtml`.

**Chaîne technique :**
1. `menu-badges.js` (`KTMenuBadges`) appelle `GET api/MenuBadges/all` au chargement puis toutes les **120 s** (`setInterval` 120000 ms).
2. Le contrôleur `MenuBadgesController` délègue à `IMenuBadgeAppService` (`MenuBadgeAppService`), protégé par `[AbpAuthorize(Pages_Mails, Menus_DocuCourriers)]` (l'endpoint `all` a néanmoins son autorisation retirée « pour test »).
3. `GetAllBadgesAsync()` renvoie un `MenuBadgesDto` ; le JS met à jour chaque `[data-badge-key]` : crée/actualise un `<span class="badge badge-warning menu-badge">`, ou le masque si le compteur vaut 0.
4. Endpoints unitaires additionnels : `GET api/MenuBadges/controle`, `.../validation-dg`, `.../parapheur`.
5. Rafraîchissement forcé (`forceUpdate`) sur les événements DOM `mail-processed` et `mail-validated`.

**Clés de badge et logique de comptage** (`MenuBadgeAppService`, repo `Mail` / `MailInputation` / `MailDocument`) :

| badgeKey | Entrée de menu | Méthode | Ce qui est compté |
|---|---|---|---|
| `controle` | Contrôle | `GetControleCountAsync` | Courriers en attente de contrôle : `(MailStatus != Redaction OU MailType == Arrivée)` ET `Valider == false` ET `DestinataireExpediteur == utilisateur courant`. Retourne 0 si pas d'utilisateur connecté. |
| `parapheur` | Parapheur électronique | `GetParapheurCountAsync` | Courriers dans le parapheur de l'utilisateur : union de (imputations `UserId == user`, `DateTreated == null`, `Valider == true`, `EnregistrementReponse == false`) et (mails `DestinataireExpediteur == user`, `DateTraited == null`, `Valider == true`, `EnregistrementReponse == false`), dédoublonnée. |
| `suiviCourriers` | Suivi des courriers | `GetSuiviCourriersCountAsync` | Tous les courriers non traités : `DateTraited == null`. |
| `validation` | Validation | `GetValidationCountAsync` | Courriers en attente de validation direction : `DateTraited == null` ET `Valider == true` ET `ValidationDirection == false`. |
| `integrationDecharge` | Intégration décharge | `GetIntegrationDechargeCountAsync` | Courriers de départ sans décharge : `MailType == Départ` en left-join sur `MailDocument` filtré `Decharge == true`, ne gardant que ceux sans document de décharge (`md == null`), dédoublonnés. |
| `validationDG` | *(non affiché)* | `GetValidationDGCountAsync` | Calculé et exposé (`ValidationDGCount`, endpoint `validation-dg`) mais **aucune entrée de menu ne porte `badgeKey = "validationDG"`** (le menu ValidationDG est commenté). Logique : jointure `Mail`/`MailInputation` où `MailInputationTypeId == 5` (type validation DG) ET `Valider == true` ET `DateTreated == null`. |

Toutes les méthodes de comptage sont en `try/catch` et retournent **0** en cas d'erreur (dégradation silencieuse). Le DTO `MenuBadgesDto` expose : `ControleCount`, `ValidationDGCount`, `ParapheurCount`, `SuiviCourriersCount`, `ValidationCount`, `IntegrationDechargeCount` (sérialisés en camelCase côté JSON, consommés tels quels par `menu-badges.js`).


---


## 05. Enregistrement (`/App/AddMail`)

### Rôle métier

Écran de **saisie / enregistrement d'un courrier ARRIVÉE**. C'est le point d'entrée du processus courrier : l'agent du bureau d'ordre (ou service courrier) charge le document numérique du courrier reçu (upload d'un PDF via l'explorateur, scan direct depuis un scanner, ou reprise d'un document déjà déposé par le poste client via la page « Documents scannés »), renseigne les métadonnées du courrier (objet, date du courrier, entité externe expéditrice, date d'enregistrement, références, destinataire/service d'imputation, rôles en copie, résumé), puis valide. La validation crée en une seule transaction fonctionnelle : (1) l'entité `Mail` (statut initial `Redaction`, type `Arrivée`), (2) un `Document` GED rattaché, (3) le lien `MailDocument`, (4) éventuellement des imputations « En copie », (5) une notification d'enregistrement, et le cas échéant marque le `DocumentScanne` d'origine comme traité. Le numéro d'enregistrement interne (`NReference`) est proposé automatiquement (max+1 sur 5 chiffres) et regénéré côté serveur s'il est laissé vide. La page est en **saisie** (pas de grille de consultation).

Fichiers de la page :
- Contrôleur : `src/DocuPro.Web.Mvc/Areas/App/Controllers/DocuCourriers/AddMailController.cs`
- Vue : `src/DocuPro.Web.Mvc/Areas/App/Views/AddMail/Index.cshtml` (JS inline dans la vue ; partial `_ScannerPartial` inclus via `Html.RenderPartialAsync("_ScannerPartial")` ; le pilotage scanner s'appuie aussi sur un composant JS `SimpleScanner`/`window.scanner`, réf. `scanner.js`).

### Accès & permissions

- **Contrôleur MVC** : `AddMailController` — `[Area("App")]` + `[AbpMvcAuthorize(AppPermissions.Pages_AddMail_Access)]`, hérite de `DocuProControllerBase`. Fichier : `src/DocuPro.Web.Mvc/Areas/App/Controllers/DocuCourriers/AddMailController.cs`.
- **Service applicatif** : `MailsAppService` — attribut de classe `[AbpAuthorize(AppPermissions.StandardUser)]`. **Exception importante** : la méthode `CreateOrEdit` (et `GetAllMailsWithoutFilter`) porte `[AbpAllowAnonymous]`, donc l'enregistrement lui-même n'exige pas la permission de classe. Fichier : `src/DocuPro.Application/MailBase/MailsAppService.cs`.
- **Constantes de permission** (`src/DocuPro.Core.Shared/Authorization/AppPermissions.cs`) :
  - `Pages_AddMail_Access = "Pages.AddMail.Access"` — déclarée dans `AppAuthorizationProvider.cs` : `addMail.CreateChildPermission(AppPermissions.Pages_AddMail_Access, L("AddMailAccess"))`.
  - `Menus_Docu_Courriers_AddMail = "Menus.Docu_Courriers.AddMail"`.
  - `StandardUser = "StandardUser"` (permission de classe du service).
- **Entrée de menu** (`src/DocuPro.Web.Mvc/Areas/App/Startup/AppNavigationProvider.cs`, sous le menu `Menus_DocuCourriers`) :
  - Nom de page : `AppPageNames.Common.AddMail`, libellé `L("AddMail")`, url `App/AddMail`, icône `bi bi-envelope-plus`.
  - Dépendance de permission : `new SimplePermissionDependency(requiresAll: true, AppPermissions.Pages_AddMail_Access, AppPermissions.Menus_Docu_Courriers_AddMail)`. Pas de badge.
- **Multi-tenant** : `Mail` implémente `IMayHaveTenant`. Dans `Create`, `mail.TenantId` est renseigné depuis `AbpSession.TenantId` s'il existe. `DocumentScannesAppService.GetFilePath` et `MarkAsProcessed` **désactivent** explicitement le filtre `AbpDataFilters.MayHaveTenant` (`UnitOfWorkManager.Current.DisableFilter(...)`). `GetNextNReference` lit tous les courriers via `GetAllMailsWithoutFilter` (méthode `[AbpAllowAnonymous]` qui ne pose aucun `WhereIf`, mais reste soumise aux query filters ABP par défaut).

### Interface utilisateur

- Page Razor : `src/DocuPro.Web.Mvc/Areas/App/Views/AddMail/Index.cshtml`. Script : **inline** dans cette même vue (aucun `Index.js` séparé sous `view-resources/Areas/App/Views/AddMail`). jQuery chargé en dur (`https://code.jquery.com/jquery-3.6.0.min.js`). Composants de formulaire = Syncfusion EJ2 (`ejs-textbox`, `ejs-datepicker`, `ejs-dropdownlist`, `ejs-multiselect`, `ejs-uploader`, `ejs-maskedtextbox`).
- Titre / sous-titre : `<abp-page-subheader title='@L("AddMail")' description='@L("AddMail")'>`.
- Écran en deux blocs commutables : bloc **Upload/Scan** (`#fileContainer`) puis bloc **Formulaire** (`#mainContainer`, masqué par défaut, affiché après chargement du fichier ou si on arrive depuis « Documents scannés »).
- `ViewBag` alimentés par `Index(int? documentScanneId)` : `DocumentScanneId`, `RoleList` (rôles ayant ≥ 1 utilisateur, `GenericViewModel{Id,Name}`), `ExternalEntity`, `Nature`, `Confidentiality`, `MailInputationType`, `MailObjet`, `ExternalEntityType`, `user`, `NextNReference`. (Nature, Confidentiality, MailInputationType, MailObjet sont chargés mais leurs champs de saisie sont actuellement commentés dans la vue — voir plus bas.)

#### Filtres / recherche
— (sans objet : page de saisie, aucun filtre de recherche.)

#### Colonnes du tableau
— (sans objet : aucune grille.)

#### Actions (boutons)

| Bouton | Effet (endpoint / JS) | Permission |
|---|---|---|
| `@L("ScannerLeDocument")` (`#btnScan`) | Déclenche le scan via `window.scanner` (`SimpleScanner`) ; côté serveur : `POST App/AddMail/ScanDocument` (ESCL localhost/réseau ou NAPS2.Sdk). | `Pages_AddMail_Access` (niveau contrôleur) |
| `@L("ChargerLaSelection")` (`Upload()`) | Récupère le fichier scanné ou le fichier input, appelle `sendAddFileRequest(...)`, bascule vers `#mainContainer`. | idem |
| `@L("ChargerViaExplorateur")` / `@L("ChargerViaScanner")` (`toogleUploader()`) | Bascule entre panneau scanner et panneau explorateur. | idem |
| Uploader `ejs-uploader name="File"` (`#File`, `.pdf`, `autoUpload`) | Sélection du PDF. | idem |
| `@L("ChargerLeDocument")` (`#addFile`) | `sendAddFileRequest(file, isAIChecked)` → affiche le formulaire. | idem |
| `+` (à côté d'Entité externe) | Ouvre la modale `#addExternalEntityModal`. | idem |
| `@L("Retour")` (`retourVersUpload()`) | Masque le formulaire, réaffiche l'upload. | idem |
| `@L("Valider")` (submit `#addNewMailForm`) | `submit` intercepté : validations champ par champ, construit `FormData`, ouvre la modale de vérification `#verifyDataModal`. | idem |
| `@L("Confirmer")` (`#confirmSubmitButton`) | `fetch('/App/AddMail/Add', {method:'POST', body: FormData})` → enregistrement effectif, puis redirection `window.location.href='/App/AddMail'`. | idem |
| `@L("Save")` (`#saveExternalEntityButton`) | `POST App/AddMail/AddExternalEntity` (JSON `CreateOrEditExternalEntityDto`) → crée une entité externe, recharge la dropdown. | idem |
| Endpoints AJAX auxiliaires | `GET GetExternalEntity`, `GET GetList?option=`, `GET/POST` scanner (`ListScanners`, `ScanDocument`, `GetScannedFiles`, `GetScannedFile`, `RemoveScannedFile`, `GetScannedDocument`, `ConvertImageToPdf`), `POST DoAIRecognition`. | idem |

#### Formulaire(s) / Modale(s)

**Formulaire principal `#addNewMailForm` (`asp-action="Add"`, `enctype multipart/form-data`)** — reliure champ → paramètre d'action `Add` → propriété `CreateOrEditMailDto` → colonne `Mails` :

| Champ (UI) | Nom HTML → param `Add` | Propriété DTO / colonne | Contrôle | Oblig. | Source / valeurs / défaut |
|---|---|---|---|---|---|
| Objet (`@L("Subject") *`) | `Title` | `CreateOrEditMailDto.Title` → `Mails.Title` | `ejs-textbox` `#Title` | Oui (JS + `[Required]`) | Saisie libre. Pré-remplissable par IA (`DoAIRecognition`). |
| Date du courrier (`@L("MailDate") *`) | `Date` (DateTime) | `CreateOrEditMailDto.Date` → `Mails.Date` | `ejs-datepicker` `#Date` `max=today` `dd-MM-yyyy` | Oui (JS) | Sérialisée en `yyyy-MM-dd` avant envoi. |
| Entité externe (`@L("ChooseExternalEntity") *`) | `ExternalEntityId` (int?) | `CreateOrEditMailDto.ExternalEntityId` → `Mails.ExternalEntityId` | `ejs-dropdownlist` `#ExternalEntityId` (filtrable) | Oui (JS) | `dataSource=@ViewBag.ExternalEntity` (`ExternalEntity.Id`/`ExternalEntity.Name`) ; rechargée via `GetExternalEntity`. Bouton `+` → modale. |
| Date d'enregistrement (`@L("DateEnregistrementCourrier") *`) | `DateEnregistrementCourrier` (DateTime) | `CreateOrEditMailDto.DateEnregistrementCourrier` → `Mails.DateEnregistrementCourrier` | `ejs-datepicker` `#DateEnregistrementCourrier` `max=today` | Marqué `*` (non bloqué en JS) | Sérialisée `yyyy-MM-dd`. |
| Leur référence (`@L("MailReference")`) | `Vreference` (string?) | `CreateOrEditMailDto.Reference` → `Mails.Reference` | `ejs-textbox` `#vreference` | Non | Référence de l'expéditeur. Pré-remplissable par IA (`vreference`). |
| Notre référence (`@L("OurReference")`) | `Nreference` (string?) | `CreateOrEditMailDto.NReference` → `Mails.NReference` | `ejs-textbox` `#nvreference` | Non | Pré-rempli `value=@ViewBag.NextNReference`. Si vide à l'envoi, regénéré serveur (`GetNextNReference`, max+1 « D5 »). |
| Transfert pour imputation (`Transfert pour imputation *`) | `DestinataireExpediteurId` (int, **ID de RÔLE**) | Résolu en `long userId` → `CreateOrEditMailDto.DestinataireExpediteur` → `Mails.DestinataireExpediteur` | `ejs-dropdownlist` `#DestinataireExpediteur` | Oui (JS) | `dataSource=@ViewBag.RoleList` (`Id`/`Name`). Le contrôleur résout le rôle → 1er utilisateur du rôle ; sinon `_defaultMailDestinataire`. |
| En copie (`@L("EnCopie")`) | `EnCopieRoles` (multiselect) → hidden `selectedValues` | Non mappé sur `Mails` : génère des `MailInputation` | `ejs-multiselect` `#multiselect` mode CheckBox + `<input hidden #selectedValues name="selectedValues">` | Non | `dataSource=@ViewBag.RoleList`. `multiselectChange` copie `value.join(',')` dans `selectedValues`. |
| Résumé / Description (`@L("Description")`) | `Description` (string?) | `CreateOrEditMailDto.Description` → `Mails.Description` | `ejs-textbox multiline` `#Description` | Non | Saisie libre. Pré-remplissable par IA (`resume`). |
| Fichier | `File` (IFormFile) / `documentScanneId` / `ScannedFileId` | Non stocké sur `Mails` : sert à créer le `Document` GED | `ejs-uploader`/scan/`documentScanneId` | Oui sauf si `documentScanneId` présent | PDF. Voir « Règles de gestion ». |
| (caché) `Inputation` | `Inputation` (form key) | Lu par `Request.Form.ContainsKey("Inputation")` | `#Inputation` checkbox (panneau imputation commenté) | — | Bloc d'imputation détaillé actuellement **commenté** dans la vue et le contrôleur. |
| (caché) `documentScanneIdValue` | `documentScanneId` | Voir MarkAsProcessed | `<input hidden #documentScanneIdValue value=@ViewBag.DocumentScanneId>` | — | Renseigné quand on arrive depuis « Documents scannés » (query `?documentScanneId=`). |

**Champs présents dans la vue mais COMMENTÉS (non rendus actuellement)** — à signaler pour une réimplémentation : panneau « Inputer le courrier » (radios `inputationOptions` ToutLeMonde/parUtilisateur/parService/parRole, `MailInputationTypeId`, `Instructions`, `DateButoir`), et le champ « Nature » (`NatureId`). Les `ViewBag.Nature`, `ViewBag.Confidentiality`, `ViewBag.MailObjet`, `ViewBag.MailInputationType` restent chargés mais sans champ actif. Conséquence : `MailNatureId`, `MailObjetId`, `ConfidentialitesId`, `DateButoire`, `DateFollowUp` ne sont **pas** renseignés par cette page (voir DTO/tables).

**Modale « Ajouter une entité externe » (`#addExternalEntityModal`)** — POST `AddExternalEntity` (`[FromBody] CreateOrEditExternalEntityDto`) :

| Champ | Nom | Contrôle | Oblig. |
|---|---|---|---|
| Type d'entité | `ExternalEntityTypeId` | `ejs-dropdownlist` `#externalEntityTypeId` (`@ViewBag.ExternalEntityType`) | Non |
| Nom | `Name` | `ejs-textbox` `#externalEntityName` `required` | Oui |
| Téléphone | `Telephone` | `ejs-maskedtextbox` `#externalEntityTelephone` mask `00 00 00 00 00` | Non |
| Email | `Email` | `ejs-textbox` `#externalEntityEmail` | Non |
| Prénom | `FirstName` | `ejs-textbox` `#externalEntityFirstName` | Non |
| Nom (LastName) | `LastName` | `ejs-textbox` `#externalEntityLastName` | Non |

**Modale de vérification (`#verifyDataModal`)** : lecture seule ; affiche Objet, Date, Entité externe, Date d'enregistrement, Leur/Notre référence, Destinataire, En copie, Description avant confirmation. Bouton `@L("Confirmer")` → envoie `Add`.

### Service applicatif & opérations

- Interface : `src/DocuPro.Application.Shared/MailBase/IMailsAppService.cs`. Implémentation : `src/DocuPro.Application/MailBase/MailsAppService.cs`.

**Méthodes `IMailsAppService` utilisées par cette page :**

| Méthode | Entrée | Sortie | Description |
|---|---|---|---|
| `CreateOrEdit` | `CreateOrEditMailDto input` | `Task<int?>` | `[AbpAllowAnonymous]`. Si `input.Id == null` → `Create` (renvoie le nouvel Id) ; sinon `Update` (renvoie `null`). Sur cette page, toujours création (Id null). |
| `Create` (protected) | `CreateOrEditMailDto` | `Task<int>` | `ObjectMapper.Map<Mail>(input)` ; pose `TenantId` (session) ; force `mail.DateButoire = input.DateButoire` ; calcule et pose `mail.OrganigrammeId` = 1er `OrganigrammeId` des rôles du `DestinataireExpediteur` (sinon null) ; `InsertAndGetIdAsync` ; vide caches `MailsCache`/`ParapheurCache`/`CourrierDepartCache`. |
| `Update` (protected) | `CreateOrEditMailDto` | `Task` | Non utilisée ici. `ObjectMapper.Map(input, mail)` + `DateButoire` ; vide caches. |
| `GetAllMailsWithoutFilter` | — | `Task<List<MailDto>>` | `[AbpAllowAnonymous]`. Projette tous les `Mail` en `MailDto` (Id, Title, Date, Description, NReference, Reference, MailType, MailStatus). Sert au calcul du prochain `NReference`. |
| `GetExternalEntityIdByReference` | `string reference` | `Task<int?>` | Cherche un `Mail` où `NReference == reference || Reference == reference` et renvoie son `ExternalEntityId`. Utilisée par le helper `GetExternalTierId` (rapprochement expéditeur), pas dans le flux `Add` principal. |
| `GetMailForEdit` | `EntityDto` (int) | `Task<GetMailForEditOutput>` | Non utilisée par cette page (fournie par l'interface ; mappe un `Mail` vers `CreateOrEditMailDto` + noms confidentialité/parent/entité). |

**Services tiers appelés par le contrôleur `Add` :**
- `IDocumentAddAppService.AddDocumentAsync(Name, dateDocument, documentTypeId, documentClassificationId, documentConfidentialitesId, file, documentState, dossier, Archive=true)` → `Task<int>` (crée le `Document` GED ; ici `documentTypeId=_mailDocumentTypeId`, `documentState=0`, `dossier=_generalDossierId`, `Archive=true`). Fichier : `src/DocuPro.Application/Common/DocumentAddAppService.cs`.
- `IMailDocumentsAppService.CreateOrEdit(CreateOrEditMailDocumentDto{MailId, DocumentId, Decharge=false})` → lien courrier/document.
- `IMailInputationsAppService.CreateOrEdit(CreateOrEditMailInputationDto{MailId, UserId, SendsSMS=false, MailInputationTypeId=_mailInputationTypeIdEnCopie})` → une imputation « en copie » par utilisateur de chaque rôle sélectionné.
- `IDocumentScannesAppService.GetFilePath(int id)` / `MarkAsProcessed(int id, int mailId, int documentId)`. Fichier : `src/DocuPro.Application/DocumentBase/DocumentScannesAppService.cs`.
- `IAppNotifier.NotificationEnregistrementCourrierAsync(int mailId, long destinataireUserId, List<long> enCopieUserIds = null)`. Fichiers : `src/DocuPro.Core/Notifications/IAppNotifier.cs`, `AppNotifier.cs`.

**Actions MVC principales du contrôleur `AddMailController` :**

| Action | Signature (paramètres) | Retour |
|---|---|---|
| `Index` | `Index(int? documentScanneId = null)` | `View()` ; remplit `ViewBag` (dont `DocumentScanneId`, `NextNReference`). |
| `Add` | `Add(IFormFile File, int DestinataireExpediteurId, string Title, DateTime Date, DateTime DateEnregistrementCourrier, int? ExternalEntityId, string? Vreference, string? Nreference, string? Description, string? selectedValues, string? ScannedFileId = null, string documentScanneId = null)` | `Json({success, message})` ; `500` en erreur. Orchestration complète (voir Règles). |
| `GetNextNReference` (privée) | — | `string` : max(NReference numériques)+1 formaté « D5 » (`00001`…) ; `"00001"` par défaut/erreur. |
| `AddExternalEntity` | `[FromBody] CreateOrEditExternalEntityDto input` | `Json({success})`. |
| `getExternalEntity` | — | `Json({success, result})` liste des entités externes. |
| `GetList` | `GetList(string option)` — `ToutLeMonde`/`parUtilisateur`/`parService`/`parRole` | `Json(List<GenericViewModel>)` (alimente le panneau imputation commenté). |
| `DoAIRecognition` | `DoAIRecognition(IFormFile uploadedFile)` | `Json({date, expediteur, nreference, vreference, title, resume})` via OpenAI Vision + extraction texte PDF. |
| Actions scanner | `ListScanners`, `ScanDocument(...)`, `ConvertImageToPdf`, `GetScannedDocument`, `GetScannedFiles`, `GetScannedFile`, `RemoveScannedFile` | JSON / flux fichier ; pilotage scanners ESCL/NAPS2 + dossier surveillé. |

### DTOs

**`CreateOrEditMailDto`** (`src/DocuPro.Application.Shared/MailBase/Dtos/CreateOrEditMailDto.cs`, hérite `EntityDto<int?>`) — DTO d'entrée de `CreateOrEdit` :

| Propriété | Type C# | Oblig. | Description / usage sur cette page |
|---|---|---|---|
| `Id` (hérité) | `int?` | Non | `null` en création (déclenche `Create`). |
| `Title` | `string` | Oui `[Required]` | Objet du courrier → `Mails.Title`. |
| `Date` | `DateTime` | Non (défaut) | Date du courrier → `Mails.Date`. |
| `DateFollowUp` | `DateTime?` | Non | Non renseigné par cette page. |
| `Description` | `string` | Non | Résumé → `Mails.Description`. |
| `NReference` | `string` | Non | Notre n° d'enregistrement → `Mails.NReference`. |
| `MailType` | `MailType` (enum) | Non | **Non fixé par le contrôleur** → défaut enum `0 = Arrivée`. → `Mails.MailType`. |
| `MailStatus` | `MailStatus` (enum) | Non | **Non fixé par le contrôleur** → défaut enum `0 = Redaction`. → `Mails.MailStatus`. |
| `Reference` | `string` | Non | Leur référence (`Vreference`) → `Mails.Reference`. |
| `ConfidentialitesId` | `int?` | Non | Non renseigné (champ commenté). |
| `MailParent` | `int?` | Non | Non renseigné. |
| `ExternalEntityId` | `int?` | Non | Entité externe → `Mails.ExternalEntityId`. |
| `MailNatureId` | `int?` | Non | Non renseigné (champ Nature commenté). |
| `MailObjetId` | `int?` | Non | Non renseigné (calcul `DateButoire` commenté). |
| `MailDepartTypeId` | `int?` | Non | Non renseigné (courrier arrivée). |
| `DestinataireExpediteur` | `long?` | Non | userId résolu depuis le rôle → `Mails.DestinataireExpediteur`. |
| `DateTraited` | `DateTime?` | Non | Non renseigné. |
| `DateButoire` | `DateTime?` | Non | Non renseigné ici (`CalculateDateButoire` commenté) → `Mails.DateButoire` reste null. |
| `DateEnregistrementCourrier` | `DateTime?` | Non | → `Mails.DateEnregistrementCourrier`. |
| `OrganigrammeId` | `int?` | Non | **Ignoré en entrée** : recalculé dans `Create` depuis les rôles du destinataire → `Mails.OrganigrammeId`. |

**`MailDto`** (`.../Dtos/MailDto.cs`, `EntityDto`) — utilisé par `GetAllMailsWithoutFilter` (calcul `NReference`) :

| Propriété | Type C# | Description |
|---|---|---|
| `Id` (hérité) | `int` | Id du courrier. |
| `Title` | `string` | Objet. |
| `Date` | `DateTime` | Date du courrier. |
| `DateFollowUp` | `DateTime?` | Date de suivi. |
| `DateReglementaire` | `DateTime?` | Date réglementaire. |
| `Description` | `string` | Résumé. |
| `NReference` | `string` | Notre référence (lue pour trouver le max). |
| `MailType` | `MailType` | Type. |
| `MailStatus` | `MailStatus` | Statut. |
| `Reference` | `string` | Leur référence. |
| `ConfidentialitesId` | `int?` | FK confidentialité. |
| `MailParent` | `int?` | FK courrier parent. |
| `ExternalEntityId` | `int?` | FK entité externe. |
| `MailObjetId` | `int?` | FK objet. |
| `MailNatureId` | `int?` | FK nature. |
| `DestinataireExpediteur` | `long` | userId destinataire. |
| `DateTraited` | `DateTime?` | Date de traitement. |
| `DateDecharge` | `DateTime?` | Date de décharge. |
| `DateEnregistrementCourrier` | `DateTime?` | Date d'enregistrement. |

**`GetMailForViewDto`** (`.../Dtos/GetMailForViewDto.cs`) — non produit par le flux `Add`, listé car exposé par l'interface `IMailsAppService` :

| Propriété | Type C# | Description |
|---|---|---|
| `Mail` | `MailDto` | Bloc courrier. |
| `ConfidentialitesName` | `string` | Nom confidentialité. |
| `MailDisplayProperty` | `string` | Libellé courrier parent. |
| `DateEnregistrementCourrier` | `DateTime?` | Date d'enregistrement. |
| `CreationTime` | `DateTime` | Date de création. |
| `ExternalEntityName` | `string` | Nom entité externe. |
| `MailTypeName` | `string` | Libellé type. |
| `MailNature` | `string` | Libellé nature. |
| `LongDescription` | `string` | Description longue. |
| `Description` | `string` | Description. |
| `Direction` | `string` | Direction. |
| `MailObjet` | `string` | Libellé objet. |
| `Statut` | `string` | Statut. |
| `LastImputationFullName` | `string` | Dernier imputé. |
| `DateRapel` | `DateTime?` | Date de rappel. |
| `UserCreated` | `string` | Créateur. |
| `DateDecharge` | `DateTime?` | Date de décharge. |
| `DestinataireFullName` | `string` | Nom destinataire. |
| `DestinataireExpediteurId` | `long` | userId destinataire. |
| `InputationTypeName` | `string` | Type d'imputation. |
| `Deadline` | `DateTime?` | Échéance. |

**`GetMailForEditOutput`** (`.../Dtos/GetMailForEditOutput.cs`) — sortie de `GetMailForEdit` (non utilisé ici) :

| Propriété | Type C# | Description |
|---|---|---|
| `Mail` | `CreateOrEditMailDto` | Courrier à éditer. |
| `ConfidentialitesName` | `string` | Nom confidentialité. |
| `MailDisplayProperty` | `string` | Libellé parent. |
| `ExternalEntityName` | `string` | Nom entité externe. |

**`CreateOrEditMailInputationDto`** (`.../Dtos/CreateOrEditMailInputationDto.cs`, `EntityDto<int?>`) — utilisé pour les imputations « En copie » :

| Propriété | Type C# | Oblig. | Renseigné par `Add` |
|---|---|---|---|
| `Id` (hérité) | `int?` | Non | null (création). |
| `Instructions` | `string` | Non | Non (null). |
| `Deadline` | `DateTime?` | Non | Non. |
| `SendsSMS` | `bool` | Non | `false`. |
| `DateTreated` | `DateTime?` | Non | Non. |
| `MailInputationTypeId` | `int` | — | `_mailInputationTypeIdEnCopie` (config `MailInputationTypeIdEnCopie`). |
| `UserId` | `long` | — | Chaque utilisateur des rôles « en copie ». |
| `MailId` | `int` | — | Id du courrier créé. |
| `DateCreated` | `DateTime?` | Non | Non. |

**`GetAllForLookupTableInput`** (`.../Dtos/GetAllForLookupTableInput.cs`, `PagedAndSortedResultRequestDto`) : propriété `Filter` (`string`). DTO de lookup générique du module ; **non directement utilisé** par `AddMailController` (les dropdowns sont alimentées par `ViewBag`/`GenericViewModel` via les `GetAllList()` des services de référence).

**`GenericViewModel`** (`src/DocuPro.Web.Mvc/ViewModels/GenericViewModel.cs`) : `Id` (int), `Name` (string), `Name2` (string), `Valeur` (int), `Date` (DateTime, get). Alimente les dropdowns (RoleList, ExternalEntity, etc.).

### Tables & colonnes impactées

**Table `Mails`** — `[Table("Mails")]`, entité `Mail` (`src/DocuPro.Core/MailBase/Mail.cs`), base `FullAuditedEntity`, interfaces `IMayHaveTenant`, `[Audited]`. DbSet dans `DocuProDbContext`.

| Table | Colonne | Type CLR | Lecture / Écriture (par cette page) |
|---|---|---|---|
| `Mails` | `Id` | int (PK) | Écriture (généré à l'insert) ; lu pour `MarkAsProcessed`/document/imputation. |
| `Mails` | `TenantId` | int? | Écriture (depuis session dans `Create`). |
| `Mails` | `Title` | string (Required) | Écriture. |
| `Mails` | `Date` | DateTime (Required) | Écriture. |
| `Mails` | `Description` | string | Écriture. |
| `Mails` | `Reference` | string | Écriture (leur référence, `Vreference`). |
| `Mails` | `NReference` | string | Écriture (notre n°, auto ou saisi). |
| `Mails` | `MailType` | enum `MailType` | Écriture = `Arrivée` (0) par défaut du DTO. |
| `Mails` | `MailStatus` | enum `MailStatus` | Écriture = `Redaction` (0) par défaut du DTO. |
| `Mails` | `DateEnregistrementCourrier` | DateTime? | Écriture. |
| `Mails` | `ExternalEntityId` | int (FK ExternalEntity) | Écriture (entité externe sélectionnée). ⚠️ Colonne **non nullable** sur l'entité (`public virtual int ExternalEntityId`) alors que `CreateOrEditMailDto.ExternalEntityId` est `int?` ; à la sélection absente, AutoMapper mappe `null → 0` (le champ est toutefois obligatoire côté JS). |
| `Mails` | `DestinataireExpediteur` | long (FK User) | Écriture (userId résolu depuis le rôle). |
| `Mails` | `OrganigrammeId` | int? (FK Organigramme) | Écriture (recalculé depuis les rôles du destinataire). |
| `Mails` | `DateButoire` | DateTime? | Écriture = `null` (calcul commenté). |
| `Mails` | `MailNatureId` | int? (FK) | Non écrit (null). |
| `Mails` | `ConfidentialitesId` | int? (FK) | Non écrit (null). |
| `Mails` | `MailObjetId` | int? (FK) | Non écrit (null). |
| `Mails` | `MailParent` | int? (FK Mail) | Non écrit. |
| `Mails` | `MailDepartTypeId` | int? (FK) | Non écrit. |
| `Mails` | `Valider` / `ValidationDirection` / `ValidationDG` / `EnregistrementReponse` / `Decharge` | bool | Non écrits → valeurs par défaut `false`. |
| `Mails` | `DateFollowUp` / `EndDateFollowUp` / `DateDecharge` / `DateTraited` | DateTime? | Non écrits (null). |
| `Mails` | Audit : `CreationTime`, `CreatorUserId`, `LastModificationTime`, `LastModifierUserId`, `IsDeleted`, `DeleterUserId`, `DeletionTime` | — | `CreationTime`/`CreatorUserId` posés par ABP à l'insert. |

**Table `ExternalEntities`** — `[Table("ExternalEntities")]`, `ExternalEntity` (`FullAuditedEntity`, `IMayHaveTenant`, `[Audited]`) : colonnes `Id`, `TenantId`, `Name` (Required), `Email`, `Telephone`, `ExternalEntityTypeId` (FK). **Lecture** (dropdown `ExternalEntityId`, via `GetAllList`/`GetAll`). **Écriture** possible via la modale `AddExternalEntity` (crée une nouvelle ligne).

**Table `Organigrammes`** — `[Table("Organigrammes")]`, `Organigramme` (`FullAuditedEntity`, `IMayHaveTenant`) : `Id`, `TenantId`, `Name` (Required), `ParentId` (FK auto). **Lecture** (résolution de `OrganigrammeId` du destinataire via ses rôles).

**Table `MailInputations`** — écrite (via `IMailInputationsAppService.CreateOrEdit`) : une ligne par utilisateur des rôles « En copie » (`MailId`, `UserId`, `SendsSMS=false`, `MailInputationTypeId=_mailInputationTypeIdEnCopie`).

**Table `DocumentScannes`** — `[Table("DocumentScannes")]`, `DocumentScanne` (`CreationAuditedEntity`, `IMayHaveTenant`) : `Id`, `TenantId`, `FileName`, `FilePath`, `DateScanned`, `MachineName`, `IsTraite`, `MailId`, `DocumentId`. **Lecture** `FilePath` (reprise du fichier). **Écriture** via `MarkAsProcessed` : `IsTraite=true`, `MailId=<mailId>`, `DocumentId=<documentId>` (filtre tenant désactivé).

**Tables `Documents` / `MailDocuments`** — écrites indirectement : `AddDocumentAsync` crée le `Document` (+ versions/fichiers GED) ; `MailDocument` lie `MailId`/`DocumentId` (`Decharge=false`).

**Tables de référence lues mais NON exploitées par le formulaire actif** (champs commentés) : `MailNatures` (`MailNature`), `Confidentialiteses` (`Confidentialites`), `MailObjets` (`MailObjet`, colonnes `Name`, `DureeSuiviExterne`, `DureeSuiviInterne`), `MailInputationTypes`, `ExternalEntityTypes`. Note : l'entité `MailDepartType` est mappée sur `[Table("MailTypes")]` (propriété `name`), non utilisée ici.

**Mapping AutoMapper** : `CustomDtoMapper.cs` — `configuration.CreateMap<CreateOrEditMailDto, Mail>().ReverseMap();` (mapping par nom, sans `ForMember`) : toutes les propriétés homonymes du DTO sont copiées vers `Mail`.

### Règles de gestion / effets de bord / transitions de statut

**Statut initial (pas de transition explicite)** : le courrier est créé avec `MailStatus = Redaction` (0) et `MailType = Arrivée` (0) — ces deux valeurs proviennent des **défauts d'enum** du DTO (le contrôleur ne les affecte pas). Les drapeaux `Valider`, `ValidationDirection`, `ValidationDG`, `EnregistrementReponse`, `Decharge` restent `false` (défauts entité). Aucune date de workflow (`DateTraited`, `DateDecharge`, `DateFollowUp`, `DateButoire`) n'est posée à ce stade.

**Numérotation `NReference`** : `GetNextNReference()` charge tous les courriers (`GetAllMailsWithoutFilter`), parse les `NReference` numériques, prend le max, +1, formate sur 5 chiffres (`ToString("D5")` → `00001`, `00002`…). Proposé dans le champ à l'ouverture (`ViewBag.NextNReference`) et **regénéré serveur si `Nreference` est vide/blanc** à la soumission. En cas d'erreur, valeur de repli `"00001"`. ⚠️ Numérotation par max+1 non transactionnelle → risque théorique de collision en création concurrente.

**Résolution du destinataire** : `DestinataireExpediteurId` (de la dropdown) est un **ID de rôle**. Le contrôleur récupère le rôle (`RoleManager.GetRoleByIdAsync`), prend le **premier utilisateur** du rôle (`UserManager.GetUsersInRoleAsync`) comme `DestinataireExpediteur`. Fallbacks vers `_defaultMailDestinataire` (config `DefaultMailDestinataire`) si : rôle introuvable, rôle sans utilisateur, ou `DestinataireExpediteurId <= 0`.

**Affectation `OrganigrammeId`** (dans `MailsAppService.Create`) : dérivée du `DestinataireExpediteur` — 1er `OrganigrammeId` parmi les rôles de cet utilisateur ; sinon `null`. La valeur `OrganigrammeId` éventuellement passée dans le DTO est écrasée.

**Chaîne d'enregistrement (`Add`), ordre des effets de bord** :
1. Reprise fichier si `documentScanneId` fourni et `File == null` : `GetFilePath(dsId)` → lecture disque → `FormFile`. Si introuvable → `400` « Document scanné introuvable ou fichier manquant ». Si toujours aucun fichier → `400`.
2. Génération `NReference` si vide.
3. Résolution `DestinataireExpediteur`.
4. `CreateOrEdit(CreateOrEditMailDto)` → insertion `Mail` (récupère `mailId`). `await Task.Delay(50)`.
5. `AddDocumentAsync(Title, Date, _mailDocumentTypeId, null, 1, File, 0, _generalDossierId, true)` → `documentId` (gère spécifiquement une erreur « thumbnail »).
6. `MailDocuments.CreateOrEdit({MailId, DocumentId, Decharge=false})`.
7. **Liaison document scanné** : si `documentScanneId` (int) → `MarkAsProcessed(dsId, mailId, documentId)` (pose `IsTraite=true`, `MailId`, `DocumentId`). Sinon si `ScannedFileId` fourni → `CleanupScannedFileById` (supprime le fichier physique + entrée du dossier surveillé). Sinon → `CleanupScannedFileAfterSave` (rapprochement heuristique par taille ±5 % et récence ≤ 30 min).
8. **Imputations « En copie »** : `selectedValues` (CSV d'IDs de rôles) → pour chaque rôle, pour chaque utilisateur → `MailInputations.CreateOrEdit(...)` avec `MailInputationTypeId=_mailInputationTypeIdEnCopie`, `SendsSMS=false` ; collecte des `enCopieUserIds` (dédupliqués). `await Task.Delay(100)`.
9. **Notification** : `NotificationEnregistrementCourrierAsync(mailId, DestinataireExpediteur, enCopieUserIds?)` (échec non bloquant, capturé/loggé).
10. Réponse `Json({success:true, message:"Mail added successfully"})`. Le JS affiche un toast puis redirige vers `/App/AddMail`.
   - Toute exception → `500 { success:false, message }`.

**Invalidations de cache** : `Create` (et `Update`) vident `MailsCache`, `ParapheurCache`, `CourrierDepartCache`.

**Reconnaissance IA (optionnelle)** : `DoAIRecognition` extrait le texte du PDF (Syncfusion) + `IOpenAIVisionServices.ExtractDocumentInformation` et pré-remplit Objet, dates, références, résumé (le toggle IA est actuellement commenté dans la vue).

**Idempotence** : aucune protection anti-double-soumission côté serveur au-delà du flux ci-dessus ; `MarkAsProcessed` est idempotent (repose l'état traité). Le nettoyage du fichier scanné et la notification sont « best effort » (erreurs avalées, non bloquantes pour l'enregistrement).

**Effets de bord notables** : suppression physique de fichiers dans le dossier surveillé (`CleanupScannedFileById` / `CleanupScannedFileAfterSave` / `RemoveScannedFile`) ; création de fichiers PDF côté serveur lors des scans (`ScanDocument`) ; désactivation du filtre tenant lors des accès `DocumentScannes`.


---


## 06. Courriers Arrivés (`/App/Controle`)

### Rôle métier
La page « Contrôle Courriers » est l'écran de **contrôle / validation des courriers arrivés** destiné à l'utilisateur courant en tant que **destinataire** du courrier (`Mail.DestinataireExpediteur == UserId`). Elle liste, en lecture, les courriers qui lui sont adressés et qui **ne sont pas encore validés** (`Mail.Valider == false`) — c'est-à-dire encore « en attente de contrôle ». Le compteur de menu (badge `controle`) affiche le nombre de ces courriers. Depuis chaque ligne, l'utilisateur ouvre le courrier dans la page de détail `MailViewer` (lien `Action=control`) où il effectue l'acte de contrôle ; la validation bascule le drapeau `Mail.Valider` à `true`, déclenche l'envoi d'une notification d'imputation principale au rôle destinataire, vide le cache `MailsCache` et fait diminuer le badge. La grille de `/App/Controle` elle-même est **strictement une liste** : sa colonne d'action est vide (`display:none`) et aucun bouton contrôler/rejeter n'y est câblé (voir « Règles de gestion » pour les écarts constatés dans le code). Le classement des privilèges par rôle (entité `MailControle`, enum `Privileges`) est défini côté paramétrage et exposé par `MailControlesAppService.GetUserMailControle`, mais aucun appel de ce contrôle de privilège n'a été trouvé dans le chemin de code de `/App/Controle` lui-même.

### Accès & permissions
- **Contrôleur MVC** : `ControleController` — `[Area("App")]`, `[AbpMvcAuthorize(AppPermissions.Pages_Controle_Access)]`.
  Fichier : `src/DocuPro.Web.Mvc/Areas/App/Controllers/DocuCourriers/ControleController.cs`.
- **Service applicatif** : `MailsAppService` — `[AbpAuthorize(AppPermissions.StandardUser)]`.
  Fichier : `src/DocuPro.Application/MailBase/MailsAppService.cs`.
  Service annexe des privilèges : `MailControlesAppService` — `[AbpAuthorize(AppPermissions.StandardUser)]`.
  Fichier : `src/DocuPro.Application/MailBase/MailControlesAppService.cs`.
- **Constantes de permission** (`src/DocuPro.Core.Shared/Authorization/AppPermissions.cs`) :
  - `Pages_Controle_Access` = `"Pages.Controle.Access"` (accès page ; libellé de traduction `ControleAccess`).
  - `Menus_Docu_Courriers_Controle` = `"Menus.Docu_Courriers.Controle"` (entrée de menu ; libellé `Courriers_Controle`).
  - `Menus_DocuCourriers` = `"Menus.DocuCourriers"` (menu parent ; libellé `Docucourriers`).
  - `StandardUser` = `"StandardUser"` (garde du service).
  Déclaration de l'arbre de permissions : `src/DocuPro.Core/Authorization/AppAuthorizationProvider.cs` (`controle.CreateChildPermission(AppPermissions.Pages_Controle_Access, L("ControleAccess"))` ligne 412 ; `docucourriers.CreateChildPermission(AppPermissions.Menus_Docu_Courriers_Controle, L("Courriers_Controle"))` ligne 60).
- **Entrée de menu** (`src/DocuPro.Web.Mvc/Areas/App/Startup/AppNavigationProvider.cs`, lignes 139-146) :
  - Nom : `AppPageNames.Common.Controle`, libellé `L("Controle")`, url `App/Controle`, icône `bi bi-shield-check`.
  - Dépendance de permission (requiert **les deux**) : `SimplePermissionDependency(AppPermissions.Pages_Controle_Access, AppPermissions.Menus_Docu_Courriers_Controle)`.
  - Badge : `customData: new { badgeKey = "controle" }`. Valeur calculée par `MenuBadgeAppService.GetControleCountAsync` (`src/DocuPro.Application/Services/MenuBadgeAppService.cs`).
- **Multi-tenant** : `Mail` et `MailControle` implémentent `IMayHaveTenant` (filtre ABP `MayHaveTenant` actif par défaut). Aucune désactivation de filtre tenant (`DisableFilter`) n'est présente dans le code lu pour cette page.

### Interface utilisateur
- **Page Razor** : `src/DocuPro.Web.Mvc/Areas/App/Views/Controle/Index.cshtml`.
- **Script** : `src/DocuPro.Web.Mvc/wwwroot/js/controle.js` (référencé en bas de la vue : `<script src="~/js/controle.js">`).
- **Titre affiché** : « Contrôle Courriers ». **Sous-titre** : `@L("CourrierControle")`.
- **Composants** : grille Syncfusion EJ2 (`<ejs-grid id="Grid">`), zone de recherche (`<ejs-textbox id="search">`), pagination personnalisée (`<ul id="itemList">`, `<div id="total">`) et sélecteur de taille de page (`<ejs-dropdownlist id="sizer">`, valeurs `[5,10,15,20,50]`). NB : la vue déclare `@model List<DocumentViewModel>` mais le contrôleur ne passe pas de modèle à `View()` (les données sont chargées en AJAX via `LoadData`).

#### Filtres / recherche
| Libellé | Propriété (input → DTO) | Type de contrôle | Source / comportement serveur |
|---|---|---|---|
| Recherche (`@L("Recherche")`) | `search` → `GetAllMailsInput.Search` | `ejs-textbox` (event `change="onSearch"`) | `onSearch` appelle `loadData(...)` → `GET /App/Controle/LoadData?search=…`. Côté service `GetAllnonValider`, recherche insensible à la casse sur `Mail.Title`, `Mail.Description`, `Mail.Reference` et `ExternalEntityFk.Name`. |
| Items / Page | `sizer` → `pageSize` → `GetAllMailsInput.MaxResultCount` | `ejs-dropdownlist` (`[5,10,15,20,50]`, event `change="onChange"`) | `onChange` relance `loadData` avec la nouvelle taille (recalcul `SkipCount`). |
| Tri de colonne | `sorting` / `order` → `GetAllMailsInput.Sorting` / `SortDirection` | En-têtes de grille (`allowSorting="true"`, event `actionComplete="onActionComplete"`) | `onActionComplete` mappe la colonne et la direction (`Descending`→`desc`) puis relance `loadData`. Tri serveur géré sur `Title`, `Date`, `Description`, `Reference`, `MailType`, `MailStatus`, `ExternalEntityName` (défaut : `Id`). |
| Pagination (numéros de page) | `pageNumber` → `GetAllMailsInput.SkipCount` (`(pageNumber-1)*pageSize`) | `<ul id="itemList">` généré par `buildPaging`, clic `changePage(i)` | Recharge la page demandée via `loadData`. |

#### Colonnes du tableau
Colonnes déclarées dans `Index.cshtml` (`<e-grid-columns>`) ; chaque cellule (hors action) est un lien vers `/App/MailViewer/Index?Action=control&MailId=${Mail.Id}`.

| Libellé | Propriété (`field`) | DTO / colonne source | Type |
|---|---|---|---|
| (sans en-tête) Action | template `#DocumentAction` (`width="0"`, contenu vide `display:none`) | — (aucune donnée) | Template vide (aucun bouton rendu) |
| Objet (`@L("Objet")`) | `Mail.Title` (template `#objetTemplate`) | `GetMailForViewDto.Mail.Title` (`MailDto.Title`) → table `Mails.Title` | Texte (lien) |
| Expéditeur (`@L("Expediteur")`) | `ExternalEntityName` (template `#expediteurTemplate`) | `GetMailForViewDto.ExternalEntityName` (via `ExternalEntityFk.Name`) → `ExternalEntities.Name` | Texte (lien) |
| Références (`@L("References")`) | `Mail.Reference` (template `#referencesTemplate`) | `GetMailForViewDto.Mail.Reference` (`MailDto.Reference`) → `Mails.Reference` | Texte (lien) |
| Date (`@L("Date")`) | `Mail.Date` (template `#dateTemplate`) | `GetMailForViewDto.Mail.Date` (`MailDto.Date`) → `Mails.Date` | Date `dd/MM/yyyy` (formatée client par `convertirFormatDate`) |
| Statut (`@L("Statut")`) | `Status` — **colonne commentée** dans la vue | Non stocké : injecté côté JS `Status = "En attente de contrôle"` dans `loadData` | Badge (non rendu, colonne désactivée) |

#### Actions (boutons)
| Bouton / élément | Effet (endpoint / JS) | Permission |
|---|---|---|
| Clic sur une cellule (Objet / Expéditeur / Références / Date) | Navigation `GET /App/MailViewer/Index?Action=control&MailId=${Mail.Id}` (ouvre le détail du courrier pour contrôle) | Accès `MailViewer` (contrôleur `MailViewerController`, `[Area("App")]`, sans `[AbpMvcAuthorize]` de page spécifique dans le code lu) |
| `validerMail(mailId)` (fonction JS présente dans `controle.js`) | `POST /App/Controle/ValiderMail { MailId }` — **endpoint absent** de `ControleController` (voir Règles de gestion). Non relié à un bouton visible (colonne d'action vide). | `Pages_Controle_Access` (page) |
| Validation effective du contrôle | `POST /App/MailViewer/ValiderMail { MailId }` → `MailsAppService.ValiderMailControle(MailId)` | Contrôleur `MailViewerController` |

#### Formulaire(s) / Modale(s)
— (sans objet) : la page `/App/Controle` n'expose ni formulaire ni modale de saisie. La confirmation de validation est un simple `confirm()` JavaScript ; le formulaire de contrôle/imputation réel se trouve sur la page `MailViewer` (hors périmètre de ce document).

### Service applicatif & opérations
- **Interfaces** :
  - `src/DocuPro.Application.Shared/MailBase/IMailsAppService.cs` (`GetAllnonValider`, `ValiderMailControle`).
  - `src/DocuPro.Application.Shared/MailBase/IMailControlesAppService.cs` (`GetUserMailControle`, CRUD `MailControle`).
- **Implémentations** :
  - `src/DocuPro.Application/MailBase/MailsAppService.cs` (`GetAllnonValider` ligne 2952 ; `ValiderMailControle` ligne 902).
  - `src/DocuPro.Application/MailBase/MailControlesAppService.cs` (`GetUserMailControle` ligne 168).

| Méthode | Entrée (DTO) | Sortie (DTO) | Description |
|---|---|---|---|
| `GetAllnonValider` | `GetAllMailsInput` | `PagedResultDto<GetMailForViewDto>` | Liste paginée des courriers du destinataire courant non validés. Filtres : `MailStatus != Redaction || MailType == Arrivée`, `Valider == false`, `DestinataireExpediteur == UserId`. Include `ConfidentialitesFk`, `MailParentFk`, `ExternalEntityFk`. Recherche/tri/pagination en mémoire. Résultat **mis en cache** (`MailsCache`, clé par utilisateur + filtres + date du jour). Renvoie une page vide si aucun `UserId`. |
| `ValiderMailControle` | `int MailId` | `Task` (void) | Charge le `Mail`, positionne `Valider = true`, `UpdateAsync`, envoie la notification d'imputation principale (`EnvoyerNotificationImputationPrincipaleApresValidation`), puis vide le cache `MailsCache`. Lève `UserFriendlyException("Mail not found.")` si introuvable. |
| `GetUserMailControle` | `long userId` | `Task<int>` | Retourne le privilège **le plus élevé** (`Max`) parmi les rôles de l'utilisateur d'après la table `MailControles` (`(int)Priviledges`). Retourne `-1` si l'utilisateur n'a aucun rôle ou aucun privilège associé. (Enum `Privileges`.) |
| `GetControleCountAsync` | — (session) | `Task<int>` | (Service `MenuBadgeAppService`.) Compte les courriers avec le même filtre que `GetAllnonValider` (`(MailStatus != Redaction || MailType == Arrivée) && Valider == false && DestinataireExpediteur == UserId`) → valeur du badge `controle`. |

**Actions MVC du contrôleur** `ControleController` :
| Action | Signature | Renvoie |
|---|---|---|
| `Index` | `Task<IActionResult> Index()` | Vue `Index.cshtml`. Pré-charge `GetAllnonValider` (page 1, 10 items, tri `Id desc`) et place `ViewBag.TotalCount` + `ViewBag.DataSource` (liste de `MailViewModel`). |
| `LoadData` | `[HttpGet] Task<IActionResult> LoadData(int pageSize=10, int pageNumber=1, string sorting="Id", string sortDirection="desc", string search="")` | `Json(ListOfMailsJsonResponse{ DataSource: List<GetMailForViewDto>, TotalCount, PageSize, PageNumber, Search })`. Construit `GetAllMailsInput` (`SkipCount=(pageNumber-1)*pageSize`) et appelle `GetAllnonValider`. |

> Le contrôleur `ControleController` ne définit **que** `Index` et `LoadData`. Le POST de validation est porté par `MailViewerController.ValiderMail(int MailId)` (`src/DocuPro.Web.Mvc/Areas/App/Controllers/DocuCourriers/MailViewerController.cs`, ligne 142) : appelle `ValiderMailControle`, journalise via `_customAuditLogsesAppService.AddLog(details, MailId, UserId, 1019, 1)`, et renvoie `Json{ success, redirectUrl (App/Controle), triggerBadgeUpdate=true }`.

### DTOs

**`GetAllMailsInput`** (entrée) — `src/DocuPro.Application.Shared/MailBase/Dtos/GetAllMailsInput.cs`, hérite `PagedAndSortedResultRequestDto`.
| Propriété | Type C# | Obligatoire | Description |
|---|---|---|---|
| `MaxResultCount` | `int` (hérité) | non | Taille de page (mappé depuis `pageSize`). |
| `SkipCount` | `int` (hérité) | non | Décalage (`(pageNumber-1)*pageSize`). |
| `Sorting` | `string` (hérité) | non | Colonne de tri. |
| `Search` | `string` | non | Terme de recherche (utilisé par la page). |
| `Filter` | `string` | non | Renseigné à `""` par le contrôleur (non exploité par `GetAllnonValider`). |
| `TitleFilter` | `string` | non | Non utilisé par cette page. |
| `SortDirection` | `string` | non | `asc`/`desc` (utilisé par la page). |
| `MaxDateFilter` | `DateTime?` | non | Non utilisé par cette page. |
| `MinDateFilter` | `DateTime?` | non | Non utilisé par cette page. |
| `DescriptionFilter` | `string` | non | Non utilisé par cette page. |
| `NReferenceFilter` | `string` | non | Non utilisé par cette page. |
| `MailTypeFilter` | `int?` | non | Non renseigné par cette page (défaut `Arrivée`/0 si null dans le service). |
| `UserId` | `int` | non | Non utilisé par cette page (le service utilise `AbpSession.UserId`). |
| `MailStatusFilter` | `int?` | non | Non renseigné par cette page. |
| `ReferenceFilter` | `string` | non | Non utilisé par cette page. |
| `ConfidentialitesNameFilter` | `string` | non | Non utilisé par cette page. |
| `MailDisplayPropertyFilter` | `string` | non | Non utilisé par cette page. |
| `ExternalEntityNameFilter` | `string` | non | Non utilisé par cette page. |

**`GetMailForViewDto`** (sortie) — `src/DocuPro.Application.Shared/MailBase/Dtos/GetMailForViewDto.cs`. (★ = renseigné par `GetAllnonValider`.)
| Propriété | Type C# | Obligatoire | Description |
|---|---|---|---|
| `Mail` ★ | `MailDto` | non | Sous-DTO courrier (voir ci-dessous). |
| `ConfidentialitesName` ★ | `string` | non | `Mail.ConfidentialitesFk.Name` (ou `""`). |
| `MailDisplayProperty` ★ | `string` | non | Formaté `"{Reference} {Title}"` du courrier parent (`MailParentFk`). |
| `DateEnregistrementCourrier` | `DateTime?` | non | Non renseigné par cette page. |
| `CreationTime` | `DateTime` | non | Non renseigné par cette page. |
| `ExternalEntityName` ★ | `string` | non | `Mail.ExternalEntityFk.Name` (ou `""`) — colonne « Expéditeur ». |
| `MailTypeName` | `string` | non | Non renseigné par cette page. |
| `MailNature` | `string` | non | Non renseigné par cette page. |
| `LongDescription` | `string` | non | Non renseigné par cette page. |
| `Description` | `string` | non | Non renseigné par cette page (la description est dans `Mail.Description`). |
| `Direction` | `string` | non | Non renseigné par cette page. |
| `MailObjet` | `string` | non | Non renseigné par cette page. |
| `Statut` | `string` | non | Non renseigné par cette page (le statut « En attente de contrôle » est injecté côté JS sous la clé `Status`). |
| `LastImputationFullName` | `string` | non | Non renseigné par cette page. |
| `DateRapel` | `DateTime?` | non | Non renseigné par cette page. |
| `UserCreated` | `string` | non | Non renseigné par cette page. |
| `DateDecharge` | `DateTime?` | non | Non renseigné par cette page. |
| `DestinataireFullName` | `string` | non | Non renseigné par cette page. |
| `DestinataireExpediteurId` | `long` | non | Non renseigné par cette page. |
| `InputationTypeName` | `string` | non | Non renseigné par cette page. |
| `Deadline` | `DateTime?` | non | Non renseigné par cette page. |

**`MailDto`** (sous-DTO de `GetMailForViewDto.Mail`) — `src/DocuPro.Application.Shared/MailBase/Dtos/MailDto.cs`, hérite `EntityDto`. (★ = renseigné par `GetAllnonValider`.)
| Propriété | Type C# | Obligatoire | Description |
|---|---|---|---|
| `Id` ★ | `int` (hérité `EntityDto`) | non | Id du courrier (utilisé dans les liens `MailId`). |
| `Title` ★ | `string` | non | Objet du courrier → `Mails.Title`. |
| `Date` ★ | `DateTime` | non | Date du courrier → `Mails.Date`. |
| `DateFollowUp` | `DateTime?` | non | Non renseigné par cette page. |
| `DateReglementaire` | `DateTime?` | non | Non renseigné par cette page (pas de colonne `Mail` équivalente lue ici). |
| `Description` ★ | `string` | non | Description → `Mails.Description`. |
| `NReference` ★ | `string` | non | → `Mails.NReference`. |
| `MailType` ★ | `MailType` (enum) | non | → `Mails.MailType`. |
| `MailStatus` ★ | `MailStatus` (enum) | non | → `Mails.MailStatus`. |
| `Reference` ★ | `string` | non | Référence → `Mails.Reference`. |
| `ConfidentialitesId` | `int?` | non | Non renseigné dans la projection de cette page. |
| `MailParent` | `int?` | non | Non renseigné dans la projection de cette page. |
| `ExternalEntityId` | `int?` | non | Non renseigné dans la projection de cette page. |
| `MailObjetId` | `int?` | non | Non renseigné dans la projection de cette page. |
| `MailNatureId` | `int?` | non | Non renseigné dans la projection de cette page. |
| `DestinataireExpediteur` | `long` | non | Non renseigné dans la projection (sert de filtre serveur). |
| `DateTraited` | `DateTime?` | non | Non renseigné dans la projection de cette page. |
| `DateDecharge` | `DateTime?` | non | Non renseigné dans la projection de cette page. |
| `DateEnregistrementCourrier` | `DateTime?` | non | Non renseigné dans la projection de cette page. |

**`MailControleDto`** — `src/DocuPro.Application.Shared/MailBase/Dtos/MailControleDto.cs`, hérite `EntityDto`.
| Propriété | Type C# | Obligatoire | Description |
|---|---|---|---|
| `Id` | `int` (hérité) | non | Id de la ligne `MailControle`. |
| `RoleId` | `long?` | non | Rôle associé au privilège. |
| `Priviledges` | `Privileges` (enum, défaut `None`) | non | Niveau de privilège de contrôle. |

**`GetMailControleForViewDto`** — `src/DocuPro.Application.Shared/MailBase/Dtos/GetMailControleForViewDto.cs`.
| Propriété | Type C# | Obligatoire | Description |
|---|---|---|---|
| `MailControle` | `MailControleDto` | non | Ligne de privilège. |
| `RoleName` | `string` | non | Nom du rôle (`RoleFk.Name`). |

**`CreateOrEditMailControleDto`** — `src/DocuPro.Application.Shared/MailBase/Dtos/CreateOrEditMailControleDto.cs`, hérite `EntityDto<int?>`.
| Propriété | Type C# | Obligatoire | Description |
|---|---|---|---|
| `Id` | `int?` (hérité) | non | `null` = création, sinon édition. |
| `UserId` | `long?` | non | Identifiant (rôle/utilisateur) associé. |

**`GetAllMailControlesInput`** — `src/DocuPro.Application.Shared/MailBase/Dtos/GetAllMailControlesInput.cs`, hérite `PagedAndSortedResultRequestDto`. (Le fichier déclare la classe **deux fois** — une dans le namespace `DocuPro.MailBase.Dtos`, une hors namespace ; propriétés identiques.)
| Propriété | Type C# | Obligatoire | Description |
|---|---|---|---|
| `MaxResultCount` / `SkipCount` / `Sorting` | (hérités) | non | Pagination / tri. |
| `Filter` | `string` | non | Filtre générique (non exploité : `WhereIf(... , e => false)`). |
| `RoleNameFilter` | `string` | non | Filtre sur `RoleFk.Name`. |

> DTOs de contrôle **non utilisés directement par `/App/Controle`** mais liés à l'entité `MailControle` : `GetMailControleForEditOutput`, `GetAllMailControlesForExcelInput`, `MailControleUserLookupTableDto` (fichiers dans `src/DocuPro.Application.Shared/MailBase/Dtos/`).

### Tables & colonnes impactées

**Table `Mails`** — `[Table("Mails")]`, entité `Mail` (`src/DocuPro.Core/MailBase/Mail.cs`), base `FullAuditedEntity`, interfaces `IMayHaveTenant`, `[Audited]`. DbSet dans `DocuProDbContext`.
| Table | Colonne | Type SQL/CLR | Lecture / Écriture (par cette page) |
|---|---|---|---|
| Mails | `Id` | int (PK) | Lecture (lien `MailId`) |
| Mails | `Title` | nvarchar (`string`, Required) | Lecture (colonne Objet ; recherche) |
| Mails | `Date` | datetime (`DateTime`, Required) | Lecture (colonne Date ; tri) |
| Mails | `Description` | nvarchar (`string`) | Lecture (recherche) |
| Mails | `Reference` | nvarchar (`string`) | Lecture (colonne Références ; recherche ; tri) |
| Mails | `NReference` | nvarchar (`string`) | Lecture (projeté dans `MailDto`) |
| Mails | `MailType` | int (enum `MailType`) | Lecture (filtre `== Arrivée` ; tri) |
| Mails | `MailStatus` | int (enum `MailStatus`) | Lecture (filtre `!= Redaction` ; tri) |
| Mails | `DestinataireExpediteur` | bigint (`long`, FK User) | Lecture (**filtre** `== UserId`) |
| Mails | `ConfidentialitesId` | int? (FK) | Lecture (jointure `Include` → `ConfidentialitesName`) |
| Mails | `ExternalEntityId` | int (FK) | Lecture (jointure `Include` → `ExternalEntityName` ; tri) |
| Mails | `MailParent` | int? (FK auto-réf.) | Lecture (jointure `Include` → `MailDisplayProperty`) |
| Mails | `Valider` | bit (`bool`, défaut false) | **Filtre** (`== false`) en lecture ; **Écriture** `= true` lors de la validation (`ValiderMailControle`, via `MailViewer`) |
| Mails | `DateButoire` | datetime? | Lecture indirecte (passée à la notification d'imputation lors de la validation) |
| Mails | audit (`CreationTime`, `CreatorUserId`, `LastModificationTime`, `LastModifierUserId`, `IsDeleted`…) | — | Écriture implicite ABP lors de l'`UpdateAsync` de validation |

**Tables de référence / lookup lues (jointures dans `GetAllnonValider`)**
| Table | Colonne | Type | Lecture / Écriture |
|---|---|---|---|
| `ExternalEntities` (entité `ExternalEntity`, via `Mails.ExternalEntityId`) | `Name` | nvarchar | Lecture (colonne « Expéditeur » = `ExternalEntityName` ; recherche ; tri) |
| `Confidentialites` (via `Mails.ConfidentialitesId`) | `Name` | nvarchar | Lecture (`ConfidentialitesName`) |
| `Mails` (auto-réf. via `MailParent`) | `Title`, `Reference` | nvarchar | Lecture (`MailDisplayProperty`) |

**Table `MailControles`** — `[Table("MailControles")]`, entité `MailControle` (`src/DocuPro.Core/MailBase/MailControle.cs`), base `FullAuditedEntity`, interface `IMayHaveTenant`. Lue par `GetUserMailControle` (résolution des privilèges par rôle) ; **non écrite** par `/App/Controle`.
| Table | Colonne | Type SQL/CLR | Lecture / Écriture |
|---|---|---|---|
| MailControles | `Id` | int (PK) | Lecture |
| MailControles | `TenantId` | int? | (filtre tenant) |
| MailControles | `RoleId` | int? (FK `Role`) | Lecture (jointure sur les rôles de l'utilisateur) |
| MailControles | `Priviledges` | int (enum `Privileges`, défaut entité = `FullControl`) | Lecture (`Max` des privilèges de l'utilisateur) |
| MailControles | audit (`CreationTime`, `CreatorUserId`…) | — | Non touché par cette page |
| `AbpRoles` (entité `Role`, via `RoleId`) | `Name` | nvarchar | Lecture (dans `MailControlesAppService.GetAll`, hors page Controle) |

### Règles de gestion / effets de bord / transitions de statut
- **Filtre métier de la liste** (`GetAllnonValider`) : un courrier apparaît si `(MailStatus != Redaction OU MailType == Arrivée)` **ET** `Valider == false` **ET** `DestinataireExpediteur == UserId`. Le même prédicat sert au compteur de badge `controle` (`MenuBadgeAppService.GetControleCountAsync`).
- **Transition de statut / bascule de drapeau** : l'acte de contrôle appelle `ValiderMailControle(MailId)` qui positionne **`Mail.Valider = true`**. Aucune autre transition n'est faite ici : `MailStatus` **n'est pas modifié**, et les drapeaux `ValidationDirection`, `ValidationDG`, `EnregistrementReponse`, `Decharge` ne sont **pas** touchés par cette page. Aucune date (`DateEnregistrementCourrier`, `DateFollowUp`, `DateDecharge`, `DateTraited`, `DateButoire`) n'est positionnée par la validation de contrôle.
- **Effet de bord — notification** : après `Valider = true`, `EnvoyerNotificationImputationPrincipaleApresValidation` récupère le premier rôle du destinataire (`GetDestinataireRoleName`) et envoie `_appNotifier.MailImputationPrincipaleAsync(mail.Id, roleName, mail.Title, mail.DateButoire, UserId)`. Les erreurs de notification sont capturées (log `Warn`/`Error`) sans bloquer la validation.
- **Effet de bord — cache** : `ValiderMailControle` vide le cache `MailsCache` (`cache.ClearAsync()`). `GetAllnonValider` met en cache le résultat sous une clé incluant l'utilisateur, les filtres et **la date du jour** (`DateTime.Now.Date`) ; la liste se rafraîchit donc au changement de jour ou à l'invalidation du cache.
- **Effet de bord — journal d'audit** : le POST `MailViewer/ValiderMail` ajoute un log applicatif via `_customAuditLogsesAppService.AddLog("Contrôle du courrier effectué", MailId, UserId, 1019, 1)`. L'entité `Mail` étant `[Audited]`, l'`UpdateAsync` génère aussi une entrée d'audit ABP.
- **Mise à jour du badge** : après succès, la réponse porte `triggerBadgeUpdate=true` ; `controle.js` appelle `window.KTMenuBadges.forceUpdate()` et diffuse un `CustomEvent('mail-validated', { mailId, action:'controle' })`, ce qui recharge la grille et met à jour le compteur.
- **Privilèges (`enum Privileges`)** — `src/DocuPro.Core.Shared/Helpers/Enums.cs` (attention : les descriptions sont contre-intuitives) :
  `None`(0, `[Description("Controle Courrier")]`), `Read`(1, `[Description("ValidationDG")]`), `Admin`(2, `[Description("Signature")]`), `FullControl`(3, `[Description("Contrôle total")]`). `GetUserMailControle` renvoie le **maximum** de `(int)Priviledges` sur les rôles de l'utilisateur (via `MailControles`), ou `-1` si aucun rôle/privilège. Défaut de l'entité `MailControle.Priviledges` = `FullControl` ; défaut du DTO `MailControleDto.Priviledges` = `None`. **Aucun appel à `GetUserMailControle` n'a été trouvé dans le chemin de `/App/Controle`** (contrôleur/service de listing) : le gardiennage effectif de la page repose sur `Pages_Controle_Access` + `Menus_Docu_Courriers_Controle`.
- **Écarts constatés dans le code (à ne pas confondre avec un fonctionnement réel)** :
  - `controle.js` définit `validerMail(mailId)` qui fait `POST /App/Controle/ValiderMail`, **mais `ControleController` ne déclare aucune action `ValiderMail`** (seulement `Index` et `LoadData`) : cet appel renverrait 404. L'endpoint réellement existant est `POST /App/MailViewer/ValiderMail` (contrôleur `MailViewerController`).
  - La colonne d'action de la grille (`template #DocumentAction`) est **vide et masquée** (`display:none`, `width="0"`) : `validerMail` n'est **relié à aucun bouton** de la page. La validation se déclenche donc en pratique depuis la page de détail `MailViewer` ouverte via les liens de cellule (`Action=control`).
  - La colonne « Statut » est **commentée** dans la vue ; le libellé « En attente de contrôle » est purement cosmétique (injecté côté client sous la clé `Status`).
  - Aucune action **« rejeter »** de courrier n'existe dans les sources lues pour cette page.
  - **Tri d'en-tête partiellement inopérant** : les colonnes triables Objet, Références et Date déclarent les `field` `Mail.Title`, `Mail.Reference`, `Mail.Date` (préfixe `Mail.`). Or le `switch (input.Sorting)` de `GetAllnonValider` n'expose que des clés **non préfixées** (`Title`, `Date`, `Description`, `Reference`, `MailType`, `MailStatus`, `ExternalEntityName`) sans retrait du préfixe. `controle.js` renvoyant `sorting = args.columnName`, un clic sur ces trois en-têtes envoie `Mail.Title`/`Mail.Reference`/`Mail.Date`, non reconnus → **retombée sur le tri par défaut `Id`**. Seul le tri par la colonne Expéditeur (`ExternalEntityName`) correspond à une clé gérée par le service. (NB : la méthode utilitaire `GetSortedQuery` lignes 880-898 gère bien les deux formes `Mail.Title`/`Title`, mais elle n'est **pas** appelée par `GetAllnonValider`.)
- **Idempotence** : re-valider un courrier déjà `Valider == true` reste sans effet fonctionnel visible (il ne figure de toute façon plus dans la liste, filtrée sur `Valider == false`), mais `ValiderMailControle` réécrirait `true` et renverrait une notification.
- **Multi-tenant** : filtre `MayHaveTenant` actif (aucune désactivation trouvée) ; les compteurs et listes sont donc implicitement bornés au tenant courant.


---


## 07. Documents scannés (`/App/DocumentsScannes`)

### Rôle métier
Écran d'entrée du flux courrier : il liste les fichiers numérisés déposés automatiquement sur le serveur par le service Windows de scan (poste client / dossier surveillé) et qui ne sont **pas encore enregistrés** comme courrier. L'agent du courrier consulte chaque fichier (aperçu dans une popup) puis le transforme en courrier via l'une des trois portes d'entrée : « Enregistrer le courrier » (courrier arrivée), « Courrier départ » ou « Décharge ». Une fois transformé, le document est marqué comme traité (`IsTraite = true`) et disparaît de la liste. L'écran lui-même est en lecture seule : il ne crée/édite aucune donnée, il oriente vers les autres écrans qui, eux, réalisent l'enregistrement.

### Accès & permissions
- Contrôleur MVC protégé par `[AbpMvcAuthorize(AppPermissions.Menus_Docu_Courriers_DocumentsScannes)]`.
- Service applicatif protégé par `[AbpAuthorize(AppPermissions.Menus_Docu_Courriers_DocumentsScannes)]`.
- Constante : `Menus_Docu_Courriers_DocumentsScannes = "Menus.Docu_Courriers.DocumentsScannes"` (déclarée dans `AppAuthorizationProvider` comme enfant de `docucourriers`, libellé de traduction `Courriers_DocumentsScannes`).
- Menu : entrée `DocumentsScannes` (icône `bi bi-file-earmark-arrow-up`, url `App/DocumentsScannes`), dépendance de permission simple sur `Menus_Docu_Courriers_DocumentsScannes`. **Aucun badge** n'est attaché à cet item (pas de `customData`).
- Particularité multi-tenant : le filtre ABP `MayHaveTenant` est **désactivé** dans toutes les lectures du service — les documents du host et du tenant courant sont visibles.

### Interface utilisateur
Page Razor : `src/DocuPro.Web.Mvc/Areas/App/Views/DocumentsScannes/Index.cshtml` (grille Syncfusion `ejs-grid`).
Script : `src/DocuPro.Web.Mvc/wwwroot/js/documents-scannes.js`.
Titre de page : **« Documents scannés »**, sous-titre : « Documents déposés par le service (poste client). Consultez puis enregistrez comme courrier. »

#### Filtres / recherche
| Libellé | Propriété | Type | Source |
|---|---|---|---|
| Recherche | `search` → `input.Filter` | Zone de texte (`ejs-textbox`, event `change="onSearch"`) | Saisie libre. Côté serveur : `FileName.Contains(filtre)` **OU** `MachineName.Contains(filtre)`. |
| (implicite, non affiché) | `IsTraiteFilter` | Booléen forcé | Le contrôleur force `IsTraiteFilter = false` → seuls les documents **non traités** sont listés. |

#### Colonnes du tableau
| Libellé | Propriété (`field` / `data:`) | Type |
|---|---|---|
| Fichier | `fileName` (template `#fichierTemplate`, largeur 280) | Texte (nom du fichier, fallback `-`) |
| Date dépôt | `dateScanned` (template `#dateTemplate`, affiche `dateScannedFormatted`, largeur 150) | Date/heure formatée `jj/mm/aaaa hh:mm` (formatage JS `formatDate`) |
| Poste client | `machineName` (template `#posteTemplate`, largeur 150) | **Colonne commentée / désactivée** dans le `.cshtml` (non affichée ; la donnée `machineName` reste chargée côté JS) |
| (sans en-tête) Actions | template `#actionsTemplate`, largeur 420, `allowSorting=false` | Boutons d'action (voir ci-dessous) |

- Tri activé (`allowSorting`), tri par défaut `DateScanned desc` ; le tri déclenche `onActionComplete` → recharge `LoadData`.
- Pagination personnalisée (hors pagination native) : liste `#itemList`, sélecteur de taille `ejs-dropdownlist #sizer` avec valeurs **5, 10, 15, 20, 50** (défaut effectif 10 au premier chargement, `pageSize=20` déclaré sur la grille), compteur « Total : N document(s) ».

#### Actions (boutons)
| Bouton | Effet | Permission |
|---|---|---|
| Consulter | `onclick="openViewDocument(id)"` → charge `App/DocumentsScannes/ViewDocument?id={id}` dans l'`iframe` de la modale `#viewDocumentModal` (aperçu **inline**, pas de téléchargement). | `Menus_Docu_Courriers_DocumentsScannes` |
| Enregistrer le courrier | Lien vers `/App/AddMail?documentScanneId={id}` (écran d'enregistrement courrier arrivée). | Écran cible `AddMail` |
| Courrier départ | Lien vers `/App/CourrierDepart?documentScanneId={id}`. | Écran cible `CourrierDepart` |
| Décharge | Lien vers `/App/IntegrationDecharge?documentScanneId={id}`. | Écran cible `IntegrationDecharge` |

> Les trois derniers boutons ne réalisent aucune opération sur cet écran : ils passent l'`id` du document scanné en paramètre d'URL à l'écran cible, lequel appellera `MarkAsProcessed` à la fin de son propre enregistrement.

#### Formulaire(s) / Modale(s)
**Aucune modale de création/édition (pas de `_CreateOrEditModal`, pas de DTO `CreateOrEdit`).** L'écran est en lecture seule.

Modale unique — `#viewDocumentModal` (aperçu du document) :
| Champ | Propriété DTO | Type | Obligatoire | Source/valeurs |
|---|---|---|---|---|
| Aperçu du fichier | (aucune — flux binaire) | `<iframe>` (modal-xl, hauteur 70vh) | — | `ViewDocument(id)` : lit `FilePath`, ouvre un `FileStream` et le renvoie en `inline` avec le `Content-Type` déduit de l'extension. |

Types MIME gérés par `GetContentType` : `.pdf` → application/pdf ; `.jpg`/`.jpeg` → image/jpeg ; `.png` → image/png ; `.tiff`/`.tif` → image/tiff ; `.bmp` → image/bmp ; sinon `application/octet-stream`.

### Service applicatif & opérations
Interface : `DocuPro.DocumentBase.IDocumentScannesAppService` — implémentation `DocumentScannesAppService` (repository `IRepository<DocumentScanne, int>`).

| Méthode | Entrée (DTO) | Sortie (DTO) | Description |
|---|---|---|---|
| `GetPagedList` | `GetAllDocumentScannesInput` | `PagedResultDto<GetDocumentScanneForViewDto>` | Liste paginée/triée/filtrée. Filtre tenant `MayHaveTenant` désactivé. Applique `IsTraiteFilter` si non nul, et le filtre texte sur `FileName`/`MachineName`. Tri par défaut `DateScanned desc`. Utilisée par l'action MVC `LoadData`. |
| `GetForView` | `int id` | `GetDocumentScanneForViewDto` | Renvoie un document scanné par id (ou `null`). Non utilisée directement par cet écran (fournie pour réutilisation). |
| `GetFilePath` | `int id` | `string` | Renvoie le `FilePath` physique du document. Utilisée par l'action MVC `ViewDocument` pour streamer le fichier. |
| `MarkAsProcessed` | `int id, int mailId, int documentId` | `Task` (void) | Marque le document comme traité : `IsTraite = true`, renseigne `MailId` et `DocumentId`, puis `UpdateAsync`. **Appelée par les écrans cibles** (AddMail / CourrierDepart / IntegrationDecharge) après création du courrier, pas depuis cet écran. |

Actions MVC du contrôleur `DocumentsScannesController` :
- `Index()` → renvoie la vue `Index.cshtml`.
- `LoadData(pageNumber=1, pageSize=10, sorting="DateScanned", sortDirection="desc", search="")` → construit `GetAllDocumentScannesInput` (`SkipCount = (pageNumber-1)*pageSize`, `MaxResultCount = pageSize`, `Sorting = sorting + " " + sortDirection`, `Filter = search`, `IsTraiteFilter = false`) et renvoie un JSON `{ DataSource, TotalCount, PageSize, PageNumber, Search }`.
- `ViewDocument(id)` → `GetFilePath` puis `FileStreamResult` inline ; renvoie `NotFound()` si chemin vide ou fichier absent.

### DTOs

**`GetAllDocumentScannesInput`** (hérite de `PagedAndSortedResultRequestDto`)
| Propriété | Type C# | Obligatoire | Description |
|---|---|---|---|
| `SkipCount` | `int` (hérité) | Non | Nombre d'éléments à sauter (pagination). |
| `MaxResultCount` | `int` (hérité) | Non | Taille de page. |
| `Sorting` | `string` (hérité) | Non | Clause de tri dynamique (ex. `DateScanned desc`). |
| `IsTraiteFilter` | `bool?` | Non | Filtre sur l'état traité/non traité (forcé à `false` par le contrôleur). |
| `Filter` | `string` | Non | Texte de recherche sur `FileName`/`MachineName`. |

**`GetDocumentScanneForViewDto`**
| Propriété | Type C# | Obligatoire | Description |
|---|---|---|---|
| `Id` | `int` | — | Identifiant du document scanné. |
| `FileName` | `string` | Non | Nom du fichier (ex. `Document.pdf`). |
| `DateScanned` | `DateTime` | — | Date/heure de dépôt. |
| `MachineName` | `string` | Non | Nom du poste client émetteur. |
| `IsTraite` | `bool` | — | `true` si déjà enregistré comme courrier. |
| `MailId` | `int?` | Non | Id du courrier créé lors de l'enregistrement. |
| `DocumentId` | `int?` | Non | Id du document créé lors de l'enregistrement. |

> Aucun attribut `[Required]` n'est présent sur ces DTOs (écran de lecture, pas de validation de saisie).

### Tables & colonnes impactées
Table : `[Table("DocumentScannes")]` — entité `DocumentScanne` (`CreationAuditedEntity`, `IMayHaveTenant`). DbSet `DocumentScannes`. Index sur `TenantId` et sur `IsTraite`.

| Table | Colonne | Type | Lecture/Écriture |
|---|---|---|---|
| DocumentScannes | Id | int (PK, identity) | Lecture |
| DocumentScannes | FileName | nvarchar(max) | Lecture (grille + recherche) |
| DocumentScannes | FilePath | nvarchar(max) | Lecture (streaming aperçu `ViewDocument`) |
| DocumentScannes | DateScanned | datetime2 | Lecture (colonne + tri par défaut) |
| DocumentScannes | MachineName | nvarchar(max) | Lecture (recherche ; colonne d'affichage désactivée) |
| DocumentScannes | IsTraite | bit | Lecture (filtre `= false`) / Écriture (`MarkAsProcessed`) |
| DocumentScannes | MailId | int? | Lecture / Écriture (`MarkAsProcessed`) |
| DocumentScannes | DocumentId | int? | Lecture / Écriture (`MarkAsProcessed`) |
| DocumentScannes | TenantId | int? | Lecture (filtre désactivé mais colonne présente) |
| DocumentScannes | CreationTime | datetime2 | (audit, non exposé par l'écran) |
| DocumentScannes | CreatorUserId | bigint | (audit, non exposé par l'écran) |

> Remarque : la ligne courrier (`Mail`) et le document GED (`Document`) référencés par `MailId`/`DocumentId` sont créés par les écrans cibles (AddMail / CourrierDepart / IntegrationDecharge), pas par cet écran. Les transitions de statut courrier (MailStatus) et les drapeaux (`Valider`, `ValidationDirection`, `ValidationDG`, `EnregistrementReponse`, `Decharge`, dates `DateEnregistrementCourrier`, `DateFollowUp`, `DateDecharge`, `DateTraited`, `DateButoire`) relèvent de ces écrans et non de « Documents scannés ».

### Règles de gestion / effets de bord / transitions de statut
- La liste n'affiche que les documents **non traités** (`IsTraite = false`) : le contrôleur force `IsTraiteFilter = false`. Un document enregistré comme courrier disparaît donc automatiquement de la liste.
- Multi-tenant : le filtre ABP `MayHaveTenant` est désactivé pour `GetPagedList`, `GetForView`, `GetFilePath`, `MarkAsProcessed` → visibilité host + tenant courant sur les documents déposés par le service de scan.
- Recherche serveur : insensible au tri, applique `FileName.Contains` OU `MachineName.Contains`.
- Tri : dynamique via `System.Linq.Dynamic.Core`, valeur par défaut `DateScanned desc`.
- Aperçu (`ViewDocument`) : renvoie le fichier en **inline** (en-tête `Content-Disposition: inline; filename="..."`, nom encodé), jamais en téléchargement forcé ; `404 NotFound` si `FilePath` est vide ou si le fichier physique n'existe pas.
- `MarkAsProcessed` (appelée depuis les écrans d'enregistrement, pas depuis celui-ci) est le seul effet d'écriture sur la table : positionne `IsTraite = true` et lie le document au couple `MailId` / `DocumentId` nouvellement créés. Idempotence : si l'entité n'existe pas, la méthode retourne sans erreur.
- Cet écran ne génère aucune notification, aucun e-mail, ne modifie aucun statut de courrier et n'attribue aucun numéro/séquence : il oriente uniquement vers les écrans qui portent cette logique.
- Les fichiers de la liste sont alimentés en amont par un service Windows externe (dépôt automatique) ; l'écran est purement consommateur.


---


## 08. Courriers Imputés (Parapheur Électronique) (`/App/ParapheurElectronique`)

### Rôle métier
Cet écran est la **corbeille / boîte de réception personnelle** de l'utilisateur connecté dans le module Docu-Courriers. Il liste tous les courriers qui lui ont été **imputés** (via une `MailInputation` non encore traitée) ou dont il est le **destinataire principal** (`Mail.DestinataireExpediteur`), et qui restent **à traiter** (`DateTreated == null` / `DateTraited == null`). Il fait office de « parapheur électronique » : le point d'entrée à partir duquel l'agent consulte ses courriers en attente, chacun renvoyant vers le visualiseur de courrier (`MailViewer`) où se déroulent réellement les actions métier (traitement, ré-imputation, validation, réponse, décharge). L'écran est purement une **liste de travail (worklist) en lecture seule** : il n'écrit rien en base directement.

### Accès & permissions
- Contrôleur décoré `[Area("App")]` + `[AbpMvcAuthorize(AppPermissions.Pages_ParapheurElectronique_Access)]`.
- Permission requise : **`Pages.ParapheurElectronique.Access`** (libellé `ParapheurElectroniqueAccess`), enfant de la permission de page **`Pages.ParapheurElectronique`** (libellé `ParapheurElectronique`).
- Définies dans `src/DocuPro.Core/Authorization/AppAuthorizationProvider.cs` (lignes 431-432).
- **Entrée de menu** : `AppPageNames.Common.ParapheurElectronique`, URL `App/ParapheurElectronique`, icône `bi bi-pencil-square`, dépendance de permission (requiresAll=true) : `Pages_ParapheurElectronique_Access` **ET** `Menus_Docu_Courriers_ParapheurElectronique`.
- **Badge de menu** : `customData: new { badgeKey = "parapheur" }`. Le compteur est fourni par `MenuBadgesController` route `parapheur` → `MenuBadgeAppService.GetParapheurCountAsync()`. Ce compteur compte les courriers où `MailInputation.UserId == moi && DateTreated == null && Mail.Valider == true && Mail.EnregistrementReponse == false`, en union avec les mails où `DestinataireExpediteur == moi && DateTraited == null && Valider == true && EnregistrementReponse == false` (distinct). **Note** : le badge applique des filtres supplémentaires (`Valider == true`, `EnregistrementReponse == false`) que la liste elle-même n'applique pas — le compteur peut donc différer du nombre de lignes affichées.

### Interface utilisateur

Titre de page (fixe) : **« Docu-Courriers »** ; sous-titre localisé : `@L("ParapheurElectronique")` (« Parapheur Électronique »).
Grille Syncfusion EJ2 (`ejs-grid#Grid`), tri activé, retour à la ligne activé, pagination custom (non native EJ2) pilotée en jQuery via AJAX vers `LoadData`.

#### Filtres / recherche
| Libellé | Propriété | Type | Source |
|---|---|---|---|
| Recherche (`@L("Recherche")`) | `search` (→ `GetAllMailsInput.Search`) | Zone de texte `ejs-textbox#search`, event `onSearch` | Saisie libre. Recherche serveur (insensible à la casse) sur `Mail.Title`, `ExternalEntityFk.Name`, `DestinataireExpediteurFk.FullName`, `Mail.Reference` |

Contrôles de pagination (hors grille) :
- `ejs-dropdownlist#sizer` (valeurs `5, 10, 15, 20, 50`) → change la taille de page (`onChange` → `pageSize`).
- `ul#itemList` : boutons de page générés dynamiquement (`buildPaging`).
- `#total` : libellé « Page X of Y ( N items) ».

#### Colonnes du tableau
(Toutes les cellules sont des liens `<a href="/App/MailViewer/Index?MailId=${MailId}">` ; cliquer une cellule ouvre le visualiseur de courrier. La 1re colonne « Action » est masquée : `width="0"`, template vide.)

| Libellé (entête) | Propriété liée (`field`) | Type / affichage |
|---|---|---|
| (aucune / Action) | — (template `#DocumentAction`) | Colonne masquée, largeur 0, conteneur vide |
| Objet (`@L("Objet")`) | `Title` | Texte multi-lignes, lien vers MailViewer |
| Expediteur (`@L("Expediteur")`) | `ExternalEntityName` | Texte |
| Imputé à moi (`@L("ImputeaMoi")`) | `InputationMoiTypeName` | Badge (nom du type d'imputation, ou « Imputation principale ») |
| Date butoir (`@L("DateButoir")`) | `DateInmputeMoi` | Date/heure formatée `dd/MM/yyyy HH:mm` (badge rouge) |
| Date de traitement (`@L("DateDeTraitement")`) | `DateDeTraitementFormatted` | Date `dd/MM/yyyy` (alimentée par `Mail.DateButoire` — voir Règles) |
| Dernière imputation (`@L("DerniereImputation")`) | `LastImputationFullName` | Texte (nom complet de l'imputateur) |
| Date dernière imputation (`@L("LastImputationDate")`) | `LastImputationDate` | Date/heure `dd/MM/yyyy HH:mm` (badge bleu) |
| Références (`@L("References")`) | `VReference` | Texte monospace |
| Date courrier (`@L("DateCourrier")`) | `MailDate` | Date formatée côté JS `toLocaleDateString('fr-FR')` (badge cyan) |
| Destinataire (`@L("Destinataire")`) | `DestinataireFullName` | Texte |

> Remarque : `StatusMoi` et `StatusLast` sont calculés et renvoyés par le service mais **ne sont affichés dans aucune colonne**.

#### Actions (boutons)
| Bouton / interaction | Effet | Permission |
|---|---|---|
| Clic sur une cellule / ligne | Navigation vers `/App/MailViewer/Index?MailId={MailId}` (visualiseur du courrier, où se font traitement / imputation / validation / réponse / décharge) | `Pages_ParapheurElectronique_Access` pour voir la liste ; actions réelles gérées par MailViewer |
| Zone de recherche | Recharge la liste filtrée (AJAX `LoadData`) | idem |
| Dropdown taille de page / boutons pages | Pagination AJAX (`LoadData`) | idem |
| Tri d'en-tête de colonne | Recharge triée (AJAX, `onActionComplete`) | idem |

> **Aucun bouton d'action métier (créer / éditer / supprimer / imputer / valider / décharger / exporter) n'est présent sur cet écran.** C'est une liste de consultation ; les opérations se déclenchent dans MailViewer.

#### Formulaire(s) / Modale(s)
**Aucun.** L'écran ne contient ni modale de création/édition, ni modale de vue, ni modale de lookup. Il n'y a pas de fichier `_CreateOrEditModal.cshtml` / `_ViewModal.cshtml` pour cette vue.

### Service applicatif & opérations
Service injecté : **`IMailsAppService`** (`src/DocuPro.Application.Shared/MailBase/IMailsAppService.cs`), implémenté par `MailsAppService` (`src/DocuPro.Application/MailBase/MailsAppService.cs`).

Opérations réellement invoquées **par cet écran** :

| Méthode | Entrée (DTO) | Sortie (DTO) | Description |
|---|---|---|---|
| `GetParapheur` | `GetAllMailsInput` | `PagedResultDto<GetMailForParapheurDto>` | Liste paginée/triée/filtrée des courriers imputés à l'utilisateur (`MailInputation.UserId == UserId && DateTreated == null`) **union** des courriers dont il est destinataire (`DestinataireExpediteur == UserId && DateTraited == null`), distinct. Appelée par `Index()` et par `LoadData()`. |
| `GetParapheurCountAsync` *(MenuBadgeAppService, hors IMailsAppService)* | — (UserId de session) | `int` | Compteur du badge de menu « parapheur » (voir Accès & permissions pour les filtres additionnels). |

Actions MVC du contrôleur `ParapheurElectroniqueController` :

| Action | Verbe | Paramètres | Retour | Description |
|---|---|---|---|---|
| `Index` | GET | — (UserId de session) | Vue `Index.cshtml` (données initiales via ViewBag : `DataSource`, `TotalCount`) | Charge la 1re page (page 1, 10 lignes, tri `Id desc`). |
| `LoadData` | GET | `pageSize=10, pageNumber=1, sorting="Id", sortDirection="desc", search=""` | JSON `ListOfMailsJsonResponse` `{ DataSource, TotalCount, PageSize, PageNumber, Search }` | Alimente la grille en AJAX (recherche, tri, pagination). |

> Le reste de l'interface `IMailsAppService` (ex. `ValidationDirection`, `UpdateValidationDG`, `EnregistrementReponse`, `DechargeCourrier`, `ArchiverCourrier`, `GetParapheurDecharge`, `GetParapheurCourrierValide`, `GetCourrierValidationDG`, `CreateOrEdit`, `Delete`, etc.) concerne d'**autres écrans** du workflow parapheur (Validation, Validation DG, Décharge, Enregistrement Réponse, Suivi Courriers, Guichet Unique...) et **n'est pas appelé depuis cet écran**.

### DTOs

#### `GetAllMailsInput` (entrée) — hérite de `PagedAndSortedResultRequestDto` (fournit `SkipCount`, `MaxResultCount`, `Sorting`)
| Propriété | Type C# | Obligatoire | Description |
|---|---|---|---|
| `Search` | `string` | Non | Terme de recherche (Title / Expéditeur / Destinataire / Référence). |
| `Filter` | `string` | Non | Non utilisé par GetParapheur (passé vide). |
| `TitleFilter` | `string` | Non | Non utilisé ici. |
| `SortDirection` | `string` | Non | `"asc"` / `"desc"`. |
| `MaxDateFilter` | `DateTime?` | Non | Non utilisé ici. |
| `MinDateFilter` | `DateTime?` | Non | Non utilisé ici. |
| `DescriptionFilter` | `string` | Non | Non utilisé ici. |
| `NReferenceFilter` | `string` | Non | Non utilisé ici. |
| `MailTypeFilter` | `int?` | Non | Non utilisé ici. |
| `UserId` | `int` | Oui (de fait) | Utilisateur connecté (fixé par le contrôleur depuis `AbpSession.UserId`). Clé du filtrage imputation/destinataire. |
| `MailStatusFilter` | `int?` | Non | Non utilisé ici. |
| `ReferenceFilter` | `string` | Non | Non utilisé ici. |
| `ConfidentialitesNameFilter` | `string` | Non | Non utilisé ici. |
| `MailDisplayPropertyFilter` | `string` | Non | Non utilisé ici. |
| `ExternalEntityNameFilter` | `string` | Non | Non utilisé ici. |
| *(hérité)* `Sorting` | `string` | Non | Nom de colonne de tri. |
| *(hérité)* `SkipCount` | `int` | Non | Offset pagination. |
| *(hérité)* `MaxResultCount` | `int` | Non | Taille de page. |

#### `GetMailForParapheurDto` (sortie)
(Colonnes alimentées par `GetParapheur` marquées ✔ ; les autres restent nulles/inutilisées pour cet écran.)

| Propriété | Type C# | Obligatoire | Description |
|---|---|---|---|
| `MailId` | `int` | — | ✔ `Mail.Id`. Clé pour le lien MailViewer. |
| `Title` | `string` | — | ✔ `Mail.Title` (objet du courrier). |
| `ExternalEntityName` | `string` | — | ✔ `ExternalEntityFk.Name` (expéditeur). |
| `InputationMoiTypeName` | `string` | — | ✔ Nom du type d'imputation de l'utilisateur (`MailInputationTypeFk.Name`) ; « Imputation principale » si aucune imputation mais l'utilisateur est destinataire. |
| `DateInmputeMoi` | `string` | — | ✔ Deadline de l'imputation à l'utilisateur, formatée `dd/MM/yyyy HH:mm` (vide si null). Affichée en « Date butoir ». |
| `LastImputationFullName` | `string` | — | ✔ Nom complet du dernier imputateur (`UserFk.FullName`, dernière `MailInputation` non traitée). |
| `LastImputationDate` | `string` | — | ✔ `CreationTime` de la dernière imputation non traitée, `dd/MM/yyyy HH:mm`. |
| `MailDate` | `DateTime` | — | ✔ `Mail.Date`. |
| `DateDeTraitement` | `DateTime?` | — | ✔ Alimentée par `Mail.DateButoire` (source du champ `DateDeTraitementFormatted`). |
| `DateDeTraitementFormatted` | `string` | — | ✔ (calculé dans le contrôleur) `DateDeTraitement?.ToString("dd/MM/yyyy")` sinon `"-"`. Colonne « Date de traitement ». |
| `DestinataireFullName` | `string` | — | ✔ `DestinataireExpediteurFk.FullName`. |
| `VReference` | `string` | — | ✔ `Mail.Reference` (colonne « Références »). |
| `StatusMoi` | `string` | — | ✔ Statut calculé sur la deadline de l'utilisateur (`OnTime` / `Warning` / `Late` / `NA`). **Non affiché.** |
| `StatusLast` | `string` | — | ✔ Statut calculé sur la deadline de la dernière imputation. **Non affiché.** |
| `ConfidentialiteName` | `string` | — | Non alimenté par GetParapheur. |
| `Nature` | `string` | — | Non alimenté par GetParapheur. |
| `DateEnregistrementCourrier` | `DateTime?` | — | Non alimenté ici (utilisé par SuiviCourriers). |
| `NReference` | `string` | — | Non alimenté ici. |
| `Reference` | `string` | — | Non alimenté ici. |
| `CreationTime` | `DateTime` | — | Non alimenté ici. |
| `MailType` | `MailType` (enum) | — | Non alimenté ici (Arrivée=0, Départ=1, Interne=2). |

#### `ListOfMailsJsonResponse` (réponse AJAX interne au contrôleur)
| Propriété | Type C# | Description |
|---|---|---|
| `DataSource` | `List<GetMailForParapheurDto>` | Lignes de la page courante. |
| `TotalCount` | `int` | Nombre total de courriers (avant pagination). |
| `PageSize` | `int` | Taille de page. |
| `PageNumber` | `int` | Page courante. |
| `Search` | `string` | Terme de recherche appliqué. |

### Tables & colonnes impactées
Écran **en lecture seule** : aucune écriture. Tables lues :

| Table | Colonne | Type | Lecture/Écriture |
|---|---|---|---|
| `Mails` | `Id` | int (PK) | Lecture (jointure, `MailId`) |
| `Mails` | `Title` | string | Lecture (Objet + recherche + tri) |
| `Mails` | `Date` | DateTime | Lecture (Date courrier + tri `MailDate`) |
| `Mails` | `Reference` | string | Lecture (Références + recherche + tri) |
| `Mails` | `DateButoire` | DateTime? | Lecture (→ `DateDeTraitement`/`DateDeTraitementFormatted`) |
| `Mails` | `DateTraited` | DateTime? | Lecture (filtre : destinataire non traité) |
| `Mails` | `DestinataireExpediteur` | long (FK → AbpUsers) | Lecture (filtre + jointure destinataire) |
| `Mails` | `ExternalEntityId` | int (FK → ExternalEntities) | Lecture (jointure expéditeur) |
| `MailInputations` | `Id` | int (PK) | Lecture (ordonnancement « dernière imputation ») |
| `MailInputations` | `MailId` | int (FK → Mails) | Lecture (jointure) |
| `MailInputations` | `UserId` | long (FK → AbpUsers) | Lecture (filtre imputé à moi) |
| `MailInputations` | `DateTreated` | DateTime? | Lecture (filtre : imputation non traitée) |
| `MailInputations` | `Deadline` | DateTime? | Lecture (Date butoir + statuts + tri) |
| `MailInputations` | `MailInputationTypeId` | int (FK) | Lecture (type d'imputation) |
| `MailInputations` | `CreationTime` | DateTime | Lecture (Date dernière imputation) |
| `MailInputationTypes` | `Name` | string | Lecture (« Imputé à moi ») |
| `ExternalEntities` | `Name` | string | Lecture (Expéditeur + recherche) |
| `AbpUsers` | `FullName` | string | Lecture (Destinataire, Dernier imputateur + recherche) |

### Règles de gestion / effets de bord / transitions de statut
- **Aucune transition de statut ni effet de bord** (pas de notification, e-mail, drapeau, séquence ni date modifiée) n'est déclenché depuis cet écran : il ne fait que lire. Les mutations (`MailStatus`, `Valider`, `ValidationDirection`, `ValidationDG`, `EnregistrementReponse`, `Decharge`, `DateTraited`, `DateDecharge`, etc.) se produisent sur les écrans MailViewer / Validation / Décharge.
- **Périmètre de la liste (2 sources en union, distinct)** :
  1. Courriers dont l'utilisateur a une imputation active : `MailInputation.UserId == UserId && DateTreated == null`.
  2. Courriers dont l'utilisateur est le destinataire principal : `Mail.DestinataireExpediteur == UserId && Mail.DateTraited == null`.
- **Filtrage recherche** (côté serveur, en mémoire après matérialisation) : insensible à la casse, `Contains` sur `Title`, `ExternalEntityFk.Name`, `DestinataireExpediteurFk.FullName`, `Reference`.
- **Tri** : colonnes gérées `Title`, `ExternalEntityName`, `MailDate` (→ `Mail.Date`), `VReference`, `LastImputationFullName`, `LastImputationDate` (→ deadline de la dernière imputation), `StatusLast`, `DateInmputeMoi` (→ deadline de l'utilisateur), `StatusMoi`. Défaut : `Id` (desc).
- **Calcul de statut** (`GetMailStatus(deadline)`), non affiché mais calculé : `NA` si pas de deadline ; sinon selon `joursRestants = deadline.Date - aujourd'hui` : `>= -1` → `OnTime`, `>= 0` → `Warning`, sinon → `Late`. (La logique des seuils est particulière/ordonnée de sorte que `Warning` est en pratique inatteignable — à revoir si réimplémenté.)
- **« Imputation principale »** : si l'utilisateur n'a pas d'imputation dédiée sur le courrier mais en est le destinataire (`DestinataireExpediteur`), la colonne « Imputé à moi » affiche « Imputation principale ».
- **Particularité colonne « Date de traitement »** : elle n'affiche PAS une date de traitement réelle ; elle est alimentée par `Mail.DateButoire` (`DateDeTraitement = m.DateButoire`) puis formatée `dd/MM/yyyy`. Divergence source-vs-libellé à conserver telle quelle lors d'une réimplémentation fidèle (ou à corriger sciemment).
- **Deadline « Date butoir » (`DateInmputeMoi`)** : plus proche `Deadline` parmi les imputations non traitées de l'utilisateur, formatée `dd/MM/yyyy HH:mm` (vide si absente).
- **Pagination** : `TotalCount` = nombre total après filtre recherche (avant `Skip/Take`) ; la pagination custom (jQuery) recalcule le nombre de pages `ceil(total/pageSize)`.
- **Badge de menu** : rafraîchi indépendamment via `MenuBadgeAppService.GetParapheurCountAsync()`, avec des critères plus stricts (`Valider == true && EnregistrementReponse == false`) — donc pas nécessairement égal au nombre de lignes listées.
- **Navigation** : chaque cellule pointe vers `/App/MailViewer/Index?MailId={MailId}` ; le traitement effectif du courrier se fait dans MailViewer.


---


## 09. Suivi des Courriers (`/App/SuiviCourriers`)

### Rôle métier
Écran de **suivi / traçabilité des courriers en cours de traitement** du module Docu-Courriers (libellé de sous-titre : « Guichet Unique »). Il liste tous les courriers **non encore traités** (`DateTraited == null`) sous forme de tableau paginé et cherchable, avec pour chaque courrier son objet, son expéditeur, ses numéros (enregistrement / origine), ses dates et son destinataire. Depuis chaque ligne, l'utilisateur peut ouvrir le courrier (consultation dans `MailViewer`) ou **générer/imprimer/télécharger la Fiche d'Imputation** (DOCX/PDF). L'écran est essentiellement en **lecture seule** sur le courrier : il ne modifie ni statut ni drapeau du `Mail` ; sa seule sortie « écrite » est la génération d'un document de fiche d'imputation.

### Accès & permissions
- Attribut contrôleur : `[AbpMvcAuthorize(AppPermissions.Pages_SuiviPermanentCourrier_Access, AppPermissions.Pages_DC_SuiviCourrier_Access)]` → l'accès à la page est accordé si l'utilisateur possède **au moins l'une** des deux permissions (sémantique OR d'ABP sur la liste).
- Constantes de permission (`AppPermissions.cs`) :
  - `Pages.SuiviPermanentCourrier` / `Pages.SuiviPermanentCourrier.Access`
  - `Pages.DC_SuiviCourrier` / `Pages.DC_SuiviCourrier.Access`
  - Menus associés : `Menus.Docu_Courriers.SuiviPermanentCourrier`, `Menus.Docu_Courriers.DC_SuiviCourrier`
- **Filtrage du contenu selon la permission effective** (évalué à l'exécution via `IsGrantedAsync`) :
  - `Pages_SuiviPermanentCourrier` accordé → l'utilisateur voit **tous** les courriers non traités (suivi « permanent »).
  - sinon `Pages_DC_SuiviCourrier` accordé → l'utilisateur ne voit que les courriers **pour lesquels il a une imputation non traitée** (contrôlé par `GetUserMailInputation(mailId, userId)`).
  - aucune des deux → liste vide.
- Entrée de menu : `AppNavigationProvider` → `SuiviCourriers`, url `App/SuiviCourriers`, icône `bi bi-save`, dépendance de permission sur `Pages_SuiviPermanentCourrier_Access` / `Pages_DC_SuiviCourrier_Access`.
- Page enregistrée sous `AppPageNames.Common.SuiviCourriers` (titre H1 affiché : « Docu-Courriers »).

### Interface utilisateur
Grille **Syncfusion EJ2** (`ejs-grid`) avec pagination **custom** (barre `<ul id="itemList">` + dropdown de taille + compteur), pilotée par AJAX (`suivi-courriers.js`) et non par le paging natif de la grille. Le chargement initial (ViewBag) est immédiatement remplacé par un appel AJAX `LoadData` au `document.ready`.

#### Filtres / recherche
| Libellé | Propriété | Type | Source |
|---|---|---|---|
| Recherche (`ejs-textbox` id=`search`, placeholder `L("Recherche")`, `change=onSearch`) | `search` (param serveur `search`) | Texte libre | Recherche insensible à la casse côté serveur sur `Mail.Title`, `ExternalEntityFk.Name`, `DestinataireExpediteurFk.FullName`, `Mail.Reference`, `Mail.NReference` |
| Taille de page (`ejs-dropdownlist` id=`sizer`, `change=onChange`) | `pageSize` (param `pageSize`) | Liste : 5, 10, 15, 20, 50 | Statique (tableau `data` dans la vue ; `pageSize` par défaut 10 côté JS, `pageSize=20` sur le `e-grid-pagesettings`) |
| Tri (clic entête colonne) | `sorting` + `sortDirection` | Tri serveur | Colonnes triables : `Title`, `ExternalEntityName`, `MailDate`, `VReference`, `NReference` (défaut `Id` desc) |

#### Colonnes du tableau
Ordre exact des colonnes déclarées dans `Index.cshtml` (`field` = liaison Syncfusion / tri ; « Affiche » = propriété réellement rendue par le template) :

| # | Libellé (headerText) | field (liaison/tri) | Affiche (template) | Type |
|---|---|---|---|---|
| 1 | (vide) | — | Bouton action `#DocumentAction` → `generateFicheImputation(MailId)` | Action (icône `fa-download`) |
| 2 | `L("Objet")` | `Title` | `Title` (lien vers MailViewer) `#objetTemplate` | string, texte multi-ligne (`allowTextWrap`) |
| 3 | `L("Expediteur")` | `ExternalEntityName` | `ExternalEntityName` `#expediteurTemplate` | string |
| 4 | « Date d'arrivée » | `DateEnregistrementCourrier` | `formatDateArrivee(DateEnregistrementCourrier)` (masque si vide ou année ≤ 1970) `#dateArriveeTemplate` | Date (fr-FR) |
| 5 | « Numéro d'enregistrement » | `NReference` | `NReference` `#numeroEnregistrementTemplate` | string (monospace) |
| 6 | « Numéro d'origine » | `Reference` | **`VReference`** (le template affiche `VReference`, pas le champ `Reference`) `#numeroOrigineTemplate` | string (monospace) |
| 7 | `L("DateCourrier")` | `MailDate` | `new Date(MailDate)` (fr-FR) `#dateCourrierTemplate` | Date |
| 8 | « Date d'enregistrement » | `MailDate` (champ lié) | **`new Date(CreationTime)`** (le template affiche `CreationTime`, pas `MailDate`) `#dateEnregistrement` | Date |
| 9 | `L("Destinataire")` | `DestinataireFullName` | `DestinataireFullName` `#destinataireTemplate` | string |

Notes de fidélité :
- Colonne commentée (désactivée) dans la vue : `VReference` / `L("References")` (`#referencesTemplate`).
- Toutes les cellules (sauf la colonne d'action) sont des liens `/App/MailViewer/Index?Action=suivi&MailId=${MailId}` ; un clic ligne redirige aussi vers cette URL (sauf clic sur bouton/lien d'action).

#### Actions (boutons)
| Bouton / interaction | Effet | Permission |
|---|---|---|
| Icône « Générer Fiche d'Imputation » (`fa-download`, par ligne) | `generateFicheImputation(MailId)` → ouvre une modale `#ficheImputationPreviewModal` affichant le PDF de la fiche (iframe) via `POST /App/MailTabs/GenerateFicheImputationPdf` | Accès page |
| Modale → « Imprimer » | `printFicheImputation()` → régénère le PDF (`POST /App/MailTabs/GenerateFicheImputationPdf`, blob) et l'imprime dans une fenêtre | Accès page |
| Modale → « Télécharger » | `downloadFicheImputation(MailId)` → `POST /App/MailTabs/GenerateFicheImputation` renvoie un **.docx** (`FICHE_IMPUTATION_<mailId>_<timestamp>.docx`) | Accès page |
| Modale → « Fermer » | Ferme la modale Bootstrap | — |
| Clic sur une ligne / cellule (hors bouton) | Redirige vers `/App/MailViewer/Index?Action=suivi&MailId=<MailId>` (consultation du courrier) | Accès page |
| Champ « Recherche » | Recharge la grille filtrée (`onSearch` → `loadData`) | Accès page |
| Dropdown taille + pagination custom | `onChange` / `changePage` → recharge via `LoadData` | Accès page |
| Clic entête colonne | `onActionComplete` (requestType `sorting`) → recharge triée | Accès page |

Aucun bouton « Créer / Éditer / Supprimer / Imputer / Valider / Décharger » n'est présent sur cet écran (écran de suivi/consultation). Ces opérations existent sur d'autres écrans du module.

#### Formulaire(s) / Modale(s)
**Modale `#ficheImputationPreviewModal` (générée en JS)** — pas de champ de saisie ; visualiseur PDF + actions.

| Champ | Propriété | Type | Obligatoire | Source/valeurs |
|---|---|---|---|---|
| Aperçu document | `#ficheDocViewer` (iframe) | Visualiseur PDF | — | Blob PDF renvoyé par `POST /App/MailTabs/GenerateFicheImputationPdf` (data: `mailId`) |
| (contexte) | `window.currentFicheImputationMailId` | int (MailId) | oui (pour Imprimer/Télécharger) | Fourni par le bouton de la ligne |

La fiche d'imputation est produite côté serveur par `MailTabsController.GenerateFicheImputation` / `GenerateFicheImputationPdf` à partir du modèle `wwwroot/Common/templates/FICHE_IMPUTATION.docx` et des données `GetMailForView(mailId)` (hors périmètre de cet écran, mais déclenché depuis lui).

### Service applicatif & opérations
Services injectés dans `SuiviCourriersController` : `IMailsAppService`, `IMailInputationsAppService`, `RoleManager`, `UserManager`.

Opérations effectivement déclenchées depuis cet écran :

| Méthode | Entrée (DTO) | Sortie (DTO) | Description |
|---|---|---|---|
| `IMailsAppService.GetParapheurSuiviCourriers` | `GetAllMailsInput` | `PagedResultDto<GetMailForParapheurDto>` | Source de données du tableau : courriers non traités (`DateTraited == null`), recherche + tri + pagination serveur, projection avec calcul de statut/échéance d'imputation. Appelée par `Index()` et `LoadData(...)`. |
| `IMailInputationsAppService.GetUserMailInputation` | `int mailId, int userId` | `List<GetMailInputationForViewDto>` | Vérifie si l'utilisateur (permission `DC_SuiviCourrier`) a une imputation **non traitée** (`DateTreated == null`) pour un courrier ; filtre les lignes visibles. |
| `MailTabsController.GenerateFicheImputationPdf` (POST MVC) | `int mailId` | Fichier PDF (blob) | Aperçu / impression de la fiche d'imputation. |
| `MailTabsController.GenerateFicheImputation` (POST MVC) | `int mailId` | Fichier DOCX (blob) | Téléchargement de la fiche d'imputation. |

Endpoints MVC du contrôleur d'écran :

| Action | Verbe | Entrée | Sortie | Description |
|---|---|---|---|---|
| `SuiviCourriersController.Index` | GET | — | `View()` (ViewBag.DataSource / TotalCount) | Rend la page ; charge la 1re page (MaxResultCount=10) et pré-filtre par permission. |
| `SuiviCourriersController.LoadData` | GET | `pageSize, pageNumber, sorting, sortDirection, search` | `Json(ListOfMailsJsonResponse)` | Alimente la grille en AJAX ; `ListOfMailsJsonResponse { DataSource: List<GetMailForParapheurDto>, TotalCount, PageSize, PageNumber, Search }`. |

### DTOs

**`GetAllMailsInput` (entrée)** — hérite de `PagedAndSortedResultRequestDto` (fournit `SkipCount`, `MaxResultCount`, `Sorting`). Seuls `Search`, `Sorting`, `SortDirection`, pagination et `UserId` sont exploités par cet écran.

| Propriété | Type C# | Obligatoire | Description |
|---|---|---|---|
| `Search` | string | non | Terme de recherche (Title / ExternalEntity.Name / Destinataire.FullName / Reference / NReference) |
| `Filter` | string | non | Non utilisé par cet écran (passé `""`) |
| `TitleFilter` | string | non | Non utilisé ici |
| `SortDirection` | string | non | `"asc"` / `"desc"` (défaut `desc`) |
| `MaxDateFilter` | DateTime? | non | Non utilisé ici |
| `MinDateFilter` | DateTime? | non | Non utilisé ici |
| `DescriptionFilter` | string | non | Non utilisé ici |
| `NReferenceFilter` | string | non | Non utilisé ici |
| `MailTypeFilter` | int? | non | Non utilisé ici |
| `UserId` | int | non | Utilisé dans la projection pour calculer l'imputation/échéance « Moi » |
| `MailStatusFilter` | int? | non | Non utilisé ici |
| `ReferenceFilter` | string | non | Non utilisé ici |
| `ConfidentialitesNameFilter` | string | non | Non utilisé ici |
| `MailDisplayPropertyFilter` | string | non | Non utilisé ici |
| `ExternalEntityNameFilter` | string | non | Non utilisé ici |
| `Sorting` (hérité) | string | non | Nom de colonne de tri (défaut `Id`) |
| `SkipCount` (hérité) | int | non | `(pageNumber - 1) * pageSize` |
| `MaxResultCount` (hérité) | int | non | Taille de page |

**`GetMailForParapheurDto` (sortie / ligne de tableau)**

| Propriété | Type C# | Obligatoire | Description |
|---|---|---|---|
| `MailId` | int | — | Id du courrier (`Mails.Id`) ; clé de navigation/action |
| `Title` | string | — | Objet du courrier (`Mails.Title`) |
| `ExternalEntityName` | string | — | Nom de l'expéditeur (`ExternalEntities.Name`) |
| `InputationMoiTypeName` | string | — | Type de la dernière imputation non traitée de l'utilisateur, ou « Imputation principale » s'il est destinataire |
| `DateInmputeMoi` | string | — | Échéance (`Deadline`) de l'imputation « Moi » formatée `dd/MM/yyyy HH:mm` (vide si absente) |
| `ConfidentialiteName` | string | — | (non projeté par cet écran) |
| `MailDate` | DateTime | — | Date du courrier (`Mails.Date`) |
| `DateDeTraitement` | DateTime? | — | (non projeté par cet écran) |
| `DateDeTraitementFormatted` | string | — | (non projeté par cet écran) |
| `DestinataireFullName` | string | — | Destinataire (`AbpUsers.FullName` via `DestinataireExpediteur`) |
| `VReference` | string | — | Référence d'origine du courrier (`Mails.Reference`) ; affichée en « Numéro d'origine » |
| `LastImputationFullName` | string | — | Nom de l'agent de la dernière imputation non traitée |
| `LastImputationDate` | string | — | Échéance de la dernière imputation, formatée (vide si absente) |
| `StatusMoi` | string | — | Statut d'échéance « Moi » : `NA` / `OnTime` / `Warning` / `Late` |
| `StatusLast` | string | — | Statut d'échéance de la dernière imputation : `NA` / `OnTime` / `Warning` / `Late` |
| `Nature` | string | — | (non projeté par cet écran) |
| `DateEnregistrementCourrier` | DateTime? | — | Date d'arrivée/enregistrement du courrier (`Mails.DateEnregistrementCourrier`) |
| `NReference` | string | — | Numéro d'enregistrement (`Mails.NReference`) |
| `Reference` | string | — | (propriété présente ; le tableau lie la colonne « Numéro d'origine » à `Reference` mais rend `VReference`) |
| `CreationTime` | DateTime | — | Date de création de l'enregistrement (`Mails.CreationTime`) ; affichée en colonne « Date d'enregistrement » |
| `MailType` | MailType (enum) | — | Type de courrier : `Arrivée`=0 / `Départ`=1 / `Interne`=2 |

Aucune propriété n'est marquée `[Required]` sur ces DTOs (DTOs de lecture / de requête).

### Tables & colonnes impactées
Écran **en lecture seule** sur la base (aucune écriture déclenchée depuis `SuiviCourriers` ; la génération de fiche lit seulement). `[Table(...)]` exacts :

| Table | Colonne | Type | Lecture/Écriture |
|---|---|---|---|
| `Mails` | `Id` | int (PK) | Lecture (clé, tri par défaut) |
| `Mails` | `DateTraited` | datetime? | Lecture (filtre : `== null`) |
| `Mails` | `Title` | nvarchar | Lecture (objet, recherche, tri) |
| `Mails` | `Reference` | nvarchar | Lecture (numéro d'origine / `VReference`, recherche, tri `VReference`) |
| `Mails` | `NReference` | nvarchar | Lecture (numéro d'enregistrement, recherche, tri) |
| `Mails` | `Date` | datetime | Lecture (`MailDate`, tri) |
| `Mails` | `DateEnregistrementCourrier` | datetime? | Lecture (date d'arrivée) |
| `Mails` | `CreationTime` | datetime | Lecture (date d'enregistrement, colonne 8) |
| `Mails` | `MailType` | int (enum) | Lecture (projeté dans le DTO) |
| `Mails` | `ExternalEntityId` | int (FK) | Lecture (jointure expéditeur) |
| `Mails` | `DestinataireExpediteur` | bigint (FK → AbpUsers) | Lecture (jointure destinataire) |
| `ExternalEntities` | `Name` | nvarchar | Lecture (nom expéditeur, recherche/tri) |
| `AbpUsers` | `FullName` | nvarchar | Lecture (destinataire + noms d'imputation, recherche) |
| `MailInputations` | `MailId` | int (FK) | Lecture (échéance/statut, filtre permission DC) |
| `MailInputations` | `UserId` | bigint (FK) | Lecture (imputation « Moi », filtre permission DC) |
| `MailInputations` | `DateTreated` | datetime? | Lecture (imputation non traitée : `== null`) |
| `MailInputations` | `Deadline` | datetime? | Lecture (calcul StatusMoi/StatusLast, DateInmputeMoi/LastImputationDate) |
| `MailInputations` | `MailInputationTypeId` | int (FK) | Lecture (nom du type d'imputation) |
| `MailInputationTypes` | `Name` | nvarchar | Lecture (`InputationMoiTypeName`) |

### Règles de gestion / effets de bord / transitions de statut
- **Périmètre des courriers** : seuls les courriers **non traités** sont listés — `Where(m => m.DateTraited == null)`. Aucun filtre sur `MailType` (Arrivée/Départ/Interne coexistent).
- **Recherche serveur** (`input.Search`, `ToUpper().Contains`) sur : `Title`, `ExternalEntityFk.Name`, `DestinataireExpediteurFk.FullName`, `Reference`, `NReference`.
- **Tri serveur** (`input.Sorting` / `SortDirection`) : `Title`, `ExternalEntityName` (`ExternalEntityFk.Name`), `MailDate` (`Date`), `VReference` (`Reference`), `NReference` ; défaut = `Id` (desc au chargement).
- **Pagination** : `Skip(SkipCount).Take(MaxResultCount)` ; `TotalCount` = comptage **avant** pagination. Barre de pagination reconstruite côté client à partir de `TotalCount / pageSize`.
- **Filtrage par permission (post-requête, en mémoire)** :
  - `Pages_SuiviPermanentCourrier` → tous les items de la page.
  - `Pages_DC_SuiviCourrier` (sans la précédente) → on ne garde un item que si `GetUserMailInputation(mail.MailId, userId).Count > 0` (imputation non traitée de l'utilisateur courant).
  - aucune → liste vide.
  - ⚠️ Incohérence connue (commentée dans le code) : pour les utilisateurs `DC_SuiviCourrier`, `TotalCount` renvoyé reste celui de la requête globale (non recalculé après filtrage en mémoire) ; la pagination peut donc afficher plus de pages que d'items réellement visibles.
- **Calcul de statut d'échéance** `GetMailStatus(deadline)` :
  - pas de `Deadline` → `NA` ;
  - `daysUntilDeadline >= -1` → `OnTime` ;
  - `>= 0` → `Warning` ;
  - sinon → `Late`.
  - (ordre des `if` tel qu'écrit : la branche `Warning` est en pratique masquée par `OnTime` — comportement à reproduire ou corriger selon besoin.)
- **Imputation « Moi »** (`GetLastImputationNameMoiCorrected`) : renvoie le type de la 1re imputation non traitée de l'utilisateur (triée par `Deadline`) ; si aucune mais l'utilisateur est le `DestinataireExpediteur` du courrier → « Imputation principale ».
- **Dernière imputation** (`GetLastImputationFullName` / `GetDeadlineLast`) : imputation non traitée la plus récente (`OrderByDescending(Id)`).
- **Format de date** : `FormatDateTimeOrEmpty` → `dd/MM/yyyy HH:mm` (chaîne vide si null). Côté client, `formatDateArrivee` masque aussi les dates invalides / année ≤ 1970 (affiche `-`).
- **Aucune transition de statut ni mutation de drapeau** n'est effectuée depuis cet écran : `Valider`, `ValidationDirection`, `ValidationDG`, `EnregistrementReponse`, `Decharge`, `DateTraited`, `DateDecharge`, `DateFollowUp`, `DateButoire`, `MailStatus` **ne sont pas modifiés** ici (ces effets appartiennent à d'autres écrans : Parapheur, Validation Direction/DG, Décharge, etc.).
- **Seul effet « de bord » exportant** : génération de la **Fiche d'Imputation** (DOCX via `GenerateFicheImputation`, PDF via `GenerateFicheImputationPdf`) à partir du modèle `wwwroot/Common/templates/FICHE_IMPUTATION.docx` et de `GetMailForView(mailId)` — opération de lecture/rendu, sans mutation du courrier.
- **Navigation** : ouverture d'un courrier en mode suivi via `/App/MailViewer/Index?Action=suivi&MailId=<id>` (clic ligne/cellule).
- **Dépendances front notables** : jQuery 3.6.0 + Syncfusion EJ2 (CDN), Font Awesome 6.4 (CDN), Bootstrap 5 (modale), `abp.notify` / `abp.ui.setBusy`. Le rendu réel de la grille est piloté par AJAX `LoadData` (le `DataSource` initial via ViewBag n'est pas utilisé par le JS).


---


## 10. Validation (`/App/Validation`)

### Rôle métier

Écran de **validation "Direction"** du module Docu-Courriers. Il liste les courriers **Arrivée déjà « validés » (contrôlés)** qui restent en attente de la validation par la Direction, et permet à la Direction de les valider **en masse** (sélection multiple via cases à cocher, puis bouton « Valider »). La validation positionne le drapeau `ValidationDirection = true` sur chaque courrier, ce qui le fait sortir de cette file d'attente et déclenche l'envoi de notifications système + e-mails à toutes les personnes associées au courrier (destinataire, personnes imputées, personnes en copie). C'est une étape intermédiaire du circuit d'approbation, après le contrôle/validation initiale (`Valider`) et avant la validation DG (`ValidationDG`) et l'enregistrement de la réponse.

### Accès & permissions

- Contrôleur décoré `[Area("App")]` + `[AbpMvcAuthorize(AppPermissions.Pages_Validation_Access)]`.
- **Permission d'accès à l'écran** : `Pages.Validation.Access` (constante `AppPermissions.Pages_Validation_Access`). Permission parente déclarée : `Pages.Validation`.
- **Permissions de filtrage du contenu** (déterminent les lignes visibles, vérifiées à l'exécution via `IsGrantedAsync`) :
  - `Pages.SuiviPermanentCourrier` (`Pages_SuiviPermanentCourrier`) : voit **tous** les courriers de la file de validation.
  - `Pages.DC_SuiviCourrier` (`Pages_DC_SuiviCourrier`) : voit **uniquement** les courriers sur lesquels l'utilisateur courant possède au moins une imputation **non traitée** (`DateTreated == null`).
  - Aucune de ces deux permissions ⇒ liste **vide** (l'écran s'ouvre mais aucune ligne).
- Aucun badge de notification spécifique n'est associé au menu de cet écran.

### Interface utilisateur

Page construite avec **Syncfusion EJ2** (`ejs-grid`, `ejs-textbox`, `ejs-dropdownlist`). En-tête de page : titre « Docu-Courriers », sous-titre localisé `@L("Validation")`. Chaque cellule du tableau est un lien vers `/App/MailViewer/Index?Action=suivi&MailId=${MailId}`.

#### Filtres / recherche

| Libellé | Propriété | Type | Source |
|---|---|---|---|
| Recherche | `search` (→ `GetAllMailsInput.Search`) | Zone de texte (`ejs-textbox`, `onSearch`) | Saisie libre. Filtre serveur sur `Title`, `ExternalEntity.Name`, `Destinataire.FullName`, `Reference`, `NReference` (comparaison `ToUpper().Contains`) |
| Items / Page | `sizer` (→ paramètre `pageSize`) | Liste déroulante (`ejs-dropdownlist`) | Valeurs fixes `{5, 10, 15, 20, 50}` |
| Pagination (n° de page) | `pageNumber` | Liste `<ul id="itemList">` générée en JS | Construite depuis `TotalCount / pageSize` |

> Le tri est piloté par la grille (`onActionComplete` → `sorting` + `order`) sur les colonnes `Title`, `ExternalEntityName`, `MailDate`, `VReference`, `NReference` ; tri par défaut `Id desc`.

#### Colonnes du tableau

| Libellé (headerText) | Propriété (`field` / template) | Type |
|---|---|---|
| (sélection) | `MailId` (case à cocher `.row-checkbox`, template `#CheckboxTemplate` + en-tête `#HeaderCheckboxTemplate` « tout sélectionner ») | Checkbox |
| (action, masquée, width 0) | — (template `#DocumentAction`, conteneur vide) | — |
| Objet | `Title` (template `#objetTemplate`) | string |
| Expediteur | `ExternalEntityName` (template `#expediteurTemplate`) | string |
| Date d'arrivée | `DateEnregistrementCourrier` (template `#dateArriveeTemplate`, formaté `toLocaleDateString('fr-FR')`) | date |
| Numéro d'enregistrement | `NReference` (template `#numeroEnregistrementTemplate`) | string |
| Numéro d'origine | `Reference` (template `#numeroOrigineTemplate` — **affiche en réalité `VReference`**) | string |
| References | `VReference` (template `#referencesTemplate`) | string |
| DateCourrier | `MailDate` (template `#dateCourrierTemplate`, formaté `fr-FR`) | date |
| Date d'enregistrement | `MailDate` (déclaré) — template `#dateEnregistrement` **affiche `CreationTime`** formaté `fr-FR` | date |
| Destinataire | `DestinataireFullName` (template `#destinataireTemplate`) | string |

> Remarques de fidélité : deux colonnes déclarent `field="MailDate"` ; le template « Numéro d'origine » et « Numéro d'enregistrement » lient `Reference`/`VReference` de façon incohérente avec l'en-tête. À reproduire tel quel ou corriger selon le besoin.

#### Actions (boutons)

| Bouton | Effet | Permission |
|---|---|---|
| **Valider** (`btn-bulk-validate`, `validationCourrier()`) — visible seulement si ≥ 1 ligne cochée | Confirmation SweetAlert → `POST /App/Validation/ValidationCourrier` avec la liste des `MailId` cochés → `UpdateValidationDirectionBatch(ids, true)` + notifications ; recharge la grille | `Pages.Validation.Access` (accès écran) |
| Case « tout sélectionner » (`#selectAll`, `toggleSelectAll`) | Coche/décoche toutes les lignes de la page ; met à jour le compteur `x sélectionné(s)` | — |
| Case ligne (`.row-checkbox`, `updateSelectionCount`) | Sélectionne un courrier (valeur = `MailId`) ; affiche/masque la barre d'actions groupées | — |
| Lien de cellule | Ouvre la fiche de suivi du courrier : `/App/MailViewer/Index?Action=suivi&MailId=<id>` | — |

#### Formulaire(s) / Modale(s)

**Aucune modale de création/édition.** L'écran n'a ni `_CreateOrEditModal.cshtml` ni `_ViewModal.cshtml`. La seule interaction « formulaire » est la **boîte de confirmation SweetAlert** de validation groupée :

| Champ | Propriété | Type | Obligatoire | Source/valeurs |
|---|---|---|---|---|
| Liste des courriers à valider | `selectedMailIds` (→ body JSON `List<int>` de `MailId`) | tableau d'entiers | Oui (≥ 1, sinon alerte « Veuillez sélectionner au moins un courrier ») | Cases `.row-checkbox:checked` de la grille |
| Confirmation | — | Bouton « Valider » / « Annuler » | — | SweetAlert (`Swal.fire`) |

### Service applicatif & opérations

Interface : `DocuPro.MailBase.IMailsAppService` (méthodes réellement invoquées par cet écran).

| Méthode | Entrée (DTO) | Sortie (DTO) | Description |
|---|---|---|---|
| `ValidationDirection` | `GetAllMailsInput` | `PagedResultDto<GetMailForParapheurDto>` | Retourne la file d'attente de validation Direction : courriers `DateTraited == null && Valider == true && ValidationDirection == false`. Applique recherche texte, tri dynamique et pagination. Utilisée par `Index()` et `LoadData()`. |
| `UpdateValidationDirectionBatch` | `List<int> mailIds`, `bool validationDirection = true` | `(int successCount, List<int> failedIds)` (tuple) | Pour chaque `mailId` : charge le `Mail`, positionne `ValidationDirection = validationDirection`, `UpdateAsync`. Comptabilise succès/échecs. Vide les caches `MailsCache`, `ParapheurCache`, `CourrierDepartCache` si au moins un succès. |

Autre service utilisé par le contrôleur (filtrage par permission) : `IMailInputationsAppService.GetUserMailInputation(int mailId, int userId)` → `List<GetMailInputationForViewDto>` (imputations **non traitées** de l'utilisateur sur le courrier). Et `IAppNotifier.ValidationDirectionCourrierAsync(int mailId, string validateurName)` pour les notifications. Le nom du validateur provient de `UserManager.GetUserByIdAsync` (`Name + Surname`, sinon `UserName`, sinon « Direction »).

**Endpoints MVC de l'écran** (contrôleur `ValidationController`) :
- `GET /App/Validation/Index` → vue `Index.cshtml`.
- `GET /App/Validation/LoadData(pageSize, pageNumber, sorting, sortDirection, search)` → `Json(ListOfMailsJsonResponse{ DataSource, TotalCount, PageSize, PageNumber, Search })`.
- `POST /App/Validation/ValidationCourrier([FromBody] List<int> mailIds)` → `Json({ success, message, partialSuccess?, failedIds? })`.

### DTOs

**`GetAllMailsInput`** (hérite `PagedAndSortedResultRequestDto` → fournit `MaxResultCount`, `SkipCount`, `Sorting`) — entrée de `ValidationDirection` :

| Propriété | Type C# | Obligatoire | Description |
|---|---|---|---|
| Search | string | Non | Terme de recherche plein texte |
| Filter | string | Non | Filtre générique (mis à `""`) |
| TitleFilter | string | Non | Non utilisé par cet écran |
| SortDirection | string | Non | `"asc"`/`"desc"` (défaut `desc`) |
| MaxDateFilter | DateTime? | Non | Non utilisé ici |
| MinDateFilter | DateTime? | Non | Non utilisé ici |
| DescriptionFilter | string | Non | Non utilisé ici |
| NReferenceFilter | string | Non | Non utilisé ici |
| MailTypeFilter | int? | Non | Non utilisé ici |
| UserId | int | Non | Utilisé dans la projection (imputations « moi ») |
| MailStatusFilter | int? | Non | Non utilisé ici |
| ReferenceFilter | string | Non | Non utilisé ici |
| ConfidentialitesNameFilter | string | Non | Non utilisé ici |
| MailDisplayPropertyFilter | string | Non | Non utilisé ici |
| ExternalEntityNameFilter | string | Non | Non utilisé ici |
| *Sorting* (hérité) | string | Non | Colonne de tri |
| *MaxResultCount* (hérité) | int | Non | Taille de page |
| *SkipCount* (hérité) | int | Non | Décalage de pagination |

**`GetMailForParapheurDto`** — sortie (une ligne du tableau) :

| Propriété | Type C# | Obligatoire | Description |
|---|---|---|---|
| Title | string | — | Objet du courrier |
| ExternalEntityName | string | — | Nom de l'expéditeur (entité externe) |
| InputationMoiTypeName | string | — | Type d'imputation « moi » (renseigné mais non affiché ici) |
| DateDeTraitementFormatted | string | — | Non renseigné par cet écran |
| DateInmputeMoi | string | — | Échéance de mon imputation (formatée) |
| ConfidentialiteName | string | — | Non renseigné ici |
| MailDate | DateTime | — | Date du courrier |
| DateDeTraitement | DateTime? | — | Non renseigné ici |
| DestinataireFullName | string | — | Destinataire (nom complet utilisateur) |
| VReference | string | — | Référence d'origine (`Mail.Reference`) |
| LastImputationFullName | string | — | Dernière personne imputée |
| LastImputationDate | string | — | Date/échéance de la dernière imputation (formatée) |
| StatusMoi | string | — | Statut d'échéance de mon imputation |
| StatusLast | string | — | Statut d'échéance de la dernière imputation |
| MailId | int | — | Identifiant du courrier (`Mail.Id`) |
| Nature | string | — | Non renseigné ici |
| DateEnregistrementCourrier | DateTime? | — | Date d'arrivée/enregistrement |
| NReference | string | — | Numéro d'enregistrement |
| Reference | string | — | Numéro d'origine (déclaré ; non peuplé par `ValidationDirection`) |
| CreationTime | DateTime | — | Date de création de l'enregistrement |
| MailType | MailType (enum) | — | Arrivée=0 / Départ=1 / Interne=2 |

**`GetMailInputationForViewDto`** — utilisé par `GetUserMailInputation` pour le filtrage par permission `DC_SuiviCourrier` (seule sa présence/quantité compte, pas son contenu affiché) :

| Propriété | Type C# | Obligatoire | Description |
|---|---|---|---|
| MailInputation | `MailInputationDto` | — | Objet imputation (Instructions, Deadline, DateTreated, Id, CreationTime, CreatorUserName) |
| MailInputationTypeName | string | — | Libellé du type d'imputation |
| UserName | string | — | Utilisateur imputé |
| MailTitle | string | — | Objet du courrier |

**`ListOfMailsJsonResponse`** (classe interne du contrôleur, réponse de `LoadData`) :

| Propriété | Type C# | Obligatoire | Description |
|---|---|---|---|
| DataSource | `List<GetMailForParapheurDto>` | — | Lignes de la page |
| TotalCount | int | — | Nombre total (avant pagination) |
| PageSize | int | — | Taille de page |
| PageNumber | int | — | Page courante |
| Search | string | — | Terme de recherche renvoyé |

### Tables & colonnes impactées

Table principale : **`Mails`** (`[Table("Mails")]`, entité `DocuPro.MailBase.Mail : FullAuditedEntity, IMayHaveTenant`).

| Table | Colonne | Type | Lecture/Écriture |
|---|---|---|---|
| Mails | Id | int | Lecture (clé, `MailId`, tri) |
| Mails | Title | string | Lecture (Objet, recherche, tri) |
| Mails | Date | DateTime | Lecture (`MailDate`, tri) |
| Mails | Description | string | Lecture (e-mail de notification) |
| Mails | Reference | string | Lecture (`VReference` / numéro d'origine, recherche, tri) |
| Mails | NReference | string | Lecture (numéro d'enregistrement, recherche, tri) |
| Mails | DateEnregistrementCourrier | DateTime? | Lecture (Date d'arrivée) |
| Mails | CreationTime | DateTime | Lecture (Date d'enregistrement / audit) |
| Mails | DateTraited | DateTime? | Lecture (filtre file d'attente : `== null`) |
| Mails | Valider | bool | Lecture (filtre : `== true`) |
| Mails | **ValidationDirection** | bool | **Lecture** (filtre : `== false`) **+ Écriture** (mise à `true` lors de la validation) |
| Mails | DestinataireExpediteur | long (FK → AbpUsers.Id) | Lecture (destinataire, notifications) |
| Mails | ExternalEntityId | int (FK → ExternalEntities) | Lecture (expéditeur) |
| Mails | MailType | enum/int | Lecture (projeté dans le DTO) |
| ExternalEntities | Name | string | Lecture (nom expéditeur, recherche) |
| AbpUsers | Id, Name, Surname, UserName, FullName, EmailAddress, TenantId | — | Lecture (destinataire, nom du validateur, destinataires des notifications/e-mails) |
| MailInputations | MailId, UserId, DateTreated, MailInputationTypeId, CreatorUserId, Instructions, Deadline, CreationTime | — | Lecture (filtrage `DC_SuiviCourrier`, ciblage des notifications) |
| MailInputationTypes | Id, Name | string | Lecture (ex. distinction « En Copie » pour les notifications) |

> Écriture réelle de l'écran : **uniquement `Mails.ValidationDirection = true`** (via `UpdateAsync`, qui met aussi à jour les champs d'audit `LastModificationTime`/`LastModifierUserId` de `FullAuditedEntity`). Aucune autre colonne (statut, dates, séquence) n'est modifiée par cet écran.

### Règles de gestion / effets de bord / transitions de statut

- **Critère de présence dans la file** : un courrier apparaît si et seulement si `DateTraited == null` **ET** `Valider == true` **ET** `ValidationDirection == false`. Il s'agit donc des courriers déjà contrôlés/validés mais pas encore validés par la Direction et non encore traités.
- **Action de validation** : `UpdateValidationDirectionBatch` positionne `ValidationDirection = true` sur chaque courrier sélectionné. Le traitement est **par lot, tolérant aux erreurs** : chaque courrier est traité indépendamment ; les IDs en échec sont collectés dans `failedIds`, les autres comptés dans `successCount`. Réponse possible : succès total, échec total, ou **succès partiel** (`partialSuccess = true` + `failedIds`).
- **Transition de statut** : **aucun changement de `MailStatus`**, et **aucune date** (`DateTraited`, `DateDecharge`, `DateEnregistrementCourrier`, `DateFollowUp`, `DateButoire`) n'est modifiée. La transition est purement matérialisée par le drapeau booléen `ValidationDirection`.
- **Sortie de file** : après validation, `ValidationDirection == true` fait disparaître le courrier de cet écran. Il devient éligible aux écrans aval, notamment `GetParapheurCourrierValide` / `GetCourrierValidationDG` (qui sélectionnent `ValidationDirection == true || ValidationDG == true`).
- **Invalidation de cache** : à la fin d'un lot réussi, vidage des caches `MailsCache`, `ParapheurCache`, `CourrierDepartCache`.
- **Notifications (effet de bord majeur)** : pour chaque courrier validé avec succès, `ValidationDirectionCourrierAsync(mailId, validateurName)` est appelée. Elle :
  - construit la liste des destinataires : le **destinataire principal** (`Mail.DestinataireExpediteur`), la **première personne imputée** (première imputation dont le type ≠ « En Copie »), **toutes les personnes en copie** (type = « En Copie ») et **toutes les personnes imputées** ;
  - envoie à chacun une **notification système** (`SimpleMessage`, sévérité Success) et un **e-mail HTML** (sujet « ✅ Validation Direction - <objet> », gabarit aux couleurs Sénat de Côte d'Ivoire) contenant objet, référence, date, destinataire, provenance, validateur, date de validation, n° d'origine et résumé ;
  - l'URL du courrier dans l'e-mail utilise `App:RedirectAllowedExternalWebSites` (fallback `http://173.249.41.143:8080`) : `<base>/App/MailViewer/Index?MailId=<id>`.
  - Les erreurs de notification/e-mail sont **journalisées mais non bloquantes** : elles n'annulent pas la validation.
- **Nom du validateur** : dérivé de l'utilisateur connecté (`Name Surname`, sinon `UserName`, sinon « Direction »).
- **Sécurité applicative de l'affichage** : les lignes retournées sont re-filtrées côté contrôleur selon les permissions (`SuiviPermanentCourrier` = tout ; `DC_SuiviCourrier` = seulement mes imputations non traitées ; sinon liste vide). `TotalCount` renvoyé reste celui de la requête serveur `ValidationDirection` (non recalculé après filtrage par imputation — la pagination peut donc être approximative pour le profil `DC_SuiviCourrier`).
- **UX** : la barre d'actions groupées n'apparaît que si au moins une ligne est cochée ; validation sans sélection ⇒ avertissement. Après succès, la grille est rechargée (`loadData`) pour refléter la sortie des courriers validés.


---


## 11. Recherche Multicritères (`/App/ResearchMultiCriteriaCourrier`)

### Rôle métier
Écran de consultation transversale du module Docu-Courriers permettant de retrouver n'importe quel courrier (Arrivée ou Départ) à partir de plusieurs critères combinés : mots-clés, provenance (entité externe), organigramme, type de courrier et plage de dates. Il ne crée ni ne modifie de courrier : c'est un outil de **recherche/lecture seule**. Chaque ligne de résultat est un lien vers la visionneuse de courrier (`/App/MailViewer/Index?MailId=...`) pour consulter le détail. La grille est vide au premier chargement ; elle ne se remplit qu'après soumission du formulaire de recherche.

### Accès & permissions
- Permission de contrôleur (attribut `[AbpMvcAuthorize]`) : `Pages.ResearchMultiCriteriaCourrier.Access` (constante `AppPermissions.Pages_ResearchMultiCriteriaCourrier_Access`).
- Permission parente déclarée : `AppPermissions.Pages_ResearchMultiCriteriaCourrier` (nœud `ResearchMultiCriteriaCourrier`).
- Entrée de menu (`AppNavigationProvider`) : requiert **toutes** (`requiresAll: true`) les permissions `Pages_ResearchMultiCriteriaCourrier_Access` **et** `Menus_Docu_Courriers_ResearchMultiCriteriaCourrier`.
- Titre de page : « Docu-Courriers » avec sous-titre localisé `@L("ResearchMultiCriteria")` ; `CurrentPageName = AppPageNames.Common.RechercheMultiCretereCourrier`.
- Aucun badge.

### Interface utilisateur
Layout en deux volets (Syncfusion `ejs-splitter`) : volet gauche 30 % = panneau de critères (`#left-pane-content_search`), volet droit 70 % = grille de résultats (`#last-pane-content_search`). Contrôles Syncfusion EJ2 (textbox, dropdownlist, datepicker, grid).

#### Filtres / recherche
Formulaire POST vers `GetSearchResult` / contrôleur `ResearchMultiCriteriaCourrier`. Modèle lié : `SearchCriteria`.

| Libellé | Propriété | Type | Source |
|---|---|---|---|
| Mots-clés (`@L("Keywords")`) | `Filter` | `ejs-textbox` (string, showClearButton) | Saisie libre. Recherche `Contains` sur `Title`, `Description`, `Reference`, `NReference` |
| Provenance (`@L("ChoisirLaProvenance")`) | `ExternalEntityId` | `ejs-dropdownlist` (int?, showClearButton) | `ViewBag.ExternalEntity` = `IExternalEntitiesAppService.GetAll(new GetAllExternalEntitiesInput())`. Champs : text=`ExternalEntity.Name`, value=`ExternalEntity.Id` |
| Nature (`@L("ChoisirLaNature")`) | `MailNatureId` | `ejs-dropdownlist` (int?) | `ViewBag.MailNatures` = `IMailNaturesAppService.GetAllList()`. **Masqué** (bloc commenté dans la vue) mais toujours transmis/traité côté serveur. Champs : text=`MailNature.Name`, value=`MailNature.Id` |
| Organigramme (`@L("ChoisirLOrganigramme")`) | `OrganigrammeId` | `ejs-dropdownlist` (int?, showClearButton) | `ViewBag.Organigrammes` = `IOrganigrammesAppService.GetAllList()`. Champs : text=`Organigramme.Name`, value=`Organigramme.Id` |
| Type de courrier (`@L("TypeDeCourrier")`) | `MailDepartTypeId` | `ejs-dropdownlist` (int?, showClearButton) | `ViewBag.MailType` = `IMailDepartTypesAppService.GetAllList()` projeté en `GenericViewModel{ Id = MailType.Id, Name = MailType.name }`. Champs : text=`Name`, value=`Id` |
| Date de début (`@L("StartDate")`) | `MinDateFilter` | `ejs-datepicker` (DateTime?, format dd-MM-yyyy) | Saisie. Filtre `Mail.Date >= MinDateFilter` |
| Date de fin (`@L("EndDate")`) | `MaxDateFilter` | `ejs-datepicker` (DateTime?, format dd-MM-yyyy) | Saisie. Filtre `Mail.Date <= MaxDateFilter` |
| Arrivée / Départ | `Options` | 2 boutons radio (`radioArrivee`="Arrivée", `radioDepart`="Départ") | Valeurs littérales `"Arrivée"` / `"Départ"` ; mappées vers l'enum `MailType`. (Valeur `"Interne"` supportée côté service mais absente de l'UI.) |
| — (bouton) | — | `submit` « Rechercher » | Soumet le formulaire |

#### Colonnes du tableau
Grille Syncfusion `ejs-grid` (id `Grid`) : pagination (`allowPaging`, pageSizes), tri (`allowSorting`), retour à la ligne (`allowTextWrap`). `dataSource = @ViewBag.DataSource` (liste `GetMailForViewDto`).

| Libellé (headerText) | Propriété (field) | Type / rendu |
|---|---|---|
| (vide) | — (template `#DocumentAction`) | Colonne d'action, `width=0`, contenu `display:none` (masquée/inactive) |
| Objet (`@L("Objet")`) | `Mail.Title` | Lien vers MailViewer ; texte wrap. `${Mail.Title || '-'}` |
| Correspondant | `ExternalEntityName` | Lien ; `${ExternalEntityName || '-'}` |
| Date d'arrivée | `DateEnregistrementCourrier` | Lien ; `formatDateArrivee()` (fr-FR ; « - » si null/invalide/année ≤ 1970) |
| Numéro d'enregistrement | `NReference` (rendu via `Mail.NReference`) | Lien ; badge « reference-text ». `${Mail.NReference || '-'}` |
| Numéro d'origine | `Mail.Reference` | Lien ; badge. `${Mail.Reference || '-'}` |
| Type (`@L("MailType")`) | `MailTypeName` | Lien ; badge « mail-type-badge ». `${MailTypeName || '-'}` |
| Nature (`@L("MailNature")`) | `MailNature` | Lien ; badge « mail-nature-badge ». `${MailNature || '-'}` |
| Date (`@L("DateCourrier")`) | `Mail.Date` | Lien ; `new Date(Mail.Date).toLocaleDateString('fr-FR')` |
| Direction (`@L("Direction")`) | `Mail.Title` (header « Direction », affiche `Direction`) | Lien ; texte wrap. `${Direction || '-'}` |

Chaque cellule (hors colonne d'action) est un `<a href="/App/MailViewer/Index?MailId=${Mail.Id}">`.

#### Actions (boutons)

| Bouton | Effet | Permission |
|---|---|---|
| Rechercher (submit) | POST `GetSearchResult` → recharge la vue Index avec les résultats et repopule les listes déroulantes + valeurs de filtre | `Pages.ResearchMultiCriteriaCourrier.Access` |
| Clic sur une ligne de résultat | Navigation GET vers `/App/MailViewer/Index?MailId={id}` (visionneuse de courrier) | permission de MailViewer |

Aucun bouton Créer / Éditer / Supprimer / Imputer / Valider / Décharger / Exporter sur cet écran.

#### Formulaire(s) / Modale(s)
Aucune modale (`_CreateOrEditModal`, `_ViewModal`, modales de lookup) sur cet écran. Le seul formulaire est le panneau de critères décrit ci-dessus (section « Filtres / recherche »). Un unique fichier de vue : `Index.cshtml` (styles inline en `@section Styles` et templates de cellules `<script type="text/x-template">` inline ; aucun `Index.js` dédié).

### Service applicatif & opérations
Contrôleur `ResearchMultiCriteriaCourrierController` (namespace `DocuPro.Web.Areas.App.Controllers.DocuArchives`). Services injectés : `IMailsAppService`, `IMailInputationsAppService`, `IMailInputationTypesAppService`, `IUserAppService`, `IMailDocumentsAppService`, `IExternalEntitiesAppService`, `IMailNaturesAppService`, `IOrganigrammesAppService`, `IMailDepartTypesAppService`. **Seuls réellement utilisés par cet écran** : `IMailsAppService` (recherche), `IExternalEntitiesAppService`, `IMailNaturesAppService`, `IOrganigrammesAppService`, `IMailDepartTypesAppService` (remplissage des listes).

Actions MVC :
- `Index()` (GET) : remplit les 4 sources de listes déroulantes ; `ViewBag.DataSource` = liste vide → vue `Index`.
- `GetSearchResult(SearchCriteria criteria)` (POST) : appelle `GetMailRechercheAsync`, projette en `GetMailForViewDto`, remplit `ViewBag.DataSource` + repopule listes et valeurs de filtres → renvoie la vue `Index`.

Opérations backend consommées :

| Méthode | Entrée (DTO) | Sortie (DTO) | Description |
|---|---|---|---|
| `IMailsAppService.GetMailRechercheAsync` | `string filter, DateTime? minDateFilter, DateTime? maxDateFilter, string options, int? externalEntityId, int? mailNatureId=null, int? organigrammeId=null, int? mailDepartTypeId=null` | `List<GetMailForViewDto>` | Recherche multicritères principale des courriers (cf. règles de gestion) |
| `IExternalEntitiesAppService.GetAll` | `GetAllExternalEntitiesInput` | `PagedResultDto<...>` (`.Items`) | Liste des entités externes (provenance) |
| `IMailNaturesAppService.GetAllList` | — | `List<...>` (MailNature) | Liste des natures de courrier |
| `IOrganigrammesAppService.GetAllList` | — | `List<...>` (Organigramme) | Liste des organigrammes |
| `IMailDepartTypesAppService.GetAllList` | — | `List<...>` (MailDepartType, avec `MailType.Id`/`MailType.name`) | Liste des types de courrier |

### DTOs

**`SearchCriteria`** (ViewModel MVC lié au formulaire — `DocuPro.Web.ViewModels`)

| Propriété | Type C# | Obligatoire | Description |
|---|---|---|---|
| `Filter` | `string` | Non | Mots-clés (Title/Description/Reference/NReference) |
| `MinDateFilter` | `DateTime?` | Non | Borne basse sur `Mail.Date` |
| `MaxDateFilter` | `DateTime?` | Non | Borne haute sur `Mail.Date` |
| `Options` | `string` | Non | "Arrivée" / "Départ" (/"Interne") → `MailType` |
| `ExternalEntityId` | `int?` | Non | Filtre provenance |
| `MailNatureId` | `int?` | Non | Filtre nature (UI masquée) |
| `OrganigrammeId` | `int?` | Non | Filtre organigramme (via rôles/utilisateurs) |
| `MailDepartTypeId` | `int?` | Non | Filtre type de courrier (`Mail.MailDepartTypeId`) |

**`GetMailForViewDto`** (sortie — `DocuPro.MailBase.Dtos`) — champs réellement peuplés/utilisés par cet écran : `Mail`, `MailDisplayProperty`, `MailTypeName`, `Direction`, `ConfidentialitesName`, `ExternalEntityName`, `MailNature`, `DateEnregistrementCourrier`.

| Propriété | Type C# | Obligatoire | Description |
|---|---|---|---|
| `Mail` | `MailDto` | — | Objet courrier (voir ci-dessous) |
| `ConfidentialitesName` | `string` | — | Nom de la confidentialité (résolu, non affiché ici) |
| `MailDisplayProperty` | `string` | — | = `mail.Title` |
| `DateEnregistrementCourrier` | `DateTime?` | — | Date d'enregistrement (colonne « Date d'arrivée ») |
| `CreationTime` | `DateTime` | — | Non peuplé ici |
| `ExternalEntityName` | `string` | — | Nom de l'entité externe (colonne Correspondant) |
| `MailTypeName` | `string` | — | `mail.MailType.ToString()` |
| `MailNature` | `string` | — | Nom de la nature (colonne Nature) |
| `LongDescription` / `Description` / `MailObjet` | `string` | — | Non peuplés ici |
| `Direction` | `string` | — | Nom de l'organigramme du destinataire (colonne Direction) |
| `Statut` / `LastImputationFullName` | `string` | — | Non peuplés ici |
| `DateRapel` / `DateDecharge` / `Deadline` / `DateRapel` | `DateTime?` | — | Non peuplés ici |
| `UserCreated` / `DestinataireFullName` / `InputationTypeName` | `string` | — | Non peuplés ici |
| `DestinataireExpediteurId` | `long` | — | Non peuplé ici |

**`MailDto`** (`DocuPro.MailBase.Dtos`, hérite `EntityDto` → `Id`) — champs consommés par la grille : `Id`, `Title`, `Date`, `NReference`, `Reference`, `MailType`.

| Propriété | Type C# | Obligatoire | Description |
|---|---|---|---|
| `Id` | `int` | — | Clé (via `EntityDto`), utilisée dans les liens MailViewer |
| `Title` | `string` | — | Objet (colonne Objet) |
| `Date` | `DateTime` | — | Date du courrier (colonne Date + filtre min/max) |
| `DateFollowUp` | `DateTime?` | — | — |
| `DateReglementaire` | `DateTime?` | — | — |
| `Description` | `string` | — | Cible de la recherche mots-clés |
| `NReference` | `string` | — | Numéro d'enregistrement (colonne + recherche) |
| `MailType` | `MailType` | — | Arrivée/Départ/Interne |
| `MailStatus` | `MailStatus` | — | — |
| `Reference` | `string` | — | Numéro d'origine (colonne + recherche) |
| `ConfidentialitesId` | `int?` | — | — |
| `MailParent` | `int?` | — | — |
| `ExternalEntityId` | `int?` | — | Filtre provenance |
| `MailObjetId` | `int?` | — | — |
| `MailNatureId` | `int?` | — | Filtre nature |
| `DestinataireExpediteur` | `long` | — | Destinataire (calcul Direction) |
| `DateTraited` | `DateTime?` | — | — |
| `DateDecharge` | `DateTime?` | — | — |
| `DateEnregistrementCourrier` | `DateTime?` | — | Date d'arrivée |

**`GenericViewModel`** (utilisé pour la liste « Type de courrier ») : `Id` (int), `Name` (string), `Name2` (string), `Valeur` (int), `Date` (DateTime, read-only).

### Tables & colonnes impactées
Écran en **lecture seule** : aucune écriture. Table principale : `[Table("Mails")]` → **Mails** (entité `Mail`, `FullAuditedEntity`, `IMayHaveTenant`).

| Table | Colonne | Type | Lecture/Écriture |
|---|---|---|---|
| Mails | Id | int (PK) | Lecture |
| Mails | Title | string | Lecture (filtre + affichage) |
| Mails | Date | DateTime | Lecture (filtre min/max + affichage) |
| Mails | Description | string | Lecture (filtre mots-clés) |
| Mails | Reference | string | Lecture (filtre + affichage) |
| Mails | NReference | string | Lecture (filtre + affichage) |
| Mails | MailType | int (enum) | Lecture (filtre Options + affichage) |
| Mails | MailStatus | int (enum) | Lecture |
| Mails | ExternalEntityId | int | Lecture (filtre + jointure nom) |
| Mails | MailNatureId | int? | Lecture (filtre + jointure nom) |
| Mails | MailDepartTypeId | int? | Lecture (filtre) |
| Mails | OrganigrammeId | int? | Lecture (non filtré directement ici) |
| Mails | ConfidentialitesId | int? | Lecture (jointure nom) |
| Mails | DestinataireExpediteur | long | Lecture (résolution Direction) |
| Mails | DateEnregistrementCourrier | DateTime? | Lecture (affichage) |
| Mails | TenantId | int? | Filtre implicite ABP |
| MailInputations | MailId, UserId | int / long | Lecture (filtre organigramme : courriers imputés aux utilisateurs de l'organigramme) |
| ExternalEntities | Id, Name | int / string | Lecture (source liste + nom Correspondant) |
| MailNatures | Id, Name | int / string | Lecture (source liste + nom Nature) |
| Organigrammes | Id, Name | int / string | Lecture (source liste + nom Direction) |
| MailDepartTypes | Id, name (MailType) | int / string | Lecture (source liste type de courrier) |
| Roles (AbpRoles) | Id, Name, OrganigrammeId | — | Lecture (mapping organigramme ↔ rôles) |
| Users (AbpUsers) | Id, roles | long | Lecture (users d'un rôle ; rôle → organigramme pour Direction) |
| Confidentialites | Id, Name | int / string | Lecture |

### Règles de gestion / effets de bord / transitions de statut
- **Aucune écriture, aucune transition de statut, aucun effet de bord** (pas de notification, e-mail, drapeau, séquence ou date positionnés). Les champs `Valider`, `ValidationDirection`, `ValidationDG`, `EnregistrementReponse`, `Decharge`, `DateDecharge`, `DateTraited`, `DateButoire`, `DateFollowUp` de `Mail` ne sont **pas** modifiés par cet écran.
- Filtre mots-clés (`Filter`) : `Contains` (sensible à la casse, LINQ→SQL) sur `Title` OU `Description` OU `Reference` OU `NReference`.
- Filtre dates : `Mail.Date >= MinDateFilter` et/ou `Mail.Date <= MaxDateFilter`.
- Filtre `Options` : mappé sur l'enum `MailType` (`"Arrivée"`→Arrivée, `"Départ"`→Départ, `"Interne"`→Interne) ; valeur inconnue et non vide → `ArgumentException`. Si `Options` vide/null, pas de filtre de type.
- Filtre provenance/nature/type-départ : appliqués seulement si l'id est `HasValue` et `> 0` (`ExternalEntityId`, `MailNatureId`, `MailDepartTypeId`).
- Filtre **Organigramme** (logique spécifique, étape préalable) : récupère les rôles dont `OrganigrammeId` = valeur, puis tous les utilisateurs de ces rôles ; les courriers autorisés = **union** de (a) courriers imputés à ces utilisateurs (`MailInputations.UserId`) et (b) courriers dont `Mail.DestinataireExpediteur` ∈ ces utilisateurs. Si l'organigramme est demandé mais ne produit aucun id → retour liste vide. En cas d'erreur pendant ce calcul, le filtre organigramme est ignoré (fallback silencieux).
- **Direction** (colonne) : calculée par courrier — utilisateur `DestinataireExpediteur` → ses rôles → premier rôle ayant un `OrganigrammeId` → `Organigramme.Name`. Vide si non résolu.
- Résolution des libellés (`ExternalEntityName`, `MailNature`, `ConfidentialitesName`) via lookups individuels par courrier, chacun protégé par try/catch renvoyant chaîne vide en cas d'échec.
- `MailTypeName` = `mail.MailType.ToString()` ; `MailDisplayProperty` = `mail.Title`.
- La liste « Type de courrier » alimente `Mail.MailDepartTypeId` (et non `MailType`), issue de `IMailDepartTypesAppService.GetAllList()`.
- Toute exception globale de la recherche est convertie en `UserFriendlyException` incluant message + stack trace (comportement de debug).
- Enum `MailStatus` = { Redaction, Rédigé, Déchargé, Traité, Supprimé } ; enum `MailType` = { Arrivée, Départ, Interne } — référence pour la réimplémentation.
- La grille est vide tant qu'aucune recherche n'a été soumise (`Index` GET initialise `DataSource` à liste vide).


---


## 12. Courrier de Départ (`/App/CourrierDepart`)

### Rôle métier
Page de **saisie / génération d'un courrier sortant** (`MailType = Départ`). Elle permet à un agent d'enregistrer en une seule opération un courrier de départ : renseigner l'objet, le destinataire (entité externe), la date, le **type de courrier de départ** (`MailDepartType`), un **numéro d'enregistrement** (auto-incrémenté), un éventuel **courrier parent** (« en liaison au courrier ») et de **joindre le fichier PDF** (soit un upload direct, soit un document déjà scanné passé par `documentScanneId`). Au clic sur « Valider », le contrôleur crée l'entité `Mail`, intègre le document (GED), lie le document au courrier (et au parent le cas échéant), fait passer le statut à `Rédigé`, marque éventuellement le document scanné comme traité, archive le courrier parent lié, puis envoie des notifications. La page sert donc à la fois d'écran de création et de moteur d'intégration documentaire pour la branche « départ » du workflow courrier. C'est une page de **saisie** (aucune grille de liste), destinée aux agents habilités à produire des courriers sortants.

### Accès & permissions
- **Contrôleur MVC** : `CourrierDepartController` — `src/DocuPro.Web.Mvc/Areas/App/Controllers/DocuCourriers/CourrierDepartController.cs`. Attributs : `[Area("App")]`, `[DisableAuditing]`, `[AbpMvcAuthorize(AppPermissions.Pages_CourrierDepart_Access)]`. Hérite de `DocuProControllerBase`.
- **Service applicatif** : `MailsAppService` (`src/DocuPro.Application/MailBase/MailsAppService.cs`). La classe n'expose pas d'attribut `[AbpAuthorize(...)]` de page dédié pour les méthodes utilisées ici (`CreateOrEdit`, `UpdateMailStatus`, `GetMailDestinataire`, etc.) ; l'autorisation est portée par le contrôleur MVC.
- **Constantes de permission** (`src/DocuPro.Core.Shared/Authorization/AppPermissions.cs`) :
  - `Pages_CourrierDepart_Access = "Pages.CourrierDepart.Access"` (ligne 445) — libellé de traduction `CourrierDepartAccess` (déclaré dans `AppAuthorizationProvider.cs` ligne 452).
  - `Menus_Docu_Courriers_CourrierDepart = "Menus.Docu_Courriers.CourrierDepart"` (ligne 78) — libellé `Courriers_CourrierDepart` (`AppAuthorizationProvider.cs` ligne 54).
- **Entrée de menu** (`src/DocuPro.Web.Mvc/Areas/App/Startup/AppNavigationProvider.cs`, lignes 264-270) : sous le menu **Docu-Courriers**. Nom de page `AppPageNames.Common.CourrierDepart`, libellé `L("CourrierDepart")`, `url: "App/CourrierDepart"`, `icon: "bi bi-envelope-open"`, dépendance de permission `SimplePermissionDependency(requiresAll: true, Pages_CourrierDepart_Access, Menus_Docu_Courriers_CourrierDepart)`. **Aucun badge.**
- **Multi-tenant** : `Mail`, `MailDepartType`, `ExternalEntity` implémentent `IMayHaveTenant` ; le filtre `MayHaveTenant` ABP est **actif** par défaut. À la création (`Create`), `mail.TenantId` est forcé à `AbpSession.TenantId` s'il est non nul. **Exception** : `DocumentScannesAppService.GetFilePath` et `MarkAsProcessed` **désactivent** le filtre `MayHaveTenant` (`UnitOfWorkManager.Current.DisableFilter(AbpDataFilters.MayHaveTenant)`) pour retrouver le document scanné indépendamment du tenant.

### Interface utilisateur
- **Page Razor** : `src/DocuPro.Web.Mvc/Areas/App/Views/CourrierDepart/Index.cshtml`.
- **Script** : **aucun fichier JS dédié** dans `wwwroot/view-resources/Areas/App/Views/CourrierDepart/` (introuvable). Toute la logique client est **inline** dans `Index.cshtml` (fonctions `createAndIntegrate`, `GetMailDestinataire`, `onMailTypeChange`, `updateExternalEntityDropdown`, gestion du bouton `saveExternalEntityButton`). Composants **Syncfusion EJ2** (`ejs-textbox`, `ejs-dropdownlist`, `ejs-datepicker`, `ejs-uploader`, `ejs-maskedtextbox`) + SweetAlert2 (`Swal`).
- **Titre / sous-titre** : `abp-page-subheader` avec `title = L("CourrierDepart")` et `description = L("CourrierDepart")`. Carte interne intitulée `L("InformationsRelativesALaGenerationDuCourrier")` (icône `fas fa-envelope`).

#### Filtres / recherche
— (sans objet : page de saisie, pas de grille ni de filtres).

#### Colonnes du tableau
— (sans objet : aucune grille sur cette page).

#### Actions (boutons)
| Bouton | Effet (endpoint / JS) | Permission |
|---|---|---|
| **Valider** (`onclick="createAndIntegrate()"`) | Valide côté client (objet, date, destinataire, type, fichier/documentScanneId), confirme via `Swal`, puis `POST multipart/form-data` → `/App/CourrierDepart/CreateAndIntegrateCourrierDepart`. Réinitialise le formulaire en cas de succès. | `Pages_CourrierDepart_Access` (contrôleur) |
| **+** (à côté de « Destinataire ») | Ouvre la modale Bootstrap `#addExternalEntityModal` pour créer une entité externe. | — |
| **Save** (`#saveExternalEntityButton`, dans la modale) | `POST /App/AddMail/AddExternalEntity` (JSON) via `Swal.preConfirm`, puis rafraîchit la liste déroulante `ExternalEntityId` via `GET /App/AddMail/getExternalEntity`. **Endpoints portés par `AddMailController`, hors de ce contrôleur.** | — |
| Changement du champ **Destinataire** (`change="GetMailDestinataire"`) | `GET /App/CourrierDepart/GetMailDestinataire?externalEntityId=…` → alimente la liste « En liaison au courrier » (`MailId`). | — |
| Changement du champ **Type de Courrier** (`change="onMailTypeChange"`) | `GET /App/CourrierDepart/GetNextReferenceByMailType?mailTypeId=…` → pré-remplit le champ « Numéro d'enregistrement » (`reference`) avec le prochain numéro du type. | — |

#### Formulaire (carte « Informations relatives à la génération du courrier »)
Formulaire `id="formFileCourrierDeppart"`. Les données sont lues par le contrôleur via `Request.Form[...]` (pas de binding sur le DTO directement). **Colonne de destination = table `Mails`** sauf le fichier.

| Champ (écran) | Nom HTML (`Request.Form`) | Propriété DTO (`CreateOrEditMailDto`) | Colonne `Mails` | Type de contrôle | Obligatoire | Source / valeurs |
|---|---|---|---|---|---|---|
| **Objet** | `Title` | `Title` | `Title` | `ejs-textbox` | **Oui** (validé JS + `[Required]`) | Saisie libre |
| **Destinataire** | `ExternalEntityId` | `ExternalEntityId` | `ExternalEntityId` | `ejs-dropdownlist` (filtrable) | **Oui** (validé JS) | `ViewBag.ExternalEntity` = `ExternalEntitiesAppService.GetAllList()` → `GenericViewModel{Id, Name}` |
| **Date du courrier** | `Date` | `Date` | `Date` | `ejs-datepicker` `format=dd-MM-yyyy` | **Oui** (validé JS) | Parse serveur `DateTime.ParseExact(..., "dd-MM-yyyy")` |
| **Type de Courrier** | `DestinataireExpediteur` (id `DestinataireExpediteurIndex`) | **`MailDepartTypeId`** | **`MailDepartTypeId`** | `ejs-dropdownlist` | **Oui** (validé JS) | `ViewBag.MailType` = `MailDepartTypesAppService.GetAllList()` → `GenericViewModel{Id, Name=name}`. ⚠️ Malgré son nom HTML `DestinataireExpediteur`, ce champ alimente `MailDepartTypeId`, **pas** la colonne `DestinataireExpediteur`. |
| **Numéro d'enregistrement** | `reference` | `NReference` | `NReference` | `ejs-textbox` | Marqué `*` mais **non bloquant** : si vide, le serveur génère via `GetNextNReference()` | Pré-rempli côté client par `onMailTypeChange` (`GetNextReferenceByMailType`) |
| **En liaison au courrier** | `MailId` | `MailParent` (et sert à renseigner `Reference`) | `MailParent` (+ `Reference`) | `ejs-dropdownlist` | Non | Alimenté par `GetMailDestinataire` (courriers de l'entité externe choisie) |
| **Charger document PDF** | `File` (fichier) | — (hors DTO) | — (intégré en GED, lié via `MailDocuments`) | `ejs-uploader` `allowedExtensions=.pdf`, `autoUpload=false` | Oui **sauf si** `documentScanneId` présent (validé JS) | Upload direct. Ligne masquée si `ViewBag.DocumentScanneId != null`. |
| *(caché)* `documentScanneIdValue` | `documentScanneId` (ajouté par JS au `FormData`) | — | — | `input hidden` | Non | `ViewBag.DocumentScanneId` (query string `documentScanneId`) |

**Champs lus par le contrôleur mais SANS champ d'écran correspondant dans cette vue** (valeurs par défaut appliquées) :
- `Request.Form["Description"]` → `Description` → `Mails.Description` : absent du formulaire ⇒ `null`.
- `Request.Form["DateRappel"]` → `DateFollowUp` → `Mails.DateFollowUp` : absent du formulaire ⇒ `null`.
- `Request.Form["ConfidentialiteId"]` → `ConfidentialitesId` → `Mails.ConfidentialitesId` : absent ⇒ défaut **`1`** (le `TryParse` échoue, la variable reste initialisée à 1).
- `Request.Form["NatureId"]` → dans `CreateAndIntegrateCourrierDepart` **non utilisé** pour `MailNatureId` (voir plus bas) ; lu mais ignoré.

**Modale « Ajouter une entité externe »** (`#addExternalEntityModal`) — champs `ExternalEntityTypeId` (`ejs-dropdownlist` sur `ViewBag.ExternalEntityType`), `Name` (requis), `Telephone` (`ejs-maskedtextbox` `00 00 00 00 00`), `Email`, `FirstName`, `LastName`. Soumis à `/App/AddMail/AddExternalEntity`. Ces champs ne concernent pas `MailsAppService` (création d'`ExternalEntity` déléguée à `AddMailController`).

### Service applicatif & opérations
- **Interface** : `IMailsAppService` — `src/DocuPro.Application.Shared/MailBase/IMailsAppService.cs`.
- **Implémentation** : `MailsAppService` — `src/DocuPro.Application/MailBase/MailsAppService.cs`.
- Services auxiliaires : `IExternalEntitiesAppService`, `IExternalEntityTypesAppService`, `IMailNaturesAppService`, `IMailDepartTypesAppService`, `IDocumentModelsAppService`, `IDocumentAddAppService` (`Common/DocumentAddAppService.cs`), `IMailDocumentsAppService`, `IDocumentScannesAppService` (`DocumentBase/DocumentScannesAppService.cs`), `IAppNotifier` (`Core/Notifications/AppNotifier.cs`), `IBinaryObjectManager`, `IUserAppService`.

**Méthodes de `MailsAppService` utilisées par la page**
| Méthode | Entrée | Sortie | Description |
|---|---|---|---|
| `CreateOrEdit` | `CreateOrEditMailDto` | `Task<int?>` | Si `Id == null` → `Create` (retourne le nouvel Id) ; sinon `Update` (retourne `null`). |
| `Create` *(protected)* | `CreateOrEditMailDto` | `int` (mailId) | `ObjectMapper.Map<Mail>` ; force `TenantId` ; force `DateButoire` ; renseigne `OrganigrammeId` = 1er organigramme du `DestinataireExpediteur` ; `InsertAndGetIdAsync` ; vide caches `MailsCache`/`ParapheurCache`/`CourrierDepartCache`. |
| `Update` *(protected)* | `CreateOrEditMailDto` | `Task` | `FirstOrDefaultAsync(Id)` + `ObjectMapper.Map` + `DateButoire` ; vide les 3 caches. (Non emprunté par le flux de création départ.) |
| `GetMailForView` | `int id` | `GetMailForViewDto` | Utilisé pour lire la `Reference` du courrier parent (ligne 153). |
| `GetAllMailsDescriptionAndId` | — | `List<GetMailForViewDto>` | Sert à (a) alimenter `ViewBag.mail`, (b) récupérer le dernier courrier créé (`OrderByDescending(m => m.Mail.Id).FirstOrDefault()`). |
| `GetMailDestinataire` | `int externalEntityId` | `List<GetMailForViewDto>` | Retourne les courriers rattachés à l'entité externe (via `ExternalEntityId`), incl. `ConfidentialitesFk`. Alimente le dropdown « En liaison au courrier ». |
| `UpdateMailStatus(int, MailStatus, DateTime)` | mailId, statut, dateDecharge | `Task` | Positionne `MailStatus` **et `DateDecharge`** ; vide `MailsCache`. Appelée avec (`newMail.Id`, `Rédigé`, `DateTime.Now`). |
| `GetAllMailsWithoutFilter` | — | `List<MailDto>` | Tous les courriers sans filtre (utilisé par `GetNextNReference`). |
| `GetDepartMailsByMailDepartTypeId` | `int mailDepartTypeId` | `List<MailDto>` | Courriers `MailType == Départ` filtrés par `MailDepartTypeId` (via réflexion) ; utilisé par `GetNextReferenceByMailType`. |
| `ArchiverCourrier` | `int mailId` | `Task` | Positionne `DateTraited = DateTime.Now` sur le courrier **parent** ; vide les 3 caches. |

**Autres services**
| Méthode | Signature | Effet |
|---|---|---|
| `DocumentAddAppService.AddDocumentAsync` | `(string name, DateTime dateDocument, int documentTypeId, int? documentClassificationId, int? documentConfidentialitesId, IFormFile file, int documentState, int? dossierId)` → `Task<int>` | Intègre le fichier en GED et retourne le `DocumentId`. Appelée avec `name = file.Name` (⚠️ = **nom du champ de formulaire** `"File"`, pas le nom réel du fichier), `dateDocument = DateTime.Now`, `documentTypeId = _OutgoingMailDocumentTypeId`, `documentClassificationId = null`, **`documentConfidentialitesId = 1`** (argument positionnel), `documentState = default` (**`0`**, passé via le mot-clé `default`), `dossierId = _generalDossierId`. |
| `MailDocumentsAppService.CreateOrEdit` | `CreateOrEditMailDocumentDto` | Crée le lien courrier↔document (table `MailDocuments`). |
| `DocumentScannesAppService.GetFilePath` | `(int id)` → `Task<string>` | Chemin du document scanné (filtre tenant désactivé). |
| `DocumentScannesAppService.MarkAsProcessed` | `(int id, int mailId, int documentId)` | Positionne `IsTraite = true`, `MailId`, `DocumentId` sur le `DocumentScanne` (filtre tenant désactivé). |
| `AppNotifier.NotificationCourrierDepartAsync` | `(int courrierDepartId, int? courrierParentId)` | Envoie notifications/e-mails (voir effets de bord). |

**Actions MVC du contrôleur** (`CourrierDepartController`)
| Action | Signature | Retour |
|---|---|---|
| `Index` | `Index(int? mailId = null, int? documentScanneId = null)` | `View()`. Remplit `ViewBag` : `DocumentScanneId`, `mail`, `DocumentModels`, `ExternalEntity`, `ExternalEntityType`, `Nature`, `MailType` (= `MailDepartTypes`), `NextNReference` (= `GetNextNReference()`). |
| `CreateAndIntegrateCourrierDepart` | `[HttpPost]` — lit `Request.Form` (multipart) | `Json{ success, mailId, message }` ou `BadRequest{ message }`. **Action principale** (voir séquence). |
| `GenererWordDocument` | `[HttpPost]` — lit `Request.Form` | `Ok()` / `BadRequest`. Crée un `Mail` `Départ` (`MailNatureId = NatureId`, `DestinataireExpediteur = form.DestinataireExpediteur`, **sans** `MailDepartTypeId`, **sans** intégration de fichier). ⚠️ **Non référencée** par la vue actuelle (`Index.cshtml` n'appelle que `CreateAndIntegrateCourrierDepart`). |
| `GetMailDestinataire` | `[HttpGet]` `(int externalEntityId)` | `Json` de `GenericViewModel{ Id, Name = Reference + " " + Title }` triés par `CreationTime`/`Date` décroissant. Renseigne aussi `ViewBag.OutboundMails`. |
| `GetNextReferenceByMailType` | `[HttpGet]` `(int mailTypeId)` | `Json{ success, nextReference }` — max numérique des `NReference` des départs du type + 1, formaté `D5`. |
| `GetNextNReference` *(private)* | `()` → `Task<string>` | Max numérique des `NReference` de **tous** les courriers + 1, formaté `D5` (défaut `"00001"`). |
| `PerformMailMerge` *(private)* | `(byte[] templateContent, List<MailMergeDto>, string reference, string Date, string Title)` → `WordDocument` | Fusion de publipostage Syncfusion DocIO (remplacements `%PROP%`, `%REFERENCE%`, `%DATE%`, `%TITRE%`). Utilitaire non branché dans le flux HTTP courant. |

### DTOs

**`CreateOrEditMailDto`** — `src/DocuPro.Application.Shared/MailBase/Dtos/CreateOrEditMailDto.cs` (hérite `EntityDto<int?>` → propriété `Id`). Mappé vers `Mail` (`CustomDtoMapper.cs` ligne 141 : `CreateMap<CreateOrEditMailDto, Mail>().ReverseMap()`).
| Propriété | Type C# | Obligatoire | Description / usage sur cette page |
|---|---|---|---|
| `Id` | `int?` | Non | `null` en création (départ crée toujours). |
| `Title` | `string` | **`[Required]`** | Objet du courrier. |
| `Date` | `DateTime` | — | Date du courrier. |
| `DateFollowUp` | `DateTime?` | Non | ← `DateRappel` (absent de la vue ⇒ `null`). |
| `Description` | `string` | Non | ← `Description` (absent ⇒ `null`). |
| `NReference` | `string` | Non | Numéro d'enregistrement (form `reference` ou auto). |
| `MailType` | `MailType` (enum) | — | Forcé à **`MailType.Départ` (1)**. |
| `MailStatus` | `MailStatus` (enum) | — | Non défini au `Create` ⇒ défaut `Redaction (0)` ; passe à `Rédigé (1)` après intégration du fichier. |
| `Reference` | `string` | Non | = `Reference` du courrier parent si `MailId` fourni, sinon `null`. |
| `ConfidentialitesId` | `int?` | Non | ← `ConfidentialiteId` (absent ⇒ défaut `1`). |
| `MailParent` | `int?` | Non | ← `MailId` (courrier lié). |
| `ExternalEntityId` | `int?` | Non | Destinataire (entité externe). |
| `MailNatureId` | `int?` | Non | Dans `CreateAndIntegrate` = **`_mailTypeId`** (`settings.MailTypeId`). Dans `GenererWordDocument` = `NatureId` du form. |
| `MailObjetId` | `int?` | Non | Non renseigné par cette page. |
| `MailDepartTypeId` | `int?` | Non | ← champ « Type de Courrier » (form `DestinataireExpediteur`). |
| `DestinataireExpediteur` | `long?` | Non | Dans `CreateAndIntegrate` = **`AbpSession.UserId`** (émetteur = utilisateur courant). Dans `GenererWordDocument` = form `DestinataireExpediteur`. |
| `DateTraited` | `DateTime?` | Non | Non renseigné par cette page. |
| `DateButoire` | `DateTime?` | Non | Non renseigné ici (mais recopié explicitement dans `Create`/`Update`). |
| `DateEnregistrementCourrier` | `DateTime?` | Non | Non renseigné par cette page. |
| `OrganigrammeId` | `int?` | Non | Non renseigné par le contrôleur ; **écrasé** dans `Create` (1er organigramme du destinataire). |

**`CreateOrEditMailDocumentDto`** — `src/DocuPro.Application.Shared/MailBase/Dtos/CreateOrEditMailDocumentDto.cs` (hérite `EntityDto<int?>`). Table cible `MailDocuments`.
| Propriété | Type C# | Obligatoire | Description |
|---|---|---|---|
| `Id` | `int?` | Non | `null` en création. |
| `Date` | `DateTime` | Non | Non renseigné ici (défaut). |
| `MailId` | `int` | — | = `newMail.Mail.Id` (et = `MailId` parent pour le second lien). |
| `DocumentId` | `int` | — | = `documentId` retourné par `AddDocumentAsync`. |
| `ConfidentialitesId` | `int` | Non | Non renseigné ici. |
| `Decharge` | `bool` | — | Forcé à `false`. |

**`MailDto`** (sortie) — `src/DocuPro.Application.Shared/MailBase/Dtos/MailDto.cs` (hérite `EntityDto` → `Id` int). Retourné par `GetAllMailsWithoutFilter` et `GetDepartMailsByMailDepartTypeId` (pour le calcul des numéros).
| Propriété | Type C# | Description |
|---|---|---|
| `Id` | `int` | Id du courrier. |
| `Title` | `string` | Objet. |
| `Date` | `DateTime` | Date. |
| `DateFollowUp` | `DateTime?` | Date de rappel. |
| `DateReglementaire` | `DateTime?` | (non peuplé par ces requêtes). |
| `Description` | `string` | Description. |
| `NReference` | `string` | Numéro d'enregistrement (base du calcul du prochain numéro). |
| `MailType` | `MailType` | Type de courrier. |
| `MailStatus` | `MailStatus` | Statut. |
| `Reference` | `string` | Référence. |
| `ConfidentialitesId` | `int?` | Confidentialité. |
| `MailParent` | `int?` | Courrier parent. |
| `ExternalEntityId` | `int?` | Entité externe. |
| `MailObjetId` | `int?` | Objet du courrier. |
| `MailNatureId` | `int?` | Nature. |
| `DestinataireExpediteur` | `long` | Destinataire/expéditeur. |
| `DateTraited` | `DateTime?` | Date de traitement. |
| `DateDecharge` | `DateTime?` | Date de décharge. |
| `DateEnregistrementCourrier` | `DateTime?` | Date d'enregistrement. |

**`GetMailForViewDto`** (sortie) — `src/DocuPro.Application.Shared/MailBase/Dtos/GetMailForViewDto.cs`. Retourné par `GetMailForView`, `GetMailDestinataire`, `GetAllMailsDescriptionAndId`.
| Propriété | Type C# | Description |
|---|---|---|
| `Mail` | `MailDto` | Le courrier (voir ci-dessus). |
| `ConfidentialitesName` | `string` | Libellé confidentialité. |
| `MailDisplayProperty` | `string` | Chaîne d'affichage. |
| `DateEnregistrementCourrier` | `DateTime?` | Date d'enregistrement. |
| `CreationTime` | `DateTime` | Date de création (tri de `GetMailDestinataire`). |
| `ExternalEntityName` | `string` | Nom de l'entité externe. |
| `MailTypeName` | `string` | Nom du type. |
| `MailNature` | `string` | Nature. |
| `LongDescription` | `string` | Description longue. |
| `Description` | `string` | Description. |
| `Direction` | `string` | Direction. |
| `MailObjet` | `string` | Objet. |
| `Statut` | `string` | Statut lisible. |
| `LastImputationFullName` | `string` | Dernière imputation. |
| `DateRapel` | `DateTime?` | Date de rappel. |
| `UserCreated` | `string` | Créateur. |
| `DateDecharge` | `DateTime?` | Date de décharge. |
| `DestinataireFullName` | `string` | Destinataire. |
| `DestinataireExpediteurId` | `long` | Id destinataire/expéditeur. |
| `InputationTypeName` | `string` | Type d'imputation. |
| `Deadline` | `DateTime?` | Échéance. |

**`GenericViewModel`** (view model MVC) — `src/DocuPro.Web.Mvc/ViewModels/GenericViewModel.cs` — utilisé pour peupler les dropdowns et le JSON de `GetMailDestinataire` : `Id`(int), `Name`(string), `Name2`(string), `Valeur`(int), `Date`(DateTime, get-only). Sur cette page seuls `Id` et `Name` sont renseignés.

### Tables & colonnes impactées

**Table `Mails`** — entité `Mail` (`src/DocuPro.Core/MailBase/Mail.cs`), `[Table("Mails")]`, `[Audited]`, base ABP `FullAuditedEntity`, interface `IMayHaveTenant`. DbSet `Mails` (`DocuProDbContext.cs` ligne 102). Index : `HasIndex(TenantId)` (`DocuProDbContext.cs` lignes 349-352 et 357-360, déclaré deux fois).

| Table | Colonne | Type CLR | Lecture / Écriture (cette page) |
|---|---|---|---|
| `Mails` | `Id` | `int` (PK) | Lecture (récup. dernier courrier, parent) |
| `Mails` | `TenantId` | `int?` | Écriture (`Create`, = `AbpSession.TenantId`) |
| `Mails` | `Title` | `string` (Required) | Écriture |
| `Mails` | `Date` | `DateTime` (Required) | Écriture |
| `Mails` | `Description` | `string` | Écriture (`null` faute de champ UI) |
| `Mails` | `Reference` | `string` | Écriture (= `Reference` du parent ou `null`) |
| `Mails` | `MailType` | `MailType` (enum) | Écriture (`Départ`) |
| `Mails` | `MailStatus` | `MailStatus` (enum) | Écriture (`Redaction` puis `Rédigé`) |
| `Mails` | `NReference` | `string` | Lecture (calcul du prochain n°) + Écriture |
| `Mails` | `DateFollowUp` | `DateTime?` | Écriture (`null` faute de champ UI) |
| `Mails` | `DateDecharge` | `DateTime?` | Écriture (positionné par `UpdateMailStatus(..., DateTime.Now)`) |
| `Mails` | `DateTraited` | `DateTime?` | Écriture **sur le parent** (`ArchiverCourrier`) |
| `Mails` | `DateButoire` | `DateTime?` | Écriture (recopie explicite ; ici `null`) |
| `Mails` | `DateEnregistrementCourrier` | `DateTime?` | Non écrit par cette page |
| `Mails` | `DestinataireExpediteur` | `long` (FK `AbpUsers`) | Écriture (= `AbpSession.UserId`) |
| `Mails` | `MailNatureId` | `int?` (FK `MailNatures`) | Écriture (= `settings.MailTypeId`) |
| `Mails` | `ConfidentialitesId` | `int?` (FK `Confidentialites`) | Écriture (défaut `1`) |
| `Mails` | `ExternalEntityId` | `int` (FK `ExternalEntities`) | Écriture |
| `Mails` | `MailParent` | `int?` (FK auto-réf. `Mails`) | Écriture (= `MailId`) |
| `Mails` | `MailObjetId` | `int?` (FK `MailObjets`) | Non écrit |
| `Mails` | `OrganigrammeId` | `int?` (FK `Organigrammes`) | Écriture (1er organigramme du destinataire = utilisateur courant) |
| `Mails` | `MailDepartTypeId` | `int?` (FK `MailTypes`) | Écriture (= champ « Type de Courrier ») |
| `Mails` | `Valider`, `ValidationDirection`, `ValidationDG`, `EnregistrementReponse`, `Decharge` | `bool` (défaut `false`) | Non modifiés par cette page (restent `false`) |
| `Mails` | `EndDateFollowUp` | `DateTime?` | Non écrit |
| `Mails` | audit (`CreationTime`, `CreatorUserId`, `LastModificationTime`, `LastModifierUserId`, `IsDeleted`, `DeleterUserId`, `DeletionTime`) | — | Géré par ABP |

**Table `MailTypes`** — entité **`MailDepartType`** (`src/DocuPro.Core/MailBase/MailType.cs`), `[Table("MailTypes")]`, `FullAuditedEntity`, `IMayHaveTenant`. DbSet `MailTypes` (`DocuProDbContext.cs` ligne 32). Index `HasIndex(TenantId)` (lignes 213-216).
| Table | Colonne | Type CLR | Lecture / Écriture |
|---|---|---|---|
| `MailTypes` | `Id` | `int` (PK) | Lecture (dropdown, filtre numérotation) |
| `MailTypes` | `TenantId` | `int?` | Lecture |
| `MailTypes` | `name` | `string` (Required) | Lecture (libellé dropdown « Type de Courrier ») |

**Table `ExternalEntities`** — entité `ExternalEntity` (`src/DocuPro.Core/CommonEntities/ExternalEntity.cs`), `[Table("ExternalEntities")]`, `[Audited]`, `FullAuditedEntity`, `IMayHaveTenant`. DbSet `ExternalEntities` (ligne 150).
| Table | Colonne | Type CLR | Lecture / Écriture |
|---|---|---|---|
| `ExternalEntities` | `Id` | `int` (PK) | Lecture (dropdown Destinataire, jointures) |
| `ExternalEntities` | `Name` | `string` (Required) | Lecture (libellé, provenance notification) |
| `ExternalEntities` | `Email`, `Telephone`, `ExternalEntityTypeId` | — | Non lus par cette page (création déléguée à `AddMailController`) |

**Table `MailDocuments`** — entité `MailDocument` (`src/DocuPro.Core/MailBase/MailDocument.cs`). **Écriture** via `MailDocumentsAppService.CreateOrEdit` : une ligne pour le courrier de départ, plus une seconde pour le parent si `MailId` fourni (`MailId`, `DocumentId`, `Decharge = false`).

**Table `DocumentScannes`** (lookup, cas `documentScanneId`) — `DocumentScannesAppService` : **lecture** de `FilePath` (`GetFilePath`), **écriture** de `IsTraite = true`, `MailId`, `DocumentId` (`MarkAsProcessed`). Filtre `MayHaveTenant` désactivé.

**Tables de référence lues (via `ViewBag`) sans écriture** : `MailNatures` (`ViewBag.Nature`, non exploité par un champ UI), `ExternalEntityTypes` (modale), `DocumentModels` (`ViewBag.DocumentModels`, non exploité). La GED (documents, dossiers) est écrite indirectement par `DocumentAddAppService.AddDocumentAsync` (`documentTypeId = OutgoingMailDocumentTypeId`, `dossierId = GeneralDossierId`).

### Règles de gestion / effets de bord / transitions de statut

**Séquence complète de `CreateAndIntegrateCourrierDepart`** :
1. Lecture des champs `Request.Form`. Parse `Date` en `dd-MM-yyyy` (échec ⇒ exception ⇒ `BadRequest`).
2. **Numérotation** : si `reference` vide, `NReference` = `GetNextNReference()` = (max numérique des `NReference` de **tous** les courriers) + 1, formaté sur 5 chiffres (`D5`), défaut `"00001"`. Le client peut aussi pré-remplir via `GetNextReferenceByMailType` (max par `MailDepartTypeId`).
3. Construction du `CreateOrEditMailDto` : `MailType = Départ`, `MailDepartTypeId = form.DestinataireExpediteur`, `DestinataireExpediteur = AbpSession.UserId`, `MailNatureId = settings.MailTypeId`, `MailParent = MailId`, `Reference = parent.Reference` (si lié).
4. `CreateOrEdit` → `Create` : insertion `Mail` (statut initial `Redaction (0)`), `TenantId` forcé, `OrganigrammeId` = 1er organigramme du destinataire (= utilisateur courant), vidage caches.
5. Récupération du **dernier** courrier (`GetAllMailsDescriptionAndId().OrderByDescending(Id).First()`) comme `newMail`. Si `null` ⇒ `BadRequest`.
6. **Résolution du fichier** : upload `File` prioritaire ; sinon si `documentScanneId` fourni, lecture du chemin (`GetFilePath`) et chargement en `FormFile` (introuvable ⇒ `BadRequest`).
7. Si fichier présent : `AddDocumentAsync` (type `OutgoingMailDocumentTypeId`, `documentClassificationId = null`, `documentConfidentialitesId = 1`, `documentState = default (0)`, `dossierId = GeneralDossierId`) → `documentId` ; création `MailDocument(newMail, documentId, Decharge=false)` ; si parent, second `MailDocument(MailId, documentId, false)` ; **`UpdateMailStatus(newMail.Id, MailStatus.Rédigé, DateTime.Now)`** → `MailStatus = Rédigé (1)` **et `DateDecharge = DateTime.Now`** ; si `documentScanneId`, `MarkAsProcessed` (le scan disparaît de la liste « Documents scannés »).
8. Si `MailId` (parent) : `ArchiverCourrier(MailId)` → `parent.DateTraited = DateTime.Now` (dans un `try/catch` : un échec n'interrompt pas). 
9. `NotificationCourrierDepartAsync(newMail.Id, MailId)` (dans un `try/catch` non bloquant).
10. Réponse `Json{ success = true, mailId, message }`.

**Transitions de `MailStatus`** : `Redaction (0)` à la création → `Rédigé (1)` après intégration du fichier. Aucune autre transition ici. **Aucun** des drapeaux `Valider`, `ValidationDirection`, `ValidationDG`, `EnregistrementReponse`, `Decharge` n'est modifié (restent `false`).

**Dates positionnées** : `DateDecharge = DateTime.Now` (effet de bord de l'overload `UpdateMailStatus(int, MailStatus, DateTime)` — la date passée alimente `DateDecharge` même si l'appel vise seulement à passer le statut à `Rédigé`) ; `DateTraited = DateTime.Now` **sur le parent** (`ArchiverCourrier`) ; `OrganigrammeId` dérivé du destinataire. `DateFollowUp`, `DateEnregistrementCourrier`, `DateButoire` non positionnées (restent `null`).

**Effets de bord / intégrations** :
- **GED** : création d'un document sortant (`OutgoingMailDocumentTypeId`) dans `GeneralDossierId`, lié via `MailDocuments` au courrier de départ **et** au courrier parent.
- **Documents scannés** : le scan source est marqué `IsTraite = true` (+ `MailId`, `DocumentId`) et sort de la file d'attente.
- **Notifications** (`NotificationCourrierDepartAsync`) : construit provenance (`ExternalEntity.Name`), type (`MailDepartType.name`), courrier lié (`parent.NReference - Title`), nom de fichier, créateur ; puis, si courrier lié, notifie le **destinataire du courrier parent**, les personnes **« En Copie »** et les autres imputations du parent (via `MailInputations`). Envoi non bloquant.
- **Cache** : `Create`, `Update`, `ArchiverCourrier` vident `MailsCache`, `ParapheurCache`, `CourrierDepartCache` ; `UpdateMailStatus` vide `MailsCache`.
- **Idempotence** : aucune. Chaque `POST` crée un nouveau courrier ; l'identification du « dernier créé » repose sur `Max(Id)` (hypothèse : pas de création concurrente entre l'insert et la relecture).

**Différences notables vs Courrier d'Arrivée** (observées sur cette page) :
- `MailType = Départ (1)` (au lieu de `Arrivée (0)`).
- Le champ **« Type de Courrier »** alimente `MailDepartTypeId` (spécifique aux départs) ; le libellé HTML `DestinataireExpediteur` est trompeur.
- `Mail.DestinataireExpediteur` = **utilisateur courant** (`AbpSession.UserId`, l'émetteur), et non un destinataire choisi.
- `MailNatureId` = `settings.MailTypeId` (valeur de configuration), non saisie par l'utilisateur.
- Type de document GED = `OutgoingMailDocumentTypeId` (document sortant).
- Numérotation `NReference` par type de départ (`GetNextReferenceByMailType`) en plus de la numérotation globale.
- Le courrier peut être **en liaison** à un courrier existant (`MailParent`), ce qui déclenche double liaison documentaire, archivage du parent et notifications ciblées.
- Passage direct au statut `Rédigé` (pas de circuit d'imputation/validation depuis cette page).


---


## 13. Intégration Décharge (`/App/IntegrationDecharge`)

### Rôle métier

Page de **saisie / traitement** qui clôt le cycle d'un **courrier de départ** (`MailType.Départ`) en y intégrant la **preuve de décharge** (le PDF signé/tamponné renvoyé par le destinataire). L'agent sélectionne un courrier de départ **non encore déchargé**, fournit le fichier PDF de décharge (soit par upload manuel, soit à partir d'un **document scanné** déposé automatiquement par le service Windows), puis valide. Le système enregistre le PDF comme `Document`, le rattache au courrier via une ligne `MailDocument` marquée `Decharge = true` (et au courrier parent le cas échéant), fait passer le courrier au statut `MailStatus.Déchargé` en horodatant `DateDecharge`, archive le courrier (`DateTraited`), marque le document scanné source comme traité (`MarkAsProcessed`) pour qu'il quitte la file d'attente, puis envoie une notification. C'est l'écran repéré par le badge de menu `integrationDecharge`; il peut être ouvert directement depuis la liste des documents scannés via le paramètre de requête `documentScanneId`, auquel cas la zone d'upload est masquée et le fichier est rechargé depuis le disque.

### Accès & permissions

- **Contrôleur MVC** : `IntegrationDechargeController` — `src/DocuPro.Web.Mvc/Areas/App/Controllers/DocuCourriers/IntegrationDechargeController.cs`. Attributs de classe : `[Area("App")]`, `[DisableAuditing]`, `[AbpMvcAuthorize(AppPermissions.Pages_IntegrationDecharge_Access)]`. Hérite de `DocuProControllerBase`.
- **Services applicatifs sollicités** :
  - `IMailsAppService` → `MailsAppService` (`src/DocuPro.Application/MailBase/MailsAppService.cs`), protégé par `[AbpAuthorize(AppPermissions.StandardUser)]` (attribut de classe, ligne 45).
  - `IDocumentScannesAppService` → `DocumentScannesAppService` (`src/DocuPro.Application/DocumentBase/DocumentScannesAppService.cs`), protégé par `[AbpAuthorize(AppPermissions.Menus_Docu_Courriers_DocumentsScannes)]`.
  - `IDocumentAddAppService` → `DocumentAddAppService` (`src/DocuPro.Application/Common/DocumentAddAppService.cs`).
  - `IMailDocumentsAppService` → `MailDocumentsAppService` (`src/DocuPro.Application/MailBase/MailDocumentsAppService.cs`) ; la méthode `CreateOrEdit` porte `[AbpAllowAnonymous]`.
  - `IAppNotifier` → `AppNotifier` (`src/DocuPro.Core/Notifications/AppNotifier.cs`).
- **Constantes de permission** (`src/DocuPro.Core.Shared/Authorization/AppPermissions.cs`) :
  - `Pages_IntegrationDecharge` = `"Pages.IntegrationDecharge"` (ligne 452)
  - `Pages_IntegrationDecharge_Access` = `"Pages.IntegrationDecharge.Access"` (ligne 453) — exigée par le contrôleur.
  - `Menus_Docu_Courriers_IntegrationDecharge` = `"Menus.Docu_Courriers.IntegrationDecharge"` (ligne 80) — exigée par le menu.
- **Déclaration / libellés de traduction** (`src/DocuPro.Core/Authorization/AppAuthorizationProvider.cs`) :
  - ligne 56 : `docucourriers.CreateChildPermission(AppPermissions.Menus_Docu_Courriers_IntegrationDecharge, L("Courriers_IntegrationDecharge"))`
  - ligne 459 : `pages.CreateChildPermission(AppPermissions.Pages_IntegrationDecharge, L("IntegrationDecharge"))`
  - ligne 460 : `integrationDecharge.CreateChildPermission(AppPermissions.Pages_IntegrationDecharge_Access, L("IntegrationDechargeAccess"))`
- **Entrée de menu** (`src/DocuPro.Web.Mvc/Areas/App/Startup/AppNavigationProvider.cs`, lignes 278-285) : nom `AppPageNames.Common.IntegrationDecharge` (= `"IntegrationDecharge"`, `AppPageNames.cs` ligne 100), libellé `L("IntegrationDecharge")`, url `App/IntegrationDecharge`, icône `bi bi-plug`, dépendance de permission `SimplePermissionDependency(requiresAll: true, Pages_IntegrationDecharge_Access, Menus_Docu_Courriers_IntegrationDecharge)`, `customData = new { badgeKey = "integrationDecharge" }`.
- **Multi-tenant** : le contrôleur est audité-désactivé (`[DisableAuditing]`). `DocumentScannesAppService` **désactive** le filtre `MayHaveTenant` (`UnitOfWorkManager.Current.DisableFilter(AbpDataFilters.MayHaveTenant)`) dans `GetFilePath` et `MarkAsProcessed` — les documents scannés sont visibles/modifiables hôte + tenant courant. `MailDocumentsAppService.Create` renseigne `TenantId` à partir de `AbpSession.TenantId` s'il est non nul. Les requêtes `MailsAppService` (`GetMailNoDecharge`, `GetMailForView`) s'exécutent sous le filtre tenant standard.

### Interface utilisateur

- **Page Razor** : `src/DocuPro.Web.Mvc/Areas/App/Views/IntegrationDecharge/Index.cshtml`.
- **Script** : **inline dans la vue** (bloc `<script>` lignes 113-206, fonction `integrateMail()`). Aucun fichier `Index.js` / `view-resources` dédié n'existe pour cette page (confirmé par recherche).
- **Titre / sous-titre affichés** : `abp-page-subheader` avec titre `L("DocuCourriers")` et description `L("IntegrationDecharge")` ; en-tête de carte `L("IntegrerDechargeCourrierDepart")` (icône `fas fa-file-download`).
- **Composants** : Syncfusion (`ejs-dropdownlist`, `ejs-uploader`), confirmations SweetAlert2 (`Swal`), overlay `#loader`.

#### Filtres / recherche

— (sans objet) : la page n'a pas de grille filtrable. Le seul « filtre » est la liste déroulante de sélection du courrier (voir Formulaire).

#### Colonnes du tableau

— (sans objet) : pas de grille sur cette page.

#### Actions (boutons)

| Bouton | Effet (endpoint / JS) | Permission |
|---|---|---|
| **Décharger** (`L("Decharger")`, icône `fa fa-check-circle`) | `onclick="integrateMail()"` : valide la sélection (courrier obligatoire ; fichier obligatoire sauf si `documentScanneId` présent), demande confirmation `Swal`, puis `fetch POST /App/IntegrationDecharge/IntegrationDecharge` avec un `FormData` (`mailId`, `File`, éventuel `documentScanneId`). En succès : message puis `window.location.reload()`. | Héritée de la page (`Pages_IntegrationDecharge_Access`) |

#### Formulaire(s) / Modale(s)

Formulaire `#formFileDechargeeMail` (pas de modale). Tous les champs :

| Champ (écran) | Propriété / paramètre serveur | Type de contrôle | Obligatoire | Source / valeurs |
|---|---|---|---|---|
| Courrier de départ (`L("CourrierDepartPlaceholder")`) | `mailId` (paramètre POST `int mailId`) — la valeur est `Mail.Id` de l'élément sélectionné | `ejs-dropdownlist` (`showClearButton`, `popupHeight="220px"`) ; `text = LongDescription`, `value = Mail.Id` | Oui (validé côté JS : `L("VeuillezSelectionnerUnCourrierDepart")`) | `dataSource = ViewBag.OutboundMails` = `List<GetMailForViewDto>` issu de `IMailsAppService.GetMailNoDecharge()` (courriers `Départ` sans décharge) |
| Fichier de décharge (PDF) (`L("ChargerDocumentPDF")`) | `File` (paramètre POST `IFormFile File`, lu aussi via `Request.Form.Files.FirstOrDefault()`) | `ejs-uploader` (`allowedExtensions=".pdf"`, `autoUpload="false"`) | Oui **sauf si** `documentScanneId` fourni. La ligne `#fileUploadRowDecharge` est masquée quand `ViewBag.DocumentScanneId != null`. Validation JS : `L("VeuillezSelectionnerUnFichier")` | Upload utilisateur |
| (masqué) Id du document scanné | champ caché `#documentScanneIdValue` → ajouté au `FormData` sous la clé `documentScanneId` → lu serveur via `Request.Form["documentScanneId"]` | `<input type="hidden">` (valeur = `ViewBag.DocumentScanneId ?? ""`) | Non | Renseigné par le paramètre de requête `Index(int? documentScanneId)` (provenance : liste « Documents scannés ») |

### Service applicatif & opérations

**Interfaces / implémentations** :
- `IMailsAppService` (`src/DocuPro.Application.Shared/MailBase/IMailsAppService.cs`) / `MailsAppService` (`src/DocuPro.Application/MailBase/MailsAppService.cs`).
- `IDocumentScannesAppService` / `DocumentScannesAppService` (`src/DocuPro.Application/DocumentBase/DocumentScannesAppService.cs`).
- `IDocumentAddAppService` / `DocumentAddAppService` (`src/DocuPro.Application/Common/DocumentAddAppService.cs`).
- `IMailDocumentsAppService` / `MailDocumentsAppService` (`src/DocuPro.Application/MailBase/MailDocumentsAppService.cs`).
- `IAppNotifier` / `AppNotifier` (`src/DocuPro.Core/Notifications/AppNotifier.cs`).

**Méthodes de service utilisées par cette page** :

| Méthode | Entrée | Sortie | Description |
|---|---|---|---|
| `MailsAppService.GetMailNoDecharge()` | — | `List<GetMailForViewDto>` | Courriers `MailType.Départ` n'ayant **aucun** `MailDocument` avec `Decharge = true` (jointure externe `md == null`), triés `Id desc`. Construit `Mail` (sous-ensemble de colonnes) + `LongDescription` (`Title - ExternalEntity.Name - Date(yyyy-MM-dd) - NReference`) + `ExternalEntityName`. Alimente la liste déroulante. |
| `MailsAppService.GetMailForView(int id)` | `mailId` | `GetMailForViewDto` | Charge le courrier (Includes : `ConfidentialitesFk`, `ExternalEntityFk`, `MailNatureFk`, `DestinataireExpediteurFk`, `MailObjetFk`) — le contrôleur ne s'en sert que pour lire `mail.Mail.MailParent`. Lève `EntityNotFoundException` si introuvable. |
| `DocumentScannesAppService.GetFilePath(int id)` | `documentScanneId` | `string` (chemin `FilePath`) | Renvoie le chemin disque du `DocumentScanne`, filtre tenant désactivé. Sert à recharger le PDF quand l'upload est absent. |
| `DocumentAddAppService.AddDocumentAsync(name, dateDocument, documentTypeId, documentClassificationId=null, documentConfidentialitesId=1, file, documentState=1, dossierId)` | fichier + métadonnées | `int documentId` | Crée `Document` (+ `DocumentVersion` + `DocumentVersionFile`), sauvegarde le fichier sur disque (`DocumentFolderPath`), génère une vignette, journalise un log d'audit. `documentTypeId = _OutgoingMailDocumentTypeId`, `dossierId = _generalDossierId`. |
| `MailDocumentsAppService.CreateOrEdit(CreateOrEditMailDocumentDto)` | DTO (`Id == null` ⇒ Create) | `Task` | Insère la ligne de liaison `MailDocument` (Mail↔Document) avec `Decharge = true` ; renseigne `TenantId` depuis la session ; ajoute un log d'audit (action 7, type 1). |
| `DocumentScannesAppService.MarkAsProcessed(int id, int mailId, int documentId)` | ids | `Task` | Positionne `IsTraite = true`, `MailId`, `DocumentId` sur le `DocumentScanne` (filtre tenant désactivé). |
| `MailsAppService.UpdateMailStatus(int MailId, MailStatus status)` | `mailId`, `MailStatus.Déchargé` | `Task` | Affecte `mail.MailStatus = status` ; comme `status == Déchargé`, positionne `mail.DateDecharge = DateTime.Now` ; vide le cache `MailsCache`. (Surcharge à un seul statut — la variante `UpdateMailStatus(int, MailStatus, DateTime)` existe mais **n'est pas** appelée ici.) |
| `MailsAppService.ArchiverCourrier(int mailId)` | `mailId` | `Task` | Positionne `mail.DateTraited = DateTime.Now` ; vide les caches `MailsCache`, `ParapheurCache`, `CourrierDepartCache`. |
| `AppNotifier.NotificationIntegrationDechargeAsync(int courrierDepartId, int? courrierParentId)` | `mailId`, `mailParentId` | `Task` | Envoie la notification d'intégration de décharge (provenance, type de courrier, courrier lié). Encadrée d'un `try/catch` : un échec **ne bloque pas** l'intégration. |

**Actions MVC du contrôleur** (`IntegrationDechargeController`) :

| Action | Signature | Renvoie |
|---|---|---|
| `Index` | `Task<IActionResult> Index(int? documentScanneId = null)` | Vue `Index.cshtml`. Si `documentScanneId` a une valeur ⇒ `ViewBag.DocumentScanneId = documentScanneId.ToString()`. Charge `ViewBag.OutboundMails = (await GetMailNoDecharge()).ToList()`. |
| `IntegrationDecharge` | `[HttpPost] Task<JsonResult> IntegrationDecharge(int mailId, IFormFile File)` | JSON `{ success: bool, message: string }`. Voir séquence ci-dessous. |
| `GetRecentOutboundMails` | `[HttpGet] Task<JsonResult> GetRecentOutboundMails()` | JSON `{ success, data }` : `GetMailNoDecharge()` filtré `Mail.Date >= Now-24h`, trié `Date desc`. (En cas d'erreur : `{ success:false, message }`.) |

**Séquence de `IntegrationDecharge` (POST)** :
1. `DossierId = _generalDossierId` (config `GeneralDossierId`, `DocuProSettings`).
2. Récupère le fichier : `Request.Form.Files.FirstOrDefault()`. Si aucun fichier ET `Request.Form["documentScanneId"]` parse en int ⇒ `documentScanneIdForMark = valeur`, charge le PDF depuis `GetFilePath(id)` (relu du disque dans un `FormFile` nommé `"File"`).
3. Si toujours pas de fichier ⇒ `{ success:false, message:"Aucun fichier fourni..." }`.
4. `mailDocumentTypeId = _OutgoingMailDocumentTypeId` (config `OutgoingMailDocumentTypeId`).
5. `mail = GetMailForView(mailId)` ⇒ `mailParentId = mail?.Mail?.MailParent`.
6. `documentId = AddDocumentAsync(file.Name, DateTime.Now, mailDocumentTypeId, null, 1, file, 1, DossierId)`.
7. `CreateOrEdit(new CreateOrEditMailDocumentDto { MailId = mailId, DocumentId = documentId, Decharge = true })`.
8. Si `mailParentId.HasValue` ⇒ second `CreateOrEdit` liant le **même** `documentId` au **courrier parent** (`Decharge = true`).
9. Si `documentScanneIdForMark.HasValue` ⇒ `MarkAsProcessed(documentScanneIdForMark, mailId, documentId)`.
10. `UpdateMailStatus(mailId, MailStatus.Déchargé)` puis `ArchiverCourrier(mailId)`.
11. `NotificationIntegrationDechargeAsync(mailId, mailParentId)` (best-effort).
12. `{ success:true, message:"Décharge intégrée avec succès" }`. Toute exception ⇒ `{ success:false, message:"Erreur lors de l'intégration de la décharge: " + ex.Message }`.

### DTOs

**`GetMailForViewDto`** — `src/DocuPro.Application.Shared/MailBase/Dtos/GetMailForViewDto.cs` (sortie de `GetMailNoDecharge` / `GetMailForView` / `GetRecentOutboundMails`). Toutes les propriétés :

| Propriété | Type C# | Obligatoire | Description |
|---|---|---|---|
| `Mail` | `MailDto` | non | Bloc courrier (voir DTO ci-dessous). `Mail.Id` = valeur de la liste déroulante. |
| `ConfidentialitesName` | `string` | non | Nom du niveau de confidentialité. |
| `MailDisplayProperty` | `string` | non | Libellé du courrier parent (`Reference Title`) dans `GetMailForView`. |
| `DateEnregistrementCourrier` | `DateTime?` | non | Date d'enregistrement. |
| `CreationTime` | `DateTime` | non | Horodatage de création. |
| `ExternalEntityName` | `string` | non | Nom de l'entité externe (utilisé pour `LongDescription`). |
| `MailTypeName` | `string` | non | Libellé du type de courrier. |
| `MailNature` | `string` | non | Nom de la nature du courrier. |
| `LongDescription` | `string` | non | Texte affiché dans la liste déroulante (`Title - Entité - Date - NReference`). |
| `Description` | `string` | non | Description du courrier. |
| `Direction` | `string` | non | Direction. |
| `MailObjet` | `string` | non | Objet du courrier. |
| `Statut` | `string` | non | Statut textuel. |
| `LastImputationFullName` | `string` | non | Dernier imputataire. |
| `DateRapel` | `DateTime?` | non | Date de rappel. |
| `UserCreated` | `string` | non | Créateur (nom + prénom). |
| `DateDecharge` | `DateTime?` | non | Date de décharge. |
| `DestinataireFullName` | `string` | non | Nom complet destinataire. |
| `DestinataireExpediteurId` | `long` | non | Id du destinataire/expéditeur. |
| `InputationTypeName` | `string` | non | Type d'imputation. |
| `Deadline` | `DateTime?` | non | Échéance. |

**`MailDto`** — `src/DocuPro.Application.Shared/MailBase/Dtos/MailDto.cs` (hérite de `EntityDto`, donc expose `Id` int). Toutes les propriétés :

| Propriété | Type C# | Obligatoire | Description |
|---|---|---|---|
| `Id` (hérité `EntityDto`) | `int` | non | PK du courrier ; c'est la `value` de la liste déroulante (`mailId`). |
| `Title` | `string` | non | Intitulé du courrier. |
| `Date` | `DateTime` | non | Date du courrier (filtre 24 h de `GetRecentOutboundMails`). |
| `DateFollowUp` | `DateTime?` | non | Date de suivi. |
| `DateReglementaire` | `DateTime?` | non | Date réglementaire. |
| `Description` | `string` | non | Description. |
| `NReference` | `string` | non | Numéro de référence (affiché dans `LongDescription`). |
| `MailType` | `MailType` (enum) | non | Type (`Départ` pour cette page). |
| `MailStatus` | `MailStatus` (enum) | non | Statut (bascule vers `Déchargé`). |
| `Reference` | `string` | non | Référence. |
| `ConfidentialitesId` | `int?` | non | FK confidentialité. |
| `MailParent` | `int?` | non | FK courrier parent — **lue** pour propager la décharge au parent. |
| `ExternalEntityId` | `int?` | non | FK entité externe. |
| `MailObjetId` | `int?` | non | FK objet. |
| `MailNatureId` | `int?` | non | FK nature. |
| `DestinataireExpediteur` | `long` | non | FK utilisateur destinataire/expéditeur. |
| `DateTraited` | `DateTime?` | non | Date de traitement. |
| `DateDecharge` | `DateTime?` | non | Date de décharge. |
| `DateEnregistrementCourrier` | `DateTime?` | non | Date d'enregistrement. |

**`CreateOrEditMailDocumentDto`** — `src/DocuPro.Application.Shared/MailBase/Dtos/CreateOrEditMailDocumentDto.cs` (hérite de `EntityDto<int?>`, donc `Id` nullable ; `Id == null` ⇒ Create). Toutes les propriétés :

| Propriété | Type C# | Obligatoire | Description |
|---|---|---|---|
| `Id` (hérité `EntityDto<int?>`) | `int?` | non | Null lors de l'intégration ⇒ insertion. |
| `Date` | `DateTime` | non | Non renseignée par cette page (valeur par défaut). |
| `MailId` | `int` | oui (valeur métier) | Courrier cible (`mailId`, puis `mailParentId` pour la 2ᵉ liaison). |
| `DocumentId` | `int` | oui (valeur métier) | Document de décharge créé. |
| `ConfidentialitesId` | `int` | non | Non renseignée par cette page. |
| `Decharge` | `bool` | oui (posée à `true`) | Marque la liaison comme preuve de décharge. |

> Le POST `IntegrationDecharge` ne consomme **pas** de DTO de requête : il reçoit `int mailId` + `IFormFile File` + le champ de formulaire `documentScanneId` (lu via `Request.Form`). Les DTOs `GetDocumentScanneForViewDto` / `GetAllDocumentScannesInput` de `DocumentScannesAppService` ne sont pas utilisés par cette page (elle n'appelle que `GetFilePath` → `string` et `MarkAsProcessed` → `void`).

### Tables & colonnes impactées

Entités et DbSet (`src/DocuPro.EntityFrameworkCore/EntityFrameworkCore/DocuProDbContext.cs`) :

- **`Mails`** — entité `Mail` (`src/DocuPro.Core/MailBase/Mail.cs`), `FullAuditedEntity`, `IMayHaveTenant`, `[Audited]` ; `DbSet<Mail> Mails` (ligne 102). Index tenant standard.
- **`MailDocuments`** — entité `MailDocument` (`src/DocuPro.Core/MailBase/MailDocument.cs`), `FullAuditedEntity`, `IMayHaveTenant`, `[Audited]` ; `DbSet<MailDocument> MailDocuments` (ligne 52). Index : `HasIndex(TenantId)` (ligne 255).
- **`Documents`** — entité `Document` (`src/DocuPro.Core/DocumentBase/Document.cs`), `FullAuditedEntity`, `IMayHaveTenant`, `[Audited]` ; `DbSet<Document> Documents` (ligne 136). Index : `HasIndex(TenantId)` (ligne 448).
- **`DocumentScannes`** — entité `DocumentScanne` (`src/DocuPro.Core/DocumentBase/DocumentScanne.cs`), `CreationAuditedEntity`, `IMayHaveTenant` ; `DbSet<DocumentScanne> DocumentScannes` (ligne 138). Index : `HasIndex(TenantId)` et `HasIndex(IsTraite)` (lignes 439-440).
- Tables secondaires écrites par `AddDocumentAsync` : **`DocumentVersions`** et **`DocumentVersionFiles`** (une version + un fichier de version par document créé).
- Tables de référence lues : **`ExternalEntities`** (jointure dans `GetMailNoDecharge` et `GetMailForView`), et via les `Include` de `GetMailForView` : `Confidentialites`, `MailNatures`, `Users` (destinataire), `MailObjets`, `Mails` (parent).

| Table | Colonne | Type SQL/CLR | Lecture / Écriture (par cette page) |
|---|---|---|---|
| `Mails` | `Id` | int (PK) | Lecture (sélection courrier, `GetMailForView`) |
| `Mails` | `MailType` | int (enum `MailType`) | Lecture (`== Départ` dans `GetMailNoDecharge`) |
| `Mails` | `ExternalEntityId` | int | Lecture (jointure entité externe) |
| `Mails` | `MailParent` | int? | Lecture (propagation au parent) |
| `Mails` | `Title`, `Date`, `Description`, `NReference`, `MailStatus`, `Reference`, `ConfidentialitesId` | divers | Lecture (projection `GetMailForViewDto`) |
| `Mails` | `MailStatus` | int (enum `MailStatus`) | **Écriture** ⇒ `Déchargé` (2) via `UpdateMailStatus` |
| `Mails` | `DateDecharge` | datetime? | **Écriture** ⇒ `DateTime.Now` (dans `UpdateMailStatus`, branche `Déchargé`) |
| `Mails` | `DateTraited` | datetime? | **Écriture** ⇒ `DateTime.Now` (via `ArchiverCourrier`) |
| `MailDocuments` | `Id` | int (PK) | **Écriture** (insertion) |
| `MailDocuments` | `MailId` | int (FK `Mails`) | **Écriture** = `mailId` (puis `mailParentId`) ; **Lecture** (jointure `Decharge` dans `GetMailNoDecharge`) |
| `MailDocuments` | `DocumentId` | int (FK `Documents`) | **Écriture** = `documentId` |
| `MailDocuments` | `Decharge` | bit (`[Required]`) | **Écriture** = `true` ; **Lecture** (filtre exclusion des déjà déchargés) |
| `MailDocuments` | `TenantId` | int? | **Écriture** (depuis `AbpSession.TenantId`) |
| `Documents` | `Id` | int (PK) | **Écriture** (insertion, retourne `documentId`) |
| `Documents` | `Description` | nvarchar | **Écriture** = `file.Name` |
| `Documents` | `DocumentDate` | datetime | **Écriture** = `DateTime.Now` |
| `Documents` | `DocumentTypeId` | int (FK) | **Écriture** = `_OutgoingMailDocumentTypeId` |
| `Documents` | `DocumentState` | int (enum `DocumentStates`) | **Écriture** = `1` |
| `Documents` | `DossierId` | int? (FK) | **Écriture** = `_generalDossierId` |
| `Documents` | `ClassificationId` | int? | **Écriture** = `null` — comme la valeur passée est `null`, elle **peut** être remplacée par le défaut du paramétrage type (`ParametrageTypedocument.ClassificationId`) s'il est configuré |
| `Documents` | `ConfidentialitesId` | int? | **Écriture** = `1` — la valeur passée étant non nulle et ≠ 0, le défaut du paramétrage type **ne s'applique pas** (`AddDocumentAsync` ne substitue que les valeurs `null`/`0`) ; reste donc `1` |
| `Documents` | `TenantId` | int? | **Écriture** (contexte tenant) |
| `DocumentScannes` | `Id` | int (PK) | Lecture (`GetFilePath`, `MarkAsProcessed`) |
| `DocumentScannes` | `FilePath` | nvarchar | Lecture (rechargement du PDF) |
| `DocumentScannes` | `IsTraite` | bit | **Écriture** ⇒ `true` (`MarkAsProcessed`) |
| `DocumentScannes` | `MailId` | int? | **Écriture** = `mailId` (`MarkAsProcessed`) |
| `DocumentScannes` | `DocumentId` | int? | **Écriture** = `documentId` (`MarkAsProcessed`) |
| `DocumentVersions` | `DocumentId` (+PK) | int | **Écriture** (créée par `AddDocumentAsync`) |
| `DocumentVersionFiles` | `DocumentVersionId`, `FileType`, `FileName` | divers | **Écriture** (créée par `AddDocumentAsync`) |
| `ExternalEntities` | `Id`, `Name` | int / nvarchar | Lecture (jointures libellé) |

### Règles de gestion / effets de bord / transitions de statut

- **Transition de statut** : `MailStatus` → **`Déchargé` (2)** via `UpdateMailStatus(mailId, MailStatus.Déchargé)`. Comme la valeur est `Déchargé`, cette surcharge positionne aussi **`DateDecharge = DateTime.Now`**. La colonne `Mail.Decharge` (drapeau booléen) **n'est pas** modifiée par cette page ; la « décharge » est matérialisée par la ligne `MailDocument.Decharge = true` et le `MailStatus`.
- **Archivage** : `ArchiverCourrier(mailId)` positionne **`DateTraited = DateTime.Now`** (le courrier de départ est marqué traité en même temps que déchargé).
- **Liaison document / scan** :
  - Le PDF devient un `Document` (via `AddDocumentAsync`, type = courrier sortant, dossier = dossier général) + une ligne `MailDocument` (Mail↔Document, `Decharge = true`).
  - **Propagation au parent** : si `Mail.MailParent` existe, une **seconde** ligne `MailDocument` relie le même `DocumentId` au courrier parent avec `Decharge = true` (le même fichier de décharge apparaît sur le courrier parent).
  - **`documentScanneId` + `MarkAsProcessed`** : quand le fichier provient d'un document scanné (paramètre `documentScanneId`), après création du document, `MarkAsProcessed(documentScanneId, mailId, documentId)` positionne `IsTraite = true`, `MailId`, `DocumentId` sur `DocumentScannes` — le scan **disparaît de la file « Documents scannés »** et pointe désormais vers le courrier et le document produits.
- **Idempotence / éligibilité** : la liste déroulante ne propose que les courriers `Départ` **sans** `MailDocument` de décharge (`GetMailNoDecharge`, filtre `md == null`). Une fois déchargé, le courrier n'y réapparaît plus. Aucune protection transactionnelle explicite : `MailDocumentsAppService.Create` force `SaveChangesAsync` après l'insertion.
- **Sélection de source de fichier** : upload manuel prioritaire ; à défaut, rechargement depuis le disque via `DocumentScanne.FilePath`. Si ni l'un ni l'autre ⇒ échec `{ success:false }` (aucune écriture).
- **Notifications** : `NotificationIntegrationDechargeAsync(mailId, mailParentId)` envoyée après coup ; encadrée d'un `try/catch` — un échec de notification est journalisé mais **ne bloque pas** ni n'annule l'intégration.
- **Caches invalidés** : `MailsCache` (par `UpdateMailStatus`), puis `MailsCache` + `ParapheurCache` + `CourrierDepartCache` (par `ArchiverCourrier`).
- **Audit / logs** : le contrôleur est `[DisableAuditing]`. `AddDocumentAsync` et `MailDocumentsAppService.Create` écrivent chacun un log d'audit applicatif (`CustomAuditLogs`) ; les étapes clés émettent des `Logger.Info`, et la branche notification un `Logger.Error` en cas d'échec.
- **Multi-tenant** : lecture/écriture des `DocumentScannes` avec filtre `MayHaveTenant` **désactivé** (host + tenant courant) ; `MailDocument.TenantId` renseigné depuis la session ; `Documents`/`Mails` sous filtre tenant standard.


---


## 14. Organigrammes (`/App/Organigrammes`)

### Rôle métier

Page de **paramétrage** du sous-menu **Paramétrage (MailSettings)**. Elle gère l'**arborescence des organigrammes** (structures / unités organisationnelles internes) qui sert de référentiel aux courriers : chaque `Mail` peut être rattaché à un organigramme via `Mail.OrganigrammeId` (FK → `Organigramme`, voir `src/DocuPro.Core/MailBase/Mail.cs` lignes 213-214). C'est un **CRUD arborescent** parent/enfant : l'entité `Organigramme` est **auto-référencée** (`ParentId` → `ParentFk`), permettant des niveaux illimités. La page est destinée à un administrateur/gestionnaire du paramétrage et fonctionne en **saisie** (création multiple, édition, suppression). 

**Lien OrganizationUnit ABP : aucun.** L'entité `Organigramme` n'a **pas** de relation avec les `OrganizationUnit` d'ABP ; l'arborescence est portée uniquement par le couple `ParentId`/`ParentFk` de la table `Organigrammes` (source : `src/DocuPro.Core/CommonEntities/Organigramme.cs`).

### Accès & permissions

- **Contrôleur MVC** : `OrganigrammesController` — `[Area("App")]`, `[AbpMvcAuthorize(AppPermissions.Pages_Organigrammes_Access)]`.
  Fichier : `src/DocuPro.Web.Mvc/Areas/App/Controllers/Parametrages/OrganigrammesController.cs` (namespace `DocuPro.Web.Areas.App.Controllers.Common`).
- **Service applicatif** : `OrganigrammesAppService` — `[AbpAuthorize(AppPermissions.StandardUser)]` au niveau de la classe.
  Fichier : `src/DocuPro.Application/CommonEntities/OrganigrammesAppService.cs`.
  Permissions par méthode :
  - `GetOrganigrammeForEdit` / `Update` : `[AbpAuthorize(AppPermissions.Pages_Administration_Organigrammes_Edit)]`
  - `Create` : `[AbpAuthorize(AppPermissions.Pages_Administration_Organigrammes_Create)]`
  - `Delete` : `[AbpAuthorize(AppPermissions.Pages_Administration_Organigrammes_Delete)]`
  - `GetAllOrganigrammeForLookupTable` : `[AbpAuthorize(AppPermissions.Pages_Administration_Organigrammes)]`
  - `GetAllList`, `GetAllList1`, `GetAll`, `GetOrganigrammeForView`, `CheckIsDuplicate`, `CreateOrEdit`, `GetOrganigrammesToExcel`, `GetOrganigrammeExcelColumnsToExcel` : héritent du `[AbpAuthorize(StandardUser)]` de la classe.
- **Constantes de permission** (`src/DocuPro.Core.Shared/Authorization/AppPermissions.cs`) :
  - `Pages_Organigrammes` = `"Pages.Organigrammes"` (l.482)
  - `Pages_Organigrammes_Access` = `"Pages.Organigrammes.Access"` (l.483) — libellé `L("OrganigrammesAccess")`
  - `Menus_Mail_Settings_Organigrammes` = `"Menus.Mail_Settings.Organigrammes"` (l.104) — libellé `L("MailSettings_Organigrammes")`
  - `Pages_Administration_Organigrammes` = `"Pages.Administration.Organigrammes"` (l.20) — libellé `L("Organigrammes")`
  - `Pages_Administration_Organigrammes_Create` = `"Pages.Administration.Organigrammes.Create"` (l.21) — libellé `L("CreateNewOrganigramme")`
  - `Pages_Administration_Organigrammes_Edit` = `"Pages.Administration.Organigrammes.Edit"` (l.22) — libellé `L("EditOrganigramme")`
  - `Pages_Administration_Organigrammes_Delete` = `"Pages.Administration.Organigrammes.Delete"` (l.23) — libellé `L("DeleteOrganigramme")`
  Déclarations dans `src/DocuPro.Core/Authorization/AppAuthorizationProvider.cs` (lignes 82, 123-126, 485-487).
- **Entrée de menu** (`src/DocuPro.Web.Mvc/Areas/App/Startup/AppNavigationProvider.cs`, l.358-364) :
  - Nom de page : `AppPageNames.Common.Organigrammes` = `"Administration.CommonEntities.Organigrammes"`
  - Libellé : `L("Organigrammes")` · URL : `App/Organigrammes` · Icône : `bi bi-diagram-3`
  - Dépendance de permission : `SimplePermissionDependency(requiresAll: true, Pages_Organigrammes_Access, Menus_Mail_Settings_Organigrammes)` (les DEUX requises)
  - Aucun badge.
- **Multi-tenant** : entité `Organigramme : IMayHaveTenant` → filtre `MayHaveTenant` **actif**. Index sur `TenantId` (`DocuProDbContext.cs` l.221-224). À la création (`OrganigrammesAppService.Create`), `TenantId` et `CreatorUserId` sont positionnés depuis `AbpSession` si `AbpSession.TenantId != null`.

### Interface utilisateur

- **Page Razor** : `src/DocuPro.Web.Mvc/Areas/App/Views/Organigrammes/Index.cshtml`
- **Script** : **inline** dans `Index.cshtml` (bloc `@section Scripts`, l.132-490) + `<ejs-scripts>`. La page **n'inclut pas** le fichier `wwwroot/view-resources/Areas/App/Views/Organigrammes/Index.js`.
- **Titre affiché** : `L("MailSettings")` — **sous-titre / description** : `L("Organigrammes")` (via `<abp-page-subheader>`).
- **Composants** : la page réelle est bâtie sur des composants **Syncfusion** — `ejs-treegrid` (colonne gauche, arbre) et, en colonne droite, un `ejs-dropdowntree` (choix du parent), un `<textarea>` (saisie multiple) et un `ejs-textbox` (édition). Ce n'est **pas** une page DataTable + modale.

> **Important — code RAD non câblé.** Les fichiers `Index.js`, `_CreateOrEditModal.cshtml`/`_CreateOrEditModal.js`, `_ViewOrganigrammeModal.cshtml`, `_OrganigrammeOrganigrammeLookupTableModal.cshtml`/`.js` et `_ExcelColumnSelectionModal.cshtml` présents dans l'arborescence sont des **restes générés par l'outil RAD (AspNetZero)**. Ils référencent des endpoints (`App/Organigrammes/CreateOrEditModal`, `VieworganigrammeModal`, `ExcelColumnSelectionModal`, `OrganigrammeLookupTableModal`, `ImportFromExcel`) et une table `#OrganigrammesTable` **qui n'existent pas** dans le `OrganigrammesController` ni dans `Index.cshtml`. Le modèle Créer/Éditer est documenté ci-dessous (section « Modale RAD ») pour exhaustivité, mais il **n'est pas atteignable** depuis la page en production.

#### Filtres / recherche

| Libellé | Propriété (input→DTO) | Type de contrôle | Source / comportement serveur |
|---|---|---|---|
| Recherche TreeGrid | — (aucune, côté client) | Bouton `Search` de la toolbar Syncfusion | Filtrage **client** sur les données déjà chargées (`ViewBag.Organigrammes`). Aucun appel serveur, aucune pagination serveur sur la page réelle. |

Le TreeGrid est alimenté par `ViewBag.Organigrammes` (rendu serveur au chargement d'`Index`). Aucun filtre serveur n'est exposé par la page réelle. *(La méthode `GetAll(GetAllOrganigrammesInput)` avec `Filter`/`NameFilter`/`MinParentIdFilter`/`MaxParentIdFilter` existe côté service mais n'est utilisée que par le code RAD orphelin.)*

#### Colonnes du tableau (TreeGrid `ejs-treegrid`, `Index.cshtml` l.47-51)

| Libellé | Propriété (`field`) | Type |
|---|---|---|
| (case à cocher) | — | `type="checkbox"` (sélection multiple, `width=10`) |
| — | `Id` | entier (colonne quasi masquée, `width=1`) |
| `L("Organigrammes")` | `Name` | texte (colonne arbre, `treeColumnIndex=2`) |

Configuration de l'arbre : `idMapping="Id"`, `parentIdMapping="ParentId"`, `hasChildMapping="HasChildren"`, `expanded="Expanded"`. Objet de données injecté par le contrôleur (`Index()`) : `{ Id, Name, ParentId, HasChildren = (des enfants existent), Expanded = true }`. Pagination client `pageSize=10`.

#### Actions (boutons)

| Bouton | Effet (endpoint / JS) | Permission |
|---|---|---|
| `L("Delete")` (`#deleteOrganigrammesButton`) | `deleteOrganigramme()` → POST `App/Organigrammes/DeleteNodes` avec la liste des `Id` sélectionnés (JSON). Désactivé tant qu'aucune ligne n'est sélectionnée. | Contrôleur `Pages_Organigrammes_Access` + service `Delete` : `Pages_Administration_Organigrammes_Delete` |
| `L("Add")` (`#addOrganigrammesButton`) | `addOrganigramme()` → POST `App/Organigrammes/CreateMultipleNodes` avec `{ ParentId, NodeNames[] }` (JSON). Confirmation Swal. | Contrôleur `Pages_Organigrammes_Access` + service `Create` : `Pages_Administration_Organigrammes_Create` |
| `L("Edit")` (`#updateOrganigrammeButton`) | `editOrganigramme()` → POST `App/Organigrammes/EditOrganigramme` avec `{ id, name, parentId }` (form-urlencoded). Désactivé tant qu'aucune ligne n'est sélectionnée. Validation client `validateHierarchy` (interdit nœud = son propre parent). | Contrôleur `Pages_Organigrammes_Access` + service `Update` : `Pages_Administration_Organigrammes_Edit` |
| Toolbar `Search` / `ExcelExport` / `CsvExport` / `PdfExport` | Export **client** Syncfusion (`toolbarClick` → `excelExport` / `csvExport` / `pdfExport`). N'appelle pas le serveur. | `Pages_Organigrammes_Access` |

#### Formulaire de saisie (panneau droit d'`Index.cshtml`, PAS une modale)

| Champ | Propriété DTO (via requête) | Type de contrôle | Obligatoire | Source / valeurs |
|---|---|---|---|---|
| Sélection du parent (`#parentOrganigrammeDropdown`) | `ParentId` (`CreateMultipleNodes` → `MultipleNodeRequestOrganigramme.ParentId` ; `EditOrganigramme` → `parentId`) → colonne `Organigrammes.ParentId` | `ejs-dropdowntree` (arbre filtrable, `allowFiltering`, `filterType=Contains`) | Non (`int?`) | Arbre `ViewBag.Organigrammes` (`value=Id`, `parentValue=ParentId`, `text=Name`). Si aucun parent → racine (`ParentId = null`). |
| Zone de saisie multiple (`#organigrammeNames`) | `NodeNames` (liste) → chaque nom crée un `CreateOrEditOrganigrammeDto.Name` → colonne `Organigrammes.Name` | `<textarea>` 4 lignes, un nom par ligne | Oui (au moins un nom non vide, `validateForm()`) | Saisie libre. Le JS déduplique (minuscule + espaces normalisés), trie alphabétiquement et réaffiche la liste nettoyée avant envoi. Placeholder `L("EntrezLesOrganigrammes")`. |
| Édition du nom (`#editOrganigrammeName`) | `name` (`EditOrganigramme`) → `CreateOrEditOrganigrammeDto.Name` → colonne `Organigrammes.Name` | `ejs-textbox` (`floatLabelType=Auto`) | Oui (non vide, `validateForm(true)`) | Pré-rempli avec le `Name` de la ligne sélectionnée (`updateFormWithSelectedData`). Placeholder `L("EditOrganigramme")`. |

Comportements JS notables (`Index.cshtml`) : sélection multiple activée sur le TreeGrid (`selectionSettings = { type:'Multiple', mode:'Row' }`) ; `onRowSelected` remplit le formulaire d'édition et le dropdown parent ; après succès d'une action, `handleAjaxSuccess` affiche un Swal puis **recharge la page** (`window.location.reload()`).

#### Modale RAD `_CreateOrEditModal.cshtml` (non câblée — pour référence)

Fichier : `src/DocuPro.Web.Mvc/Areas/App/Views/Organigrammes/_CreateOrEditModal.cshtml` (modèle `CreateOrEditOrganigrammeModalViewModel`). Aucune action `CreateOrEditModal` n'existe dans le contrôleur, la modale n'est donc pas servie.

| Champ | Propriété DTO | Type de contrôle | Obligatoire | Source / valeurs |
|---|---|---|---|---|
| `id` (mode édition uniquement) | `CreateOrEditOrganigrammeDto.Id` | `<input type=hidden name=id>` | — | `Model.Organigramme.Id` |
| Nom du parent (`#OrganigrammeName`, `name=organigrammeName`) | (affichage seul — libellé du parent) | `<input type=text disabled>` + bouton `Pick` (`#OpenOrganigrammeLookupTableButton`) + bouton effacer (`#ClearOrganigrammeNameButton`) | Non | Renseigné via la modale lookup `_OrganigrammeOrganigrammeLookupTableModal` ; `_CreateOrEditModal.js` positionne `organigrammeName` (texte) et `parentId` (valeur). |
| Parent (`#Organigramme_ParentId`, `name=parentId`, caché) | `CreateOrEditOrganigrammeDto.ParentId` → `Organigrammes.ParentId` | `<input type=text hidden>` | Non (`int?`) | `Model.Organigramme.ParentId` (édition) ou vide (création). |
| Nom (`#Organigramme_Name`, `name=name`) | `CreateOrEditOrganigrammeDto.Name` → `Organigrammes.Name` | `<input type=text required>` | **Oui** (`required` + `[Required]` DTO) | `Model.Organigramme.Name`. |

Le script `_CreateOrEditModal.js` envoie le formulaire sérialisé à `abp.services.app.organigrammes.createOrEdit` (API dynamique ABP), initialise un `select2` de parent alimenté par `api/services/app/Organigrammes/GetAllOrganigrammeForLookupTable`, et pré-charge le parent courant via `api/services/app/Organigrammes/GetOrganigrammeForView`.

### Service applicatif & opérations

- Interface : `src/DocuPro.Application.Shared/CommonEntities/IOrganigrammesAppService.cs`
- Implémentation : `src/DocuPro.Application/CommonEntities/OrganigrammesAppService.cs`

| Méthode | Entrée | Sortie | Description |
|---|---|---|---|
| `GetAllList()` | — | `List<GetOrganigrammeForViewDto>` | Tous les organigrammes triés par `Name`. **Mis en cache** (`ICacheManager`, cache `"OrganigrammeCache"`, clé `"Organigrammes_All"`). Utilisé par `Index()`. |
| `GetAllList1()` | — | `List<GetOrganigrammeForViewDto>` | Identique mais **sans cache** (accès direct repo). |
| `GetAll(GetAllOrganigrammesInput)` | `GetAllOrganigrammesInput` | `PagedResultDto<GetOrganigrammeForViewDto>` | Liste paginée/filtrée (`Filter`, `NameFilter`, `MinParentIdFilter`, `MaxParentIdFilter`), jointure sur le parent pour `ParentOrganigrammeName`. *(Utilisée par le code RAD, pas par la page réelle.)* |
| `GetOrganigrammeForView(int id)` | `int id` | `GetOrganigrammeForViewDto` | Un organigramme mappé en `OrganigrammeDto`. |
| `GetOrganigrammeForEdit(EntityDto)` | `EntityDto` (`Id`) | `GetOrganigrammeForEditOutput` | Mappe vers `CreateOrEditOrganigrammeDto`. Permission `Pages_Administration_Organigrammes_Edit`. |
| `CheckIsDuplicate(string name)` | `string name` | `bool` | `true` si un organigramme du même nom (comparaison majuscules) existe. *(Exposée mais non appelée par les flux de cette page.)* |
| `CreateOrEdit(CreateOrEditOrganigrammeDto)` | `CreateOrEditOrganigrammeDto` | `Task` | Capitalise la 1re lettre du `Name` (reste en minuscules), aiguille vers `Create` (`Id == null`) ou `Update`, puis **vide le cache** `"OrganigrammeCache"`. |
| `Create` (protégé) | `CreateOrEditOrganigrammeDto` | `Task` | Insère l'entité, positionne `TenantId`/`CreatorUserId` depuis `AbpSession`. Permission `Pages_Administration_Organigrammes_Create`. |
| `Update` (protégé) | `CreateOrEditOrganigrammeDto` | `Task` | Met à jour `Name` et `ParentId`. Permission `Pages_Administration_Organigrammes_Edit`. |
| `Delete(EntityDto)` | `EntityDto` (`Id`) | `Task` | Supprime (soft-delete `FullAuditedEntity`) puis **vide le cache**. Permission `Pages_Administration_Organigrammes_Delete`. |
| `GetOrganigrammesToExcel(GetAllOrganigrammesForExcelInput)` | `GetAllOrganigrammesForExcelInput` | `FileDto` | Export Excel via `IOrganigrammesExcelExporter` sur colonnes sélectionnées. |
| `GetAllOrganigrammeForLookupTable(GetAllForLookupTableInput)` | `GetAllForLookupTableInput` (`Filter`) | `PagedResultDto<OrganigrammeOrganigrammeLookupTableDto>` | Lookup paginé `{ Id, DisplayName=Name }`. Permission `Pages_Administration_Organigrammes`. |
| `GetOrganigrammeExcelColumnsToExcel()` | — | `List<string>` | Noms de colonnes exportables de `OrganigrammeDto` (`EntityExportHelper`). |

**Actions MVC du contrôleur** (`OrganigrammesController.cs`) :

| Action | Signature | Renvoi |
|---|---|---|
| `Index` | `Task<IActionResult> Index()` | Vue. Construit `ViewBag.Organigrammes` = projection `{ Id, Name, ParentId, HasChildren, Expanded=true }` depuis `GetAllList()`. |
| `CreateMultipleNodes` | `[HttpPost] ([FromBody] MultipleNodeRequestOrganigramme request)` | JSON `{ success, newNodes:[{Id,Name}], errors:[] }`. Normalise les noms (trim, minuscules, sans espaces), déduplique, vérifie l'existence via `GetAllList()`, crée chaque nœud via `CreateOrEdit`. Renvoie `{ success:false, message }` si `NodeNames` vide. |
| `EditOrganigramme` | `[HttpPost] (int? id, string name, int? parentId)` | JSON `{ success, message }`. Vérifie l'`id`, charge via `GetOrganigrammeForView`, appelle `CreateOrEdit` avec `{ Id, Name, ParentId }`. Messages localisés (`OrganigrammeUpdatedSuccessfully`, `ErrorUpdatingOrganigramme`…). |
| `DeleteNodes` | `[HttpPost] ([FromBody] List<int> ids)` | JSON `{ success }`. Pour chaque id : `GetOrganigrammeForView` puis `Delete(new EntityDto(id))`. Renvoie `{ success:false, message }` si la liste est vide ou un id introuvable. |

### DTOs

**`OrganigrammeDto`** (`src/DocuPro.Application.Shared/CommonEntities/Dtos/OrganigrammeDto.cs`) — `: EntityDto` (donc `Id` : `int`)

| Propriété | Type C# | Obligatoire | Description |
|---|---|---|---|
| `Id` | `int` (hérité `EntityDto`) | — | Identifiant. |
| `Name` | `string` | Non (au niveau DTO) | Nom de l'organigramme → `Organigrammes.Name`. |
| `ParentId` | `int?` | Non | Parent → `Organigrammes.ParentId`. |

**`CreateOrEditOrganigrammeDto`** (`.../Dtos/CreateOrEditOrganigrammeDto.cs`) — `: EntityDto<int?>` (donc `Id` : `int?`)

| Propriété | Type C# | Obligatoire | Description |
|---|---|---|---|
| `Id` | `int?` (hérité) | Non | `null` = création, sinon édition. |
| `Name` | `string` | **Oui** `[Required]` | Nom → `Organigrammes.Name`. |
| `ParentId` | `int?` | Non | Parent → `Organigrammes.ParentId`. |

**`GetOrganigrammeForViewDto`** (`.../Dtos/GetOrganigrammeForViewDto.cs`)

| Propriété | Type C# | Obligatoire | Description |
|---|---|---|---|
| `Organigramme` | `OrganigrammeDto` | — | Enveloppe de lecture. |

**`GetOrganigrammeForEditOutput`** (`.../Dtos/GetOrganigrammeForEditOutput.cs`)

| Propriété | Type C# | Obligatoire | Description |
|---|---|---|---|
| `Organigramme` | `CreateOrEditOrganigrammeDto` | — | Enveloppe d'édition. |

**`GetAllOrganigrammesInput`** (`.../Dtos/GetAllOrganigrammesInput.cs`) — `: PagedAndSortedResultRequestDto`

| Propriété | Type C# | Obligatoire | Description |
|---|---|---|---|
| `Filter` | `string` | Non | Filtre global sur `Name`. |
| `NameFilter` | `string` | Non | Filtre sur `Name`. |
| `MinParentIdFilter` | `int?` | Non | `ParentId >=`. |
| `MaxParentIdFilter` | `int?` | Non | `ParentId <=`. |
| `SkipCount` / `MaxResultCount` / `Sorting` | (hérités `PagedAndSortedResultRequestDto`) | Non | Pagination / tri. |

**`GetAllOrganigrammesForExcelInput`** (`.../Dtos/GetAllOrganigrammesForExcelInput.cs`) — `: IExcelColumnSelectionInput`

| Propriété | Type C# | Obligatoire | Description |
|---|---|---|---|
| `Filter` | `string` | Non | Filtre global sur `Name`. |
| `SelectedColumns` | `List<string>` | Non | Colonnes à exporter. |
| `NameFilter` | `string` | Non | Filtre sur `Name`. |
| `MinParentIdFilter` | `int?` | Non | `ParentId >=`. |
| `MaxParentIdFilter` | `int?` | Non | `ParentId <=`. |

**`OrganigrammeOrganigrammeLookupTableDto`** (`.../Dtos/OrganigrammeOrganigrammeLookupTableDto.cs`)

| Propriété | Type C# | Obligatoire | Description |
|---|---|---|---|
| `Id` | `int` | — | Id de l'organigramme parent candidat. |
| `DisplayName` | `string` | — | `Name` de l'organigramme. |

**`GetAllForLookupTableInput`** (`.../CommonEntities/Dtos/GetAllForLookupTableInput.cs`) — `: PagedAndSortedResultRequestDto`

| Propriété | Type C# | Obligatoire | Description |
|---|---|---|---|
| `Filter` | `string` | Non | Terme de recherche sur `Name`. |
| `SkipCount` / `MaxResultCount` / `Sorting` | (hérités) | Non | Pagination / tri. |

**`MultipleNodeRequestOrganigramme`** (classe interne du contrôleur, `OrganigrammesController.cs`)

| Propriété | Type C# | Obligatoire | Description |
|---|---|---|---|
| `ParentId` | `int?` | Non | Parent commun des nœuds à créer. |
| `NodeNames` | `List<string>` | — | Noms à créer (un par ligne de la textarea). |

**`UpdateNodeRequestOrganigramme`** (classe interne du contrôleur, **déclarée mais non utilisée**) : `Id` (`int`), `Name` (`string`), `ParentId` (`int?`).

**ViewModels MVC** (`src/DocuPro.Web.Mvc/Areas/App/Models/Organigrammes/`) — les cinq fichiers présents, tous des restes RAD non consommés par `Index.cshtml` :
- `CreateOrEditOrganigrammeModalViewModel` : `Organigramme` (`CreateOrEditOrganigrammeDto`), `OrganigrammeName` (`string`), `IsEditMode => Organigramme.Id.HasValue`.
- `OrganigrammeViewModel : GetOrganigrammeForViewDto` (vide) — fichier `OrganigrammeViewModel.cs`.
- `OrganigrammeOrganigrammeLookupTableViewModel` : `Id` (`int?`), `DisplayName` (`string`), `FilterText` (`string`) — fichier `OrganigrammeOrganigrammeOrganigrammeLookupTableViewModel.cs` (nom de fichier avec triple « Organigramme », classe à double).
- `OrganigrammesViewModel` : `FilterText` (`string`) — fichier `OrganigrammesViewModel.cs` (modèle de la vue liste RAD).
- `OrganigrammeExcelColumnSelectionViewModel` : `OrganigrammeExcelColumns` (`List<string>`) — fichier `ExcelColumnSelectionViewModel.cs` (modèle de la modale RAD de sélection des colonnes Excel).

### Tables & colonnes impactées

**Table `Organigrammes`** — entité `Organigramme` (`src/DocuPro.Core/CommonEntities/Organigramme.cs`), `[Table("Organigrammes")]`.
Base ABP : `FullAuditedEntity` (donc soft-delete). Interface : `IMayHaveTenant`. DbSet : `DocuProDbContext.Organigrammes` (l.36). Index : `HasIndex(e => new { e.TenantId })` (`DocuProDbContext.cs` l.221-224). Clé étrangère auto-référencée : `ParentId` → `ParentFk` (`[ForeignKey("ParentId")]`).

| Table | Colonne | Type SQL/CLR | Lecture / Écriture (par cette page) |
|---|---|---|---|
| `Organigrammes` | `Id` | `int` (PK) | Lecture (grille, sélection, édition, suppression) |
| `Organigrammes` | `TenantId` | `int?` | Écriture (à la création, depuis `AbpSession`) ; filtre tenant en lecture |
| `Organigrammes` | `Name` | `nvarchar`/`string` **[Required]** | Lecture + Écriture (création multiple, édition) |
| `Organigrammes` | `ParentId` | `int?` (FK auto → `Organigrammes.Id`) | Lecture + Écriture (parent choisi via dropdown) |
| `Organigrammes` | `CreationTime` | `datetime` | Écriture (audit, création) |
| `Organigrammes` | `CreatorUserId` | `bigint`/`long?` | Écriture (positionné à la création) |
| `Organigrammes` | `LastModificationTime` | `datetime?` | Écriture (audit, édition) |
| `Organigrammes` | `LastModifierUserId` | `long?` | Écriture (audit, édition) |
| `Organigrammes` | `IsDeleted` | `bit`/`bool` | Écriture (soft-delete à la suppression) |
| `Organigrammes` | `DeleterUserId` | `long?` | Écriture (soft-delete) |
| `Organigrammes` | `DeletionTime` | `datetime?` | Écriture (soft-delete) |

**Table de référence liée (non écrite par cette page)** :

| Table | Colonne | Relation | Lecture / Écriture |
|---|---|---|---|
| `Mails` | `OrganigrammeId` | `int?` FK → `Organigrammes.Id` (`Mail.cs` l.213-214, `[ForeignKey("OrganigrammeId")]`) | Consommateur de ce référentiel ; **non touché** par la page Organigrammes |

### Règles de gestion / effets de bord / transitions de statut

- **Transitions de `MailStatus` / drapeaux `Mail`** : — (sans objet). Page de paramétrage : aucune interaction avec les statuts, drapeaux ou dates des courriers.
- **Normalisation du nom** : `CreateOrEdit` met en majuscule la première lettre du `Name` et le reste en minuscules (`char.ToUpper(Name[0]) + Name.Substring(1).ToLower()`) avant enregistrement.
- **Anti-doublon (création multiple)** : côté serveur, `CreateMultipleNodes` normalise chaque nom (trim → minuscules → suppression des espaces), déduplique via `HashSet`, et compare à la liste existante (`GetAllList()`) ; tout doublon est ignoré et ajouté à `errors`. Côté client, `addOrganigramme()` déduplique (minuscule + espaces normalisés) et trie avant envoi. La méthode `CheckIsDuplicate` existe mais **n'est pas** appelée dans ce flux.
- **Validation hiérarchie (client)** : `validateHierarchy` empêche de définir un nœud comme **son propre parent** (`nodeId === parentId`). **Aucune** protection serveur contre les cycles plus profonds (A→B→A) n'a été trouvée dans la source lue.
- **Cache applicatif** : cache ABP `"OrganigrammeCache"`, clé `"Organigrammes_All"`, rempli par `GetAllList()` et **invalidé** (`cache.ClearAsync()`) à chaque `CreateOrEdit` et `Delete`.
- **Suppression** : soft-delete (`FullAuditedEntity` → `IsDeleted=true`), pas de suppression physique. Suppression **par lot** possible (cases à cocher du TreeGrid → liste d'ids).
- **Multi-tenant** : filtre `MayHaveTenant` actif ; `TenantId` et `CreatorUserId` positionnés à la création depuis `AbpSession`.
- **Rechargement UI** : après succès d'un Ajout/Édition/Suppression, la page effectue `window.location.reload()` (pas de mise à jour incrémentale du TreeGrid).
- **Numérotation / séquences / notifications / e-mails / jobs** : — (sans objet). Aucune séquence, notification ni job déclenché par cette page.
- **Import Excel** : le bouton d'import (`ImportFromExcel`) figure dans le code RAD orphelin ; **aucune** action `ImportFromExcel` n'existe dans `OrganigrammesController` → fonctionnalité **non opérante** sur la page réelle.


---


## 15. Gestion organisationnelle (`/App/RoleOrganigramme`)

### Rôle métier

Page de **paramétrage** du module Docu-Courriers (sous-menu « Paramétrage / MailSettings ») permettant d'**affecter à chaque rôle applicatif un nœud d'organigramme**. Concrètement, l'écran présente à gauche la liste des rôles du tenant (filtrée pour ne montrer que les rôles qui possèdent au moins un utilisateur) avec l'organigramme actuellement rattaché, et à droite un mini-formulaire (liste déroulante de rôle + arbre d'organigramme) pour choisir ou retirer le nœud d'organigramme d'un rôle sélectionné. L'affectation sert de rattachement organisationnel du rôle (utilisé ailleurs pour router/filtrer les courriers par nœud d'organigramme via `Mail.OrganigrammeId`). C'est une page d'administration en **saisie** : elle lit les rôles ABP et les organigrammes, et écrit le rattachement directement sur l'entité `Role`.

**Point d'architecture important à retenir pour une ré-implémentation :** malgré le nom « RoleOrganigrammeAssignment », **il n'existe AUCUNE table de liaison (junction) rôle ⇄ organigramme**. L'affectation est matérialisée par une **colonne nullable `OrganigrammeId` ajoutée à la table des rôles ABP `AbpRoles`** (l'entité `Role : AbpRole<User>` a été étendue). La cardinalité est donc **un rôle → au plus un organigramme** (relation plusieurs-à-un `AbpRoles.OrganigrammeId → Organigrammes.Id`), et non plusieurs-à-plusieurs. La page écrit sur `AbpRoles` (colonnes `OrganigrammeId` et, potentiellement, `DisplayName`) et lit `Organigrammes` en lecture seule.

### Accès & permissions

- **Contrôleur MVC** : `RoleOrganigrammeController` — `[Area("App")]`, `[AbpMvcAuthorize(AppPermissions.Pages_RoleOrganigramme_Access)]`.
  Fichier : `src/DocuPro.Web.Mvc/Areas/App/Controllers/Parametrages/RoleOrganigrammeController.cs`.
  L'action POST `UpdateAssignments` porte aussi `[HttpPost]` + `[AbpMvcAuthorize(AppPermissions.Pages_RoleOrganigramme_Access)]`.
- **Service applicatif** : `RoleOrganigrammeAssignmentAppService` — attribut de classe `[AbpAuthorize(AppPermissions.StandardUser)]` (donc l'ensemble des méthodes exige la permission `StandardUser`) ; la méthode d'écriture `UpdateRoleOrganigrammeAssignments` ajoute `[AbpAuthorize(AppPermissions.Pages_RoleOrganigramme_Access)]`.
  Fichier : `src/DocuPro.Application/CommonEntities/RoleOrganigrammeAssignmentAppService.cs`.
- **Constantes de permission** (`src/DocuPro.Core.Shared/Authorization/AppPermissions.cs`) :
  - `Pages_RoleOrganigramme` = `"Pages.RoleOrganigramme"` (permission parente de page).
  - `Pages_RoleOrganigramme_Access` = `"Pages.RoleOrganigramme.Access"` (accès à la page — celle contrôlée par le contrôleur et l'écriture).
  - `Menus_Mail_Settings_RoleOrganigramme` = `"Menus.Mail_Settings.RoleOrganigramme"` (permission d'entrée de menu).
  - `StandardUser` = `"StandardUser"` (permission de classe du service).
- **Déclaration des permissions** (`src/DocuPro.Core/Authorization/AppAuthorizationProvider.cs`) :
  - `pages.CreateChildPermission(AppPermissions.Pages_RoleOrganigramme, L("RoleOrganigramme"))` puis `.CreateChildPermission(AppPermissions.Pages_RoleOrganigramme_Access, L("RoleOrganigrammeAccess"))`.
  - `mailsettings.CreateChildPermission(AppPermissions.Menus_Mail_Settings_RoleOrganigramme, L("MailSettings_RoleOrganigramme"))`.
  Libellés de traduction associés : `RoleOrganigramme`, `RoleOrganigrammeAccess`, `MailSettings_RoleOrganigramme`.
- **Entrée de menu** (`src/DocuPro.Web.Mvc/Areas/App/Startup/AppNavigationProvider.cs`) :
  - Nom de page : `AppPageNames.Common.RoleOrganigramme` (= `"RoleOrganigramme"`, défini dans `src/DocuPro.Web.Mvc/Areas/App/Startup/AppPageNames.cs`).
  - Libellé : `L("RoleOrganigramme")` ; URL : `App/RoleOrganigramme` ; icône : `bi bi-people-fill`.
  - Dépendance : `SimplePermissionDependency(requiresAll: true, AppPermissions.Pages_RoleOrganigramme_Access, AppPermissions.Menus_Mail_Settings_RoleOrganigramme)` (les DEUX permissions requises).
  - Badge : aucun.
- **Particularités multi-tenant** :
  - `Organigramme` implémente `IMayHaveTenant` (`TenantId int?`), donc `_organigrammeRepository.GetAllListAsync()` / `FirstOrDefaultAsync` sont filtrés par le tenant courant (filtre `MayHaveTenant` actif par défaut).
  - `Role` (`AbpRole<User>`) porte également `TenantId` ; `RoleManager.Roles` est filtré par tenant. La page ne manipule donc que les rôles et organigrammes du tenant courant. Aucun désactivation de filtre (`DisableFilter`) n'est effectuée dans le code de cette page.

### Interface utilisateur

- **Page Razor** : `src/DocuPro.Web.Mvc/Areas/App/Views/RoleOrganigramme/Index.cshtml` (modèle `@model DocuPro.CommonEntities.Dtos.RoleOrganigrammeAssignmentInputDto`).
- **Scripts** :
  - **Actif** : script inline dans `@section Scripts` de `Index.cshtml` (fonctions `updateAssignment()`, `clearAssignment()`, `onRowSelected`, etc. + composants Syncfusion `ejs-grid` / `ejs-dropdownlist` / `ejs-dropdowntree`).
  - `src/DocuPro.Web.Mvc/wwwroot/view-resources/Areas/App/Views/RoleOrganigramme/Index.js` : **code hérité / non branché**. Il opère sur des éléments (`#RoleAssignmentForm`, `#RoleAssignmentTable`, `.role-name-input`, `.organigramme-select`, `#SaveAssignmentsButton`) qui **n'existent pas dans le `Index.cshtml` actuel** (lequel utilise une grille Syncfusion et un formulaire à droite, sans ces id/classes). Ce fichier est donc inerte vis-à-vis de la page courante ; la logique réellement exécutée est le script inline de la vue. À ne PAS ré-implémenter tel quel.
- **Titre / sous-titre affichés** (`abp-page-subheader`) : titre `L("RoleOrganigrammeAssignment")`, description `L("RoleOrganigrammeAssignmentDescription")`.
- **Données injectées côté client** (sérialisées en JSON dans la vue) :
  - `roleAssignmentsData` = `Model.RoleAssignments` (liste des affectations rôle→organigramme).
  - `organigrammesData` = `ViewBag.Organigrammes` (arbre d'organigrammes aplati, cf. `OrganigrammeComboboxItemDto`).
  - `roleListData` = `ViewBag.RoleList` (rôles ayant des utilisateurs, cf. `GenericViewModel`).

#### Filtres / recherche

| Libellé | Propriété (input→DTO) | Type de contrôle | Source / comportement serveur |
|---|---|---|---|
| Recherche grille | — (aucune liaison DTO) | Barre de recherche Syncfusion (`toolbar: "Search"`) | Filtre côté client de la grille `RoleAssignmentGrid` (pas d'appel serveur). |
| Export | — | Boutons toolbar `ExcelExport`, `CsvExport`, `PdfExport` | Export client Syncfusion (`gridObj.excelExport()/csvExport()/pdfExport()`). Pas d'appel serveur. |

#### Colonnes du tableau (grille `RoleAssignmentGrid`, source `Model.RoleAssignments`)

| Libellé | Propriété (`field`) | Type |
|---|---|---|
| (case à cocher de sélection) | — (`type="checkbox"`, largeur 50) | Sélection ligne (mode `Single`) |
| (masquée) | `RoleId` (`visible="false"`, largeur 1) | int |
| `L("RoleName")` | `RoleName` (largeur 200) | string |
| `L("AssignedOrganigramme")` | `OrganigrammeName` (largeur 250) | string |

Pagination : `pageSize=10`. Sélection : `type="Single"`, `mode="Row"`.

#### Actions (boutons)

| Bouton | Effet (endpoint / JS) | Permission |
|---|---|---|
| `L("UpdateAssignment")` (`#updateAssignmentButton`, `btn-success`) | JS `updateAssignment()` : lit le rôle (`#editRoleDropdown`) + l'organigramme (`#editOrganigrammeDropdown`), met à jour la ligne sélectionnée et le tableau `roleAssignmentsData`, puis POST AJAX JSON de **toute la liste** vers `UpdateAssignments` (`RoleOrganigramme`, area `App`). Succès → toast SweetAlert `AssignmentUpdatedAndSaved`. Désactivé tant qu'aucune ligne n'est sélectionnée. | `Pages_RoleOrganigramme_Access` (contrôleur + service) |
| `L("ClearAssignment")` (`#clearAssignmentButton`, `btn-danger`) | JS `clearAssignment()` : confirmation SweetAlert (`ConfirmClearAssignment`) puis met `OrganigrammeId=null` / `OrganigrammeName=''` sur la ligne sélectionnée **uniquement côté client** (`treeGrid.refresh()`), toast `AssignmentClearedLocally`. **N'enregistre PAS en base** (aucun appel serveur) — il faut ensuite « Update » pour persister. Désactivé sans sélection. | — (purement client) |

#### Formulaire (panneau droit — édition de l'affectation)

| Champ | Propriété DTO | Type de contrôle | Obligatoire | Source / valeurs |
|---|---|---|---|---|
| `L("RoleName")` | `RoleId` (valeur) → propagé vers `RoleName` via lookup client | `ejs-dropdownlist` `#editRoleDropdown`, `allowFiltering`, `filterType=Contains`, champs `text=Name` / `value=Id` | Oui (JS bloque si vide : `RoleNameCannotBeEmpty`) | `ViewBag.RoleList` (`GenericViewModel`: `Id`, `Name`) = rôles du tenant ayant ≥ 1 utilisateur. Le libellé retenu (`RoleName`) provient de `roleListData` (=`DisplayName` du rôle). |
| `L("AssignedOrganigramme")` | `OrganigrammeId` | `ejs-dropdowntree` `#editOrganigrammeDropdown` (arbre), `allowFiltering`, `filterType=Contains`, champs `value=Id` / `text=DisplayName`, `hasChildren=false` | Non (peut être vide → non affecté) | `ViewBag.Organigrammes` (`OrganigrammeComboboxItemDto`: `Id`, `DisplayName` hiérarchisé). |

Bloc d'aide (`alert-info`) : instructions `SelectRoleFromTable`, `ModifyRoleNameAndOrganigramme`, `ClickUpdateToSaveToDatabase`.

### Service applicatif & opérations

- **Interface** : `src/DocuPro.Application.Shared/CommonEntities/IRoleOrganigrammeAssignmentAppService.cs`.
- **Implémentation** : `src/DocuPro.Application/CommonEntities/RoleOrganigrammeAssignmentAppService.cs` (dépendances injectées : `RoleManager`, `IRepository<Organigramme>`).

| Méthode | Entrée | Sortie | Description |
|---|---|---|---|
| `GetRoleOrganigrammeAssignments()` | — | `RoleOrganigrammeAssignmentInputDto` | Parcourt **tous** les rôles (`RoleManager.Roles.ToListAsync()`), crée un `RoleOrganigrammeAssignmentDto` par rôle avec `RoleId=role.Id`, `RoleName=role.DisplayName ?? role.Name`, `OrganigrammeId=role.OrganigrammeId`, `IsAssigned=role.OrganigrammeId.HasValue`. Si affecté, charge le nom via `_organigrammeRepository.FirstOrDefaultAsync(OrganigrammeId)` → `OrganigrammeName=organigramme?.Name`. |
| `GetOrganigrammesForCombobox()` | — | `List<OrganigrammeComboboxItemDto>` | Charge tous les organigrammes (`GetAllListAsync`), reconstruit l'arbre depuis les racines (`ParentId == null`) et aplatit en liste hiérarchique via `AddOrganigrammeWithChildren` (préfixe `"── "` cumulé par niveau, `Level` incrémenté). `DisplayName = prefix + Name`. |
| `UpdateRoleOrganigrammeAssignments(RoleOrganigrammeAssignmentInputDto input)` | `RoleOrganigrammeAssignmentInputDto` | `Task` (void) | Pour chaque `assignment` : récupère le rôle (`RoleManager.GetRoleByIdAsync(assignment.RoleId)`) ; **si le rôle est introuvable (`role == null`), l'affectation est silencieusement ignorée** (garde `if (role != null)`, aucune exception) ; sinon, si `role.DisplayName != assignment.RoleName` → met à jour `role.DisplayName` ; affecte `role.OrganigrammeId = assignment.OrganigrammeId` (null autorisé = désaffectation) ; persiste via `RoleManager.UpdateAsync(role)`. `[AbpAuthorize(Pages_RoleOrganigramme_Access)]`. |

Méthode privée `AddOrganigrammeWithChildren(List<Organigramme> all, Organigramme current, List<OrganigrammeComboboxItemDto> result, int level, string prefix)` : récursion de construction de l'arbre aplati.

**Actions MVC du contrôleur** (`RoleOrganigrammeController`) :

| Action | Signature | Renvoie |
|---|---|---|
| `Index` | `public async Task<ActionResult> Index()` | Vue `Index.cshtml` avec `model = await _roleOrganigrammeAssignmentAppService.GetRoleOrganigrammeAssignments()`. Alimente `ViewBag.Organigrammes = GetOrganigrammesForCombobox()` et `ViewBag.RoleList` = liste de `GenericViewModel { Id=(int)roleItem.Id, Name=roleItem.DisplayName }` construite en filtrant `_roleAppService.GetRoles(new GetRolesInput())` pour ne garder que les rôles où `_userManager.GetUsersInRoleAsync(roleItem.Name)` renvoie au moins un utilisateur (les erreurs sont journalisées via `Logger.Error`, le rôle est alors ignoré). |
| `UpdateAssignments` | `[HttpPost] public async Task<ActionResult> UpdateAssignments([FromBody] RoleOrganigrammeAssignmentInputDto model)` | Si `ModelState.IsValid` : appelle `UpdateRoleOrganigrammeAssignments(model)` et renvoie `Json(new { success = true, message = "Role assignments updated successfully!" })`. Sinon `Json(new { success = false, message = "Please correct the errors and try again." })`. |

Dépendances du contrôleur : `IRoleOrganigrammeAssignmentAppService`, `IRoleAppService` (`GetRoles(GetRolesInput)`), `UserManager` (`GetUsersInRoleAsync`).

### DTOs

**`RoleOrganigrammeAssignmentDto`** — `src/DocuPro.Application.Shared/CommonEntities/Dtos/RoleOrganigrammeAssignmentDto.cs`

| Propriété | Type C# | Obligatoire (`[Required]`) | Description |
|---|---|---|---|
| `RoleId` | `int` | Non | Identifiant du rôle (`AbpRoles.Id`). |
| `RoleName` | `string` | **Oui** (`[Required]`) | Libellé du rôle ; lu depuis `DisplayName ?? Name`, réécrit dans `AbpRoles.DisplayName`. |
| `OrganigrammeId` | `int?` | Non | Nœud d'organigramme affecté (`AbpRoles.OrganigrammeId`) ; `null` = non affecté. |
| `OrganigrammeName` | `string` | Non | Nom de l'organigramme affecté (lecture seule, `Organigrammes.Name`). |
| `IsAssigned` | `bool` | Non | Indicateur calculé `OrganigrammeId.HasValue` (aussi recalculé côté JS `!!OrganigrammeId`). |

**`RoleOrganigrammeAssignmentInputDto`** — même fichier (modèle de la vue et payload POST)

| Propriété | Type C# | Obligatoire | Description |
|---|---|---|---|
| `RoleAssignments` | `List<RoleOrganigrammeAssignmentDto>` | Non | Collection complète des affectations rôle→organigramme (initialisée à liste vide par le constructeur). Le POST envoie la **liste entière**, pas seulement la ligne modifiée. |

**`OrganigrammeComboboxItemDto`** — même fichier (source de l'arbre déroulant)

| Propriété | Type C# | Obligatoire | Description |
|---|---|---|---|
| `Id` | `int` | Non | `Organigrammes.Id`. |
| `Name` | `string` | Non | `Organigrammes.Name` brut. |
| `DisplayName` | `string` | Non | Nom hiérarchisé (préfixe `"── "` par niveau). |
| `Level` | `int` | Non | Profondeur dans l'arbre (0 = racine). |

**`GenericViewModel`** — `src/DocuPro.Web.Mvc/ViewModels/GenericViewModel.cs` (utilisé pour `ViewBag.RoleList` ; seuls `Id` et `Name` sont renseignés ici)

| Propriété | Type C# | Obligatoire | Description |
|---|---|---|---|
| `Id` | `int` | Non | Id du rôle (renseigné). |
| `Name` | `string` | Non | `DisplayName` du rôle (renseigné). |
| `Name2` | `string` | Non | Non utilisé par cette page. |
| `Valeur` | `int` | Non | Non utilisé par cette page. |
| `Date` | `DateTime` (get-only) | Non | Non utilisé par cette page. |

### Tables & colonnes impactées

**Aucune table de liaison dédiée.** L'affectation vit dans la colonne `OrganigrammeId` de la table des rôles ABP.

- **Table `AbpRoles`** — entité `Role : AbpRole<User>` (`src/DocuPro.Core/Authorization/Roles/Role.cs`). Base ABP : `AbpRole<TUser>` (dérive de `FullAuditedEntity<int>`, implémente `IMayHaveTenant`). La FK vers l'organigramme est déclarée **par annotation** sur l'entité (`[ForeignKey("OrganigrammeId")] public virtual Organigramme OrganigrammeFk`) ; **aucune configuration Fluent** n'existe dans `DocuProDbContext` pour `Role`. DbSet : géré par ABP (`Roles`).

| Table | Colonne | Type SQL / CLR | Lecture / Écriture (par cette page) |
|---|---|---|---|
| `AbpRoles` | `Id` | `int` (PK) | Lecture (identification du rôle) |
| `AbpRoles` | `TenantId` | `int?` | Lecture (filtre tenant implicite) |
| `AbpRoles` | `Name` | `nvarchar` | Lecture (fallback `RoleName`, et clé pour `GetUsersInRoleAsync`) |
| `AbpRoles` | `DisplayName` | `nvarchar` | Lecture + **Écriture** (mis à jour si `RoleName` diffère) |
| `AbpRoles` | **`OrganigrammeId`** | `int?` (FK → `Organigrammes.Id`) | Lecture + **Écriture** (cœur de l'affectation ; `null` = désaffectation) |

- **Table `Organigrammes`** — entité `Organigramme` (`src/DocuPro.Core/CommonEntities/Organigramme.cs`), `[Table("Organigrammes")]`, base `FullAuditedEntity`, interface `IMayHaveTenant`. DbSet : `public virtual DbSet<Organigramme> Organigrammes` (`DocuProDbContext.cs`). Index : `modelBuilder.Entity<Organigramme>(o => o.HasIndex(e => new { e.TenantId }))`. **Lecture seule** dans cette page.

| Table | Colonne | Type SQL / CLR | Lecture / Écriture |
|---|---|---|---|
| `Organigrammes` | `Id` | `int` (PK) | Lecture |
| `Organigrammes` | `TenantId` | `int?` | Lecture (index / filtre tenant) |
| `Organigrammes` | `Name` | `nvarchar` **Required** | Lecture (`OrganigrammeName`, `DisplayName`) |
| `Organigrammes` | `ParentId` | `int?` (FK auto-réf. → `Organigrammes.Id`) | Lecture (reconstruction de l'arbre) |
| `Organigrammes` | audit (`CreationTime`, `CreatorUserId`, `LastModificationTime`, `LastModifierUserId`, `IsDeleted`, `DeleterUserId`, `DeletionTime`) | divers | Non utilisées par cette page |

- **Table `AbpUserRoles`** (liaison ABP utilisateur↔rôle) — **lecture indirecte** via `UserManager.GetUsersInRoleAsync(role.Name)` dans `Index()`, uniquement pour filtrer les rôles à afficher dans `ViewBag.RoleList` (ne garder que les rôles ayant au moins un utilisateur). Aucune écriture.

### Règles de gestion / effets de bord / transitions de statut

- **Pas de transition de `MailStatus` ni de bascule des drapeaux `Mail`** : cette page ne touche pas l'entité `Mail`. `MailStatus`, `Valider`, `ValidationDirection`, `ValidationDG`, `EnregistrementReponse`, `Decharge` et les dates (`DateEnregistrementCourrier`, etc.) — **sans objet ici**.
- **Effet principal (écriture)** : `UpdateRoleOrganigrammeAssignments` positionne `AbpRoles.OrganigrammeId` (ou le met à `null`) pour chaque rôle de la liste envoyée, et met à jour `AbpRoles.DisplayName` si le libellé a changé. Persistance via `RoleManager.UpdateAsync`.
- **Portée du POST** : le client (`updateAssignment()`) construit le payload à partir de **toute** `roleAssignmentsData` (pas seulement la ligne éditée). Le serveur itère donc sur l'ensemble et ré-applique `OrganigrammeId`/`DisplayName` pour chaque rôle — comportement de type « upsert complet » sur les rôles listés. Il n'y a pas de suppression de rôle ; `null` sur `OrganigrammeId` signifie simplement « non affecté ».
- **« Clear » non persistant** : le bouton `ClearAssignment` efface l'affectation **uniquement dans la grille (client)** ; sans clic ultérieur sur `UpdateAssignment`, la base n'est pas modifiée (source possible d'incohérence perçue par l'utilisateur).
- **Filtrage d'affichage des rôles** : seuls les rôles possédant au moins un utilisateur (`GetUsersInRoleAsync`) alimentent la liste déroulante de droite (`ViewBag.RoleList`). En revanche la **grille de gauche** (`Model.RoleAssignments`) liste **tous** les rôles du tenant (retournés par `GetRoleOrganigrammeAssignments`) — divergence de périmètre entre les deux panneaux.
- **Notifications / e-mails / jobs** : aucun. Aucun envoi de mail, aucune numérotation/séquence, aucun job déclenché, aucune liaison document/scan (`MarkAsProcessed`).
- **Idempotence** : ré-envoyer le même payload produit le même état (réaffecte les mêmes valeurs). Pas de garde d'idempotence spécifique.
- **Multi-tenant** : opérations bornées au tenant courant via les filtres `IMayHaveTenant` sur `Role` et `Organigramme` (aucun `DisableFilter`).
- **Validation** : côté serveur, seul `ModelState.IsValid` est vérifié dans l'action (le `[Required]` sur `RoleName` en fait partie) ; côté client, le JS bloque l'enregistrement si aucun rôle n'est sélectionné ou si `RoleId` est vide. Aucune validation d'existence de l'`OrganigrammeId` transmis n'est effectuée avant l'affectation (la contrainte FK `AbpRoles.OrganigrammeId → Organigrammes.Id` reste le garde-fou base de données).


---


## 16. Types d'entités externes (`/App/ExternalEntityTypes`)

### Rôle métier

Page de **paramétrage** (menu *Paramétrage / MailSettings*) permettant de gérer le référentiel des **types d'entités externes** (`ExternalEntityType`). Un « type d'entité externe » est une catégorie servant à classer les entités externes (`ExternalEntity`) qui interviennent comme expéditeur/destinataire dans les courriers (ex. Ministère, Ambassade, Direction, Société…). La page est une page de **saisie/administration** (lecture + écriture) : elle liste les types existants dans une grille et permet de les **créer en masse** (un nom par ligne), de **renommer** l'élément sélectionné et de **supprimer** une sélection multiple. Elle n'intervient dans aucune transition de statut de courrier. À noter : malgré l'intitulé du besoin, cette page **ne gère pas** directement les *propriétés personnalisées* (`ExternalEntityCustomProperty`) : ces propriétés sont créées dynamiquement ailleurs (voir §Règles de gestion) ; aucune interface de gestion des propriétés n'est branchée sur cette page, et les entités concernées **ne portent pas de type de donnée (`DataType`)** — seul un `Name` est stocké (voir §DTOs et §Tables).

### Accès & permissions

- **Contrôleur MVC** : `ExternalEntityTypesController` (namespace `DocuPro.Web.Areas.App.Controllers.Common`), fichier `src/DocuPro.Web.Mvc/Areas/App/Controllers/Parametrages/ExternalEntityTypesController.cs`.
  - Attributs : `[Area("App")]`, `[AbpMvcAuthorize(AppPermissions.Pages_ExternalEntityTypes_Access)]`.
- **Service applicatif** : `ExternalEntityTypesAppService` (`src/DocuPro.Application/CommonEntities/ExternalEntityTypesAppService.cs`), attribut de classe `[AbpAuthorize(AppPermissions.StandardUser)]`. Les attributs plus fins (`Pages_ExternalEntityTypes_Create/Edit/Delete`) existent en constantes mais sont **commentés** sur les méthodes du service (aucune vérification par opération côté service).
  - Service annexe (propriétés personnalisées) : `ExternalEntityCustomPropertiesAppService` (`src/DocuPro.Application/CommonEntities/ExternalEntityCustomPropertiesAppService.cs`), `[AbpAuthorize(AppPermissions.StandardUser)]`.
- **Constantes de permission** (`src/DocuPro.Core.Shared/Authorization/AppPermissions.cs`) :
  - `Pages_ExternalEntityTypes` = `"Pages.ExternalEntityTypes"`
  - `Pages_ExternalEntityTypes_Access` = `"Pages.ExternalEntityTypes.Access"` (libellé `ExternalEntityTypesAccess` → « Accès Types d'entités externes »)
  - `Pages_ExternalEntityTypes_Create` = `"Pages.ExternalEntityTypes.Create"` (libellé `CreateNewExternalEntityType`)
  - `Pages_ExternalEntityTypes_Edit` = `"Pages.ExternalEntityTypes.Edit"` (libellé `EditExternalEntityType`)
  - `Pages_ExternalEntityTypes_Delete` = `"Pages.ExternalEntityTypes.Delete"` (libellé `DeleteExternalEntityType`)
  - `Menus_Mail_Settings_ExternalEntityTypes` = `"Menus.Mail_Settings.ExternalEntityTypes"` (libellé `MailSettings_ExternalEntityTypes` → « Types d'entités externes »)
  - Déclaration hiérarchique dans `src/DocuPro.Core/Authorization/AppAuthorizationProvider.cs` (lignes 379-383 pour les pages ; ligne 84 pour l'entrée de menu MailSettings).
  - Permissions des propriétés personnalisées (déclarées mais **sans page/menu** rattachés) : `Pages_ExternalEntityCustomProperties` / `_Create` / `_Edit` / `_Delete` (`AppAuthorizationProvider.cs` lignes 194-197).
- **Entrée de menu** (`src/DocuPro.Web.Mvc/Areas/App/Startup/AppNavigationProvider.cs`, lignes 372-378) :
  - Nom de page : `AppPageNames.Common.ExternalEntityTypes` = `"CommonBase.ExternalEntityTypes"` (`AppPageNames.cs` ligne 114).
  - Libellé : `L("ExternalEntityTypes")` → « Types d'entités externes ».
  - URL : `App/ExternalEntityTypes` · Icône : `bi bi-layers` · Pas de badge.
  - Dépendance de permission : `SimplePermissionDependency(requiresAll: true, AppPermissions.Pages_ExternalEntityTypes_Access, AppPermissions.Menus_Mail_Settings_ExternalEntityTypes)` — **les deux** permissions sont requises.
- **Multi-tenant** : entité `ExternalEntityType` en `IMayHaveTenant`. À la création, `TenantId` est renseigné depuis `AbpSession.TenantId` s'il est non nul (`ExternalEntityTypesAppService.Create`). Filtre de tenant ABP standard (non désactivé).

### Interface utilisateur

- **Page Razor** : `src/DocuPro.Web.Mvc/Areas/App/Views/ExternalEntityTypes/Index.cshtml`.
- **Script** : bloc `@section Scripts` **inline** dans `Index.cshtml` (le fichier utilise ses propres fonctions JavaScript). Les fichiers `src/DocuPro.Web.Mvc/wwwroot/view-resources/Areas/App/Views/ExternalEntityTypes/Index.js` et `_CreateOrEditModal.js` (générés par le RadTool AspNetZero standard : DataTable `#ExternalEntityTypesTable`, modale `CreateOrEditModal`, `ImportFromExcel`, `ExportToExcel`, `ViewModal`) **ne sont PAS référencés** par cette vue et pointent vers des endpoints inexistants dans le contrôleur actuel → **code mort** (idem `_ExcelColumnSelectionModal.js`).
- **Titre / sous-titre affichés** : `abp-page-subheader` avec `title = L("MailSettings")` et `description = L("ExternalEntityTypes")` ; `ViewBag.Title = L("ExternalEntityTypes")`.
- **Données injectées** : l'action `Index` place dans `ViewBag.ExternalEntityTypes` une liste anonyme `{ Id, Name }` (issue de `GetAllList()`) qui alimente directement la grille et est sérialisée en JSON (`externalEntityTypesData`).
- **Disposition** : deux cartes côte à côte (`col-md-6`). Carte gauche = grille + bouton Supprimer. Carte droite = zone d'ajout en masse + zone d'édition.

#### Filtres / recherche

| Libellé | Propriété (input→serveur) | Type de contrôle | Source / comportement serveur |
|---|---|---|---|
| Recherche | — | Barre de recherche intégrée du toolbar Syncfusion (`toolbar` inclut `"Search"`) | **Filtrage purement client** sur les données déjà chargées dans la grille `TreeGrid` (pas d'appel serveur). Aucun `Filter`/`NameFilter` n'est envoyé depuis cette page. |

> Remarque : la méthode serveur `GetAll(GetAllExternalEntityTypesInput)` (avec `Filter`/`NameFilter`) existe dans le service mais **n'est pas utilisée** par cette page ; la vue charge tout via `GetAllList()` (mis en cache).

#### Colonnes du tableau (grille `TreeGrid` — Syncfusion `ejs-grid`)

| Libellé | Propriété (`field`) | Type |
|---|---|---|
| (case à cocher de sélection) | — (`type="checkbox"`, width 20) | Sélection multiple de lignes |
| `L("Name")` (« Nom ») | `Name` (width 200) | Texte |

Paramètres grille : `locale="fr"`, `allowPaging="true"` (`pageSize=10`), `allowSorting="true"`, `allowExcelExport="true"`, `allowPdfExport="true"`, `dataSource="ViewBag.ExternalEntityTypes"`. Toolbar : `Search`, `ExcelExport`, `CsvExport`, `PdfExport`. Sélection : `type: 'Multiple', mode: 'Row'` (configurée dans `DOMContentLoaded`). Les exports Excel/CSV/PDF sont **côté client** (méthodes `grid.excelExport()/csvExport()/pdfExport()` déclenchées par `toolbarClick`), sans appel serveur.

#### Actions (boutons)

| Bouton | Effet (endpoint / JS) | Permission |
|---|---|---|
| **Ajouter** (`#addExternalEntityTypesButton`, `onclick=addExternalEntityTypes()`) | Lit le `textarea`, découpe par ligne, normalise (trim, collapse d'espaces, dédup insensible à la casse), trie, confirme (SweetAlert) puis `POST` AJAX vers `CreateMultipleNodes` avec `{ ParentId:null, NodeNames:[…] }`. Recharge la page au succès. | `Pages_ExternalEntityTypes_Access` (contrôleur). Pas de contrôle `Create` séparé. |
| **Modifier** (`#updateExternalEntityTypeButton`, `onclick=updateExternalEntityType()`, désactivé tant qu'aucune ligne sélectionnée) | `POST` AJAX vers `UpdateNode` avec `{ Id: <sélection>.Id, Name: <editExternalEntityTypeName> }`. Recharge au succès. | `Pages_ExternalEntityTypes_Access`. Pas de contrôle `Edit` séparé. |
| **Supprimer** (`#deleteExternalEntityTypesButton`, `onclick=deleteExternalEntityTypes()`, désactivé tant qu'aucune sélection) | Récupère les `Id` des lignes cochées, confirme, `POST` AJAX vers `DeleteNodes` avec un tableau JSON d'entiers `[id,…]`. Recharge au succès. | `Pages_ExternalEntityTypes_Access`. Pas de contrôle `Delete` séparé. |
| Export Excel / CSV / PDF (toolbar) | Export client Syncfusion (`toolbarClick`). | — |

Comportement de sélection : `onRowSelected`/`onRowDeselected` mémorisent `selectedExternalEntityType` (= `args.data`, objet `{Id, Name}`), activent/désactivent les boutons Modifier/Supprimer et pré-remplissent le champ `editExternalEntityTypeName` avec le `Name` sélectionné (`updateUIState`).

#### Formulaire(s) / champs de saisie (pas de modale — saisie inline dans la carte droite)

| Champ | Propriété DTO (chaîne d'appel) | Type de contrôle | Obligatoire | Source / valeurs |
|---|---|---|---|---|
| Zone d'ajout en masse (`#externalEntityTypeNames`, placeholder `L("EnterExternalEntityTypes")`) | lignes → `MultipleNodeRequestExternalEntityType.NodeNames` (List&lt;string&gt;) → pour chacune `CreateOrEditExternalEntityTypeDto.Name` | `textarea` (rows=4) | Oui (au moins une ligne non vide, sinon erreur `NoExternalEntityTypeNamesProvided`) | Saisie libre, un nom par ligne |
| Champ d'édition (`#editExternalEntityTypeName`, placeholder `L("EditExternalEntityType")`) | `UpdateNodeRequestExternalEntityType.Name` (+ `.Id`) → `CreateOrEditExternalEntityTypeDto.Name` | `ejs-textbox` Syncfusion (`floatLabelType="Auto"`) | Oui (vide → erreur `ExternalEntityTypeNameCannotBeEmpty`) | Pré-rempli avec la ligne sélectionnée dans la grille |

Mapping écran → DTO → colonne (fil conducteur) :
- Colonne grille `Name` ⇐ `GetExternalEntityTypeForViewDto.ExternalEntityType.Name` (projeté `{Id, Name}` par l'action `Index`) ⇐ `ExternalEntityTypes.Name`.
- Textarea → `NodeNames[i]` → `CreateOrEditExternalEntityTypeDto.Name` → **écrit** `ExternalEntityTypes.Name` (nouvelle ligne).
- Champ d'édition → `UpdateNodeRequestExternalEntityType.Name` → chargé via `GetExternalEntityTypeForEdit` → `CreateOrEditExternalEntityTypeDto.Name` → **met à jour** `ExternalEntityTypes.Name`.
- Cases cochées → `List<int>` (ids) → `Delete(EntityDto)` → **supprime** (soft delete) la ligne `ExternalEntityTypes`.

### Service applicatif & opérations

- **Interface** : `src/DocuPro.Application.Shared/CommonEntities/IExternalEntityTypesAppService.cs`
- **Implémentation** : `src/DocuPro.Application/CommonEntities/ExternalEntityTypesAppService.cs`

| Méthode | Entrée | Sortie | Description |
|---|---|---|---|
| `GetAllList()` | — | `List<GetExternalEntityTypeForViewDto>` | Liste triée par `Name`, **mise en cache** (cache `"ExternalEntityTypeCache"`, clé `"ExternalEntityTypes_All"`). Projette `{Id, Name}`. Utilisée par l'action `Index`. |
| `CheckIsDuplicate(string name)` | `name` | `bool` | Vrai s'il existe déjà un type dont le `Name` (comparé en majuscules) est identique. Utilisée par `UpdateNode`. |
| `GetAll(GetAllExternalEntityTypesInput input)` | `GetAllExternalEntityTypesInput` | `PagedResultDto<GetExternalEntityTypeForViewDto>` | Recherche paginée/filtrée (`Filter`/`NameFilter` sur `Name`), tri `Sorting ?? "id asc"`. **Non appelée** par cette page. |
| `GetExternalEntityTypeForView(int id)` | `id` | `GetExternalEntityTypeForViewDto` | Charge par Id, mappe vers `ExternalEntityTypeDto`. Utilisée dans `CreateMultipleNodes` et `DeleteNodes`. |
| `GetExternalEntityTypeForEdit(EntityDto input)` | `EntityDto` | `GetExternalEntityTypeForEditOutput` | Charge par Id, mappe vers `CreateOrEditExternalEntityTypeDto`. Utilisée dans `UpdateNode`. |
| `CreateOrEdit(CreateOrEditExternalEntityTypeDto input)` | `CreateOrEditExternalEntityTypeDto` | `Task` | **Uniquement si** la 1re lettre du `Name` est en minuscule (`char.IsLower(input.Name[0])`), la met en majuscule et passe **le reste en minuscules** (ex. `ministère des FINANCES` → `Ministère des finances`) ; si la 1re lettre est déjà en majuscule, le libellé est laissé **tel quel** (aucune mise en minuscule du reste). Ensuite, si `Id == null` → `Create`, sinon → `Update` ; **vide le cache** après. |
| `Create` *(protected)* | `CreateOrEditExternalEntityTypeDto` | `Task` | Mappe vers `ExternalEntityType`, positionne `TenantId` depuis `AbpSession`, `InsertAsync`. |
| `Update` *(protected)* | `CreateOrEditExternalEntityTypeDto` | `Task` | Recharge l'entité par `Id` et applique le mapping. |
| `Delete(EntityDto input)` | `EntityDto` | `Task` | `DeleteAsync(input.Id)` (soft delete via `FullAuditedEntity`) puis **vide le cache**. |
| `GetExternalEntityTypesToExcel(GetAllExternalEntityTypesForExcelInput input)` | `GetAllExternalEntityTypesForExcelInput` | `FileDto` | **Stub** : construit la requête mais l'export réel est commenté ; renvoie un `FileDto` vide. Non utilisée par cette page. |

**Service des propriétés personnalisées** — Interface `src/DocuPro.Application.Shared/CommonEntities/IExternalEntityCustomPropertiesAppService.cs`, impl. `src/DocuPro.Application/CommonEntities/ExternalEntityCustomPropertiesAppService.cs` :

| Méthode | Entrée | Sortie | Description |
|---|---|---|---|
| `GetOrCreateCustomPropertyByName(string name)` | `name` | `ExternalEntityCustomPropertyDto` | Cherche une propriété par `Name` ; si absente, la crée (avec `TenantId`) et `SaveChangesAsync`. **Point d'entrée réel** de création des propriétés dynamiques (appelée hors de cette page). |
| `GetAll(GetAllExternalEntityCustomPropertiesInput)` | idem type | `PagedResultDto<GetExternalEntityCustomPropertyForViewDto>` | Recherche paginée/filtrée. Non branchée sur une page. |
| `GetExternalEntityCustomPropertyForView(int id)` | `id` | `GetExternalEntityCustomPropertyForViewDto` | Vue par Id. |
| `GetExternalEntityCustomPropertyForEdit(EntityDto)` | `EntityDto` | `GetExternalEntityCustomPropertyForEditOutput` | Édition par Id. |
| `CreateOrEdit(CreateOrEditExternalEntityCustomPropertyDto)` | idem type | `Task` | Create/Update selon `Id`. |
| `Delete(EntityDto)` | `EntityDto` | `Task` | Suppression (soft delete). |
| `GetExternalEntityCustomPropertiesToExcel(...)` | input Excel | `FileDto` | **Stub** (FileDto vide). |

**Actions MVC du contrôleur** (`ExternalEntityTypesController`) :

| Action | Signature / paramètres | Retour |
|---|---|---|
| `Index()` | `GET`, sans paramètre | `View()` ; alimente `ViewBag.ExternalEntityTypes` = `GetAllList()` projeté en `{ Id, Name }`. |
| `CreateMultipleNodes([FromBody] MultipleNodeRequestExternalEntityType request)` | `POST`, JSON `{ NodeNames: string[] }` | `JsonResult`. Normalise (`Trim`, non vide, `ToLowerInvariant().Replace(" ","")`, `Distinct`), rejette doublons existants, appelle `CreateOrEdit`, relit chaque créé via `GetExternalEntityTypeForView`. JSON : `{ success, newNodes:[{Id,Name}], errors:[] }`. Si `NodeNames` vide → `{ success:false, message }`. |
| `DeleteNodes([FromBody] List<int> ids)` | `POST`, JSON `[int,…]` | `JsonResult`. Pour chaque id : `GetExternalEntityTypeForView` (si null → `{success:false}`) puis `Delete(new EntityDto(id))`. JSON `{ success:true }`. Liste vide → `{ success:false, message }`. |
| `UpdateNode([FromBody] UpdateNodeRequestExternalEntityType request)` | `POST`, JSON `{ Id:int, Name:string }` | `JsonResult`. `Id==0` → erreur. `CheckIsDuplicate(Name)` → si vrai `{ success:false, "Duplicate node" }`. Sinon `GetExternalEntityTypeForEdit`, affecte `Name`, `CreateOrEdit`. JSON `{ success:true }`. |

### DTOs

**`ExternalEntityTypeDto`** (`.../Dtos/ExternalEntityTypeDto.cs`) — hérite `EntityDto` (donc `Id` int).

| Propriété | Type C# | Obligatoire | Description |
|---|---|---|---|
| `Id` | `int` (hérité de `EntityDto`) | — | Identifiant. |
| `Name` | `string` | Non ([Required] absent ici) | Libellé du type. |

**`CreateOrEditExternalEntityTypeDto`** (`.../Dtos/CreateOrEditExternalEntityTypeDto.cs`) — hérite `EntityDto<int?>`.

| Propriété | Type C# | Obligatoire | Description |
|---|---|---|---|
| `Id` | `int?` (hérité de `EntityDto<int?>`) | Non | Null = création, non-null = édition. |
| `Name` | `string` | **Oui** (`[Required]`) | Libellé du type. |

**`GetExternalEntityTypeForViewDto`** (`.../Dtos/GetExternalEntityTypeForViewDto.cs`).

| Propriété | Type C# | Obligatoire | Description |
|---|---|---|---|
| `ExternalEntityType` | `ExternalEntityTypeDto` | — | Wrapper de vue. |

**`GetExternalEntityTypeForEditOutput`** (`.../Dtos/GetExternalEntityTypeForEditOutput.cs`).

| Propriété | Type C# | Obligatoire | Description |
|---|---|---|---|
| `ExternalEntityType` | `CreateOrEditExternalEntityTypeDto` | — | Wrapper d'édition. |

**`GetAllExternalEntityTypesInput`** (`.../Dtos/GetAllExternalEntityTypesInput.cs`) — hérite `PagedAndSortedResultRequestDto`.

| Propriété | Type C# | Obligatoire | Description |
|---|---|---|---|
| `Filter` | `string` | Non | Filtre global (sur `Name`). |
| `NameFilter` | `string` | Non | Filtre sur `Name`. |
| `Sorting` | `string` (hérité) | Non | Tri (défaut `"id asc"`). |
| `SkipCount` | `int` (hérité) | Non | Pagination. |
| `MaxResultCount` | `int` (hérité) | Non | Pagination. |

**`GetAllExternalEntityTypesForExcelInput`** (`.../Dtos/GetAllExternalEntityTypesForExcelInput.cs`).

| Propriété | Type C# | Obligatoire | Description |
|---|---|---|---|
| `Filter` | `string` | Non | Filtre global. |
| `NameFilter` | `string` | Non | Filtre sur `Name`. |

**`MultipleNodeRequestExternalEntityType`** (classe interne au contrôleur `ExternalEntityTypesController.cs`).

| Propriété | Type C# | Obligatoire | Description |
|---|---|---|---|
| `NodeNames` | `List<string>` | — | Noms à créer en masse (le champ `ParentId` envoyé par le JS n'est **pas** lié : pas de propriété correspondante côté serveur). |

**`UpdateNodeRequestExternalEntityType`** (classe interne au contrôleur).

| Propriété | Type C# | Obligatoire | Description |
|---|---|---|---|
| `Id` | `int` | — | Type à renommer. |
| `Name` | `string` | — | Nouveau libellé. |

**DTOs des propriétés personnalisées** (déclarés, non consommés par cette page) :

- **`ExternalEntityCustomPropertyDto`** (`EntityDto`) : `Id` (int), `Name` (string).
- **`CreateOrEditExternalEntityCustomPropertyDto`** (`EntityDto<int?>`) : `Id` (int?), `Name` (string, `[Required]`).
- **`GetExternalEntityCustomPropertyForViewDto`** : `ExternalEntityCustomProperty` (`ExternalEntityCustomPropertyDto`).
- **`GetExternalEntityCustomPropertyForEditOutput`** : `ExternalEntityCustomProperty` (`CreateOrEditExternalEntityCustomPropertyDto`).
- **`GetAllExternalEntityCustomPropertiesInput`** (`PagedAndSortedResultRequestDto`) : `Filter` (string), `NameFilter` (string) + `Sorting`/`SkipCount`/`MaxResultCount` hérités.
- **`GetAllExternalEntityCustomPropertiesForExcelInput`** : `Filter` (string), `NameFilter` (string).

> Aucun de ces DTOs (ni les entités correspondantes) ne comporte de propriété **`DataType`**, ni d'enum de type de donnée : la « propriété personnalisée » se réduit à un `Name`.

### Tables & colonnes impactées

**Table `ExternalEntityTypes`** — entité `ExternalEntityType` (`src/DocuPro.Core/CommonEntities/ExternalEntityType.cs`), base `FullAuditedEntity`, interface `IMayHaveTenant`. DbSet : `DocuProDbContext.ExternalEntityTypes` (ligne 152). Index : `HasIndex(TenantId)` (`DocuProDbContext.cs` lignes 474-477). Table **principale lue et écrite** par cette page.

| Table | Colonne | Type SQL/CLR | Lecture / Écriture (par cette page) |
|---|---|---|---|
| `ExternalEntityTypes` | `Id` | `int` (PK, identité) | Lecture (grille, edit, delete) |
| `ExternalEntityTypes` | `TenantId` | `int?` | Écriture (positionné à la création) / filtrage tenant |
| `ExternalEntityTypes` | `Name` | `nvarchar` (`[Required]`) | Lecture + Écriture (create/update) |
| `ExternalEntityTypes` | `IsDeleted` | `bit` (FullAudited) | Écriture (soft delete) |
| `ExternalEntityTypes` | `DeleterUserId` | `bigint?` | Écriture (soft delete) |
| `ExternalEntityTypes` | `DeletionTime` | `datetime2?` | Écriture (soft delete) |
| `ExternalEntityTypes` | `CreationTime` | `datetime2` | Écriture (création) |
| `ExternalEntityTypes` | `CreatorUserId` | `bigint?` | Écriture (création) |
| `ExternalEntityTypes` | `LastModificationTime` | `datetime2?` | Écriture (édition) |
| `ExternalEntityTypes` | `LastModifierUserId` | `bigint?` | Écriture (édition) |

**Table `ExternalEntityCustomProperties`** — entité `ExternalEntityCustomProperty` (`src/DocuPro.Core/CommonEntities/ExternalEntityCustomProperty.cs`), `FullAuditedEntity`, `IMayHaveTenant`. DbSet `ExternalEntityCustomProperties` (ligne 148). Index `HasIndex(TenantId)` (lignes 466-469). **Non écrite par cette page** (créée dynamiquement ailleurs).

| Table | Colonne | Type SQL/CLR | Lecture / Écriture (par cette page) |
|---|---|---|---|
| `ExternalEntityCustomProperties` | `Id` | `int` (PK) | — (hors page) |
| `ExternalEntityCustomProperties` | `TenantId` | `int?` | — |
| `ExternalEntityCustomProperties` | `Name` | `nvarchar` (`[Required]`) | — |
| `ExternalEntityCustomProperties` | (colonnes d'audit `FullAudited`) | — | — |

**Table `ExternalEntityCustomValues`** (référence, non touchée par cette page) — entité `ExternalEntityCustomValue` (`src/DocuPro.Core/CommonEntities/ExternalEntityCustomValue.cs`), `[Audited]`, `FullAuditedEntity`, `IMayHaveTenant`. Fait le lien entre un type, une propriété, une entité externe et une valeur : `Value` (string, Required), FK `ExternalEntityTypeId` → `ExternalEntityTypes`, FK `ExternalEntityCustomPropertyId` → `ExternalEntityCustomProperties`, FK `ExternalEntityId` → `ExternalEntities`. Index `HasIndex(TenantId)`. Alimentée par le flux document/courrier (voir §Règles), pas par cette page.

### Règles de gestion / effets de bord / transitions de statut

- **Aucune transition de `MailStatus`** ni bascule de drapeau courrier : page de paramétrage sans effet sur le cycle de vie des courriers.
- **Normalisation du libellé** :
  - Côté client (ajout) : découpage par ligne, `trim`, suppression des vides, dédoublonnage insensible à la casse (clé = minuscule + espaces compactés), tri alphabétique ; le contenu du textarea est réécrit trié/dédupliqué avant envoi.
  - Côté serveur (`CreateMultipleNodes`) : re-dédoublonnage (`ToLowerInvariant().Replace(" ", "")`, `HashSet` `OrdinalIgnoreCase`), et vérification d'existence contre la base → un doublon existant est **ignoré** et ajouté aux `errors` (le reste continue).
  - `CreateOrEdit` applique une normalisation **conditionnelle** du libellé : **uniquement si** la 1re lettre est en minuscule (`char.IsLower(Name[0])`), il la met en majuscule et met **le reste en minuscules** (ex. `« ministère des FINANCES »` → `« Ministère des finances »`). Si le libellé commence **déjà** par une majuscule (ex. `« MINISTÈRE des Finances »`), il est **laissé inchangé** (le reste n'est pas passé en minuscules). Cette normalisation s'applique aussi bien à la création qu'à l'édition.
  - `UpdateNode` refuse le renommage si `CheckIsDuplicate(Name)` est vrai (comparaison en majuscules sur l'ensemble de la table).
- **Cache** : `GetAllList()` sert la grille depuis le cache `"ExternalEntityTypeCache"` (clé `"ExternalEntityTypes_All"`). Le cache est **vidé** (`cache.ClearAsync()`) à chaque `CreateOrEdit` et `Delete`, garantissant une grille à jour après le `window.location.reload()` déclenché par le JS.
- **Suppression** : soft delete (`FullAuditedEntity` → `IsDeleted=true`). La suppression multiple boucle sur les ids ; si un id est introuvable, la réponse globale devient `{ success:false }` (les suppressions déjà exécutées dans la boucle ne sont pas annulées explicitement).
- **Multi-tenant** : `TenantId` renseigné depuis `AbpSession.TenantId` à la création (types et propriétés).
- **Propriétés personnalisées dynamiques** (le cœur du besoin « custom properties ») : elles ne sont **pas gérées depuis cette page**. Le mécanisme réel : lors du traitement d'un modèle de document, `MailTabsController.GetModelDataBydocumentModelId` (`src/DocuPro.Web.Mvc/Areas/App/Controllers/DocuCourriers/MailTabsController.cs`, ~ligne 1148) extrait les mots entre accolades du document (`ProcessDocumentWords`), puis pour chaque mot appelle `ExternalEntityCustomPropertiesAppService.GetOrCreateCustomPropertyByName(word)` (création à la volée de la propriété si absente), puis `GetOrCreateCustomValueByPropertyAndEntity` pour matérialiser la valeur dans `ExternalEntityCustomValues` (liée à la propriété, au type et à l'entité externe). Il n'existe **ni contrôleur, ni entrée de menu, ni route** pour `ExternalEntityCustomProperties` (les permissions `Pages.ExternalEntityCustomProperties.*` sont déclarées mais orphelines).
- **Absence de type de donnée** : contrairement à l'attendu initial, ni `ExternalEntityType` ni `ExternalEntityCustomProperty` ne portent d'attribut `DataType`/enum de type ; toute valeur personnalisée est stockée en `string` (`ExternalEntityCustomValues.Value`).
- **Export** : les exports Excel/CSV/PDF de la grille sont **100 % côté client** (Syncfusion). Les méthodes serveur `GetExternalEntityTypesToExcel` / `GetExternalEntityCustomPropertiesToExcel` sont des **stubs** renvoyant un `FileDto` vide (le vrai exporteur est commenté). Il existe un `ExternalEntityCustomPropertiesExcelExporter` (`src/DocuPro.Application/CommonEntities/Exporting/`) mais il n'est pas injecté/utilisé.
- **Code mort à ignorer lors d'une ré-implémentation** : `Index.js`, `_CreateOrEditModal.js`, `_ExcelColumnSelectionModal.js` (et équivalents `.min.js`) sous `wwwroot/view-resources/Areas/App/Views/ExternalEntityTypes/` et `.../ExternalEntityCustomProperties/` — générés par le RadTool, non référencés par `Index.cshtml`, pointant vers des endpoints inexistants (`CreateOrEditModal`, `ImportFromExcel`, `ExportToExcel`, `ViewModal`, DataTable `getAll`).


---


## 17. Entités externes (`/App/ExternalEntities`)

### Rôle métier

La page **Entités externes** est un écran de **paramétrage** du module Docu-Courriers (sous-menu « Paramétrage Docu-Courriers » / `MailSettings`). Elle gère le **référentiel des correspondants externes** (expéditeurs et destinataires : personnes, organisations, administrations…) qui sont référencés par chaque courrier via la colonne `Mail.ExternalEntityId` (FK `Mails.ExternalEntityId → ExternalEntities.Id`, navigation `Mail.ExternalEntityFk`, cf. `src/DocuPro.Core/MailBase/Mail.cs` lignes 201‑203). Chaque entité externe porte un **nom** et est rattachée à un **type d'entité externe** (`ExternalEntityType`, page 16). À l'usage, cette table sert de source aux listes déroulantes « expéditeur / destinataire » du courrier, et de point d'ancrage aux **valeurs de propriétés personnalisées** (`ExternalEntityCustomValue`) : des métadonnées dynamiques, propres à chaque entité, saisies pendant le traitement du courrier (indexation / métadonnées documentaires), et non sur cette page. La page elle‑même, dans sa version active (`Index.cshtml`), est une **grille en lecture avec suppression multiple** ; le contrôleur expose en plus des points d'entrée JSON de création/mise à jour par lot. Écran de saisie léger, réservé aux administrateurs du paramétrage courrier.

### Accès & permissions

- **Contrôleur MVC** : `ExternalEntitiesController` — `src/DocuPro.Web.Mvc/Areas/App/Controllers/Parametrages/ExternalEntitiesController.cs`. Attributs : `[Area("App")]`, `[AbpMvcAuthorize(AppPermissions.Pages_ExternalEntities_Access)]`. Hérite de `DocuProControllerBase`.
- **Service applicatif** :
  - `ExternalEntitiesAppService` (`src/DocuPro.Application/CommonEntities/ExternalEntitiesAppService.cs`) — attribut `[AbpAuthorize(AppPermissions.StandardUser)]`. Les attributs de permission fins (`Pages_ExternalEntities_Create/Edit/Delete`) sont présents en **commentaires** au‑dessus des méthodes `Create`/`Update`/`Delete` mais **non appliqués** ; seule `StandardUser` est exigée au niveau classe.
  - `ExternalEntityCustomValuesAppService` (`src/DocuPro.Application/CommonEntities/ExternalEntityCustomValuesAppService.cs`) — attribut `[AbpAuthorize(AppPermissions.StandardUser)]`. Gère les valeurs de propriétés personnalisées (voir §Valeurs personnalisées).
- **Constantes de permission** (`src/DocuPro.Core.Shared/Authorization/AppPermissions.cs`) :
  - `Pages_ExternalEntities` = `"Pages.ExternalEntities"` — libellé `L("ExternalEntities")` = « Entités externes ».
  - `Pages_ExternalEntities_Access` = `"Pages.ExternalEntities.Access"` — libellé `L("ExternalEntitiesAccess")` = « Accès Entités externes ».
  - `Pages_ExternalEntities_Create` = `"Pages.ExternalEntities.Create"` — `L("CreateNewExternalEntity")` = « Créer une nouvelle entité externe ».
  - `Pages_ExternalEntities_Edit` = `"Pages.ExternalEntities.Edit"` — `L("EditExternalEntity")` = « Modifier l'entité externe ».
  - `Pages_ExternalEntities_Delete` = `"Pages.ExternalEntities.Delete"` — `L("DeleteExternalEntity")` = « Supprimer l'entité externe ».
  - Menu : `Menus_Mail_Settings_ExternalEntities` = `"Menus.Mail_Settings.ExternalEntities"` — `L("MailSettings_ExternalEntities")` = « Entités externes ».
  - Valeurs personnalisées : `Pages_ExternalEntityCustomValues` = `"Pages.ExternalEntityCustomValues"` (+ `.Create`/`.Edit`/`.Delete`), déclarées dans `AppAuthorizationProvider.cs` (lignes 189‑192) mais **sans page/contrôleur MVC dédié** ni application effective sur le service.
  - Ces déclarations de permissions figurent dans `src/DocuPro.Core/Authorization/AppAuthorizationProvider.cs` (lignes 385‑389 pour ExternalEntities).
- **Entrée de menu** (`src/DocuPro.Web.Mvc/Areas/App/Startup/AppNavigationProvider.cs`, lignes 379‑385) : `AppPageNames.Common.ExternalEntities` (= `"CommonBase.ExternalEntities"`, `AppPageNames.cs` ligne 115), libellé `L("ExternalEntities")`, url `App/ExternalEntities`, icône `bi bi-people`, dépendance de permission `SimplePermissionDependency(requiresAll: true, Pages_ExternalEntities_Access, Menus_Mail_Settings_ExternalEntities)`. Pas de badge.
- **Multi‑tenant** : `ExternalEntity` implémente `IMayHaveTenant` (colonne `TenantId int?`). Le filtre `MayHaveTenant` d'ABP est actif ; à la création, `TenantId` est renseigné depuis `AbpSession.TenantId` s'il est non nul (`ExternalEntitiesAppService.Create`, lignes 186‑189). Index `HasIndex(TenantId)` déclaré dans `DocuProDbContext.cs` (lignes 470‑473).

### Interface utilisateur

- **Page Razor** : `src/DocuPro.Web.Mvc/Areas/App/Views/ExternalEntities/Index.cshtml`.
- **Script** : aucun fichier `.js` externe n'est inclus par la vue — toute la logique est **inline** dans `@section Scripts` de `Index.cshtml`. Titre affiché : `L("ExternalEntities")` (« Entités externes ») ; sous‑en‑tête `abp-page-subheader` : titre `L("MailSettings")` (« Paramétrage Docu-Courriers »), description `L("ExternalEntities")`.
- **Composant grille** : `ejs-grid` Syncfusion `#ExternalEntitiesGrid`, `locale="fr"`, pagination (`pageSize=10`), tri, colonne case à cocher (sélection multiple), barre d'outils `Search / ExcelExport / CsvExport / PdfExport`. Source de données : variable JS `externalEntitiesData` injectée depuis `ViewBag.ExternalEntities` (voir `ExternalEntitiesController.Index`).

> **Remarque de fidélité au code** : plusieurs fichiers JS générés par AspNetZero subsistent sous `wwwroot/view-resources/Areas/App/Views/ExternalEntities/` (chacun avec sa version `.min.js`) — `Index.js` (grille DataTable serveur + boutons Créer/Éditer/Importer/Exporter), `_CreateOrEditModal.js` (modale Créer/Éditer avec select2 sur le type), ainsi que `_ExcelColumnSelectionModal.js` (sélection de colonnes d'export) et `_ExternalEntityExternalEntityTypeLookupTableModal.js` (modale lookup de type). **Aucun n'est référencé par `Index.cshtml`** (la vue n'inclut ni `Index.js`, ni de partiel `_CreateOrEditModal.cshtml` — ce fichier n'existe pas ; le dossier `Views/ExternalEntities/` ne contient que `Index.cshtml`) et ils correspondent à l'ancien gabarit CRUD. La modale CRUD demandée est donc **présente dans le code mais inactive** sur la page réelle ; la vue active offre uniquement lecture + suppression multiple.

#### Filtres / recherche

| Libellé | Propriété (input→DTO) | Type de contrôle | Source / comportement serveur |
|---|---|---|---|
| Recherche (barre d'outils grille) | — (filtrage **client** Syncfusion) | Champ de recherche intégré `ejs-grid` | Filtrage local sur les colonnes affichées ; **aucun** appel serveur (les données sont préchargées via `ViewBag.ExternalEntities`). |

> Le fichier legacy `Index.js` (non actif) définirait un filtrage serveur via `GetAll(GetAllExternalEntitiesInput)` avec `filter`, `nameFilter`, `emailFilter`, `telephoneFilter`, `externalEntityTypeNameFilter` ; ces filtres **ne s'appliquent pas** à la page active.

#### Colonnes du tableau

| Libellé | Propriété (`field`) | Type |
|---|---|---|
| (case à cocher de sélection) | — | `type="checkbox"`, largeur 20 |
| `L("Name")` (« Nom ») | `Name` | Texte (largeur 250) |
| `L("ExternalEntityType")` (« Type d'entité externe ») | `ExternalEntityTypeName` | Texte (largeur 200) |

Les objets de la source `externalEntitiesData` portent aussi `Id` et `ExternalEntityTypeId` (non affichés ; `Id` sert à la suppression). Projection construite dans `ExternalEntitiesController.Index` : `{ Id, Name, ExternalEntityTypeId, ExternalEntityTypeName }`.

#### Actions (boutons)

| Bouton | Effet (endpoint / JS) | Permission |
|---|---|---|
| `L("Delete")` (« Supprimer ») — `#deleteExternalEntitiesButton` | Désactivé tant qu'aucune ligne n'est cochée (`updateDeleteButtonState`). Au clic → `deleteExternalEntities()` : confirmation SweetAlert, POST JSON `App/ExternalEntities/DeleteNodes` avec le tableau des `Id` cochés, puis rechargement de la page. | `Pages_ExternalEntities_Access` (accès page). Aucune vérification fine côté endpoint. |
| Barre d'outils — `ExcelExport` / `CsvExport` / `PdfExport` | `toolbarClick(args)` → `grid.excelExport()` / `grid.csvExport()` / `grid.pdfExport()` (export **client** Syncfusion des lignes chargées). | Accès page. |
| Barre d'outils — `Search` | Filtre client sur la grille. | Accès page. |

> Endpoints de **création / mise à jour** exposés par le contrôleur (`CreateMultipleNodes`, `UpdateNode`) mais **non câblés** dans `Index.cshtml` : la vue active ne comporte ni bouton « Créer », ni bouton « Éditer ». Voir §Service applicatif & opérations.

#### Formulaire(s) / Modale(s)

**Vue active** : aucune modale de saisie n'est ouverte depuis `Index.cshtml` (uniquement une boîte de confirmation SweetAlert pour la suppression).

**Modale CRUD legacy** (fichier `_CreateOrEditModal.js`, **non instanciée** par la page active) — documentée pour exhaustivité, champs sérialisés vers `CreateOrEditExternalEntityDto` :

| Champ | Propriété DTO | Type de contrôle | Obligatoire | Source / valeurs |
|---|---|---|---|---|
| Nom | `CreateOrEditExternalEntityDto.Name` | input texte | Oui (`[Required]`) | Saisie libre. |
| Type d'entité externe (affichage) | `externalEntityTypeName` (champ écran, hors DTO persistant) | input texte lecture + `select2` (`#externalEntityTypeId-typeahead-selector`) | Non | Autocomplétion via `GET api/services/app/ExternalEntities/GetAllExternalEntityTypeForLookupTable` (min. 2 caractères, pagination 10). Bouton loupe `#OpenExternalEntityTypeLookupTableButton` (modale lookup) ; bouton effacer `#ClearExternalEntityTypeNameButton`. |
| Type d'entité externe (valeur) | `CreateOrEditExternalEntityDto.ExternalEntityTypeId` | input hidden `#ExternalEntity_ExternalEntityTypeId` | Non | Id sélectionné dans le lookup. Validation JS : si l'input est marqué `required` et vide → message `{0}IsRequired`. |

> Le DTO `CreateOrEditExternalEntityDto` contient aussi `Telephone`, `Email`, `FirstName`, `LastName` : non exposés par la modale legacy ni par les endpoints du contrôleur actif (voir §DTOs).

### Service applicatif & opérations

- **Interface** : `IExternalEntitiesAppService` — `src/DocuPro.Application.Shared/CommonEntities/IExternalEntitiesAppService.cs`.
- **Implémentation** : `ExternalEntitiesAppService` — `src/DocuPro.Application/CommonEntities/ExternalEntitiesAppService.cs`.

| Méthode | Entrée (DTO) | Sortie (DTO) | Description |
|---|---|---|---|
| `GetAllList()` | — | `List<GetExternalEntityForViewDto>` | Liste **complète**, triée par `Name`, avec `ExternalEntityTypeName`. **Mise en cache** (`ICacheManager`, cache `ExternalEntityCache`, clé `ExternalEntities_All`). Source directe de `ViewBag.ExternalEntities` sur la page. |
| `GetExternalEntityIdBySender(string sender)` | `sender` (string) | `int?` | Renvoie l'`Id` de l'entité dont `Name == sender` (utilisé lors de l'import/rattachement de courriers). |
| `GetAll(GetAllExternalEntitiesInput input)` | `GetAllExternalEntitiesInput` | `PagedResultDto<GetExternalEntityForViewDto>` | Liste paginée/filtrée (Filter, NameFilter, ExternalEntityTypeNameFilter, ExternalEntityTypeIdFilter), tri `input.Sorting ?? "Name asc"`, jointure vers `ExternalEntityType`. Utilisé par le legacy `Index.js` uniquement. |
| `GetExternalEntityForView(int id)` | `id` (int) | `GetExternalEntityForViewDto` | Une entité mappée + nom du type résolu. |
| `GetExternalEntityForEdit(EntityDto input)` | `EntityDto` | `GetExternalEntityForEditOutput` | Entité au format éditable (`CreateOrEditExternalEntityDto`) + nom du type. |
| `CreateOrEdit(CreateOrEditExternalEntityDto input)` | `CreateOrEditExternalEntityDto` | `Task` | Aiguille vers `Create` (si `Id == null`) ou `Update`, puis **vide le cache** `ExternalEntityCache`. |
| `Create` (protégé) | `CreateOrEditExternalEntityDto` | `Task` | Mappe → `ExternalEntity`, force `TenantId` depuis la session ; **si `ExternalEntityTypeId` null ou 0 → valeur par défaut `1014`** ; `InsertAsync`. |
| `Update` (protégé) | `CreateOrEditExternalEntityDto` | `Task` | Charge l'entité par `Id`, mappe les champs modifiés. |
| `Delete(EntityDto input)` | `EntityDto` | `Task` | Suppression logique (`DeleteAsync`, entité `FullAuditedEntity` → `IsDeleted`), puis vide le cache. |
| `GetAllExternalEntityTypeForLookupTable(GetAllForLookupTableInput input)` | `GetAllForLookupTableInput` | `PagedResultDto<ExternalEntityExternalEntityTypeLookupTableDto>` | Lookup paginé des types (filtre sur `Name`), pour le select2 de la modale. |

**Actions MVC du contrôleur** (`ExternalEntitiesController`) :

| Action | Signature / paramètres | Réponse |
|---|---|---|
| `Index()` | `GET` | Vue `Index.cshtml`. Remplit `ViewBag.ExternalEntities` (projection `{Id, Name, ExternalEntityTypeId, ExternalEntityTypeName}` depuis `GetAllList()`) et `ViewBag.ExternalEntityTypes` (`{Id, Name}` depuis `IExternalEntityTypesAppService.GetAllList()`). |
| `CreateMultipleNodes([FromBody] MultipleNodeRequestExternalEntity request)` | `POST` — `request.NodeNames` (`List<string>`), `request.ExternalEntityTypeId` (`int?`) | JSON `{ success, newNodes, errors }`. Normalise chaque nom (trim, minuscules, suppression des espaces), déduplique, rejette les doublons existants, puis `CreateOrEdit` par nom. **Non appelé par la vue active.** |
| `DeleteNodes([FromBody] List<int> ids)` | `POST` — liste d'`Id` | JSON `{ success }` / `{ success:false, message }`. Pour chaque id : `GetExternalEntityForView` puis `Delete(new EntityDto(id))`. **Endpoint de la suppression multiple de la page.** |
| `UpdateNode([FromBody] UpdateNodeRequestExternalEntity request)` | `POST` — `Id` (int), `Name` (string), `ExternalEntityTypeId` (`int?`) | JSON `{ success }` / message d'erreur. Contrôle d'unicité du nom (hors soi‑même), charge via `GetExternalEntityForEdit`, met à jour `Name` et `ExternalEntityTypeId` (→ null si ≤ 0), `CreateOrEdit`. **Non appelé par la vue active.** |

> Types de requête locaux au contrôleur : `MultipleNodeRequestExternalEntity { List<string> NodeNames; int? ExternalEntityTypeId }` et `UpdateNodeRequestExternalEntity { int Id; string Name; int? ExternalEntityTypeId }` (définis en fin de `ExternalEntitiesController.cs`).

### DTOs

**`ExternalEntityDto`** (`.../Dtos/ExternalEntityDto.cs`) — hérite `EntityDto` (`int Id`).

| Propriété | Type C# | Obligatoire | Description |
|---|---|---|---|
| `Id` | `int` | — (hérité) | Identifiant. |
| `Name` | `string` | Non (aucune annotation sur le DTO) | Nom de l'entité externe. |
| `ExternalEntityTypeId` | `int?` | Non | FK type d'entité. |

**`CreateOrEditExternalEntityDto`** (`.../Dtos/CreateOrEditExternalEntityDto.cs`) — hérite `EntityDto<int?>` (`int? Id`).

| Propriété | Type C# | Obligatoire | Description |
|---|---|---|---|
| `Id` | `int?` | — (hérité) | Null = création, sinon édition. |
| `Name` | `string` | **Oui** (`[Required]`) | Nom. |
| `Telephone` | `string` | Non | Téléphone (non exposé par l'UI/endpoints actifs ; mappé si fourni). |
| `Email` | `string` | Non | E‑mail (idem). |
| `FirstName` | `string` | Non | **Sans colonne correspondante** sur `ExternalEntity` (ignoré au mapping). |
| `LastName` | `string` | Non | **Sans colonne correspondante** (ignoré). |
| `ExternalEntityTypeId` | `int?` | Non | FK type. |

**`GetExternalEntityForViewDto`** (`.../Dtos/GetExternalEntityForViewDto.cs`).

| Propriété | Type C# | Obligatoire | Description |
|---|---|---|---|
| `ExternalEntity` | `ExternalEntityDto` | Non | Entité. |
| `ExternalEntityTypeName` | `string` | Non | Nom du type résolu. |

**`GetExternalEntityForEditOutput`** (`.../Dtos/GetExternalEntityForEditOutput.cs`).

| Propriété | Type C# | Obligatoire | Description |
|---|---|---|---|
| `ExternalEntity` | `CreateOrEditExternalEntityDto` | Non | Entité éditable. |
| `ExternalEntityTypeName` | `string` | Non | Nom du type. |

**`GetAllExternalEntitiesInput`** (`.../Dtos/GetAllExternalEntitiesInput.cs`) — hérite `PagedAndSortedResultRequestDto` (`SkipCount`, `MaxResultCount`, `Sorting`).

| Propriété | Type C# | Obligatoire | Description |
|---|---|---|---|
| `Filter` | `string` | Non | Recherche globale (sur `Name`). |
| `NameFilter` | `string` | Non | Filtre nom. |
| `ExternalEntityTypeNameFilter` | `string` | Non | Filtre nom du type. |
| `ExternalEntityTypeIdFilter` | `int?` | Non | Filtre Id du type. |

**`ExternalEntityExternalEntityTypeLookupTableDto`** (`.../Dtos/ExternalEntityExternalEntityTypeLookupTableDto.cs`).

| Propriété | Type C# | Obligatoire | Description |
|---|---|---|---|
| `Id` | `int` | — | Id du type. |
| `DisplayName` | `string` | Non | Nom affiché. |

**`GetAllForLookupTableInput`** (`.../Dtos/GetAllForLookupTableInput.cs`) — hérite `PagedAndSortedResultRequestDto`.

| Propriété | Type C# | Obligatoire | Description |
|---|---|---|---|
| `Filter` | `string` | Non | Terme de recherche du lookup. |

#### DTOs des valeurs personnalisées (`ExternalEntityCustomValue`)

**`ExternalEntityCustomValueDto`** (`.../Dtos/ExternalEntityCustomValueDto.cs`) — hérite `EntityDto`.

| Propriété | Type C# | Obligatoire | Description |
|---|---|---|---|
| `Id` | `int` | — | Identifiant. |
| `Value` | `string` | Non (aucune annotation sur le DTO) | Valeur de la propriété. |
| `ExternalEntityCustomPropertyId` | `int` | Non | FK propriété personnalisée. |
| `ExternalEntityId` | `int` | Non | FK entité externe. |

**`CreateOrEditExternalEntityCustomValueDto`** (`.../Dtos/CreateOrEditExternalEntityCustomValueDto.cs`) — hérite `EntityDto<int?>`.

| Propriété | Type C# | Obligatoire | Description |
|---|---|---|---|
| `Id` | `int?` | — | Null = création. |
| `Value` | `string` | **Oui** (`[Required]`) | Valeur. |
| `ExternalEntityCustomPropertyId` | `int` | Non | FK propriété. |
| `ExternalEntityId` | `int` | Non | FK entité externe. |

**`GetExternalEntityCustomValueForViewDto`** (`.../Dtos/GetExternalEntityCustomValueForViewDto.cs`).

| Propriété | Type C# | Obligatoire | Description |
|---|---|---|---|
| `ExternalEntityCustomValue` | `ExternalEntityCustomValueDto` | Non | Valeur. |
| `ExternalEntityCustomPropertyName` | `string` | Non | Nom de la propriété. |
| `ExternalEntityName` | `string` | Non | Nom de l'entité. |

**`GetExternalEntityCustomValueForEditOutput`** (`.../Dtos/GetExternalEntityCustomValueForEditOutput.cs`).

| Propriété | Type C# | Obligatoire | Description |
|---|---|---|---|
| `ExternalEntityCustomValue` | `CreateOrEditExternalEntityCustomValueDto` | Non | Valeur éditable. |
| `ExternalEntityCustomPropertyName` | `string` | Non | Nom propriété. |
| `ExternalEntityName` | `string` | Non | Nom entité. |

**`GetAllExternalEntityCustomValuesInput`** (`.../Dtos/GetAllExternalEntityCustomValuesInput.cs`) — hérite `PagedAndSortedResultRequestDto`.

| Propriété | Type C# | Obligatoire | Description |
|---|---|---|---|
| `Filter` | `string` | Non | Recherche globale (sur `Value`). |
| `ValueFilter` | `string` | Non | Filtre valeur. |
| `ExternalEntityCustomPropertyNameFilter` | `string` | Non | Filtre nom propriété. |
| `ExternalEntityNameFilter` | `string` | Non | Filtre nom entité. |

**`GetAllExternalEntityCustomValuesForExcelInput`** (`.../Dtos/GetAllExternalEntityCustomValuesForExcelInput.cs`) : mêmes 4 propriétés (`Filter`, `ValueFilter`, `ExternalEntityCustomPropertyNameFilter`, `ExternalEntityNameFilter`), sans pagination.

**`ExternalEntityCustomValueExternalEntityCustomPropertyLookupTableDto`** et **`ExternalEntityCustomValueExternalEntityLookupTableDto`** (`.../Dtos/`) : chacune `{ int Id; string DisplayName }`.

### Tables & colonnes impactées

- **`ExternalEntities`** — entité `ExternalEntity` (`src/DocuPro.Core/CommonEntities/ExternalEntity.cs`), `[Table("ExternalEntities")]`, `[Audited]`, base **`FullAuditedEntity`**, interface **`IMayHaveTenant`**. DbSet `DocuProDbContext.ExternalEntities` (ligne 150). Index : `HasIndex(TenantId)` (DbContext lignes 470‑473). C'est la table **écrite** par cette page.

| Table | Colonne | Type SQL/CLR | Lecture / Écriture (par cette page) |
|---|---|---|---|
| `ExternalEntities` | `Id` | `int` (PK) | Lecture (grille, suppression) |
| `ExternalEntities` | `TenantId` | `int?` | Écriture (à la création, depuis la session) |
| `ExternalEntities` | `Name` | `nvarchar` (**Required**) | Lecture + Écriture |
| `ExternalEntities` | `Email` | `nvarchar` | Non écrit par les endpoints actifs (colonne existante) |
| `ExternalEntities` | `Telephone` | `nvarchar` | Non écrit par les endpoints actifs (colonne existante) |
| `ExternalEntities` | `ExternalEntityTypeId` | `int?` (FK → `ExternalEntityTypes.Id`, nav `ExternalEntityTypeFk`) | Lecture + Écriture (défaut `1014` si null/0 à la création) |
| `ExternalEntities` | `CreationTime`, `CreatorUserId`, `LastModificationTime`, `LastModifierUserId`, `IsDeleted`, `DeleterUserId`, `DeletionTime` | audit `FullAuditedEntity` | Écriture (auto ABP ; `IsDeleted` sur suppression) |

- **`ExternalEntityTypes`** — entité `ExternalEntityType`, `[Table("ExternalEntityTypes")]`, `FullAuditedEntity`, `IMayHaveTenant`. DbSet ligne 152. **Lue** en lookup / jointure (colonnes `Id`, `Name`).

| Table | Colonne | Type SQL/CLR | Lecture / Écriture |
|---|---|---|---|
| `ExternalEntityTypes` | `Id` | `int` (PK) | Lecture |
| `ExternalEntityTypes` | `Name` | `nvarchar` (**Required**) | Lecture (nom du type affiché / lookup) |
| `ExternalEntityTypes` | `TenantId` | `int?` | Lecture (filtre tenant) |

- **`ExternalEntityCustomValues`** — entité `ExternalEntityCustomValue` (`src/DocuPro.Core/CommonEntities/ExternalEntityCustomValue.cs`), `[Table("ExternalEntityCustomValues")]`, `[Audited]`, `FullAuditedEntity`, `IMayHaveTenant`. DbSet ligne 146. Index `HasIndex(TenantId)` (lignes 462‑465). **Non écrite par la page `/App/ExternalEntities`**, mais reliée à l'entité externe (métadonnées dynamiques) et écrite depuis le workflow courrier (voir §Règles).

| Table | Colonne | Type SQL/CLR | Lecture / Écriture (contexte) |
|---|---|---|---|
| `ExternalEntityCustomValues` | `Id` | `int` (PK) | — |
| `ExternalEntityCustomValues` | `TenantId` | `int?` | Écriture (workflow) |
| `ExternalEntityCustomValues` | `Value` | `nvarchar` (**Required**) | Lecture + Écriture (workflow) |
| `ExternalEntityCustomValues` | `ExternalEntityTypeId` | `int` (FK → `ExternalEntityTypes.Id`, nav `ExternalEntityTypeFk`) | Écriture (déduit du type de l'entité) |
| `ExternalEntityCustomValues` | `ExternalEntityCustomPropertyId` | `int` (FK → `ExternalEntityCustomProperties.Id`, nav `ExternalEntityCustomPropertyFk`) | Lecture + Écriture |
| `ExternalEntityCustomValues` | `ExternalEntityId` | `int` (FK → `ExternalEntities.Id`, nav `ExternalEntityFk`) | Lecture + Écriture |
| `ExternalEntityCustomValues` | audit `FullAuditedEntity` | — | Écriture (auto) |

- **`ExternalEntityCustomProperties`** — entité `ExternalEntityCustomProperty`, `[Table("ExternalEntityCustomProperties")]`, `FullAuditedEntity`, `IMayHaveTenant`. DbSet ligne 148, index `HasIndex(TenantId)` (lignes 466‑469). Colonnes : `Id` (PK), `TenantId` (int?), `Name` (nvarchar, **Required**). Sert de dictionnaire des propriétés personnalisées (nom → propriété) résolues dynamiquement.

- **`Mails`** — colonne `ExternalEntityId` (`int`, FK → `ExternalEntities.Id`, nav `Mail.ExternalEntityFk`, cf. `src/DocuPro.Core/MailBase/Mail.cs` lignes 201‑203). **Non écrite ici** ; c'est la table consommatrice du référentiel géré par cette page (un courrier pointe vers son expéditeur/destinataire externe).

### Règles de gestion / effets de bord / transitions de statut

- **Aucune transition de `MailStatus`** ni bascule de drapeaux (`Valider`, `ValidationDG`…) : page de paramétrage sans impact direct sur le cycle de vie des courriers. — (transitions de statut : sans objet)
- **Valeur par défaut du type** : à la création d'une entité (`ExternalEntitiesAppService.Create`), si `ExternalEntityTypeId` est `null` ou `0`, il est forcé à **`1014`** (type par défaut codé en dur).
- **Multi‑tenant** : `TenantId` positionné depuis `AbpSession.TenantId` à la création ; filtre `IMayHaveTenant` actif en lecture.
- **Cache** : `GetAllList()` met le référentiel en cache (`ICacheManager`, cache `ExternalEntityCache`, clé `ExternalEntities_All`). Le cache est **vidé** (`ClearAsync`) à chaque `CreateOrEdit` et `Delete`. La page rechargeant intégralement après suppression, la grille reflète l'état à jour.
- **Unicité du nom** : appliquée **au niveau du contrôleur** (pas de contrainte SQL unique lue dans la source). `CreateMultipleNodes` normalise (trim + minuscules + suppression des espaces), déduplique et rejette les noms déjà existants (message `'{nom}' already exists.`). `UpdateNode` refuse un nom déjà porté par une autre entité (`{ success:false, message:"Duplicate name" }`).
- **Suppression** : logique (soft delete `FullAuditedEntity.IsDeleted`), non physique. La suppression multiple (`DeleteNodes`) itère les `Id` cochés ; si un id est introuvable, renvoie `{ success:false, message:"Entity with ID {id} not found" }`.
- **Valeurs de propriétés personnalisées (dynamiques par type)** — mécanisme porté par `ExternalEntityCustomValuesAppService` et consommé côté **workflow courrier** (`src/DocuPro.Web.Mvc/Areas/App/Controllers/DocuCourriers/MailTabsController.cs`), pas par cette page :
  - `GetOrCreateCustomValueByPropertyAndEntity(propertyId, externalEntityId, defaultValue="")` : récupère la valeur (propriété × entité) ou en **crée une** (avec `ExternalEntityTypeId` déduit de l'entité, `TenantId` de session, `SaveChangesAsync` pour obtenir l'Id). Utilisée pour construire dynamiquement le formulaire de métadonnées à partir de mots/propriétés extraits (`MailTabsController`, ~lignes 1145‑1160).
  - `CreateOrUpdateCustomValue(propertyId, externalEntityId, value)` : upsert d'une valeur ; à l'enregistrement des métadonnées du courrier, les paires `MetadataValues[...]` sont persistées contre l'`ExternalEntityId` du courrier (`MailTabsController`, ~lignes 1321‑1327). Lève une `UserFriendlyException` « Le courrier n'a pas d'entité externe associée » si le courrier n'a pas d'entité externe.
  - Conséquence : les propriétés personnalisées d'une entité externe sont **dynamiques selon son type** (`ExternalEntityType`) et matérialisées à la volée ; supprimer une entité externe ici laisse potentiellement des `ExternalEntityCustomValues` orphelines (aucune cascade lue dans la source).
- **Import/Export** : la page active n'expose que l'export **client** Syncfusion (Excel/CSV/PDF des lignes chargées). L'import Excel serveur `ImportFromExcel` est seulement **référencé par le legacy `Index.js`** (Dropzone) mais **n'a aucune action correspondante dans le `ExternalEntitiesController` actif** (qui n'expose que `Index`, `CreateMultipleNodes`, `DeleteNodes`, `UpdateNode`) ; l'export serveur `GetExternalEntityCustomValuesToExcel` (service des valeurs personnalisées) **renvoie un `FileDto` vide** (exporteur commenté). Aucun de ces mécanismes n'est branché sur cette vue. — (numérotation / séquences, notifications e‑mail, jobs, liaison scan `MarkAsProcessed` : sans objet pour cette page)


---


## 18. Type d'Imputation (`/App/MailInputationTypes`)

### Rôle métier

Page de **paramétrage** (menu « Paramétrage Docu-Courriers » / `MailSettings`) qui gère la **table de référence des types d'imputation** utilisés lors de l'imputation des courriers. Chaque imputation d'un courrier (entité `MailInputation`, écran Parapheur) porte un `MailInputationTypeId` obligatoire pointant sur une ligne de cette table : les valeurs saisies ici alimentent donc les listes de choix « type d'imputation » du Parapheur. L'écran est purement CRUD (créer / éditer / supprimer des types), sans notion de statut de courrier. Chaque type porte un nom (`Name`) et un indicateur booléen `Suivi` libellé à l'écran « Pas de traitement attendu ». L'ajout est fait en lot (une valeur par ligne d'une zone de texte), l'édition et la suppression se font sur la ligne sélectionnée dans la grille. La table est multi-tenant (`IMayHaveTenant`).

### Accès & permissions

- **Contrôleur MVC** : `MailInputationTypesController` (namespace `DocuPro.Web.Areas.App.Controllers.Common`), `[Area("App")]`, protégé par `[AbpMvcAuthorize(AppPermissions.Pages_MailInputationTypes_Access)]`.
  Fichier : `src/DocuPro.Web.Mvc/Areas/App/Controllers/Parametrages/MailInputationTypesController.cs`.
- **Service applicatif** : `MailInputationTypesAppService`, attribut classe `[AbpAuthorize(AppPermissions.StandardUser)]` (= `"StandardUser"`).
  ⚠️ Le service N'utilise PAS une permission dédiée à la page ; il exige seulement `StandardUser`. Les attributs `[AbpAuthorize(AppPermissions.Pages_MailInputationTypes_Create/Edit/Delete)]` présents sur `Create`, `Update`, `Delete`, `GetMailInputationTypeForEdit` sont **commentés** dans la source (`src/DocuPro.Application/MailBase/MailInputationTypesAppService.cs`, lignes 164, 195, 209, 217).
- **Constantes de permission** (`src/DocuPro.Core.Shared/Authorization/AppPermissions.cs`) :
  - `Pages_MailInputationTypes` = `"Pages.MailInputationTypes"` (l.475)
  - `Pages_MailInputationTypes_Access` = `"Pages.MailInputationTypes.Access"` (l.476)
  - `Pages_MailInputationTypes_Create` = `"Pages.MailInputationTypes.Create"` (l.477)
  - `Pages_MailInputationTypes_Edit` = `"Pages.MailInputationTypes.Edit"` (l.478)
  - `Pages_MailInputationTypes_Delete` = `"Pages.MailInputationTypes.Delete"` (l.479)
  - `Menus_Mail_Settings_MailInputationTypes` = `"Menus.Mail_Settings.MailInputationTypes"` (l.103)
  - **Déclaration effective** (`src/DocuPro.Core/Authorization/AppAuthorizationProvider.cs`) : seuls `Pages_MailInputationTypes` (parent, libellé `L("MailInputationTypes")`) et `Pages_MailInputationTypes_Access` (libellé `L("MailInputationTypesAccess")`) sont créés (l.482-483) ; les permissions Create/Edit/Delete existent comme constantes mais **ne sont pas enregistrées** dans le provider. La permission de menu `Menus_Mail_Settings_MailInputationTypes` est créée sous `Menus_MailSettings` avec le libellé `L("MailSettings_MailInputationTypes")` (l.86) = « Types d'imputation de courrier ».
- **Entrée de menu** (`src/DocuPro.Web.Mvc/Areas/App/Startup/AppNavigationProvider.cs`, l.393-399), sous le menu « Paramétrage Docu-Courriers » (`Menus_MailSettings`) :
  - nom de page : `AppPageNames.Common.MailInputationTypes` = `"MailBase.MailInputationTypes"` (`src/DocuPro.Web.Mvc/Areas/App/Startup/AppPageNames.cs`, l.120)
  - libellé : `L("MailInputationTypes")` = « Type d'Imputation »
  - url : `App/MailInputationTypes`
  - icône : `bi bi-tags`
  - dépendance : `SimplePermissionDependency(requiresAll: true, Pages_MailInputationTypes_Access, Menus_Mail_Settings_MailInputationTypes)`
  - badge : aucun.
- **Multi-tenant** : l'entité `MailInputationType` implémente `IMayHaveTenant` (colonne `TenantId int?`). À la création, `TenantId` est renseigné depuis `AbpSession.TenantId` (service, l.200-203). Filtre de tenant ABP actif par défaut (aucune désactivation `IMayHaveTenant` dans cette page).

### Interface utilisateur

- **Page Razor** : `src/DocuPro.Web.Mvc/Areas/App/Views/MailInputationTypes/Index.cshtml` (page unique ; il n'existe **pas** de vue `_CreateOrEditModal.cshtml` ni de vue `ViewmailInputationTypeModal` dans ce dossier — le CRUD est réalisé en ligne dans la page, pas dans une modale).
- **Script** : bloc `@section Scripts` **inline** dans `Index.cshtml` (fonctions `addMailInputationTypes`, `updateMailInputationType`, `deleteMailInputationTypes`, `onRowSelected`, `updateUIState`, `toolbarClick`).
- **Fichiers JS scaffoldés NON utilisés par cette vue** : `src/DocuPro.Web.Mvc/wwwroot/view-resources/Areas/App/Views/MailInputationTypes/Index.js` et `_CreateOrEditModal.js` (générés par l'outil RAD ASP.NET Zero : DataTable serverSide + `app.ModalManager` + Dropzone d'import Excel). `Index.cshtml` ne les référence pas ; ils s'appuient sur des vues/endpoints (`CreateOrEditModal`, `ViewmailInputationTypeModal`, `ImportFromExcel`) et permissions (`Pages.MailInputationTypes.Create/Edit/Delete`) qui ne sont pas câblés dans l'écran actif. À considérer comme **code mort** pour cette page.
- **Titre / sous-titre affichés** : `ViewBag.Title = L("MailInputationTypes")` = « Type d'Imputation ». Sous-en-tête (`abp-page-subheader`) : titre `L("MailSettings")` = « Paramétrage Docu-Courriers », description `L("MailInputationTypes")` = « Type d'Imputation ».
- **Disposition** : deux colonnes. Gauche (`col-md-8`) : bouton Supprimer + grille Syncfusion `ejs-grid` `id="TreeGrid"`. Droite (`col-md-4`) : panneau d'ajout (case Suivi + zone de texte multi-lignes + bouton Ajouter) et panneau d'édition (champ nom + case Suivi + bouton Modifier).
- **Source de données de la grille** : `dataSource="ViewBag.MailInputationTypes"`, pré-chargée côté serveur par `Index()` via `GetAllList()` (liste d'objets `{ Id, Name, Suivi }`). La grille NE fait PAS d'appel Ajax de lecture (pas de mode serverSide ici).

#### Filtres / recherche

| Libellé | Propriété (input→DTO) | Type de contrôle | Source / comportement serveur |
|---|---|---|---|
| Recherche (barre outil Syncfusion) | — (filtrage client) | Zone de recherche grille (`toolbar: "Search"`) | Filtrage **côté client** sur les données déjà chargées ; aucun appel serveur. |

Remarque : la recherche serveur paginée (`GetAll(GetAllMailInputationTypesInput)` avec `Filter`/`NameFilter`) existe dans le service mais n'est utilisée que par le fichier `Index.js` scaffoldé (non actif). L'écran réel ne l'appelle pas.

#### Colonnes du tableau (grille `ejs-grid` `TreeGrid`)

| Libellé (headerText) | Propriété (`field`) | Type |
|---|---|---|
| (sélection) | — | Colonne `type="checkbox"` (sélection multiple), largeur 20 |
| `L("Name")` = « Nom » | `Name` | Texte, largeur 200 |
| `L("PasdeTraitementAttendu")` = « Pas de traitement attendu » | `Suivi` | Booléen affiché en case à cocher (`displayAsCheckBox="true"`, `editType="booleanedit"`), largeur 100 |

Réglages grille : `allowPaging="true"` (`pageSize=10`), `allowSorting="true"`, `locale="fr"`, barre d'outils `{ "Search", "ExcelExport", "CsvExport", "PdfExport" }`, `allowExcelExport`/`allowPdfExport` = true. Sélection multiple par ligne (`selectionSettings = { type: 'Multiple', mode: 'Row' }`, activée dans `DOMContentLoaded`).

#### Actions (boutons)

| Bouton | Effet (endpoint / JS) | Permission |
|---|---|---|
| Supprimer (`#deleteMailInputationTypesButton`, `fa fa-trash`, désactivé sans sélection) | `deleteMailInputationTypes()` → POST `App/MailInputationTypes/DeleteNodes`, corps JSON = tableau des `Id` des lignes sélectionnées | `Pages_MailInputationTypes_Access` (accès page) |
| Ajouter (`#addMailInputationTypesButton`, `fa fa-plus`) | `addMailInputationTypes()` → POST `App/MailInputationTypes/CreateMultipleNodes`, corps `{ ParentId:null, NodeNames:[...], Suivi }` | idem |
| Modifier (`#updateMailInputationTypeButton`, `fa fa-edit`, désactivé sans sélection) | `updateMailInputationType()` → POST `App/MailInputationTypes/UpdateNode`, corps `{ Id, Name, Suivi }` | idem |
| Export Excel / CSV / PDF (barre d'outils grille) | `toolbarClick` → `grid.excelExport()` / `csvExport()` / `pdfExport()` (export **client** Syncfusion) | idem |

Chaque action est précédée d'une confirmation `Swal.fire` puis recharge la page (`window.location.reload()`) après succès.

#### Formulaire(s) / CRUD en ligne (colonne droite — LISTE COMPLÈTE DES CHAMPS)

Il n'y a **pas de modale** ; le CRUD utilise deux mini-formulaires inline. Reliure champ écran → propriété DTO → colonne de table :

**Panneau d'ajout (en lot)** → endpoint `CreateMultipleNodes` (DTO `MultipleNodeRequestMailInputationType`) → `CreateOrEditMailInputationTypeDto` :

| Champ écran | id HTML | Propriété DTO | Colonne table | Type de contrôle | Obligatoire | Source / valeurs |
|---|---|---|---|---|---|---|
| « Pas de traitement attendu » | `addMailInputationTypeSuivi` | `MultipleNodeRequestMailInputationType.Suivi` → `CreateOrEditMailInputationTypeDto.Suivi` | `MailInputationTypes.Suivi` | Case à cocher | Non | Booléen, défaut décoché (false) ; appliqué à **tous** les noms du lot |
| Zone de saisie des types | `mailInputationTypeNames` | chaque ligne → `MultipleNodeRequestMailInputationType.NodeNames[]` → `CreateOrEditMailInputationTypeDto.Name` | `MailInputationTypes.Name` | `textarea` (4 lignes), placeholder `L("EnterMailInputationTypes")` = « Entrez les types d'imputation des mails. » | Oui (au moins une ligne non vide) | Saisie libre : une valeur par ligne ; dédoublonnage + tri côté client avant envoi |

**Panneau d'édition (ligne sélectionnée)** → endpoint `UpdateNode` (DTO `UpdateNodeRequestMailInputationType`) → `CreateOrEditMailInputationTypeDto` :

| Champ écran | id HTML | Propriété DTO | Colonne table | Type de contrôle | Obligatoire | Source / valeurs |
|---|---|---|---|---|---|---|
| (Id de la ligne, masqué) | — | `UpdateNodeRequestMailInputationType.Id` → `CreateOrEditMailInputationTypeDto.Id` | `MailInputationTypes.Id` | Interne (issu de la sélection grille) | Oui (≠ 0) | `selectedMailInputationType.Id` |
| « Modifier le type d'imputation… » (nom) | `editMailInputationTypeName` (`ejs-textbox`, `floatLabelType="Auto"`, placeholder `L("EditMailInputationType")` = « Modifier le type d'imputation de courrier ») | `UpdateNodeRequestMailInputationType.Name` → `CreateOrEditMailInputationTypeDto.Name` | `MailInputationTypes.Name` | Zone de texte Syncfusion | Oui (non vide, contrôle JS) | Pré-rempli avec `selectedMailInputationType.Name` |
| « Pas de traitement attendu » | `editMailInputationTypeSuivi` | `UpdateNodeRequestMailInputationType.Suivi` → `CreateOrEditMailInputationTypeDto.Suivi` | `MailInputationTypes.Suivi` | Case à cocher | Non | Pré-remplie avec `selectedMailInputationType.Suivi` |

### Service applicatif & opérations

- **Interface** : `src/DocuPro.Application.Shared/MailBase/IMailInputationTypesAppService.cs`
- **Implémentation** : `src/DocuPro.Application/MailBase/MailInputationTypesAppService.cs`

| Méthode | Entrée (DTO) | Sortie (DTO) | Description |
|---|---|---|---|
| `GetAllList()` | — | `List<GetMailInputationTypeForViewDto>` | Liste triée par `Name`, **mise en cache** (`ICacheManager`, cache `"MailInputationTypeCache"`, clé `"MailInputationTypes_All"`). Renseigne `Name`, `Id`, `Suivi`. C'est la méthode consommée par l'écran (via `Index()`). |
| `CheckIsDuplicate(string name)` | `name` | `bool` | Vrai si un type avec le même `Name` (comparaison `ToUpper`) existe. Non appelée par le contrôleur actif. |
| `GetAll(GetAllMailInputationTypesInput input)` | `GetAllMailInputationTypesInput` | `PagedResultDto<GetMailInputationTypeForViewDto>` | Recherche paginée/triée (`Filter`, `NameFilter`). ⚠️ ne renseigne PAS `Suivi` dans le DTO retourné. Utilisée par `Index.js` scaffoldé (non actif). |
| `GetMailInputationTypeForView(int id)` | `id` | `GetMailInputationTypeForViewDto` | Charge un type par Id, mappé via `ObjectMapper` (renseigne `Name`, `Suivi`, `Id`). |
| `GetMailInputationTypeForEdit(EntityDto input)` | `EntityDto` | `GetMailInputationTypeForEditOutput` | Charge un type pour édition (`CreateOrEditMailInputationTypeDto`). |
| `CreateOrEdit(CreateOrEditMailInputationTypeDto input)` | `CreateOrEditMailInputationTypeDto` | `void` | Aiguille vers `Create` (si `Id == null`) ou `Update`. **Met la première lettre du `Name` en majuscule et le reste en minuscules** si la 1re lettre est minuscule. Vide le cache après. |
| `Create` (protégé) | `CreateOrEditMailInputationTypeDto` | `void` | Mappe vers l'entité, positionne `TenantId` depuis `AbpSession`, `InsertAsync`. |
| `Update` (protégé) | `CreateOrEditMailInputationTypeDto` | `void` | Charge par `Id` et remappe (`Name`, `Suivi`). |
| `Delete(EntityDto input)` | `EntityDto` | `void` | Suppression (soft delete `FullAuditedEntity`) par `Id`, puis vide le cache. |
| `GetMailInputationTypesToExcel(GetAllMailInputationTypesForExcelInput input)` | `GetAllMailInputationTypesForExcelInput` | `FileDto` | Construit la liste filtrée mais **retourne `null`** (exporteur commenté). Export réel non implémenté côté service. |
| `GetAll()` (surcharge sans paramètre) | — | `List<GetMailInputationTypeForViewDto>` | Liste complète triée par `Name` (sans cache, `Suivi` non renseigné). |

**Actions MVC du contrôleur** (`MailInputationTypesController`) :

| Action | Signature / paramètres | Retour |
|---|---|---|
| `Index()` | `async Task<IActionResult>` ; aucun paramètre | `View()` ; `ViewBag.MailInputationTypes` = liste anonyme `{ Id, Name, Suivi }` issue de `GetAllList()`. |
| `CreateMultipleNodes` | `[HttpPost] ([FromBody] MultipleNodeRequestMailInputationType request)` — `request.NodeNames: List<string>`, `request.Suivi: bool` | `Json { success: bool, newNodes: [{Id,Name,Suivi}], errors: string[] }`. Normalise (trim, minuscules, suppression espaces) et dédoublonne les noms, refuse les doublons existants, crée via `CreateOrEdit`. |
| `DeleteNodes` | `[HttpPost] ([FromBody] List<int> ids)` | `Json { success: bool[, message] }`. Vérifie l'existence puis `Delete` pour chaque Id. |
| `UpdateNode` | `[HttpPost] ([FromBody] UpdateNodeRequestMailInputationType request)` — `Id: int`, `Name: string`, `Suivi: bool` | `Json { success: bool[, message] }`. Refuse un doublon (nom normalisé, hors élément courant), charge via `GetMailInputationTypeForEdit`, met à jour `Name`/`Suivi` et appelle `CreateOrEdit`. |

L'écran actif appelle uniquement `Index`, `CreateMultipleNodes`, `DeleteNodes`, `UpdateNode`. Les méthodes dynamiques `abp.services.app.mailInputationTypes.getAll/createOrEdit/delete` (API Web dynamique ABP) sont utilisées seulement par les scripts scaffoldés non actifs.

### DTOs

**`CreateOrEditMailInputationTypeDto`** (`src/DocuPro.Application.Shared/MailBase/Dtos/CreateOrEditMailInputationTypeDto.cs`) — hérite `EntityDto<int?>`

| Propriété | Type C# | Obligatoire (`[Required]`) | Description |
|---|---|---|---|
| `Id` | `int?` (hérité de `EntityDto<int?>`) | Non | `null` = création, valeur = mise à jour. |
| `Name` | `string` | Non (aucun `[Required]`) | Libellé du type d'imputation. |
| `Suivi` | `bool` | Non | Indicateur « Pas de traitement attendu ». |

**`MailInputationTypeDto`** (`.../Dtos/MailInputationTypeDto.cs`) — hérite `EntityDto` (Id `int`)

| Propriété | Type C# | Obligatoire | Description |
|---|---|---|---|
| `Id` | `int` (hérité `EntityDto`) | — | Identifiant. |
| `Name` | `string` | Non | Libellé du type. |
| `Suivi` | `bool` | Non | « Pas de traitement attendu ». |

**`GetMailInputationTypeForViewDto`** (`.../Dtos/GetMailInputationTypeForViewDto.cs`)

| Propriété | Type C# | Obligatoire | Description |
|---|---|---|---|
| `MailInputationType` | `MailInputationTypeDto` | Non | Type encapsulé (lecture/affichage). |

**`GetMailInputationTypeForEditOutput`** (`.../Dtos/GetMailInputationTypeForEditOutput.cs`)

| Propriété | Type C# | Obligatoire | Description |
|---|---|---|---|
| `MailInputationType` | `CreateOrEditMailInputationTypeDto` | Non | Type à éditer. |

**`GetAllMailInputationTypesInput`** (`.../Dtos/GetAllMailInputationTypesInput.cs`) — hérite `PagedAndSortedResultRequestDto`

| Propriété | Type C# | Obligatoire | Description |
|---|---|---|---|
| `Filter` | `string` | Non | Filtre global (appliqué sur `Name`). |
| `NameFilter` | `string` | Non | Filtre sur `Name`. |
| `Sorting` | `string` (hérité) | Non | Tri (défaut `"id asc"`). |
| `SkipCount` | `int` (hérité) | Non | Pagination — offset. |
| `MaxResultCount` | `int` (hérité) | Non | Pagination — taille de page. |

**`GetAllMailInputationTypesForExcelInput`** (`.../Dtos/GetAllMailInputationTypesForExcelInput.cs`)

| Propriété | Type C# | Obligatoire | Description |
|---|---|---|---|
| `Filter` | `string` | Non | Filtre global. |
| `NameFilter` | `string` | Non | Filtre sur `Name`. |

**`MailInputationMailInputationTypeLookupTableDto`** (`.../Dtos/MailInputationMailInputationTypeLookupTableDto.cs`) — DTO de liste déroulante utilisé lors de l'imputation d'un courrier (Parapheur), pas par cet écran de paramétrage.

| Propriété | Type C# | Obligatoire | Description |
|---|---|---|---|
| `Id` | `int` | — | Id du type d'imputation. |
| `DisplayName` | `string` | Non | Libellé affiché dans le sélecteur. |

**DTO de requête internes au contrôleur** (`MailInputationTypesController.cs`) :

`MultipleNodeRequestMailInputationType` : `NodeNames` (`List<string>`), `Suivi` (`bool`).
`UpdateNodeRequestMailInputationType` : `Id` (`int`), `Name` (`string`), `Suivi` (`bool`).

### Tables & colonnes impactées

**Table principale — `[Table("MailInputationTypes")]`** — entité `MailInputationType` (`src/DocuPro.Core/MailBase/MailInputationType.cs`), base ABP `FullAuditedEntity` (Id `int`), interface `IMayHaveTenant`. DbSet : `DocuProDbContext.MailInputationTypes` (`src/DocuPro.EntityFrameworkCore/EntityFrameworkCore/DocuProDbContext.cs`, l.106). Index : `HasIndex(e => new { e.TenantId })` (l.365-368).

| Table | Colonne | Type SQL / CLR | Lecture / Écriture (par cette page) |
|---|---|---|---|
| MailInputationTypes | `Id` | `int` (PK, identity) | Lecture (grille, view, edit) |
| MailInputationTypes | `TenantId` | `int?` (nullable) | Écriture (positionné à la création depuis `AbpSession`) / Lecture (filtre) |
| MailInputationTypes | `Name` | `nvarchar` / `string` | Lecture + Écriture (création, édition) |
| MailInputationTypes | `Suivi` | `bit` / `bool` (défaut `false`) | Lecture + Écriture (création, édition) |
| MailInputationTypes | `CreationTime` | `datetime` (audit) | Écriture (auto ABP à la création) |
| MailInputationTypes | `CreatorUserId` | `bigint?` (audit) | Écriture (auto ABP) |
| MailInputationTypes | `LastModificationTime` | `datetime?` (audit) | Écriture (auto ABP à l'édition) |
| MailInputationTypes | `LastModifierUserId` | `bigint?` (audit) | Écriture (auto ABP) |
| MailInputationTypes | `IsDeleted` | `bit` (audit) | Écriture (soft delete à la suppression) |
| MailInputationTypes | `DeleterUserId` | `bigint?` (audit) | Écriture (auto ABP à la suppression) |
| MailInputationTypes | `DeletionTime` | `datetime?` (audit) | Écriture (auto ABP à la suppression) |

**Table consommatrice (référencée, non écrite par cette page) — `[Table("MailInputations")]`** — entité `MailInputation` (`src/DocuPro.Core/MailBase/MailInputation.cs`), `FullAuditedEntity`, `IMayHaveTenant`, `[Audited]`. C'est là que les types définis ici sont utilisés lors de l'imputation d'un courrier.

| Table | Colonne | Type SQL / CLR | Lecture / Écriture (par cette page) |
|---|---|---|---|
| MailInputations | `MailInputationTypeId` | `int` (FK → `MailInputationTypes.Id`, `MailInputationTypeFk`) | Ni lu ni écrit par cet écran ; consomme les valeurs de la table de référence |

### Règles de gestion / effets de bord / transitions de statut

- **Aucune transition de `MailStatus`** ni bascule de drapeaux courrier (`Valider`, `ValidationDG`, etc.) : page de paramétrage pure. — (sections statut/dates courrier sans objet.)
- **Normalisation du nom** : `CreateOrEdit` force la 1re lettre du `Name` en majuscule et le reste en minuscules lorsque la 1re lettre est minuscule (service, l.176-180).
- **Anti-doublon** :
  - `CreateMultipleNodes` : normalise chaque nom (trim, `ToLowerInvariant`, suppression des espaces), dédoublonne via `HashSet` (comparaison insensible à la casse), et rejette (message d'erreur, pas d'ajout) tout nom déjà présent (`GetAllList()` comparé après normalisation).
  - `UpdateNode` : rejette (message « Duplicate node ») si un autre type (Id différent) a le même nom normalisé.
  - `CheckIsDuplicate` (comparaison `ToUpper`) existe mais n'est pas appelée par le contrôleur actif.
- **Cache** : cache ABP `"MailInputationTypeCache"` (clé `"MailInputationTypes_All"`) alimenté par `GetAllList()` et **invalidé** (`ClearAsync`) à chaque `CreateOrEdit` et `Delete`.
- **Tenant** : `TenantId` positionné depuis `AbpSession.TenantId` à la création ; filtre multi-tenant ABP actif en lecture.
- **Suppression** : soft delete (`IsDeleted`/`DeletionTime`/`DeleterUserId`) via `FullAuditedEntity` ; suppression multiple séquentielle sur les Id sélectionnés.
- **Export** : l'export serveur (`GetMailInputationTypesToExcel`) retourne `null` (non implémenté) ; l'export réel (Excel/CSV/PDF) est effectué **côté client** par la grille Syncfusion (`toolbarClick`).
- **Rechargement UI** : après ajout/édition/suppression réussis, la page est intégralement rechargée (`window.location.reload()`), la grille étant alimentée par `ViewBag` au rendu serveur.
- **Caveat observé dans la source** (`CreateMultipleNodes`, l.92-101) : après `CreateOrEdit(newMailInputationType)`, le code teste `newMailInputationType.Id.HasValue` pour rappeler `GetMailInputationTypeForView`. Or `CreateOrEdit`/`Create` mappent l'entrée vers une **nouvelle** entité et n'affectent pas l'`Id` généré sur le DTO `input` ; `newMailInputationType.Id` reste donc `null` après insertion. Conséquence : l'enregistrement est bien créé en base, mais il est ajouté à `errors` (« ID is null »), non ajouté à `newNodes`, et `success` peut valoir `false` alors que la création a réussi (comportement tel qu'écrit dans la source lue).
- **Effets de bord notables absents** : aucune notification/e-mail, aucun job déclenché, aucune numérotation/séquence, aucune liaison document/scan depuis cette page.


---


## 19. Types de Courrier (`/App/MailDepartTypes`)

### Rôle métier
Cette page de **paramétrage** (sous-menu « MailSettings ») gère la table de référence des **types de courrier départ**. Il s'agit d'une simple liste de libellés (`name`) que l'administrateur crée/modifie/supprime, et qui alimente ensuite la liste déroulante « type » du **formulaire de courrier départ** (`App/CourrierDepart`). Concrètement, quand un agent enregistre un courrier départ, il choisit un de ces types ; la valeur choisie est stockée dans `Mails.MailDepartTypeId` (FK → table `MailTypes`). Le type sert aussi de critère de sous-numérotation : `IMailsAppService.GetDepartMailsByMailDepartTypeId(int)` récupère tous les courriers Départ d'un type donné pour calculer le prochain `NReference`. La page est en **saisie** (CRUD), pas en lecture seule.

> **Clarification de nommage (source vérifiée)** — trois notions homonymes coexistent :
> - **ENUM `MailType`** (`Arrivée`=0, `Départ`=1, `Interne`=2), dans `src/DocuPro.Core.Shared/Helpers/Enums.cs`, porté par `Mail.MailType`. **Ce n'est PAS cette table.**
> - **ENTITÉ `MailDepartType`** (fichier `src/DocuPro.Core/MailBase/MailType.cs`) mappée sur la table **`MailTypes`** — c'est **la table de référence documentée ici**.
> - Le libellé de menu est « **MailDepartTypes** » et l'URL est `App/MailDepartTypes`, mais le `AppPageName` interne reste `AppPageNames.Common.MailTypes` = `"MailBase.MailTypes"` et toutes les permissions sont nommées `Pages.MailTypes.*`. Les DTO réutilisent aussi le nom de propriété `MailType` (ex. `GetMailDepartTypeForViewDto.MailType`).

> **Deux surfaces d'écran sur la même table** (source vérifiée) :
> - `App/MailDepartTypes` (contrôleur `MailDepartTypesController`) — **c'est l'entrée de menu réelle** : grille Syncfusion + ajout en masse + édition/suppression. Documentée comme page principale ci-dessous.
> - `App/MailTypes` (contrôleur `MailTypesController`) — page CRUD classique AspNetZero (DataTables serveur + modale Créer/Éditer + import/export Excel). Son entrée de menu est **commentée** dans `AppNavigationProvider.cs` (lignes 25-31) ; elle n'est donc pas exposée dans la navigation. Documentée en fin de fiche comme surface CRUD alternative/héritée.

### Accès & permissions
- **Contrôleur MVC (page de menu)** : `MailDepartTypesController`, `[AbpMvcAuthorize(AppPermissions.Pages_MailTypes_Access)]`, namespace `DocuPro.Web.Areas.App.Controllers.Common`, `[Area("App")]` — fichier `src/DocuPro.Web.Mvc/Areas/App/Controllers/Parametrages/MailDepartTypesController.cs`.
- **Contrôleur MVC (page CRUD alternative)** : `MailTypesController`, `[AbpMvcAuthorize(AppPermissions.Pages_MailTypes)]`, hérite de `ExcelImportControllerBase`, `[Area("App")]` — fichier `src/DocuPro.Web.Mvc/Areas/App/Controllers/MailTypesController.cs`. Ses actions `CreateOrEditModal` ajoutent `[AbpMvcAuthorize(Pages_MailTypes_Create, Pages_MailTypes_Edit)]`. Sa propriété `ImportExcelPermission => Pages_MailTypes_Create`.
- **Service applicatif** : `MailDepartTypesAppService`, `[AbpAuthorize(AppPermissions.StandardUser)]` au niveau classe ; certaines méthodes surchargent avec des permissions plus fines (voir plus bas) — fichier `src/DocuPro.Application/MailBase/MailTypesAppService.cs`. Interface `IMailDepartTypesAppService` — fichier `src/DocuPro.Application.Shared/MailBase/IMailTypesAppService.cs`. (Il n'existe **aucun** `IMailTypesAppService` ni `MailTypesAppService` distinct : le nom de fichier est trompeur, la classe/interface s'appellent `MailDepartType…`.)
- **Constantes de permission** (`src/DocuPro.Core.Shared/Authorization/AppPermissions.cs`) :
  - `Pages_MailTypes` = `"Pages.MailTypes"` (libellé `L("MailTypes")`)
  - `Pages_MailTypes_Access` = `"Pages.MailTypes.Access"` (libellé `L("MailTypesAccess")`)
  - `Pages_MailTypes_Create` = `"Pages.MailTypes.Create"` (libellé `L("CreateNewMailType")`)
  - `Pages_MailTypes_Edit` = `"Pages.MailTypes.Edit"` (libellé `L("EditMailType")`)
  - `Pages_MailTypes_Delete` = `"Pages.MailTypes.Delete"` (libellé `L("DeleteMailType")`)
  - `Menus_Mail_Settings_MailTypes` = `"Menus.Mail_Settings.MailTypes"` (libellé `L("MailSettings_MailTypes")`)
  - Déclaration : `src/DocuPro.Core/Authorization/AppAuthorizationProvider.cs` lignes 87, 153-157.
- **Entrée de menu** (`src/DocuPro.Web.Mvc/Areas/App/Startup/AppNavigationProvider.cs` lignes 400-406) : sous le menu « Paramétrage / MailSettings ». `name` = `AppPageNames.Common.MailTypes` (`"MailBase.MailTypes"`), libellé `L("MailDepartTypes")`, `url: "App/MailDepartTypes"`, `icon: "bi bi-envelope"`, dépendance de permission `requiresAll: true` → `Pages_MailTypes_Access` **ET** `Menus_Mail_Settings_MailTypes`. Aucun badge.
- **Multi-tenant** : l'entité `MailDepartType` implémente `IMayHaveTenant`. À la création (`MailDepartTypesAppService.Create`), `TenantId = (int?)AbpSession.TenantId` si non nul. Un index sur `TenantId` est défini. Le filtre `MayHaveTenant` d'ABP s'applique donc normalement (chaque tenant ne voit que ses types) ; aucun `DisableFilter` n'est appliqué dans la source lue.

### Interface utilisateur
- **Page Razor (menu)** : `src/DocuPro.Web.Mvc/Areas/App/Views/MailDepartTypes/Index.cshtml`. Scripts inline dans la vue (bloc `@section Scripts`). Titre affiché : sous-header `title = L("MailSettings")`, `description = L("MailDepartTypes")`. Les données de la grille sont pré-rendues côté serveur dans `ViewBag.MailDepartTypes` (via `GetAllList()`), objets `{ Id, Name }`.
- La page se compose de deux cartes : à gauche une **grille Syncfusion** (`ejs-grid id="TreeGrid"`, `locale="fr"`, pagination 10, tri, recherche), à droite un panneau **Ajouter (en masse) / Éditer**.

#### Filtres / recherche
| Libellé | Propriété (input→traitement) | Type de contrôle | Source / comportement serveur |
|---|---|---|---|
| Recherche grille | — (filtrage client Syncfusion) | Zone de recherche de la toolbar `ejs-grid` (`toolbar="Search"`) | Filtrage **côté client** sur les données déjà chargées de `ViewBag.MailDepartTypes`. Aucun appel serveur. |

#### Colonnes du tableau (grille Syncfusion `TreeGrid`)
| Libellé | Propriété (`field`) | Type |
|---|---|---|
| (case à cocher) | — | Colonne `type="checkbox"` (sélection multiple), largeur 20 |
| `L("Name")` | `Name` | Texte (largeur 200) — vient de `MailDepartType.name` |

#### Actions (boutons)
| Bouton | Effet (endpoint / JS) | Permission |
|---|---|---|
| Ajouter (`#addMailDepartTypesButton`, `addMailDepartTypes()`) | Découpe la textarea `#mailDepartTypeNames` par ligne, normalise/dédoublonne/trie, confirme, POST JSON `{ ParentId: null, NodeNames: [...] }` → `App/MailDepartTypes/CreateMultipleNodes`, puis `window.location.reload()` | Aucune vérification client explicite ; côté serveur `Create` exige `Pages_MailTypes_Create` |
| Éditer (`#updateMailDepartTypeButton`, `updateMailDepartType()`) | Prend la ligne sélectionnée + valeur de `#editMailDepartTypeName`, confirme, POST JSON `{ Id, Name }` → `App/MailDepartTypes/UpdateNode`, puis reload. Bouton `disabled` tant qu'aucune ligne n'est sélectionnée | `Pages_MailTypes_Edit` (côté serveur `Update`) |
| Supprimer (`#deleteMailDepartTypesButton`, `deleteMailDepartTypes()`) | Récupère les `Id` des lignes cochées, confirme, POST JSON `[id, id, …]` → `App/MailDepartTypes/DeleteNodes`, puis reload. Bouton `disabled` sans sélection | `Pages_MailTypes_Delete` (côté serveur `Delete`) |
| ExcelExport / CsvExport / PdfExport | Toolbar Syncfusion → `toolbarClick` appelle `grid.excelExport() / csvExport() / pdfExport()` | Export **client** de la grille (pas d'endpoint serveur) |

#### Formulaire(s) / champs de saisie (page MailDepartTypes)
| Champ | Propriété (payload → DTO serveur) | Type de contrôle | Obligatoire | Source / valeurs |
|---|---|---|---|---|
| Saisie en masse | `NodeNames` (`List<string>`) → boucle → `CreateOrEditMailDepartTypeDto.name` | `<textarea id="mailDepartTypeNames">` (un type par ligne) | Oui (sinon Swal « NoMailDepartTypeNamesProvided ») | Saisie libre. Le JS dédoublonne (`toLowerCase`, espaces normalisés) et trie avant envoi ; le serveur re-normalise (`trim` + `ToLowerInvariant` + suppression des espaces) et rejette les doublons |
| Édition libellé | `Name` (`string`) → `UpdateNodeRequestMailDepartType.Name` → `CreateOrEditMailDepartTypeDto.name` | `<ejs-textbox id="editMailDepartTypeName">` | Oui (sinon Swal « MailDepartTypeNameCannotBeEmpty ») | Pré-rempli avec `selectedMailDepartType.Name` de la ligne sélectionnée |
| `ParentId` | envoyé `null` par le JS, **ignoré** — `MultipleNodeRequestMailDepartType` ne le déclare pas | (aucun contrôle visible) | Non | La table est plate : aucune hiérarchie réelle malgré le vocabulaire « Node/Tree » |

### Service applicatif & opérations
- **Interface** : `IMailDepartTypesAppService` — `src/DocuPro.Application.Shared/MailBase/IMailTypesAppService.cs`.
- **Implémentation** : `MailDepartTypesAppService` — `src/DocuPro.Application/MailBase/MailTypesAppService.cs`.

| Méthode | Entrée | Sortie | Description / permission |
|---|---|---|---|
| `GetAll` | `GetAllMailDepartTypesInput` | `PagedResultDto<GetMailDepartTypeForViewDto>` | Liste paginée/filtrée (`Filter` OU `nameFilter` sur `name`), tri `Sorting ?? "id asc"`. Utilisée par la page CRUD `App/MailTypes` (DataTables) |
| `GetAllList` | — | `List<GetMailDepartTypeForViewDto>` | Liste complète triée par `name`. Utilisée par la grille `App/MailDepartTypes` et par le formulaire `CourrierDepart` (lookup) |
| `GetMailTypeForView` | `EntityDto<int>` | `GetMailDepartTypeForViewDto` | Charge un type par `Id` (`GetAsync`), mappe vers `MailDepartTypeDto` |
| `GetMailTypeForEdit` | `EntityDto` | `GetMailDepartTypeForEditOutput` | `[AbpAuthorize(Pages_MailTypes_Edit)]`. Charge par `Id` (`FirstOrDefaultAsync`), mappe vers `CreateOrEditMailDepartTypeDto` |
| `CreateOrEdit` | `CreateOrEditMailDepartTypeDto` | `Task` | Aiguille : `Id == null` → `Create`, sinon `Update` |
| `Create` (protected) | `CreateOrEditMailDepartTypeDto` | `Task` | `[AbpAuthorize(Pages_MailTypes_Create)]`. Insère, positionne `TenantId` depuis la session, renvoie l'`Id` inséré dans `input.Id` |
| `Update` (protected) | `CreateOrEditMailDepartTypeDto` | `Task` | `[AbpAuthorize(Pages_MailTypes_Edit)]`. Recharge par `Id` puis `ObjectMapper.Map(input, entity)` |
| `Delete` | `EntityDto` | `Task` | `[AbpAuthorize(Pages_MailTypes_Delete)]`. `DeleteAsync(id)` → suppression **logique** (FullAudited : `IsDeleted=true`) |
| `GetMailTypesToExcel` | `GetAllMailDepartTypesForExcelInput` | `FileDto` | Export Excel via `IMailTypesExcelExporter.ExportToFile`, colonnes sélectionnées |
| `GetMailTypeExcelColumnsToExcel` | — | `List<string>` | Noms de colonnes exportables de `MailDepartTypeDto` (`EntityExportHelper`) |

**Actions MVC — `MailDepartTypesController`** (`src/DocuPro.Web.Mvc/Areas/App/Controllers/Parametrages/MailDepartTypesController.cs`) :
| Action | Signature / entrée | Renvoi |
|---|---|---|
| `Index()` | — | `View()` ; remplit `ViewBag.MailDepartTypes` = `GetAllList()` projeté en `{ Id, Name }` |
| `CreateMultipleNodes` | `[HttpPost] ([FromBody] MultipleNodeRequestMailDepartType request)` | `Json { success, newNodes:[{Id,Name}], errors:[] }`. Normalise/dédoublonne, vérifie les doublons existants (via `GetAllList`), appelle `CreateOrEdit` par élément |
| `DeleteNodes` | `[HttpPost] ([FromBody] List<int> ids)` | `Json { success }` (ou `{success:false,message}`). Pour chaque id : `GetMailTypeForView` puis `Delete` |
| `UpdateNode` | `[HttpPost] ([FromBody] UpdateNodeRequestMailDepartType request)` | `Json { success }`. Rejette si doublon (hors élément courant) ; sinon `GetMailTypeForEdit`, modifie `.MailType.name`, `CreateOrEdit` |

**Actions MVC — `MailTypesController`** (page CRUD alternative, `src/DocuPro.Web.Mvc/Areas/App/Controllers/MailTypesController.cs`) :
| Action | Signature / entrée | Renvoi |
|---|---|---|
| `Index()` | — | `View(new MailTypesViewModel { FilterText = "" })` |
| `CreateOrEditModal` | `(int? id)` — `[AbpMvcAuthorize(Create, Edit)]` | `PartialView("_CreateOrEditModal", CreateOrEditMailTypeModalViewModel)`. Si `id` : `GetMailTypeForEdit` ; sinon DTO vide |
| `ViewMailTypeModal` | `(EntityDto<int> input)` | `PartialView("_ViewMailTypeModal", MailTypeViewModel)` via `GetMailTypeForView` |
| `ExcelColumnSelectionModal` | `(long? id)` | `PartialView("_ExcelColumnSelectionModal", …)` via `GetMailTypeExcelColumnsToExcel` |
| `EnqueueExcelImportJobAsync` | `(ImportFromExcelJobArgs args)` | Enfile `ImportMailTypesToExcelJob` (import Excel en tâche de fond) |
| `ImportFromExcel` / `ExportToExcel` | héritées de `ExcelImportControllerBase` | Import/export Excel |

### DTOs

**`MailDepartTypeDto`** — `src/DocuPro.Application.Shared/MailBase/Dtos/MailTypeDto.cs` (hérite `EntityDto`)
| Propriété | Type C# | Obligatoire | Description |
|---|---|---|---|
| `Id` | `int` | — (clé) | Hérité de `EntityDto`. Id du type = `MailTypes.Id` |
| `name` | `string` | Non (pas de `[Required]` sur ce DTO) | Libellé du type = `MailTypes.name` |

**`CreateOrEditMailDepartTypeDto`** — `src/DocuPro.Application.Shared/MailBase/Dtos/CreateOrEditMailTypeDto.cs` (hérite `EntityDto<int?>`)
| Propriété | Type C# | Obligatoire | Description |
|---|---|---|---|
| `Id` | `int?` | Non (`null` = création) | Hérité de `EntityDto<int?>` |
| `name` | `string` | **Oui** (`[Required]`) | Libellé du type → `MailTypes.name` |

**`GetMailDepartTypeForViewDto`** — `src/DocuPro.Application.Shared/MailBase/Dtos/GetMailTypeForViewDto.cs`
| Propriété | Type C# | Obligatoire | Description |
|---|---|---|---|
| `MailType` | `MailDepartTypeDto` | — | Enveloppe du type (vue) |

**`GetMailDepartTypeForEditOutput`** — `src/DocuPro.Application.Shared/MailBase/Dtos/GetMailTypeForEditOutput.cs`
| Propriété | Type C# | Obligatoire | Description |
|---|---|---|---|
| `MailType` | `CreateOrEditMailDepartTypeDto` | — | Enveloppe du type (édition) |

**`GetAllMailDepartTypesInput`** — `src/DocuPro.Application.Shared/MailBase/Dtos/GetAllMailTypesInput.cs` (hérite `PagedAndSortedResultRequestDto`)
| Propriété | Type C# | Obligatoire | Description |
|---|---|---|---|
| `Filter` | `string` | Non | Filtre global sur `name` (`Contains`) |
| `nameFilter` | `string` | Non | Filtre avancé sur `name` (`Contains`) |
| `Sorting` | `string` | Non | Hérité — tri (défaut `"id asc"`) |
| `SkipCount` | `int` | Non | Hérité — pagination |
| `MaxResultCount` | `int` | Non | Hérité — pagination |

**`GetAllMailDepartTypesForExcelInput`** — `src/DocuPro.Application.Shared/MailBase/Dtos/GetAllMailTypesForExcelInput.cs` (implémente `IExcelColumnSelectionInput`)
| Propriété | Type C# | Obligatoire | Description |
|---|---|---|---|
| `Filter` | `string` | Non | Filtre global sur `name` |
| `SelectedColumns` | `List<string>` | Non | Colonnes à exporter |
| `nameFilter` | `string` | Non | Filtre sur `name` |

**Modèles de requête du contrôleur** (déclarés dans `MailDepartTypesController.cs`)
| DTO | Propriété | Type C# | Description |
|---|---|---|---|
| `MultipleNodeRequestMailDepartType` | `NodeNames` | `List<string>` | Liste des libellés à créer en masse |
| `UpdateNodeRequestMailDepartType` | `Id` | `int` | Id du type à modifier |
| `UpdateNodeRequestMailDepartType` | `Name` | `string` | Nouveau libellé |

**ViewModels MVC** (`src/DocuPro.Web.Mvc/Areas/App/Models/MailTypes/`) — pour la page CRUD alternative :
- `MailTypesViewModel` : `FilterText` (`string`).
- `CreateOrEditMailTypeModalViewModel` : `MailType` (`CreateOrEditMailDepartTypeDto`), `IsEditMode` (`bool`, = `MailType.Id.HasValue`).
- `MailTypeViewModel` : `MailType` (`MailDepartTypeDto`).

### Tables & colonnes impactées
- **Table `MailTypes`** — `[Table("MailTypes")]`, entité `MailDepartType` (`src/DocuPro.Core/MailBase/MailType.cs`), base ABP `FullAuditedEntity`, interface `IMayHaveTenant`. DbSet : `public virtual DbSet<MailDepartType> MailTypes` (`DocuProDbContext.cs` ligne 32). Configuration : `modelBuilder.Entity<MailDepartType>(m => m.HasIndex(e => new { e.TenantId }))` (`DocuProDbContext.cs` lignes 213-216). Migration de création : `20251026184942_MailType.cs` (crée `MailTypes`, index `IX_MailTypes_TenantId`).

| Table | Colonne | Type SQL / CLR | Lecture / Écriture (par cette page) |
|---|---|---|---|
| `MailTypes` | `Id` | `int` PK identity / `int` | Lecture (grille, édition, suppression), Écriture (identity à la création) |
| `MailTypes` | `TenantId` | `int` NULL / `int?` | Écriture (positionné depuis `AbpSession.TenantId` à la création), Lecture (filtre tenant, index) |
| `MailTypes` | `name` | `nvarchar(max)` NOT NULL / `string` (`[Required]`) | Lecture + Écriture (le seul champ métier) |
| `MailTypes` | `CreationTime` | `datetime2` / `DateTime` | Écriture (audit ABP, création) |
| `MailTypes` | `CreatorUserId` | `bigint` NULL / `long?` | Écriture (audit) |
| `MailTypes` | `LastModificationTime` | `datetime2` NULL / `DateTime?` | Écriture (audit, modification) |
| `MailTypes` | `LastModifierUserId` | `bigint` NULL / `long?` | Écriture (audit) |
| `MailTypes` | `IsDeleted` | `bit` / `bool` | Écriture (suppression logique) |
| `MailTypes` | `DeleterUserId` | `bigint` NULL / `long?` | Écriture (audit suppression) |
| `MailTypes` | `DeletionTime` | `datetime2` NULL / `DateTime?` | Écriture (audit suppression) |

- **Index connus** : `IX_MailTypes_TenantId` (sur `TenantId`).
- **Table de référence consommée en aval (non écrite par cette page)** : `Mails`. Colonne `MailDepartTypeId` (`int` NULL / `int?`), FK `FK_Mails_MailTypes_MailDepartTypeId` → `MailTypes.Id`, index `IX_Mails_MailDepartTypeId`. Entité : `Mail.MailDepartTypeId` + navigation `[ForeignKey("MailDepartTypeId")] MailDepartType MailDepartTypeFk` (`src/DocuPro.Core/MailBase/Mail.cs` lignes 217-219). Migration : `20251026211901_MailDepartTypeId.cs`. **Cette page n'écrit pas `Mails`** ; elle fournit uniquement les valeurs sélectionnables. C'est le formulaire `App/CourrierDepart` qui lit la liste (`ViewBag.MailType` construit depuis `_mailDepartTypesAppService.GetAllList()`, `CourrierDepartController.cs` lignes 529-531) et écrit `Mails.MailDepartTypeId` (via `CreateOrEditMailDto.MailDepartTypeId`, `int?`).

### Règles de gestion / effets de bord / transitions de statut
- **Pas de transition de `MailStatus` ni de bascule de drapeaux** ici : c'est une table de paramétrage pure, sans impact sur le cycle de vie d'un courrier. — (transitions de statut : sans objet)
- **Unicité applicative** : l'unicité des libellés est assurée **au niveau applicatif** (pas de contrainte SQL unique). Le contrôleur normalise chaque nom (`Trim` + `ToLowerInvariant` + suppression des espaces) et rejette les doublons, à la création (`CreateMultipleNodes`) comme à la mise à jour (`UpdateNode`, exclusion de l'élément courant). Le JS dédoublonne aussi côté client avant envoi.
- **Suppression = logique** : `Delete` appelle `DeleteAsync` sur une entité `FullAuditedEntity` → positionne `IsDeleted`, `DeleterUserId`, `DeletionTime`. Aucune vérification d'intégrité référentielle n'est faite avant suppression : supprimer un type déjà référencé par des `Mails.MailDepartTypeId` laisse ces courriers pointer vers un type logiquement supprimé (la FK autorise l'orphelin car `MailDepartTypeId` est nullable et la ligne n'est pas physiquement retirée).
- **Multi-tenant** : `TenantId` renseigné à la création depuis la session ; index et filtre `MayHaveTenant` par tenant.
- **Effet aval / numérotation** : le type sélectionné sur un courrier départ alimente `Mails.MailDepartTypeId`, exploité par `IMailsAppService.GetDepartMailsByMailDepartTypeId(int)` (`MailsAppService.cs` ligne 3787 ; charge les `Mail` où `MailType == MailType.Départ` puis filtre par `MailDepartTypeId`/navigation) pour retrouver les courriers Départ d'un même type et calculer le prochain `NReference`. Consommateur réel : l'action `[HttpGet] GetNextReferenceByMailType(int mailTypeId)` de `CourrierDepartController` (fichier `src/DocuPro.Web.Mvc/Areas/App/Controllers/DocuCourriers/CourrierDepartController.cs`, ligne 481, appel service ligne 486), qui calcule le max numérique du sous-ensemble. **Attention** : l'autre méthode `GetNextNReference()` (ligne 429) du même contrôleur, elle, ignore le type et prend le max sur **tous** les courriers.
- **Rafraîchissement UI** : après Ajout/Édition/Suppression, la page force `window.location.reload()` (les données de grille étant rendues côté serveur dans `ViewBag`).
- **Observation (source vérifiée, à signaler pour ré-implémentation)** :
  - La page CRUD alternative `App/MailTypes` appelle côté client `abp.services.app.mailTypes` (`Index.js` lignes 4, 40-42, etc.). Or aucun service `IMailTypesAppService` n'existe : le proxy dynamique ABP du service réel est `mailDepartTypes` (interface `IMailDepartTypesAppService`). Le tableau DataTables de cette page ne se peuple donc probablement pas ; les actions serveur du contrôleur `MailTypesController` fonctionnent, elles, car elles injectent bien `IMailDepartTypesAppService`. La page de menu opérationnelle reste `App/MailDepartTypes`.
  - Dans `CourrierDepartController` (ligne 161), un autre flux affecte `MailDepartTypeId = DestinataireExpediteur` (un identifiant utilisateur `long`) lors de la création d'un courrier lié — usage divergent du champ, à vérifier lors d'une ré-implémentation ; hors périmètre de cette page de paramétrage.


---
