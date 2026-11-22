import { Module, OnModuleInit } from '@nestjs/common';
import { CollabModule } from '../../../collab/collab.module';
import { ActionApplierRegistry } from '../action-applier.registry';
import { CatalogAppliersModule } from '../catalog-appliers.module';
import { DelegationApplier } from '../delegation.applier';
import { DraftReplyApplier, DraftReplyBaseApplier } from '../draft-reply.applier';
import { RelanceApplier } from '../relance.applier';

/**
 * Applicateurs supplémentaires du catalogue : brouillon de réponse (2 outils), relance interne, délégation.
 * Importable seul : `CatalogAppliersModule` fournit le registre et le port des acteurs imputables
 * (`WF_IMPUTABLE_ACTORS`), `CollabModule` le service de création de documents.
 */
@Module({
  imports: [CatalogAppliersModule, CollabModule],
  providers: [DraftReplyApplier, DraftReplyBaseApplier, RelanceApplier, DelegationApplier],
  exports: [DraftReplyApplier, DraftReplyBaseApplier, RelanceApplier, DelegationApplier],
})
export class CatalogExtraAppliersModule implements OnModuleInit {
  constructor(
    private readonly registry: ActionApplierRegistry,
    private readonly draftReply: DraftReplyApplier,
    private readonly draftReplyBase: DraftReplyBaseApplier,
    private readonly relance: RelanceApplier,
    private readonly delegation: DelegationApplier,
  ) {}

  onModuleInit(): void {
    for (const applier of [this.draftReply, this.draftReplyBase, this.relance, this.delegation]) {
      if (!this.registry.has(applier.toolKey)) this.registry.register(applier);
    }
  }
}
