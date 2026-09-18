import { Controller, Get } from '@nestjs/common';
import { Public } from './modules/auth/public.decorator';

/** Liveness trivial — pas de sonde DB/Redis : Compose vérifie que le process HTTP répond. */
@Controller()
export class HealthController {
  @Public()
  @Get('health')
  health(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
