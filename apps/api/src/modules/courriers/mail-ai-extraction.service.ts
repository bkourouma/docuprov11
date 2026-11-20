import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { extname } from 'node:path';
import { z } from 'zod';
import { GedAiTask } from '@archivage/types';
import { AiService } from '../ai/ai.service';
import {
  AiDisabledError,
  AiMaskingRequiredError,
  AiProviderError,
  AiUnsupportedInputError,
} from '../ai/ai.types';
import { MailsService } from './mails.service';
import { MailReferentialsService } from './mail-referentials.service';
import { MailTextExtractor } from './mail-text-extractor';
import type { UploadedScan } from './mail-scanned.service';

/**
 * Types acceptés à l'analyse IA. Plus restrictif que le dépôt §07 : l'extraction locale du texte
 * lit les PDF et les images JPEG/PNG/GIF/WebP, pas le TIFF.
 */
const MEDIA_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/** Plafond du fichier analysé localement, refusé avec un message lisible plutôt qu'un échec opaque. */
const MAX_BYTES = 10 * 1024 * 1024;

/**
 * Sortie structurée imposée au modèle (`jsonSchema`, strict). Tout est nullable : un
 * champ illisible ou absent du document doit revenir `null` et laisser la saisie manuelle
 * reprendre la main — une valeur inventée serait pire que pas de valeur du tout.
 */
const nullable = (type: 'string' | 'integer', description: string) => ({
  anyOf: [{ type }, { type: 'null' }],
  description,
});

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'title',
    'date',
    'reference',
    'externalEntityId',
    'externalEntityLabel',
    'destinataireRoleId',
    'description',
  ],
  properties: {
    title: nullable(
      'string',
      "Objet du courrier, tel qu'il figure sur le document. Une phrase, sans préfixe « Objet : ».",
    ),
    date: nullable(
      'string',
      'Date du courrier au format AAAA-MM-JJ. La date de rédaction, pas celle de réception.',
    ),
    reference: nullable(
      'string',
      "Référence attribuée au courrier par l'expéditeur (N/Réf, Notre référence, etc.).",
    ),
    externalEntityId: nullable(
      'integer',
      "Identifiant de l'expéditeur, choisi STRICTEMENT dans la liste des correspondants fournie. null si aucun ne correspond.",
    ),
    externalEntityLabel: nullable(
      'string',
      "Nom de l'expéditeur lu sur le document, renseigné même lorsque externalEntityId vaut null.",
    ),
    destinataireRoleId: nullable(
      'integer',
      'Identifiant du rôle destinataire, choisi STRICTEMENT dans la liste des rôles fournie. null si aucun ne correspond.',
    ),
    description: nullable('string', 'Résumé du courrier en deux ou trois phrases.'),
  },
} satisfies Record<string, unknown>;

const extractionSchema = z.object({
  title: z.string().nullable(),
  date: z.string().nullable(),
  reference: z.string().nullable(),
  externalEntityId: z.number().int().nullable(),
  externalEntityLabel: z.string().nullable(),
  destinataireRoleId: z.number().int().nullable(),
  description: z.string().nullable(),
});

export type MailExtraction = z.infer<typeof extractionSchema>;

const SYSTEM_PROMPT = `Tu assistes l'agent du bureau d'ordre qui enregistre un courrier entrant dans DocuPro.
On te transmet le texte du courrier numérisé ; tu en extrais les champs du formulaire d'enregistrement.

Règles :
- N'extrais que ce que le document montre. Un champ que tu ne lis pas vaut null — ne devine jamais.
- L'expéditeur est l'organisme ou la personne qui ENVOIE le courrier (en-tête, signature), pas le destinataire.
- Pour externalEntityId et destinataireRoleId, tu ne peux renvoyer qu'un identifiant présent dans les
  listes fournies. Un rapprochement demande une correspondance nette (le libellé peut différer par la
  casse, les accents, la ponctuation ou une abréviation courante) ; au moindre doute, renvoie null.
- Renseigne toujours externalEntityLabel avec le nom lu, même quand aucun correspondant ne colle :
  l'agent s'en sert pour créer la fiche manquante.
- La date du courrier est celle de sa rédaction, en AAAA-MM-JJ.
- Le document est fourni sous forme de texte issu d'une lecture automatique (OCR) : il peut contenir des
  erreurs de lecture. Des données personnelles peuvent apparaître remplacées par des marqueurs entre
  crochets, comme [IDENTITÉ] : ne les recopie jamais et ne cherche pas à deviner la valeur masquée.`;

/**
 * Pré-remplissage du formulaire d'enregistrement (§05) à partir du courrier numérisé. Le modèle ne
 * fait que proposer : rien n'est écrit en base ici, l'agent relit et corrige avant d'enregistrer.
 *
 * Le binaire n'est jamais transmis au fournisseur IA : le texte est lu localement (couche texte du
 * PDF, sinon OCR) puis envoyé comme TEXTE, masqué par AiService en cloud.
 */
@Injectable()
export class MailAiExtractionService {
  private readonly logger = new Logger(MailAiExtractionService.name);

  constructor(
    private readonly ai: AiService,
    private readonly mails: MailsService,
    private readonly referentials: MailReferentialsService,
    private readonly textExtractor: MailTextExtractor,
  ) {}

  /** Disponible si l'IA est activée ET que la lecture locale (OCR) est utilisable sur ce serveur. */
  async isEnabled(): Promise<boolean> {
    if (!this.textExtractor.isOperational()) return false;
    return (await this.ai.status()).enabled;
  }

  async extract(file: UploadedScan | undefined): Promise<MailExtraction> {
    if (!file) throw new BadRequestException('Aucun fichier reçu.');

    const ext = extname(file.originalname ?? '').toLowerCase();
    const mediaType = MEDIA_TYPES[ext];
    if (!mediaType) {
      throw new BadRequestException(
        `Format non pris en charge par l'analyse (${ext || 'inconnu'}). Formats acceptés : PDF, JPG, PNG, GIF, WebP.`,
      );
    }
    if (file.size > MAX_BYTES) {
      throw new BadRequestException(
        `Fichier trop volumineux pour l'analyse (${Math.round(file.size / 1024 / 1024)} Mo, maximum 10 Mo).`,
      );
    }

    // IA coupée : on ne lance pas l'OCR local (coûteux) pour rien.
    if (!(await this.ai.status()).enabled) throw this.disabledError();

    // Lecture locale AVANT tout appel IA : un document sans texte lisible échoue ici (400).
    const documentText = await this.textExtractor.extractText({ buffer: file.buffer, mediaType });

    // Les listes partent avec la requête : le modèle choisit un identifiant existant au lieu de
    // renvoyer un libellé qu'il faudrait rapprocher après coup, à l'aveugle.
    const [entities, roles] = await Promise.all([
      this.referentials.listExternalEntities(),
      this.mails.listDestinataireRoles(),
    ]);

    const text = [
      'Correspondants enregistrés (externalEntityId — libellé) :',
      entities.map((e) => `${e.externalEntityId} — ${e.label}`).join('\n') || '(aucun)',
      '',
      'Rôles destinataires (destinataireRoleId — libellé) :',
      roles.map((r) => `${r.roleId} — ${r.label}`).join('\n') || '(aucun)',
      '',
      'Texte du courrier (lecture automatique) :',
      '<<<DEBUT_COURRIER>>>',
      documentText,
      '<<<FIN_COURRIER>>>',
      '',
      "Extrais les champs d'enregistrement de ce courrier.",
    ].join('\n');

    let result;
    try {
      result = await this.ai.run<MailExtraction>({
        task: GedAiTask.ExtractionMetadonnees,
        request: {
          system: SYSTEM_PROMPT,
          text,
          jsonSchema: { name: 'mail_extraction', schema: OUTPUT_SCHEMA },
        },
        // La sortie structurée garantit un JSON conforme, mais on revalide : un refus du modèle ou
        // une coupure sur la longueur rend la réponse vide ou incomplète.
        parse: (raw) => extractionSchema.parse(JSON.parse(raw) as unknown),
        autoApply: false,
        minTimeoutSeconds: 180,
        promptVersion: 'mail-extraction-v2',
      });
    } catch (e) {
      if (e instanceof AiMaskingRequiredError) {
        throw new ServiceUnavailableException(
          "L'analyse du document est indisponible : le texte n'a pas pu être masqué avant envoi. Saisissez le courrier manuellement.",
        );
      }
      if (e instanceof AiUnsupportedInputError) throw new BadRequestException(e.message);
      if (e instanceof AiDisabledError) throw this.disabledError();
      // Le détail (clé invalide, quota, panne réseau) part au log, sans contenu ; l'écran reçoit
      // un message actionnable. Un échec d'analyse n'empêche pas la saisie manuelle.
      if (e instanceof AiProviderError) {
        this.logger.error(`Échec de l'extraction IA : ${e.message}`);
        throw new ServiceUnavailableException(
          "L'analyse du document a échoué. Vous pouvez saisir le courrier manuellement.",
        );
      }
      this.logger.warn(`Réponse d'extraction inexploitable (${e instanceof Error ? e.name : 'erreur'}).`);
      throw new ServiceUnavailableException(
        "Le document n'a pas pu être analysé. Vous pouvez saisir le courrier manuellement.",
      );
    }
    if (result.disabled) throw this.disabledError();
    const extracted = result.data;

    // Garde-fou : le modèle ne doit renvoyer qu'un identifiant des listes envoyées. On rejette
    // silencieusement tout autre, sinon le formulaire porterait une valeur qui échouerait à
    // l'enregistrement, loin de sa cause.
    return {
      ...extracted,
      externalEntityId: entities.some((e) => e.externalEntityId === extracted.externalEntityId)
        ? extracted.externalEntityId
        : null,
      destinataireRoleId: roles.some((r) => r.roleId === extracted.destinataireRoleId)
        ? extracted.destinataireRoleId
        : null,
    };
  }

  private disabledError(): ServiceUnavailableException {
    return new ServiceUnavailableException(
      "L'IA est désactivée : la saisie automatique est indisponible. Saisissez le courrier manuellement.",
    );
  }
}
