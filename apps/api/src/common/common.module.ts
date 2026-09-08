import { Global, Module } from '@nestjs/common';
import { AgencementService } from './agencement.service';
import { HierarchyService } from './hierarchy.service';

@Global()
@Module({
  providers: [HierarchyService, AgencementService],
  exports: [HierarchyService, AgencementService],
})
export class CommonModule {}
