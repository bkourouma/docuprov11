import { Module } from '@nestjs/common';
import { CatalogAppliersModule } from './appliers/catalog-appliers.module';
import { CatalogExtraAppliersModule } from './appliers/extra/catalog-extra-appliers.module';
import { CatalogTemplatesModule } from './templates/catalog-templates.module';
import { CatalogToolsModule } from './tools/catalog-tools.module';

/**
 * Catalogue d'agents prêts à l'emploi (lot W6) : outils (lecture et préparation), applicateurs d'effets
 * (après validation humaine) et modèles de workflow (API `GET /workflows/templates`). Chaque sous-module
 * s'enregistre lui-même (outils dans le registre W2, applicateurs dans le moteur) à l'initialisation.
 */
@Module({
  imports: [CatalogToolsModule, CatalogAppliersModule, CatalogExtraAppliersModule, CatalogTemplatesModule],
})
export class WorkflowAgentCatalogModule {}
