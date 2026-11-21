import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { MenuPermissionGuard } from '../auth/menu-permission.guard';
import { RequireAdmin } from '../auth/require-menu.decorator';
import {
  connectorIdSchema,
  createConnectorSchema,
  itemIdSchema,
  listItemsQuerySchema,
  listRunsQuerySchema,
  updateConnectorSchema,
  type CreateConnectorDto,
  type ListItemsQuery,
  type ListRunsQuery,
  type UpdateConnectorDto,
} from './connectors.dto';
import { ConnectorsService } from './connectors.service';

const connectorIdPipe = new ZodValidationPipe(connectorIdSchema);
const itemIdPipe = new ZodValidationPipe(itemIdSchema);

/**
 * Connecteurs de sources GED — administration. Accès refusé par défaut : le contrôleur ENTIER est
 * réservé aux administrateurs (un connecteur lit des sources externes avec des identifiants et
 * décide des droits des documents importés). Les routes statiques (`types`, `rotate-keys`)
 * précèdent les routes paramétrées.
 */
@Controller('ged/connectors')
@UseGuards(MenuPermissionGuard)
@RequireAdmin()
export class ConnectorsController {
  constructor(private readonly service: ConnectorsService) {}

  @Get('types')
  listTypes() {
    return this.service.listTypes();
  }

  @Get()
  list() {
    return this.service.list();
  }

  @Post()
  create(
    @Body(new ZodValidationPipe(createConnectorSchema)) body: CreateConnectorDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.create(body, user);
  }

  /** Rotation documentée des clés : rechiffre les identifiants avec la clé active. */
  @Post('rotate-keys')
  @HttpCode(200)
  rotateKeys(@CurrentUser() user: AuthUser) {
    return this.service.rotateKeys(user);
  }

  @Get(':id')
  get(@Param('id', connectorIdPipe) id: number) {
    return this.service.get(id);
  }

  @Put(':id')
  update(
    @Param('id', connectorIdPipe) id: number,
    @Body(new ZodValidationPipe(updateConnectorSchema)) body: UpdateConnectorDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.update(id, body, user);
  }

  @Post(':id/deactivate')
  @HttpCode(200)
  deactivate(@Param('id', connectorIdPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.service.deactivate(id, user);
  }

  @Post(':id/activate')
  @HttpCode(200)
  activate(@Param('id', connectorIdPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.service.activate(id, user);
  }

  @Post(':id/test')
  @HttpCode(200)
  test(@Param('id', connectorIdPipe) id: number) {
    return this.service.testConnection(id);
  }

  @Post(':id/sync')
  @HttpCode(200)
  sync(@Param('id', connectorIdPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.service.requestSync(id, user);
  }

  @Get(':id/runs')
  runs(
    @Param('id', connectorIdPipe) id: number,
    @Query(new ZodValidationPipe(listRunsQuerySchema)) query: ListRunsQuery,
  ) {
    return this.service.listRuns(id, query);
  }

  @Get(':id/items')
  items(
    @Param('id', connectorIdPipe) id: number,
    @Query(new ZodValidationPipe(listItemsQuerySchema)) query: ListItemsQuery,
  ) {
    return this.service.listItems(id, query);
  }

  @Get(':id/items/:itemId')
  item(@Param('id', connectorIdPipe) id: number, @Param('itemId', itemIdPipe) itemId: number) {
    return this.service.getItem(id, itemId);
  }
}
