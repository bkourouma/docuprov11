import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { MenuPermissionGuard } from '../auth/menu-permission.guard';
import { RequireMenu } from '../auth/require-menu.decorator';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { MailReferentialsService } from './mail-referentials.service';
import {
  createExternalEntitySchema,
  createInputationTypeSchema,
  createObjetSchema,
  labelSchema,
  setCustomValueSchema,
  updateExternalEntitySchema,
  updateInputationTypeSchema,
  updateObjetSchema,
  type CreateExternalEntityBody,
  type CreateInputationTypeBody,
  type CreateObjetBody,
  type LabelDto,
  type SetCustomValueBody,
  type UpdateExternalEntityBody,
  type UpdateInputationTypeBody,
  type UpdateObjetBody,
} from './mail-referentials.dto';

/**
 * Paramétrage Docu-Courriers (§14/§16/§17/§18/§19 + natures/objets/confidentialités). Lectures
 * ouvertes à tout utilisateur authentifié (lookups des formulaires) ; écritures gardées par le
 * menu de paramétrage correspondant.
 */
@UseGuards(MenuPermissionGuard)
@Controller('courriers/referentials')
export class MailReferentialsController {
  constructor(private readonly service: MailReferentialsService) {}

  // ---- Natures -------------------------------------------------------------
  @Get('natures')
  listNatures() {
    return this.service.listNatures();
  }

  @RequireMenu('/admin/courriers/natures')
  @Post('natures')
  createNature(@Body(new ZodValidationPipe(labelSchema)) body: LabelDto) {
    return this.service.createNature(body.label);
  }

  @RequireMenu('/admin/courriers/natures')
  @Patch('natures/:id')
  updateNature(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(labelSchema)) body: LabelDto,
  ) {
    return this.service.updateNature(id, body.label);
  }

  @RequireMenu('/admin/courriers/natures')
  @Delete('natures/:id')
  deactivateNature(@Param('id', ParseIntPipe) id: number) {
    return this.service.deactivateNature(id);
  }

  // ---- Objets --------------------------------------------------------------
  @Get('objets')
  listObjets() {
    return this.service.listObjets();
  }

  @RequireMenu('/admin/courriers/objets')
  @Post('objets')
  createObjet(@Body(new ZodValidationPipe(createObjetSchema)) body: CreateObjetBody) {
    return this.service.createObjet(body);
  }

  @RequireMenu('/admin/courriers/objets')
  @Patch('objets/:id')
  updateObjet(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(updateObjetSchema)) body: UpdateObjetBody,
  ) {
    return this.service.updateObjet(id, body);
  }

  @RequireMenu('/admin/courriers/objets')
  @Delete('objets/:id')
  deactivateObjet(@Param('id', ParseIntPipe) id: number) {
    return this.service.deactivateObjet(id);
  }

  // ---- Types d'imputation --------------------------------------------------
  @Get('inputation-types')
  listInputationTypes() {
    return this.service.listInputationTypes();
  }

  @RequireMenu('/admin/courriers/types-imputation')
  @Post('inputation-types')
  createInputationType(
    @Body(new ZodValidationPipe(createInputationTypeSchema)) body: CreateInputationTypeBody,
  ) {
    return this.service.createInputationType(body);
  }

  @RequireMenu('/admin/courriers/types-imputation')
  @Patch('inputation-types/:id')
  updateInputationType(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(updateInputationTypeSchema)) body: UpdateInputationTypeBody,
  ) {
    return this.service.updateInputationType(id, body);
  }

  @RequireMenu('/admin/courriers/types-imputation')
  @Delete('inputation-types/:id')
  deactivateInputationType(@Param('id', ParseIntPipe) id: number) {
    return this.service.deactivateInputationType(id);
  }

  // ---- Types de courrier départ (§19) --------------------------------------
  @Get('depart-types')
  listDepartTypes() {
    return this.service.listDepartTypes();
  }

  @RequireMenu('/admin/courriers/types-depart')
  @Post('depart-types')
  createDepartType(@Body(new ZodValidationPipe(labelSchema)) body: LabelDto) {
    return this.service.createDepartType(body.label);
  }

  @RequireMenu('/admin/courriers/types-depart')
  @Patch('depart-types/:id')
  updateDepartType(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(labelSchema)) body: LabelDto,
  ) {
    return this.service.updateDepartType(id, body.label);
  }

  @RequireMenu('/admin/courriers/types-depart')
  @Delete('depart-types/:id')
  deactivateDepartType(@Param('id', ParseIntPipe) id: number) {
    return this.service.deactivateDepartType(id);
  }

  // ---- Confidentialités ----------------------------------------------------
  @Get('confidentialites')
  listConfidentialites() {
    return this.service.listConfidentialites();
  }

  @RequireMenu('/admin/courriers/confidentialites')
  @Post('confidentialites')
  createConfidentialite(@Body(new ZodValidationPipe(labelSchema)) body: LabelDto) {
    return this.service.createConfidentialite(body.label);
  }

  @RequireMenu('/admin/courriers/confidentialites')
  @Patch('confidentialites/:id')
  updateConfidentialite(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(labelSchema)) body: LabelDto,
  ) {
    return this.service.updateConfidentialite(id, body.label);
  }

  @RequireMenu('/admin/courriers/confidentialites')
  @Delete('confidentialites/:id')
  deactivateConfidentialite(@Param('id', ParseIntPipe) id: number) {
    return this.service.deactivateConfidentialite(id);
  }

  // ---- Types d'entité externe (§16) ----------------------------------------
  // Deux points d'entrée, donc deux menus acceptés (OR) : l'écran dédié « Types d'entité externe »,
  // et le bouton « + » du champ Type de l'écran des entités externes. N'exiger que l'un des deux
  // condamnerait l'autre en 403.
  @Get('external-entity-types')
  listExternalEntityTypes() {
    return this.service.listExternalEntityTypes();
  }

  @RequireMenu('/admin/courriers/entites-externes', '/admin/courriers/types-entites-externes')
  @Post('external-entity-types')
  createExternalEntityType(@Body(new ZodValidationPipe(labelSchema)) body: LabelDto) {
    return this.service.createExternalEntityType(body.label);
  }

  @RequireMenu('/admin/courriers/entites-externes', '/admin/courriers/types-entites-externes')
  @Patch('external-entity-types/:id')
  updateExternalEntityType(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(labelSchema)) body: LabelDto,
  ) {
    return this.service.updateExternalEntityType(id, body.label);
  }

  @RequireMenu('/admin/courriers/entites-externes', '/admin/courriers/types-entites-externes')
  @Delete('external-entity-types/:id')
  deactivateExternalEntityType(@Param('id', ParseIntPipe) id: number) {
    return this.service.deactivateExternalEntityType(id);
  }

  // ---- Entités externes / correspondants (§17) -----------------------------
  @Get('external-entities')
  listExternalEntities() {
    return this.service.listExternalEntities();
  }

  @Get('external-entities/:id/custom-values')
  listCustomValues(@Param('id', ParseIntPipe) id: number) {
    return this.service.listCustomValues(id);
  }

  /**
   * Ouvert aussi à l'enregistrement (§05) : le bureau d'ordre découvre un correspondant en ouvrant
   * le courrier, il doit pouvoir le créer sans détour par l'écran d'administration. La modification
   * et la désactivation restent, elles, réservées à cet écran.
   */
  @RequireMenu('/admin/courriers/entites-externes', '/courriers/enregistrement')
  @Post('external-entities')
  createExternalEntity(
    @Body(new ZodValidationPipe(createExternalEntitySchema)) body: CreateExternalEntityBody,
  ) {
    return this.service.createExternalEntity(body);
  }

  @RequireMenu('/admin/courriers/entites-externes')
  @Patch('external-entities/:id')
  updateExternalEntity(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(updateExternalEntitySchema)) body: UpdateExternalEntityBody,
  ) {
    return this.service.updateExternalEntity(id, body);
  }

  @RequireMenu('/admin/courriers/entites-externes')
  @Delete('external-entities/:id')
  deactivateExternalEntity(@Param('id', ParseIntPipe) id: number) {
    return this.service.deactivateExternalEntity(id);
  }

  // ---- Propriétés personnalisées (EAV) -------------------------------------
  @Get('custom-properties')
  listCustomProperties() {
    return this.service.listCustomProperties();
  }

  @RequireMenu('/admin/courriers/entites-externes')
  @Post('custom-properties')
  createCustomProperty(@Body(new ZodValidationPipe(labelSchema)) body: LabelDto) {
    return this.service.createCustomProperty(body.label);
  }

  @RequireMenu('/admin/courriers/entites-externes')
  @Delete('custom-properties/:id')
  deactivateCustomProperty(@Param('id', ParseIntPipe) id: number) {
    return this.service.deactivateCustomProperty(id);
  }

  @RequireMenu('/admin/courriers/entites-externes')
  @Post('custom-values')
  setCustomValue(@Body(new ZodValidationPipe(setCustomValueSchema)) body: SetCustomValueBody) {
    return this.service.setCustomValue(body);
  }
}
