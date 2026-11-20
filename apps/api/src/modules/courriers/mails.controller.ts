import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
  Query,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { createReadStream } from 'node:fs';
import { access } from 'node:fs/promises';
import { MenuPermissionGuard } from '../auth/menu-permission.guard';
import { RequireMenu } from '../auth/require-menu.decorator';
import { AllowScanAgentKey } from '../auth/scan-agent-key.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../auth/auth.types';
import { MENU_SUIVI, MENU_SUIVI_DC } from '../roles/menu-catalog';
import { MAIL_WORKFLOW_MENUS } from './mail-workflow.menus';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { MailsService } from './mails.service';
import { MailSearchService } from './mail-search.service';
import { MailScannedDocumentsService, type UploadedScan } from './mail-scanned.service';
import { MailFicheService } from './mail-fiche.service';
import { MailAiExtractionService } from './mail-ai-extraction.service';
import {
  createArriveeSchema,
  createDepartSchema,
  integrateDechargeSchema,
  mailSearchSchema,
  paginationQuerySchema,
  validationDirectionSchema,
  type CreateArriveeBody,
  type CreateDepartBody,
  type IntegrateDechargeDto,
  type MailSearchDto,
  type PaginationQueryDto,
  type ValidationDirectionDto,
} from './mails.dto';

/**
 * Contrôleur des courriers (§05–§13). Chaque endpoint est gardé par le menu de son écran
 * (@RequireMenu) ; l'admin bypasse. Les endpoints statiques précèdent la route paramétrée `:id`.
 */
@UseGuards(MenuPermissionGuard)
@Controller('courriers')
export class MailsController {
  constructor(
    private readonly mails: MailsService,
    private readonly search: MailSearchService,
    private readonly scanned: MailScannedDocumentsService,
    private readonly fiche: MailFicheService,
    private readonly aiExtraction: MailAiExtractionService,
  ) {}

  /**
   * Disponibilité de la saisie automatique (§05). L'écran interroge d'abord cet endpoint : `enabled`
   * exige l'IA activée ET la lecture locale (OCR) utilisable, sinon la case à cocher n'est pas
   * proposée plutôt que d'échouer au premier usage.
   */
  @RequireMenu('/courriers/enregistrement')
  @Get('extraction-ia/disponibilite')
  async aiExtractionAvailability() {
    return { enabled: await this.aiExtraction.isEnabled() };
  }

  /**
   * Pré-remplissage du formulaire d'enregistrement à partir du courrier numérisé (§05). Le binaire
   * n'est ni stocké ni rattaché ici : c'est une lecture, le dépôt reste `POST documents-scannes`.
   * Rien n'est écrit en base — l'agent relit et corrige les valeurs proposées avant d'enregistrer.
   */
  @RequireMenu('/courriers/enregistrement')
  @Post('extraction-ia')
  @UseInterceptors(FileInterceptor('file'))
  extractWithAi(@UploadedFile() file: UploadedScan | undefined) {
    return this.aiExtraction.extract(file);
  }

  /** Compteurs de badges (§04.7) — authentifié (sous MenuPermissionGuard). */
  @Get('badges')
  badges(@CurrentUser() user: AuthUser) {
    return this.mails.badgeCounts(user);
  }

  @RequireMenu('/courriers/controle')
  @Get('controle')
  listControle(
    @Query(new ZodValidationPipe(paginationQuerySchema)) q: PaginationQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.mails.listControle(user, q);
  }

  // Gardé par le seul menu Validation : la file n'est pas soumise au périmètre de suivi (§09).
  @RequireMenu('/courriers/validation')
  @Get('validation-direction')
  listValidationDirection(
    @Query(new ZodValidationPipe(paginationQuerySchema)) q: PaginationQueryDto,
  ) {
    return this.mails.listValidationDirection(q);
  }

  @RequireMenu('/courriers/parapheur')
  @Get('parapheur')
  listParapheur(
    @Query(new ZodValidationPipe(paginationQuerySchema)) q: PaginationQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.mails.listParapheur(user, q);
  }

  // Les deux permissions de suivi sont alternatives (§09) : l'une comme l'autre ouvre l'écran,
  // le périmètre des données est tranché ensuite par le service.
  @RequireMenu(MENU_SUIVI, MENU_SUIVI_DC)
  @Get('suivi')
  listSuivi(
    @Query(new ZodValidationPipe(paginationQuerySchema)) q: PaginationQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.mails.listSuivi(user, q);
  }

  @RequireMenu('/courriers/depart')
  @Get('depart')
  listDepart(@Query(new ZodValidationPipe(paginationQuerySchema)) q: PaginationQueryDto) {
    return this.mails.listDepart(q);
  }

  /** Lookup des courriers de départ dont la décharge signée reste à intégrer (§13). */
  @RequireMenu('/courriers/integration-decharge')
  @Get('decharges-en-attente')
  listDechargesEnAttente() {
    return this.mails.listDechargesEnAttente();
  }

  @RequireMenu('/courriers/enregistrement')
  @Get('next-reference/arrivee')
  async nextArriveeReference(): Promise<{ nReference: string }> {
    return { nReference: await this.mails.previewNextArriveeReference() };
  }

  @RequireMenu('/courriers/depart')
  @Get('next-reference/depart/:typeId')
  async nextDepartReference(
    @Param('typeId', ParseIntPipe) typeId: number,
  ): Promise<{ nReference: string }> {
    return { nReference: await this.mails.previewNextDepartReference(typeId) };
  }

  /**
   * Acteurs sélectionnables (destinataire §05, imputé §08). Lecture ouverte à tout authentifié —
   * c'est un lookup de formulaire, au même titre que les référentiels.
   */
  @Get('actors')
  listActors() {
    return this.mails.listActors();
  }

  /**
   * Rôles sélectionnables comme destinataire (§05). Lecture ouverte à tout authentifié, comme
   * `actors` : c'est un lookup de formulaire.
   */
  @Get('destinataire-roles')
  listDestinataireRoles() {
    return this.mails.listDestinataireRoles();
  }

  /**
   * Lookup « Lié au courrier » (§12) : courriers d'un correspondant donné, pour rattacher un
   * Départ à celui auquel il répond. Route à 2 segments — aucun conflit avec `:id`.
   */
  @RequireMenu('/courriers/depart')
  @Get('by-external-entity/:externalEntityId')
  listByExternalEntity(@Param('externalEntityId', ParseIntPipe) externalEntityId: number) {
    return this.mails.listByExternalEntity(externalEntityId);
  }

  /**
   * File des documents scannés en attente d'enregistrement (§07). Ouverte aussi à la clé de
   * service : c'est par elle que l'agent vérifie son accès au démarrage, avant d'envoyer quoi que
   * ce soit — un service qui ne peut pas déposer doit le dire tout de suite.
   */
  @AllowScanAgentKey()
  @RequireMenu('/courriers/documents-scannes')
  @Get('documents-scannes')
  listScanned(@Query(new ZodValidationPipe(paginationQuerySchema)) q: PaginationQueryDto) {
    return this.scanned.listPending(q);
  }

  // Lu aussi par l'Enregistrement (§05), où l'on arrive avec `?scanId=` depuis « Documents
  // scannés » : sans cette clé, le nom du scan rattaché n'apparaît pas dans le formulaire.
  @RequireMenu('/courriers/documents-scannes', '/courriers/enregistrement')
  @Get('documents-scannes/:scanId')
  getScanned(@Param('scanId', ParseIntPipe) scanId: number) {
    return this.scanned.getById(scanId);
  }

  /**
   * Aperçu inline du scan (§07 `ViewDocument`) — jamais en téléchargement forcé. Le binaire vit
   * hors GED tant que le scan n'est pas enregistré, d'où la lecture par chemin (et non par fileId).
   */
  @RequireMenu('/courriers/documents-scannes')
  @Get('documents-scannes/:scanId/content')
  async scannedContent(@Param('scanId', ParseIntPipe) scanId: number): Promise<StreamableFile> {
    const target = await this.scanned.getContentTarget(scanId);
    // Cohérence base⇄disque : échouer en 404 propre avant d'émettre les en-têtes du flux.
    try {
      await access(target.filePath);
    } catch {
      throw new NotFoundException('Fichier introuvable sur le coffre disque');
    }
    // En-têtes HTTP en Latin-1 : repli ASCII pour `filename=`, nom réel en RFC 6266 `filename*`.
    const asciiName = target.fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '');
    return new StreamableFile(createReadStream(target.filePath), {
      type: target.contentType,
      disposition: `inline; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(target.fileName)}`,
    });
  }

  /**
   * Dépôt d'un document dans la file §07 — seule porte d'entrée d'un binaire dans le flux courrier.
   * Appelé par l'écran §07, par l'enregistrement (§05) et le Départ (§12) qui joignent leur PDF via
   * cette même file, et par `@archivage/scan-agent` installé sur les postes de scan (équivalent V6
   * du service Windows de numérisation du source, §01.5.1) — celui-ci s'authentifie par clé de
   * service, sans compte utilisateur, et le dépôt reste alors sans auteur (`created_by` nul :
   * l'auteur du courrier est saisi à l'enregistrement §05).
   */
  @AllowScanAgentKey()
  @RequireMenu(
    '/courriers/documents-scannes',
    '/courriers/enregistrement',
    '/courriers/depart',
    // §13 : l'intégration de décharge dépose elle aussi son PDF signé par cette file.
    '/courriers/integration-decharge',
  )
  @Post('documents-scannes')
  @UseInterceptors(FileInterceptor('file'))
  uploadScanned(
    @UploadedFile() file: UploadedScan | undefined,
    @Body('machineName') machineName: string | undefined,
    @CurrentUser() user: AuthUser,
  ) {
    return this.scanned.upload(file, machineName?.trim() || null, user);
  }

  /**
   * Fiche d'Imputation (§09) — PDF pour l'aperçu et l'impression de la modale.
   * POST comme le source (`GenerateFicheImputationPdf`) : c'est un rendu, pas une ressource
   * adressable. Le courrier n'est pas muté (§09 : « opération de lecture/rendu »).
   */
  @RequireMenu('/courriers/suivi')
  @Post(':id/fiche-imputation/pdf')
  @HttpCode(200)
  async fichePdf(@Param('id', ParseIntPipe) id: number): Promise<StreamableFile> {
    const { buffer, filename } = await this.fiche.renderPdf(id, new Date());
    return new StreamableFile(buffer, {
      type: 'application/pdf',
      disposition: `inline; filename="${filename}"`,
    });
  }

  /** Fiche d'Imputation (§09) — DOCX téléchargeable, gabarit du Sénat rempli. */
  @RequireMenu('/courriers/suivi')
  @Post(':id/fiche-imputation')
  @HttpCode(200)
  async ficheDocx(@Param('id', ParseIntPipe) id: number): Promise<StreamableFile> {
    const { buffer, filename } = await this.fiche.renderDocx(id, new Date());
    return new StreamableFile(buffer, {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      disposition: `attachment; filename="${filename}"`,
    });
  }

  // Détail : lecture ouverte à tout utilisateur authentifié (convention V6 « lectures ouvertes »).
  // Le filtrage par confidentialité relève de l'ACL PAR COURRIER, différée en v1 (décision Étape 0 :
  // accès par menu-RBAC ; MailPermission modélisée mais inactive). À réactiver si besoin confidentiel.
  // `?imputations=mine` (parapheur §08) : ne renvoie que les imputations de l'appelant et celles
  // qu'il a créées. Le serveur reste seul juge de l'exception « destinataire principal ».
  @Get(':id')
  getOne(
    @Param('id', ParseIntPipe) id: number,
    @Query('imputations') imputations: string | undefined,
    @CurrentUser() user: AuthUser,
  ) {
    return this.mails.getById(id, user, imputations === 'mine');
  }

  @RequireMenu('/courriers/enregistrement')
  @Post('arrivee')
  createArrivee(
    @Body(new ZodValidationPipe(createArriveeSchema)) body: CreateArriveeBody,
    @CurrentUser() user: AuthUser,
  ) {
    return this.mails.createArrivee(body, user);
  }

  @RequireMenu('/courriers/depart')
  @Post('depart')
  createDepart(
    @Body(new ZodValidationPipe(createDepartSchema)) body: CreateDepartBody,
    @CurrentUser() user: AuthUser,
  ) {
    return this.mails.createDepart(body, user);
  }

  @RequireMenu('/courriers/recherche')
  @Post('recherche')
  @HttpCode(200)
  searchMails(@Body(new ZodValidationPipe(mailSearchSchema)) body: MailSearchDto) {
    return this.search.search(body);
  }

  @RequireMenu('/courriers/controle')
  @Post(':id/valider')
  @HttpCode(200)
  valider(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.mails.valider(id, user);
  }

  @RequireMenu(...MAIL_WORKFLOW_MENUS)
  @Post(':id/decharge')
  @HttpCode(200)
  decharge(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.mails.dechargeCourrier(id, user);
  }

  @RequireMenu(...MAIL_WORKFLOW_MENUS)
  @Post(':id/enregistrement-reponse')
  @HttpCode(200)
  enregistrementReponse(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.mails.enregistrementReponse(id, user);
  }

  @RequireMenu(...MAIL_WORKFLOW_MENUS)
  @Post(':id/validation-dg')
  @HttpCode(200)
  validationDG(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.mails.validationDG(id, user);
  }

  @RequireMenu('/courriers/validation')
  @Post('validation-direction')
  @HttpCode(200)
  validationDirection(
    @Body(new ZodValidationPipe(validationDirectionSchema)) body: ValidationDirectionDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.mails.validationDirection(body.mailIds, user);
  }

  // Archivage : proposé seulement là où `allowArchive` est vrai (Parapheur, Validation) — Suivi,
  // Recherche et Contrôle masquent le bouton, inutile de leur ouvrir la route.
  @RequireMenu('/courriers/parapheur', '/courriers/validation')
  @Post(':id/archiver')
  @HttpCode(200)
  archiver(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.mails.archiver(id, user);
  }

  @RequireMenu('/courriers/integration-decharge')
  @Post(':id/integration-decharge')
  @HttpCode(200)
  integrateDecharge(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(integrateDechargeSchema)) body: IntegrateDechargeDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.mails.integrateDecharge(id, body, user);
  }

  @RequireMenu('/courriers/controle')
  @Delete(':id')
  softDelete(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.mails.softDelete(id, user);
  }
}
