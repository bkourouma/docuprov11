import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { exportRows } from '@archivage/exports';
import { DiskFileStore } from '@archivage/storage';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { CurrentUser } from '../auth/current-user.decorator';
import { AdminGuard } from '../auth/admin.guard';
import { MenuPermissionGuard } from '../auth/menu-permission.guard';
import { RequireMenu } from '../auth/require-menu.decorator';
import { ARCHIVES_MENUS } from '../archives/archives.menus';
import type { AuthUser } from '../auth/auth.types';
import { SearchService } from '../search/search.service';
import { DocumentsService } from './documents.service';
import { DocumentTabsService } from './document-tabs.service';
import { SealingKeyService } from './sealing-key.service';
import {
  documentConfidentialiteSchema,
  documentLifeCycleSchema,
  documentPermissionSchema,
  indexationSchema,
  type DocumentConfidentialiteDto,
  type DocumentLifeCycleDto,
  type DocumentPermissionDto,
  type IndexationDto,
} from './documents.dto';
import { exportSchema, searchSchema, type ExportDto, type SearchDto } from '../search/search.dto';

const EXPORT_COLUMNS = [
  { key: 'label', header: 'Libellé' },
  { key: 'documentType', header: 'Type de document' },
  { key: 'cote', header: 'N° pièce' },
  { key: 'documentDate', header: 'Date document' },
  { key: 'dossier', header: 'Dossier' },
  { key: 'plan', header: 'Plan de classement' },
  { key: 'location', header: 'Localisation' },
];

@Controller('documents')
export class DocumentsController {
  constructor(
    private readonly search: SearchService,
    private readonly documents: DocumentsService,
    private readonly tabs: DocumentTabsService,
    private readonly sealingKey: SealingKeyService,
    private readonly config: ConfigService,
  ) {}

  @Post('search')
  @HttpCode(200)
  searchDocuments(
    @Body(new ZodValidationPipe(searchSchema)) body: SearchDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.search.search(body, user);
  }

  @Post('export')
  @HttpCode(200)
  async export(
    @Body(new ZodValidationPipe(exportSchema)) body: ExportDto,
    @CurrentUser() user: AuthUser,
  ): Promise<StreamableFile> {
    const rows = await this.search.searchAll(body, user);
    const { buffer, contentType, filename } = await exportRows(body.format, {
      title: 'Documents',
      columns: EXPORT_COLUMNS,
      rows: rows as unknown as Array<Record<string, unknown>>,
    });
    return new StreamableFile(buffer, {
      type: contentType,
      disposition: `attachment; filename="${filename}"`,
    });
  }

  /** Contrôle des doublons de numéro de pièce avant validation d'un lot (renvoie les cotes en doublon). */
  @Post('cotes/check')
  @HttpCode(200)
  checkCotes(@Body() body: { cotes?: string[]; excludeBatchId?: number }) {
    return this.documents.findDuplicateCotes(body?.cotes ?? [], body?.excludeBatchId);
  }

  /**
   * Indexation, et scellement automatique quand elle VALIDE le document (2026-09-15).
   *
   * Le scellement est déclenché ici et non dans `DocumentsService` : c'est `DocumentTabsService`
   * qui porte le cachet, et il dépend déjà de `DocumentsService` pour le niveau effectif — les
   * faire s'appeler l'un l'autre créerait un cycle. Le contrôleur, qui a les deux sous la main,
   * est le point de couture naturel.
   *
   * `sealIfNeeded` ne re-signe pas un document déjà attesté tel qu'il est, et ne lève jamais : une
   * indexation validée avec succès ne doit pas être annulée parce que le cachet a échoué.
   */
  @Patch(':id/indexation')
  async indexation(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(indexationSchema)) body: IndexationDto,
    @CurrentUser() user: AuthUser,
  ) {
    const res = await this.documents.indexDocument(id, body, user);
    if (body.validate) {
      await this.tabs.sealIfNeeded(id, await this.sealingKey.get(), user);
    }
    return res;
  }

  @Get(':id')
  getOne(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.documents.getDetail(id, user);
  }

  // ---- Onglets de consultation (`/documents/:id`) --------------------------

  @Get(':id/life-cycle')
  lifeCycle(@Param('id', ParseIntPipe) id: number) {
    return this.tabs.getLifeCycle(id);
  }

  @Put(':id/life-cycle')
  saveLifeCycle(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(documentLifeCycleSchema)) body: DocumentLifeCycleDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.tabs.saveLifeCycle(id, body, user);
  }

  @Get(':id/permissions')
  permissions(@Param('id', ParseIntPipe) id: number) {
    return this.tabs.listPermissions(id);
  }

  /**
   * Octroi d'un droit sur CE document, sans condition d'autorisation.
   *
   * L'exigence du niveau 4 « Administration » (introduite le 2026-08-04) a été levée le 2026-08-05,
   * en même temps que les gardes des droits par type (`referentials.controller.ts`) : la décision du
   * propriétaire du produit est que l'accès à l'écran suffit. Tout utilisateur pouvant ouvrir la
   * fiche peut donc gérer ses accès. `DocumentTabsService.grantPermission` reste, elle, partagée
   * avec `AccessInquiriesService.decide`, qui a sa propre autorisation (menu « Sécurité
   * Documentaire ») — l'ouvrir ici ne change rien de ce côté.
   */
  @Post(':id/permissions')
  grantPermission(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(documentPermissionSchema)) body: DocumentPermissionDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.tabs.grantPermission(id, body, user);
  }

  /** Retrait d'un droit sur CE document — même ouverture que l'octroi ci-dessus. */
  @Delete(':id/permissions/:permissionId')
  revokePermission(
    @Param('id', ParseIntPipe) id: number,
    @Param('permissionId', ParseIntPipe) permissionId: number,
  ) {
    return this.tabs.revokePermission(id, permissionId);
  }

  @Get(':id/confidentialite')
  confidentialite(@Param('id', ParseIntPipe) id: number) {
    return this.tabs.getConfidentialite(id);
  }

  @Put(':id/confidentialite')
  setConfidentialite(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(documentConfidentialiteSchema)) body: DocumentConfidentialiteDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.tabs.setConfidentialite(id, body.confidentialiteId, user);
  }

  @Get(':id/lendings')
  lendings(@Param('id', ParseIntPipe) id: number) {
    return this.tabs.listLendings(id);
  }

  // ---------------------------------------------------------------------------
  // Écran « Intégrité du fonds » — contrôle en lot
  //
  // Autorisées par le MENU (règle maison « accès au menu ⟹ accès aux données »), pas par le
  // niveau effectif sur chaque pièce : contrôler le fonds est une responsabilité d'archiviste
  // sur l'ensemble, un droit nominatif document par document n'aurait aucun sens ici.
  // Déclarées avant les routes « :id/… » : aucune ne peut les capturer (le nombre de segments
  // diffère), mais les garder groupées en tête évite qu'un futur « :id/x/y » s'intercale.
  // ---------------------------------------------------------------------------

  /** Couverture du fonds : combien de documents sont mesurables, mesurés, conformes, scellés. */
  @Get('integrity/coverage')
  @UseGuards(MenuPermissionGuard)
  @RequireMenu(ARCHIVES_MENUS.integrity)
  integrityCoverage() {
    return this.tabs.integrityCoverage();
  }

  /** Documents actuellement en échec d'intégrité. */
  @Get('integrity/non-compliant')
  @UseGuards(MenuPermissionGuard)
  @RequireMenu(ARCHIVES_MENUS.integrity)
  integrityNonCompliant() {
    return this.tabs.listNonCompliant();
  }

  /**
   * Balaie une tranche du fonds (jamais vérifiés d'abord, puis les plus anciens).
   * `limit` est borné à 500 : au-delà, la requête HTTP resterait ouverte trop longtemps — on
   * relance le balayage, qui reprend tout seul là où il s'est arrêté.
   */
  @Post('integrity/sweep')
  @HttpCode(200)
  @UseGuards(MenuPermissionGuard)
  @RequireMenu(ARCHIVES_MENUS.integrity)
  sweepIntegrity(@CurrentUser() user: AuthUser, @Body() body: { limit?: number }) {
    const limit = Math.min(Math.max(Number(body?.limit) || 50, 1), 500);
    const store = new DiskFileStore(this.config.getOrThrow<string>('ARCHIVES_PATH'));
    return this.tabs.sweepIntegrity(store, user, limit);
  }

  /**
   * Scelle une tranche des documents jamais scellés — rattrapage du fonds antérieur au scellement
   * automatique. Même autorisation et même plafond que le balayage d'intégrité.
   */
  @Post('integrity/seal-fonds')
  @HttpCode(200)
  @UseGuards(MenuPermissionGuard)
  @RequireMenu(ARCHIVES_MENUS.integrity)
  async sealFonds(@CurrentUser() user: AuthUser, @Body() body: { limit?: number }) {
    const limit = Math.min(Math.max(Number(body?.limit) || 50, 1), 500);
    return this.tabs.sealFonds(await this.sealingKey.get(), user, limit);
  }

  /** État d'intégrité connu — lecture seule, sans relire les binaires du coffre. */
  @Get(':id/integrity')
  integrity(@Param('id', ParseIntPipe) id: number) {
    return this.tabs.getIntegrity(id);
  }

  /**
   * Vérification effective : relit chaque binaire, recalcule et compare son empreinte.
   * Niveau Modification (3) exigé par le service — elle écrit un verdict, et pose l'empreinte de
   * référence au premier passage.
   */
  @Post(':id/integrity/verify')
  @HttpCode(200)
  verifyIntegrity(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    const store = new DiskFileStore(this.config.getOrThrow<string>('ARCHIVES_PATH'));
    return this.tabs.verifyIntegrity(id, store, user);
  }

  /** État du cachet (signature + horodatage) — vérifié à la lecture, sans relire les binaires. */
  @Get(':id/seal')
  async seal(@Param('id', ParseIntPipe) id: number) {
    return this.tabs.verifySeal(id, await this.sealingKey.get());
  }

  /** Appose (ou renouvelle) le cachet serveur. Niveau Archivistique (5) exigé par le service. */
  @Post(':id/seal')
  @HttpCode(200)
  async applySeal(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.tabs.sealDocument(id, await this.sealingKey.get(), user);
  }

  /** Clé publique de l'installation — permet de vérifier un cachet HORS de l'application. */
  @Get('sealing/public-key')
  async sealingPublicKey() {
    const { fingerprint } = await this.sealingKey.get();
    return { algorithm: 'Ed25519', fingerprint, publicKeyPem: await this.sealingKey.publicKeyPem() };
  }

  /** Consigne de numérisation du type + numérisation réellement effectuée pour ce document. */
  @Get(':id/scanning')
  scanning(@Param('id', ParseIntPipe) id: number) {
    return this.tabs.getScanningSettings(id);
  }

  @Get(':id/history')
  history(@Param('id', ParseIntPipe) id: number) {
    return this.tabs.listHistory(id);
  }

  /** Suppression définitive d'un document (base + binaire disque). Réservé aux administrateurs. */
  @Delete(':id')
  @UseGuards(AdminGuard)
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.documents.deleteDocument(id, user);
  }

  @Get(':id/files/:fileId/content')
  async content(
    @Param('id', ParseIntPipe) id: number,
    @Param('fileId', ParseIntPipe) fileId: number,
    @CurrentUser() user: AuthUser,
  ): Promise<StreamableFile> {
    const file = await this.documents.getFileForDownload(id, fileId, user);
    const store = new DiskFileStore(this.config.getOrThrow<string>('ARCHIVES_PATH'));
    // base⇄disque consistency guard: the row exists but the binary may be missing. Fail with a
    // clean 404 (before the 200 stream headers) instead of letting createReadStream break mid-stream.
    if (!(await store.exists(file.fileId, file.fileExtension))) {
      throw new NotFoundException('Fichier introuvable sur le coffre disque');
    }
    const stream = store.createReadStream(file.fileId, file.fileExtension);
    const name = file.originalName ?? `${file.fileId}${file.fileExtension}`;
    // HTTP headers are Latin-1: keep an ASCII-only fallback for `filename=` and carry the
    // real (UTF-8) name — accents, en-dashes from auto-labels, etc. — via RFC 6266 `filename*`.
    const asciiName = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '');
    return new StreamableFile(stream, {
      type: 'application/pdf',
      disposition: `inline; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    });
  }
}
