import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { MenuPermissionGuard } from '../auth/menu-permission.guard';
import { RequireMenu } from '../auth/require-menu.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../auth/auth.types';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { ArchivesSettingsService } from './archives-settings.service';
import { ARCHIVES_MENUS } from './archives.menus';
import {
  createMetaDataListItemsSchema,
  createMetaDatasSchema,
  documentLifeCycleSchema,
  documentTypeLifeCycleSchema,
  documentTypeSettingSchema,
  idsSchema,
  linkMetaDataDocumentTypesSchema,
  refLabelSchema,
  refLabelsSchema,
  setMetaDatasForTypeSchema,
  updateMetaDataListItemSchema,
  updateMetaDataSchema,
  type CreateMetaDataListItemsDto,
  type CreateMetaDatasDto,
  type DocumentLifeCycleDto,
  type DocumentTypeLifeCycleDto,
  type DocumentTypeSettingDto,
  type IdsDto,
  type LinkMetaDataDocumentTypesDto,
  type RefLabelDto,
  type RefLabelsDto,
  type SetMetaDatasForTypeDto,
  type UpdateMetaDataDto,
  type UpdateMetaDataListItemDto,
} from './archives.dto';

/**
 * Menu « Paramétrage Docu-Archives ».
 *
 * Comme pour `ReferentialsController`, les LECTURES sont ouvertes à tout utilisateur authentifié :
 * ce sont des lookups de formulaire (l'écran d'indexation a besoin des métadonnées d'un type, la
 * communication de documents a besoin des motifs de prêt). Les ÉCRITURES exigent le menu de
 * paramétrage correspondant — ou le statut d'administrateur.
 */
@UseGuards(MenuPermissionGuard)
@Controller('archives/settings')
export class ArchivesSettingsController {
  constructor(private readonly service: ArchivesSettingsService) {}

  // ---- §4 Modes de destruction -------------------------------------------

  @Get('destruction-modes')
  listDestructionModes() {
    return this.service.listDestructionModes();
  }

  @RequireMenu(ARCHIVES_MENUS.destructionModes)
  @Post('destruction-modes')
  createDestructionModes(@Body(new ZodValidationPipe(refLabelsSchema)) body: RefLabelsDto) {
    return this.service.createDestructionModes(body.labels);
  }

  @RequireMenu(ARCHIVES_MENUS.destructionModes)
  @Patch('destruction-modes/:id')
  updateDestructionMode(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(refLabelSchema)) body: RefLabelDto,
  ) {
    return this.service.updateDestructionMode(id, body.label);
  }

  @RequireMenu(ARCHIVES_MENUS.destructionModes)
  @Delete('destruction-modes')
  deactivateDestructionModes(@Body(new ZodValidationPipe(idsSchema)) body: IdsDto) {
    return this.service.deactivateDestructionModes(body.ids);
  }

  // ---- §5 Sorts finaux ----------------------------------------------------

  @Get('final-fates')
  listFinalFates() {
    return this.service.listFinalFates();
  }

  @RequireMenu(ARCHIVES_MENUS.finalFates)
  @Post('final-fates')
  createFinalFates(@Body(new ZodValidationPipe(refLabelsSchema)) body: RefLabelsDto) {
    return this.service.createFinalFates(body.labels);
  }

  @RequireMenu(ARCHIVES_MENUS.finalFates)
  @Patch('final-fates/:id')
  updateFinalFate(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(refLabelSchema)) body: RefLabelDto,
  ) {
    return this.service.updateFinalFate(id, body.label);
  }

  @RequireMenu(ARCHIVES_MENUS.finalFates)
  @Delete('final-fates')
  deactivateFinalFates(@Body(new ZodValidationPipe(idsSchema)) body: IdsDto) {
    return this.service.deactivateFinalFates(body.ids);
  }

  // ---- §6 Motifs de prêt --------------------------------------------------

  @Get('lending-motives')
  listLendingMotives() {
    return this.service.listLendingMotives();
  }

  @RequireMenu(ARCHIVES_MENUS.lendingMotives)
  @Post('lending-motives')
  createLendingMotives(@Body(new ZodValidationPipe(refLabelsSchema)) body: RefLabelsDto) {
    return this.service.createLendingMotives(body.labels);
  }

  @RequireMenu(ARCHIVES_MENUS.lendingMotives)
  @Patch('lending-motives/:id')
  updateLendingMotive(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(refLabelSchema)) body: RefLabelDto,
  ) {
    return this.service.updateLendingMotive(id, body.label);
  }

  @RequireMenu(ARCHIVES_MENUS.lendingMotives)
  @Delete('lending-motives')
  deactivateLendingMotives(@Body(new ZodValidationPipe(idsSchema)) body: IdsDto) {
    return this.service.deactivateLendingMotives(body.ids);
  }

  // ---- §1 Paramétrage des types de documents ------------------------------

  @Get('document-types')
  listDocumentTypeSettings() {
    return this.service.listDocumentTypeSettings();
  }

  /** Défauts d'archivage d'un type — consommé par le formulaire d'indexation. */
  @Get('document-types/:documentTypeId/defaults')
  getDefaults(@Param('documentTypeId', ParseIntPipe) documentTypeId: number) {
    return this.service.getDefaultsForDocumentType(documentTypeId);
  }

  @RequireMenu(ARCHIVES_MENUS.documentTypeSettings)
  @Put('document-types')
  saveDocumentTypeSetting(
    @Body(new ZodValidationPipe(documentTypeSettingSchema)) body: DocumentTypeSettingDto,
  ) {
    return this.service.saveDocumentTypeSetting(body);
  }

  @RequireMenu(ARCHIVES_MENUS.documentTypeSettings)
  @Delete('document-types')
  deleteDocumentTypeSettings(@Body(new ZodValidationPipe(idsSchema)) body: IdsDto) {
    return this.service.deleteDocumentTypeSettings(body.ids);
  }

  // ---- §3 Cycles de vie ---------------------------------------------------

  @Get('life-cycles')
  listDocumentTypeLifeCycles() {
    return this.service.listDocumentTypeLifeCycles();
  }

  @RequireMenu(ARCHIVES_MENUS.lifeCycles)
  @Put('life-cycles')
  saveDocumentTypeLifeCycle(
    @Body(new ZodValidationPipe(documentTypeLifeCycleSchema)) body: DocumentTypeLifeCycleDto,
  ) {
    return this.service.saveDocumentTypeLifeCycle(body);
  }

  @RequireMenu(ARCHIVES_MENUS.lifeCycles)
  @Delete('life-cycles')
  deleteDocumentTypeLifeCycles(@Body(new ZodValidationPipe(idsSchema)) body: IdsDto) {
    return this.service.deleteDocumentTypeLifeCycles(body.ids);
  }

  /**
   * Cycle de vie d'UN document (dérogation à la règle de son type). Saisi depuis la visionneuse :
   * la permission demandée est donc celle de l'écran « DUA Expirés », qui pilote l'épuration.
   */
  @Get('document-life-cycles/:documentId')
  getDocumentLifeCycle(@Param('documentId', ParseIntPipe) documentId: number) {
    return this.service.getDocumentLifeCycle(documentId);
  }

  @RequireMenu(ARCHIVES_MENUS.lifeCycles, ARCHIVES_MENUS.duaExpired)
  @Put('document-life-cycles')
  saveDocumentLifeCycle(
    @Body(new ZodValidationPipe(documentLifeCycleSchema)) body: DocumentLifeCycleDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.saveDocumentLifeCycle(body, user.userGroupId);
  }

  // ---- §8 Métadonnées -----------------------------------------------------

  @Get('metadatas')
  listMetaDatas() {
    return this.service.listMetaDatas();
  }

  @RequireMenu(ARCHIVES_MENUS.metaDatas)
  @Post('metadatas')
  createMetaDatas(@Body(new ZodValidationPipe(createMetaDatasSchema)) body: CreateMetaDatasDto) {
    return this.service.createMetaDatas(body);
  }

  @RequireMenu(ARCHIVES_MENUS.metaDatas)
  @Patch('metadatas/:id')
  updateMetaData(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(updateMetaDataSchema)) body: UpdateMetaDataDto,
  ) {
    return this.service.updateMetaData(id, body);
  }

  @RequireMenu(ARCHIVES_MENUS.metaDatas)
  @Delete('metadatas')
  deactivateMetaDatas(@Body(new ZodValidationPipe(idsSchema)) body: IdsDto) {
    return this.service.deactivateMetaDatas(body.ids);
  }

  // ---- §9 Éléments des listes ---------------------------------------------

  @Get('metadata-list-items')
  listMetaDataListItems(@Query('metaDataId') metaDataId?: string) {
    const id = metaDataId ? Number(metaDataId) : undefined;
    return this.service.listMetaDataListItems(Number.isFinite(id) ? id : undefined);
  }

  @RequireMenu(ARCHIVES_MENUS.metaDataListItems)
  @Post('metadata-list-items')
  createMetaDataListItems(
    @Body(new ZodValidationPipe(createMetaDataListItemsSchema)) body: CreateMetaDataListItemsDto,
  ) {
    return this.service.createMetaDataListItems(body);
  }

  @RequireMenu(ARCHIVES_MENUS.metaDataListItems)
  @Patch('metadata-list-items/:id')
  updateMetaDataListItem(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(updateMetaDataListItemSchema)) body: UpdateMetaDataListItemDto,
  ) {
    return this.service.updateMetaDataListItem(id, body);
  }

  @RequireMenu(ARCHIVES_MENUS.metaDataListItems)
  @Delete('metadata-list-items')
  deactivateMetaDataListItems(@Body(new ZodValidationPipe(idsSchema)) body: IdsDto) {
    return this.service.deactivateMetaDataListItems(body.ids);
  }

  // ---- §7 Métadonnées par type de document --------------------------------

  @Get('metadata-document-types')
  listMetaDataDocumentTypes() {
    return this.service.listMetaDataDocumentTypes();
  }

  @Get('metadata-document-types/summary')
  summaryByDocumentType() {
    return this.service.summaryByDocumentType();
  }

  /** Champs du formulaire dynamique d'indexation pour un type (usage aval du §7). */
  @Get('metadata-document-types/:documentTypeId/fields')
  formFields(@Param('documentTypeId', ParseIntPipe) documentTypeId: number) {
    return this.service.formFieldsForDocumentType(documentTypeId);
  }

  @RequireMenu(ARCHIVES_MENUS.metaDataDocumentTypes)
  @Post('metadata-document-types')
  link(
    @Body(new ZodValidationPipe(linkMetaDataDocumentTypesSchema)) body: LinkMetaDataDocumentTypesDto,
  ) {
    return this.service.linkMetaDataDocumentTypes(body);
  }

  @RequireMenu(ARCHIVES_MENUS.metaDataDocumentTypes)
  @Put('metadata-document-types')
  setForType(@Body(new ZodValidationPipe(setMetaDatasForTypeSchema)) body: SetMetaDatasForTypeDto) {
    return this.service.setMetaDatasForType(body);
  }

  @RequireMenu(ARCHIVES_MENUS.metaDataDocumentTypes)
  @Delete('metadata-document-types')
  unlink(@Body(new ZodValidationPipe(idsSchema)) body: IdsDto) {
    return this.service.unlinkMetaDataDocumentTypes(body.ids);
  }
}
