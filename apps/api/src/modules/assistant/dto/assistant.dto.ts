import type { PipeTransform } from '@nestjs/common';
import type { z, ZodTypeAny } from 'zod';
import {
  asstBrouillonArgsSchema,
  asstImputationArgsSchema,
  asstProposedActionSchema,
  asstProposedActionsSchema,
  asstRelanceArgsSchema,
  confirmProposalBody,
  conversationIdParam,
  createConversationBody,
  listConversationsQuery,
  postMessageBody,
  proposalIdParam,
  refuseProposalBody,
} from '@archivage/types';
import { AsstError } from '../assistant.contracts';

// Schémas et types de requête : source unique = @archivage/types (contrat partagé avec le web).
export {
  asstBrouillonArgsSchema,
  asstImputationArgsSchema,
  asstProposedActionSchema,
  asstProposedActionsSchema,
  asstRelanceArgsSchema,
  confirmProposalBody,
  conversationIdParam,
  createConversationBody,
  listConversationsQuery,
  postMessageBody,
  proposalIdParam,
  refuseProposalBody,
};
export type {
  AsstConfirmProposalBody,
  AsstCreateConversationBody,
  AsstListConversationsQuery,
  AsstPostMessageBody,
  AsstRefuseProposalBody,
} from '@archivage/types';

/** Pipe zod de l'assistant : toute entrée invalide devient `AsstError('invalid_input')` (HTTP 422). */
export class AsstZodPipe<S extends ZodTypeAny> implements PipeTransform<unknown, z.output<S>> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.output<S> {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data as z.output<S>;
    throw new AsstError(
      'invalid_input',
      'Requête invalide.',
      result.error.issues.map((i) => ({ path: i.path.join('.') || '(root)', message: i.message })),
    );
  }
}

export function asstZodPipe<S extends ZodTypeAny>(schema: S): AsstZodPipe<S> {
  return new AsstZodPipe(schema);
}

// Pipes prêts à l'emploi pour le contrôleur.
export const conversationIdPipe = asstZodPipe(conversationIdParam);
export const proposalIdPipe = asstZodPipe(proposalIdParam);
export const createConversationPipe = asstZodPipe(createConversationBody);
export const listConversationsPipe = asstZodPipe(listConversationsQuery);
export const postMessagePipe = asstZodPipe(postMessageBody);
export const confirmProposalPipe = asstZodPipe(confirmProposalBody);
export const refuseProposalPipe = asstZodPipe(refuseProposalBody);
