import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  GED_AI_DISABLED_MESSAGE,
  GED_DRAFT_PROMPT_VERSION,
  GED_DRAFT_REVIEW_NOTICE,
  GedAiTask,
  type GedCollabCreated,
  type GedDraftCreateDocumentRequest,
  type GedDraftRequest,
  type GedDraftResponse,
  type GedDraftTemplateDetail,
  type GedDraftTemplatesResponse,
} from '@archivage/types';
import { AiConfigurationError } from '../ai/ai-provider.factory';
import { AiService } from '../ai/ai.service';
import { AiMaskingRequiredError, AiProviderError } from '../ai/ai.types';
import type { AuthUser } from '../auth/auth.types';
import { CollabDocumentsService } from '../collab/documents/collab-documents.service';
import { DraftingContextService } from './drafting-context.service';
import {
  buildDraftRequest,
  collectSourceText,
  DraftOutputError,
  finalizeDraftHtml,
  hasVisibleInstruction,
  parseDraftOutput,
} from './drafting-prompt';
import { DRAFT_TEMPLATES, findDraftTemplate, type DraftTemplate } from './drafting-templates';

const TEMPLATE_NOT_FOUND = 'Modèle introuvable';
const UNUSABLE_DRAFT = 'Le brouillon généré est inexploitable. Réessayez ou reformulez la consigne.';

/**
 * Rédaction assistée. Le brouillon est une PROPOSITION : ce service n'écrit rien en base (hors
 * le journal de décision tenu par `AiService`, qui assure aussi le masquage) et n'appelle aucune
 * API de création ou de sauvegarde. Seule `createDocumentFromTemplate` crée un document, avec le
 * squelette statique d'un modèle (jamais un texte généré).
 *
 * Aucun texte de consigne, de contexte ou de brouillon dans les logs : identifiants et types
 * d'erreur uniquement.
 */
@Injectable()
export class DraftingService {
  private readonly logger = new Logger(DraftingService.name);

  constructor(
    private readonly ai: AiService,
    private readonly context: DraftingContextService,
    private readonly collabDocuments: CollabDocumentsService,
  ) {}

  async listTemplates(_user: AuthUser): Promise<GedDraftTemplatesResponse> {
    const status = await this.ai.status();
    return {
      aiEnabled: status.enabled,
      ...(status.message ? { aiMessage: status.message } : {}),
      templates: DRAFT_TEMPLATES.map(({ id, label, description, category }) => ({
        id,
        label,
        description,
        category,
      })),
    };
  }

  getTemplate(id: string, _user: AuthUser): GedDraftTemplateDetail {
    const t = this.requireTemplate(id);
    return {
      id: t.id,
      label: t.label,
      description: t.description,
      category: t.category,
      skeletonHtml: t.skeletonHtml,
    };
  }

  async generate(dto: GedDraftRequest, user: AuthUser): Promise<GedDraftResponse> {
    if (user.isScanAgent || user.userGroupId == null) {
      throw new ForbiddenException('Ce compte ne peut pas utiliser la rédaction assistée');
    }
    const template = this.requireTemplate(dto.templateId);
    // Consigne vide une fois nettoyée (caractères invisibles seulement) : refus 400, avant tout contexte.
    if (!hasVisibleInstruction(dto.instruction)) {
      throw new BadRequestException('La consigne est vide : saisissez une demande de rédaction lisible.');
    }

    const status = await this.ai.status();
    if (!status.enabled) return { disabled: true, message: GED_AI_DISABLED_MESSAGE };

    // Les refus (404 uniforme) remontent tels quels, AVANT tout appel à l'IA.
    const context = await this.context.load(
      { contextDocumentIds: dto.contextDocumentIds, dossierId: dto.dossierId },
      user,
    );
    const request = buildDraftRequest({
      template: { label: template.label, guidance: template.guidance, skeletonHtml: template.skeletonHtml },
      instruction: dto.instruction,
      context,
    });

    let run;
    try {
      run = await this.ai.run({
        task: GedAiTask.Autre,
        request,
        parse: parseDraftOutput,
        promptVersion: GED_DRAFT_PROMPT_VERSION,
        requestedBy: user.userGroupId,
        documentId: this.singleDocumentId(dto, context.length),
        autoApply: false,
      });
    } catch (err) {
      throw this.mapAiError(err, user);
    }
    if (run.disabled) return { disabled: true, message: run.message };

    let finalized: { html: string; text: string };
    try {
      finalized = finalizeDraftHtml(run.data.html, collectSourceText(dto.instruction, context));
    } catch (err) {
      if (err instanceof DraftOutputError) throw new BadGatewayException(UNUSABLE_DRAFT);
      throw err;
    }

    return {
      disabled: false,
      templateId: template.id,
      draftHtml: finalized.html,
      draftText: finalized.text,
      contextDocumentCount: context.length,
      decisionId: run.decisionId == null ? null : run.decisionId.toString(),
      provider: run.provider,
      model: run.model,
      notice: GED_DRAFT_REVIEW_NOTICE,
    };
  }

  createDocumentFromTemplate(dto: GedDraftCreateDocumentRequest, user: AuthUser): Promise<GedCollabCreated> {
    const template = this.requireTemplate(dto.templateId);
    return this.collabDocuments.createDocumentFromHtml(dto.spaceId, dto.label, template.skeletonHtml, user);
  }

  private requireTemplate(id: string): DraftTemplate {
    const template = findDraftTemplate(id);
    if (!template) throw new NotFoundException(TEMPLATE_NOT_FOUND);
    return template;
  }

  /**
   * Identifiant du document journalisé : seulement s'il y a exactement UN document de contexte.
   * `DraftContextDocument` ne porte pas l'identifiant : il vient de la demande (un seul
   * `contextDocumentIds`). Contexte issu d'un dossier ou de plusieurs documents : `null`.
   */
  private singleDocumentId(dto: GedDraftRequest, contextCount: number): number | null {
    if (contextCount !== 1) return null;
    const ids = dto.contextDocumentIds;
    return !dto.dossierId && ids && ids.length === 1 ? ids[0] : null;
  }

  private mapAiError(err: unknown, user: AuthUser): Error {
    // Jamais de message d'origine ni de contenu dans les logs : type d'erreur + auteur seulement.
    const kind = err instanceof Error ? err.name : 'inconnue';
    this.logger.warn(`Génération de brouillon en échec (${kind}) pour le profil ${user.userGroupId}`);
    // Sortie du modèle inexploitable (JSON invalide, champ en trop, trop longue) levée dans `run`.
    if (err instanceof DraftOutputError) return new BadGatewayException(UNUSABLE_DRAFT);
    if (err instanceof AiMaskingRequiredError) return new ConflictException(err.message);
    if (err instanceof AiConfigurationError) {
      return new ServiceUnavailableException(
        "La configuration de l'IA est incomplète ou invalide. Contactez un administrateur.",
      );
    }
    if (err instanceof AiProviderError) {
      return new BadGatewayException("Le service d'IA n'a pas pu produire de brouillon. Réessayez plus tard.");
    }
    return err instanceof Error ? err : new Error('Erreur inconnue');
  }
}
