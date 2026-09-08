import { Body, Controller, Get, HttpCode, Post, Query, StreamableFile } from '@nestjs/common';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { IntercalairesService } from './intercalaires.service';
import { generateIntercalairesSchema, type GenerateIntercalairesDto } from './intercalaires.dto';

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
