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
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { MenuPermissionGuard } from '../auth/menu-permission.guard';
import { RequireMenu } from '../auth/require-menu.decorator';
import { SECURITY_MENUS } from '../access-inquiries/security.menus';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { UsersService } from './users.service';
import {
  assignGroupSchema,
  bulkConfidentialiteSchema,
  createGroupSchema,
  createUserSchema,
  resetPasswordSchema,
  updateUserSchema,
  type AssignGroupDto,
  type BulkConfidentialiteDto,
  type CreateGroupDto,
  type CreateUserDto,
  type ResetPasswordDto,
  type UpdateUserDto,
} from './users.dto';

/**
 * Gestion des utilisateurs : accessible au menu « /admin/users » (ou admin) — lecture ET écriture.
 *
 * Quelques handlers élargissent ce défaut aux menus « Sécurité Documentaire » qui en dépendent :
 * la règle « accès au menu ⟹ accès aux données » vaut aussi pour les données d'un AUTRE écran dont
 * la page a besoin (sans quoi l'écran s'ouvre puis échoue en 403). L'élargissement reste
 * handler par handler et en LECTURE, plus la seule écriture que ces écrans pratiquent
 * (`PATCH /users/confidentialite`) : création, suppression, mot de passe, `isAdmin` et `roleId`
 * restent réservés au menu « Utilisateurs ».
 *
 * Le menu ne suffit pas pour tout : `isAdmin`, le rôle système et toute action sur un compte
 * administrateur exigent un acteur administrateur (règles dans `UsersService`, d'où l'acteur passé
 * à chaque écriture).
 */
@UseGuards(MenuPermissionGuard)
@RequireMenu('/admin/users')
@Controller('users')
export class UsersController {
  constructor(private readonly service: UsersService) {}

  // Liste lue aussi par « Confidentialité des utilisateurs » (Sécurité Documentaire).
  @RequireMenu('/admin/users', SECURITY_MENUS.userConfidentiality)
  @Get()
  list() {
    return this.service.listUsers();
  }

  @Post()
  create(
    @Body(new ZodValidationPipe(createUserSchema)) body: CreateUserDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.service.createUser(body, actor);
  }

  /**
   * Affectation en masse du niveau de confidentialité — écran « Confidentialité des utilisateurs ».
   * Déclaré AVANT `@Patch(':id')` : Express essaie les routes dans l'ordre d'enregistrement, et
   * `:id` (ParseIntPipe) capturerait sinon « confidentialite » en 400.
   */
  @RequireMenu('/admin/users', SECURITY_MENUS.userConfidentiality)
  @Patch('confidentialite')
  setConfidentialite(
    @Body(new ZodValidationPipe(bulkConfidentialiteSchema)) body: BulkConfidentialiteDto,
  ) {
    return this.service.setConfidentialite(body.userIds, body.confidentialiteId);
  }

  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(updateUserSchema)) body: UpdateUserDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.service.updateUser(id, body, actor);
  }

  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() actor: AuthUser) {
    return this.service.deleteUser(id, actor);
  }

  @Post(':id/reset-password')
  resetPassword(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(resetPasswordSchema)) body: ResetPasswordDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.service.resetPassword(id, body.newPassword, actor);
  }

  @Post(':id/groups')
  assignGroup(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(assignGroupSchema)) body: AssignGroupDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.service.assignGroup(id, body.groupId, body.isDefault ?? false, actor);
  }

  // Profils : depuis que « Sécurité type document par rôle » vise les rôles (2026-08-06), ce lookup
  // n'a plus qu'un consommateur hors « Utilisateurs » — l'onglet « Accès par Profil » d'un document,
  // qui n'est pas un écran du menu Sécurité. Défaut du contrôleur, donc.
  @Get('groups/all')
  listGroups() {
    return this.service.listGroups();
  }

  @Post('groups/all')
  createGroup(@Body(new ZodValidationPipe(createGroupSchema)) body: CreateGroupDto) {
    return this.service.createGroup(body.name);
  }
}
