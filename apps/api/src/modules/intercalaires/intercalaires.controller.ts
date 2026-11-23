import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { MenuPermissionGuard } from '../auth/menu-permission.guard';
import { RequireMenu } from '../auth/require-menu.decorator';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { IntercalairesService } from './intercalaires.service';
import { generateIntercalairesSchema, type GenerateIntercalairesDto } from './intercalaires.dto';

/** Clé du menu « Intercalaires » (déclarée aussi dans `roles/menu-catalog.ts`). */
export const INTERCALAIRES_MENU = '/intercalaires';

/**
 * Génération des feuilles d'intercalaires QR. Seul l'écran « Intercalaires » consomme ces routes :
 * elles suivent donc son menu, comme le reste de l'application (ANO-ARC-T1-01). Les référentiels
 * listés ici restent lisibles par ailleurs via `/referentials/*`, ouverts à tout authentifié.
 */
@UseGuards(MenuPermissionGuard)
@RequireMenu(INTERCALAIRES_MENU)
@Controller('intercalaires')
export class IntercalairesController {
  constructor(private readonly service: IntercalairesService) {}

  @Get('categories')
  categories() {
    return this.service.listCategories();
  }

  @Get('items')
  items(@Query('category') category: string) {
    return this.service.listItems(category);
  }

  @Post('generate')
  @HttpCode(200)
  async generate(
    @Body(new ZodValidationPipe(generateIntercalairesSchema)) body: GenerateIntercalairesDto,
  ): Promise<StreamableFile> {
    const pdf = await this.service.generate(body.category, body.itemIds);
    return new StreamableFile(Buffer.from(pdf), {
      type: 'application/pdf',
      disposition: 'inline; filename="intercalaires.pdf"',
    });
  }
}
