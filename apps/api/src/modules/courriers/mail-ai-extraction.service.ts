import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { extname } from 'node:path';
import { z } from 'zod';
import { MailsService } from './mails.service';
import { MailReferentialsService } from './mail-referentials.service';
import type { UploadedScan } from './mail-scanned.service';

/**
 * Types acceptés à l'analyse IA. Plus restrictif que le dépôt §07 : le modèle lit les images en
 * JPEG/PNG/GIF/WebP et les PDF (`input_image` / `input_file` de la Responses API), mais pas le
 * TIFF — l'accepter ici ne ferait qu'échouer côté API.
 */
const MEDIA_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/**
 * Plafond du binaire envoyé au modèle. La Responses API accepte jusqu'à 50 Mo par fichier ; on
 * refuse bien en-deçà, avec un message lisible, plutôt qu'un 413 opaque côté OpenAI.
 */
const MAX_BYTES = 10 * 1024 * 1024;

/**
 * Sortie structurée imposée au modèle (`text.format`, type `json_schema`). Tout est nullable : un
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
On te transmet le courrier numérisé ; tu en extrais les champs du formulaire d'enregistrement.

Règles :
- N'extrais que ce que le document montre. Un champ que tu ne lis pas vaut null — ne devine jamais.
- L'expéditeur est l'organisme ou la personne qui ENVOIE le courrier (en-tête, signature), pas le destinataire.
- Pour externalEntityId et destinataireRoleId, tu ne peux renvoyer qu'un identifiant présent dans les
  listes fournies. Un rapprochement demande une correspondance nette (le libellé peut différer par la
  casse, les accents, la ponctuation ou une abréviation courante) ; au moindre doute, renvoie null.
- Renseigne toujours externalEntityLabel avec le nom lu, même quand aucun correspondant ne colle :
  l'agent s'en sert pour créer la fiche manquante.
- La date du courrier est celle de sa rédaction, en AAAA-MM-JJ.`;

/**
 * Pré-remplissage du formulaire d'enregistrement (§05) à partir du courrier numérisé. Le modèle ne
 * fait que proposer : rien n'est écrit en base ici, l'agent relit et corrige avant d'enregistrer.
 *
 * La clé API ne quitte jamais l'API : le navigateur envoie le binaire, jamais le modèle directement.
 */
@Injectable()
export class MailAiExtractionService {
  private readonly logger = new Logger(MailAiExtractionService.name);
  private client: OpenAI | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly mails: MailsService,
    private readonly referentials: MailReferentialsService,
  ) {}

  /** Le module démarre sans clé : la fonctionnalité est alors simplement absente de l'écran. */
  get enabled(): boolean {
    return Boolean(this.config.get<string>('OPENAI_API_KEY'));
  }

  private get openai(): OpenAI {
    const apiKey = this.config.get<string>('OPENAI_API_KEY');
    if (!apiKey) {
      throw new ServiceUnavailableException(
        "La saisie automatique par IA n'est pas configurée (OPENAI_API_KEY absente).",
      );
    }
    if (!this.client) this.client = new OpenAI({ apiKey });
    return this.client;
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

    // Les listes partent avec la requête : le modèle choisit un identifiant existant au lieu de
    // renvoyer un libellé qu'il faudrait rapprocher après coup, à l'aveugle.
    const [entities, roles] = await Promise.all([
      this.referentials.listExternalEntities(),
      this.mails.listDestinataireRoles(),
    ]);

    const data = file.buffer.toString('base64');
    const documentBlock: OpenAI.Responses.ResponseInputContent =
      mediaType === 'application/pdf'
        ? {
            type: 'input_file',
            filename: file.originalname,
            file_data: `data:application/pdf;base64,${data}`,
          }
        : { type: 'input_image', image_url: `data:${mediaType};base64,${data}`, detail: 'auto' };

    const response = await this.openai.responses
      .create({
        model: this.config.get<string>('OPENAI_MODEL') ?? 'gpt-5.6-terra',
        instructions: SYSTEM_PROMPT,
        text: {
          format: { type: 'json_schema', name: 'mail_extraction', schema: OUTPUT_SCHEMA, strict: true },
        },
        input: [
          {
            role: 'user',
            content: [
              documentBlock,
              {
                type: 'input_text',
                text: [
                  'Correspondants enregistrés (externalEntityId — libellé) :',
                  entities.map((e) => `${e.externalEntityId} — ${e.label}`).join('\n') || '(aucun)',
                  '',
                  'Rôles destinataires (destinataireRoleId — libellé) :',
                  roles.map((r) => `${r.roleId} — ${r.label}`).join('\n') || '(aucun)',
                  '',
                  "Extrais les champs d'enregistrement de ce courrier.",
                ].join('\n'),
              },
            ],
          },
        ],
      })
      .catch((e: unknown) => {
        // Le détail (clé invalide, quota, panne réseau) part au log ; l'écran reçoit un message
        // actionnable. Un échec d'analyse ne doit pas empêcher la saisie manuelle du courrier.
        this.logger.error(`Échec de l'extraction IA : ${e instanceof Error ? e.message : String(e)}`);
        throw new ServiceUnavailableException(
          "L'analyse du document a échoué. Vous pouvez saisir le courrier manuellement.",
        );
      });

    // La sortie structurée garantit un JSON conforme, mais on revalide : un refus du modèle ou une
    // coupure sur la longueur rend `output_text` vide ou incomplet.
    const parsed = response.output_text
      ? extractionSchema.safeParse(JSON.parse(response.output_text) as unknown)
      : null;
    if (!parsed?.success) {
      this.logger.warn(`Réponse d'extraction inexploitable (status: ${response.status ?? 'inconnu'}).`);
      throw new ServiceUnavailableException(
        "Le document n'a pas pu être analysé. Vous pouvez saisir le courrier manuellement.",
      );
    }
    const extracted = parsed.data;

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
}
