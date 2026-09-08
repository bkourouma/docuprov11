import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import type { ExportFormat } from '@archivage/exports';
import { MenuPermissionGuard } from '../auth/menu-permission.guard';
import { RequireAdmin, RequireMenu } from '../auth/require-menu.decorator';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { ReferentialsService } from './referentials.service';
import { SECURITY_MENUS } from '../access-inquiries/security.menus';
import {
  createConfidentialiteSchema,
  createDocumentTypeSchema,
  createDossierSchema,
  createFileTypeSchema,
  createLocationSchema,
  createPlanSchema,
  grantDocumentPermissionSchema,
  grantTypePermissionSchema,
  reparentSchema,
  updateConfidentialiteSchema,
  updateDocumentTypeSchema,
  updateDossierSchema,
  updateLocationSchema,
  updatePlanSchema,
  type CreateConfidentialiteDto,
  type CreateDocumentTypeDto,
  type CreateDossierDto,
  type CreateFileTypeDto,
  type CreateLocationDto,
  type CreatePlanDto,
  type GrantDocumentPermissionDto,
  type GrantTypePermissionDto,
  type ReparentDto,
  type UpdateConfidentialiteDto,
  type UpdateDocumentTypeDto,
  type UpdateDossierDto,
  type UpdateLocationDto,
  type UpdatePlanDto,
} from './referentials.dto';

/** Whitelist the export format from the query string; anything else falls back to Excel. */
function exportFormat(format?: string): ExportFormat {
  return format === 'pdf' ? 'pdf' : 'xlsx';
}

// Lectures (GET) ouvertes à tout utilisateur authentifié (référentiels partagés par l'acquisition
// et la recherche). Les écritures sont réservées au menu de paramétrage correspondant (ou admin).
@UseGuards(MenuPermissionGuard)
@Controller('referentials')
export class ReferentialsController {
  constructor(private readonly service: ReferentialsService) {}

  @Get('document-types')
  listDocumentTypes() {
    return this.service.listDocumentTypes();
  }

  @Get('document-types/export')
  async exportDocumentTypes(@Query('format') format?: string): Promise<StreamableFile> {
    const { buffer, contentType, filename } = await this.service.exportDocumentTypes(exportFormat(format));
    return new StreamableFile(buffer, {
      type: contentType,
      disposition: `attachment; filename="${filename}"`,
    });
  }

  @RequireMenu('/admin/document-types')
  @Post('document-types')
  createDocumentType(@Body(new ZodValidationPipe(createDocumentTypeSchema)) body: CreateDocumentTypeDto) {
    return this.service.createDocumentType(body);
  }

  @RequireMenu('/admin/document-types')
  @Patch('document-types/:id')
  updateDocumentType(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(updateDocumentTypeSchema)) body: UpdateDocumentTypeDto,
  ) {
    return this.service.updateDocumentType(id, body);
  }

  @RequireMenu('/admin/document-types')
  @Delete('document-types/:id')
  deactivateDocumentType(@Param('id', ParseIntPipe) id: number) {
    return this.service.deactivateDocumentType(id);
  }

  @Get('file-types')
  listFileTypes() {
    return this.service.listFileTypes();
  }

  @Get('authors')
  listAuthors() {
    return this.service.listAuthors();
  }

  /** Niveaux de permission (Consultation → Prêts/Communication) — lookup des écrans d'accès. */
  @Get('permission-levels')
  listPermissionLevels() {
    return this.service.listPermissionLevels();
  }

  /** Niveaux de confidentialité, du plus ouvert au plus restreint (ordre = `rank`). */
  @Get('confidentialites')
  listConfidentialites() {
    return this.service.listConfidentialites();
  }

  @RequireAdmin()
  @Post('file-types')
  createFileType(@Body(new ZodValidationPipe(createFileTypeSchema)) body: CreateFileTypeDto) {
    return this.service.createFileType(body);
  }

  @Get('plans')
  listPlans() {
    return this.service.listPlans();
  }

  @Get('plans/export')
  async exportPlans(@Query('format') format?: string): Promise<StreamableFile> {
    const { buffer, contentType, filename } = await this.service.exportPlans(exportFormat(format));
    return new StreamableFile(buffer, {
      type: contentType,
      disposition: `attachment; filename="${filename}"`,
    });
  }

  @RequireMenu('/admin/classification-plans')
  @Post('plans')
  createPlan(@Body(new ZodValidationPipe(createPlanSchema)) body: CreatePlanDto) {
    return this.service.createPlan(body);
  }

  @RequireMenu('/admin/classification-plans')
  @Patch('plans/:id')
  updatePlan(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(updatePlanSchema)) body: UpdatePlanDto,
  ) {
    return this.service.updatePlan(id, body);
  }

  @RequireMenu('/admin/classification-plans')
  @Delete('plans/:id')
  deactivatePlan(@Param('id', ParseIntPipe) id: number) {
    return this.service.deactivatePlan(id);
  }

  @Get('locations')
  listLocations() {
    return this.service.listLocations();
  }

  @Get('locations/export')
  async exportLocations(@Query('format') format?: string): Promise<StreamableFile> {
    const { buffer, contentType, filename } = await this.service.exportLocations(exportFormat(format));
    return new StreamableFile(buffer, {
      type: contentType,
      disposition: `attachment; filename="${filename}"`,
    });
  }

  @RequireMenu('/admin/geolocalisation')
  @Post('locations')
  createLocation(@Body(new ZodValidationPipe(createLocationSchema)) body: CreateLocationDto) {
    return this.service.createLocation(body);
  }

  @RequireMenu('/admin/geolocalisation')
  @Patch('locations/:id')
  updateLocation(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(updateLocationSchema)) body: UpdateLocationDto,
  ) {
    return this.service.updateLocation(id, body);
  }

  @RequireMenu('/admin/geolocalisation')
  @Delete('locations/:id')
  deactivateLocation(@Param('id', ParseIntPipe) id: number) {
    return this.service.deactivateLocation(id);
  }

  // Les routes « dossier-categories » ont disparu avec la table : un dossier n'a plus de
  // catégorie (migration 20260731160000_drop_dossier_location_category).

  @Get('dossiers')
  listDossiers() {
    return this.service.listDossiers();
  }

  @Get('dossiers/export')
  async exportDossiers(@Query('format') format?: string): Promise<StreamableFile> {
    const { buffer, contentType, filename } = await this.service.exportDossiers(exportFormat(format));
    return new StreamableFile(buffer, {
      type: contentType,
      disposition: `attachment; filename="${filename}"`,
    });
  }

  @RequireMenu('/admin/dossiers')
  @Post('dossiers')
  createDossier(@Body(new ZodValidationPipe(createDossierSchema)) body: CreateDossierDto) {
    return this.service.createDossier(body);
  }

  @RequireMenu('/admin/dossiers')
  @Patch('dossiers/:id')
  updateDossier(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(updateDossierSchema)) body: UpdateDossierDto,
  ) {
    return this.service.updateDossier(id, body);
  }

  @RequireMenu('/admin/dossiers')
  @Delete('dossiers/:id')
  deactivateDossier(@Param('id', ParseIntPipe) id: number) {
    return this.service.deactivateDossier(id);
  }

  @RequireMenu('/admin/dossiers')
  @Patch('dossiers/:id/parent')
  reparentDossier(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(reparentSchema)) body: ReparentDto,
  ) {
    return this.service.reparentDossier(id, body.parentId);
  }

  /**
   * Octroi d'un droit sur UN document — ouvert comme les droits par type (voir le `DELETE` plus
   * bas). Attention : ce n'est PAS ce qu'appelle l'onglet « Accès » d'une fiche document, qui passe
   * par `POST documents/:id/permissions` et son propre garde-fou (niveau 4 « Administration »).
   */
  @Post('document-permissions')
  grantDocumentPermission(
    @Body(new ZodValidationPipe(grantDocumentPermissionSchema)) body: GrantDocumentPermissionDto,
  ) {
    return this.service.grantDocumentPermission(body);
  }

  /**
   * Octroi d'un droit par type — SANS décorateur, comme le `DELETE` plus bas : l'écran de gestion
   * (« Sécurité type document par utilisateur / par profil ») est le seul filtre. Voir le commentaire
   * du retrait pour la décision et sa portée. Ne pas confondre avec `POST document-permissions`
   * juste au-dessus, qui porte sur UN document et reste, lui, réservé aux administrateurs.
   */
  @Post('document-type-permissions')
  grantTypePermission(
    @Body(new ZodValidationPipe(grantTypePermissionSchema)) body: GrantTypePermissionDto,
  ) {
    return this.service.grantTypePermission(body);
  }

  /** Sécurité Documentaire — droits par TYPE, lecture partagée par les 3 écrans « par utilisateur »/« par rôle »/« par classification ». */
  @Get('document-type-permissions')
  listTypePermissions() {
    return this.service.listTypePermissions();
  }

  /**
   * Retrait d'un droit par type — délibérément SANS décorateur : tout utilisateur authentifié peut
   * retirer une ligne, comme il peut déjà toutes les lire (le `GET` ci-dessus n'est pas gardé non
   * plus). L'accès à l'écran fait seul office de filtre, côté barre latérale. Décision du
   * propriétaire du produit (2026-08-05), après deux refus successifs : `@RequireAdmin()` puis
   * `@RequireMenu(typeSecurityByUser, typeSecurityByRole)`. L'octroi (`POST`) a été ouvert de
   * la même façon, pour que l'écran soit cohérent de bout en bout.
   */
  @Delete('document-type-permissions/:id')
  revokeTypePermission(@Param('id', ParseIntPipe) id: number) {
    return this.service.revokeTypePermission(id);
  }

  /** Plans de classement ayant au moins un type rattaché — lookup de « Sécurité par classification ». */
  @Get('plans-with-document-types')
  listPlansWithDocumentTypes() {
    return this.service.listPlansWithDocumentTypes();
  }

  @RequireMenu(SECURITY_MENUS.confidentialites)
  @Post('confidentialites')
  createConfidentialite(
    @Body(new ZodValidationPipe(createConfidentialiteSchema)) body: CreateConfidentialiteDto,
  ) {
    return this.service.createConfidentialite(body);
  }

  @RequireMenu(SECURITY_MENUS.confidentialites)
  @Patch('confidentialites/:id')
  updateConfidentialite(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(updateConfidentialiteSchema)) body: UpdateConfidentialiteDto,
  ) {
    return this.service.updateConfidentialite(id, body);
  }

  @RequireMenu(SECURITY_MENUS.confidentialites)
  @Delete('confidentialites/:id')
  deactivateConfidentialite(@Param('id', ParseIntPipe) id: number) {
    return this.service.deactivateConfidentialite(id);
  }
}
