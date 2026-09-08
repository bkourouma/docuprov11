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
import { SECURITY_MENUS } from '../access-inquiries/security.menus';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { RolesService } from './roles.service';
import {
  createRoleSchema,
  updateRoleSchema,
  type CreateRoleDto,
  type UpdateRoleDto,
} from './roles.dto';

// Gestion des rôles : accessible au menu « /admin/roles » (ou admin).
@UseGuards(MenuPermissionGuard)
@RequireMenu('/admin/roles')
@Controller('roles')
export class RolesController {
  constructor(private readonly service: RolesService) {}

  /** Catalogue des menus assignables (pour l'éditeur de rôle). */
  @Get('menus')
  listMenus() {
    return this.service.listMenus();
  }

  /**
   * Liste des rôles. Élargie à « Sécurité type document par rôle » (2026-08-06), qui en fait sa
   * liste de bénéficiaires, et à « Utilisateurs », dont le formulaire d'édition affecte un rôle :
   * même règle « accès au menu ⟹ accès aux données » que les lookups de `UsersController`, sinon
   * l'écran s'ouvre puis échoue en 403 sur son premier select. Le CATALOGUE des menus et
   * l'écriture restent, eux, réservés à « Rôles ».
   */
  @RequireMenu('/admin/roles', SECURITY_MENUS.typeSecurityByRole, '/admin/users')
  @Get()
  list() {
    return this.service.listRoles();
  }

  @Post()
  create(@Body(new ZodValidationPipe(createRoleSchema)) body: CreateRoleDto) {
    return this.service.createRole(body);
  }

  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(updateRoleSchema)) body: UpdateRoleDto,
  ) {
    return this.service.updateRole(id, body);
  }

  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.service.deleteRole(id);
  }
}
