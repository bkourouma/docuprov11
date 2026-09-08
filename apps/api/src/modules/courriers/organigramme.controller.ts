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
import { OrganigrammeService } from './organigramme.service';
import {
  assignRoleSchema,
  createNodeSchema,
  reparentNodeSchema,
  updateNodeSchema,
  type AssignRoleBody,
  type CreateNodeBody,
  type ReparentNodeBody,
  type UpdateNodeBody,
} from './organigramme.dto';

/** Organigramme (§14) + assignation rôle ↔ organigramme (§15). */
@UseGuards(MenuPermissionGuard)
@Controller('courriers/organigramme')
export class OrganigrammeController {
  constructor(private readonly service: OrganigrammeService) {}

  @Get()
  list() {
    return this.service.list();
  }

  @Get('role-assignments')
  listRoleAssignments() {
    return this.service.listRoleAssignments();
  }

  @RequireMenu('/admin/courriers/organigrammes')
  @Post()
  create(@Body(new ZodValidationPipe(createNodeSchema)) body: CreateNodeBody) {
    return this.service.create(body);
  }

  @RequireMenu('/admin/courriers/organigrammes')
  @Patch(':id/parent')
  reparent(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(reparentNodeSchema)) body: ReparentNodeBody,
  ) {
    return this.service.reparent(id, body.parentId);
  }

  @RequireMenu('/admin/courriers/organigrammes')
  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(updateNodeSchema)) body: UpdateNodeBody,
  ) {
    return this.service.update(id, body);
  }

  @RequireMenu('/admin/courriers/organigrammes')
  @Delete(':id')
  deactivate(@Param('id', ParseIntPipe) id: number) {
    return this.service.deactivate(id);
  }

  @RequireMenu('/admin/courriers/role-organigramme')
  @Patch('roles/:roleId')
  assignRole(
    @Param('roleId', ParseIntPipe) roleId: number,
    @Body(new ZodValidationPipe(assignRoleSchema)) body: AssignRoleBody,
  ) {
    return this.service.assignRole(roleId, body.organigrammeId);
  }
}
