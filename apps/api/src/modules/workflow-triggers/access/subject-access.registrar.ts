import { Injectable, OnModuleInit } from '@nestjs/common';
import { SubjectAccessRegistry } from '../../workflows/extension/subject-access';
import { DocumentSubjectAccessChecker } from './document-subject-access.checker';
import { MailSubjectAccessChecker } from './mail-subject-access.checker';

/**
 * Enregistre les contrôleurs d'accès aux objets liés. Seuls « mail » et « document » sont ouverts :
 * les autres types (« dossier », « other »…) restent refusés par défaut.
 */
@Injectable()
export class WorkflowSubjectAccessRegistrar implements OnModuleInit {
  constructor(
    private readonly registry: SubjectAccessRegistry,
    private readonly mail: MailSubjectAccessChecker,
    private readonly document: DocumentSubjectAccessChecker,
  ) {}

  onModuleInit(): void {
    this.registry.register(this.mail);
    this.registry.register(this.document);
  }
}
