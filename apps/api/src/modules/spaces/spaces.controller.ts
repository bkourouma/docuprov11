import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { CurrentUser } from '../auth/current-user.decorator';
import { MenuPermissionGuard } from '../auth/menu-permission.guard';
import { RequireMenu } from '../auth/require-menu.decorator';
import type { AuthUser } from '../auth/auth.types';
import { SpacesService } from './spaces.service';
import { SPACES_MENU } from './spaces.menus';
import {
  addMemberSchema,
  attachDocumentSchema,
  createSpaceSchema,
  listDocumentsQuerySchema,
  publishSpaceSchema,
  updateMemberSchema,
  updateSpaceSchema,
  type AddMemberDto,
  type AttachDocumentDto,
  type CreateSpaceDto,
  type ListDocumentsQueryDto,
  type PublishSpaceDto,
  type UpdateMemberDto,
  type UpdateSpaceDto,
} from './spaces.dto';

/**
 * Espaces GED (menu « Espaces »).
 *
 * Deux barrières successives :
 *  1. `MenuPermissionGuard` + `@RequireMenu(SPACES_MENU)` : accès à l'écran (RBAC de menu), sur
 *     TOUTES les routes — y compris la lecture d'une publication par slug, qui reste donc réservée
 *     aux utilisateurs authentifiés ayant le menu (le garde JWT global refuse déjà l'anonyme) ;
 *  2. `SpacesService` : droit sur CHAQUE espace (propriétaire / membre / publication), refus par
 *     défaut, 404 si l'espace n'est pas visible, 403 si le droit requis manque.
 *
 * Les routes littérales (`member-candidates`, `published/:slug`) sont déclarées AVANT `:id`.
 */
@UseGuards(MenuPermissionGuard)
@RequireMenu(SPACES_MENU)
@Controller('spaces')
export class SpacesController {
  constructor(private readonly spaces: SpacesService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.spaces.list(user);
  }

  @Post()
  create(
    @Body(new ZodValidationPipe(createSpaceSchema)) body: CreateSpaceDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.spaces.create(body, user);
  }

  @Get('member-candidates')
  /** Réservé au propriétaire/gestionnaire d'au moins un espace partagé (403 sinon, cf. service). */
  memberCandidates(@CurrentUser() user: AuthUser) {
    return this.spaces.memberCandidates(user);
  }

  @Get('published/:slug')
  getPublished(@Param('slug') slug: string, @CurrentUser() user: AuthUser) {
    return this.spaces.getPublished(slug, user);
  }

  @Get(':id')
  getDetail(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.spaces.getDetail(id, user);
  }

  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(updateSpaceSchema)) body: UpdateSpaceDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.spaces.update(id, body, user);
  }

  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.spaces.remove(id, user);
  }

  // ---- Membres ------------------------------------------------------------

  @Get(':id/members')
  listMembers(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.spaces.listMembers(id, user);
  }

  @Post(':id/members')
  addMember(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(addMemberSchema)) body: AddMemberDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.spaces.addMember(id, body, user);
  }

  @Patch(':id/members/:memberId')
  updateMember(
    @Param('id', ParseIntPipe) id: number,
    @Param('memberId', ParseIntPipe) memberId: number,
    @Body(new ZodValidationPipe(updateMemberSchema)) body: UpdateMemberDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.spaces.updateMember(id, memberId, body, user);
  }

  @Delete(':id/members/:memberId')
  removeMember(
    @Param('id', ParseIntPipe) id: number,
    @Param('memberId', ParseIntPipe) memberId: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.spaces.removeMember(id, memberId, user);
  }

  // ---- Documents ----------------------------------------------------------

  @Get(':id/documents')
  listDocuments(
    @Param('id', ParseIntPipe) id: number,
    @Query(new ZodValidationPipe(listDocumentsQuerySchema)) query: ListDocumentsQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.spaces.listDocuments(id, user, query);
  }

  @Post(':id/documents')
  attachDocument(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(attachDocumentSchema)) body: AttachDocumentDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.spaces.attachDocument(id, body, user);
  }

  @Delete(':id/documents/:documentId')
  detachDocument(
    @Param('id', ParseIntPipe) id: number,
    @Param('documentId', ParseIntPipe) documentId: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.spaces.detachDocument(id, documentId, user);
  }

  // ---- Publication --------------------------------------------------------

  /** `@HttpCode(200)` : transition d'état d'une ressource existante, pas une création. */
  @Post(':id/publish')
  @HttpCode(200)
  publish(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(publishSpaceSchema)) body: PublishSpaceDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.spaces.publish(id, body, user);
  }

  @Post(':id/unpublish')
  @HttpCode(200)
  unpublish(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.spaces.unpublish(id, user);
  }
}
