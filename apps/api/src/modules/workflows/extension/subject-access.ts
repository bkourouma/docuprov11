import { ForbiddenException, Injectable } from '@nestjs/common';

/** Acteur dont on vérifie l'accès à l'objet lié. */
export interface SubjectActor {
  userGroupId: number;
  userId?: number;
}

/**
 * Contrôle d'accès à un type d'objet lié à une instance (document, courrier…). Un type sans contrôleur
 * enregistré est REFUSÉ : l'instance ne doit jamais ouvrir l'accès à un objet que son lanceur ne peut
 * pas lire. Vide en W1 ; les modules propriétaires des objets s'enregistrent (point d'extension).
 */
export interface SubjectAccessChecker {
  readonly subjectType: string;
  canAccess(actor: SubjectActor, subjectId: string): Promise<boolean>;
  /** (Facultatif) Propriétaire (user_group_id) de l'objet ; null si inconnu. */
  resolveOwner?(subjectId: string): Promise<number | null>;
}

@Injectable()
export class SubjectAccessRegistry {
  private readonly checkers = new Map<string, SubjectAccessChecker>();

  register(checker: SubjectAccessChecker): void {
    this.checkers.set(checker.subjectType, checker);
  }

  get(subjectType: string): SubjectAccessChecker | undefined {
    return this.checkers.get(subjectType);
  }

  /** Propriétaire d'un objet lié ; null sans contrôleur, sans `resolveOwner` ou en cas d'erreur (ne lève jamais). */
  async resolveOwner(subjectType: string, subjectId: string): Promise<number | null> {
    try {
      const checker = this.checkers.get(subjectType);
      if (!checker?.resolveOwner) return null;
      return (await checker.resolveOwner(subjectId)) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Sans objet lié : rien à vérifier. Avec objet lié : un contrôleur doit exister ET autoriser l'acteur,
   * sinon 403 (accès refusé par défaut).
   */
  async assertAccess(
    actor: SubjectActor,
    subjectType: string | null | undefined,
    subjectId: string | null | undefined,
  ): Promise<void> {
    if (subjectType == null && subjectId == null) return;
    if (subjectType == null || subjectId == null) {
      throw new ForbiddenException('Objet lié incomplet (type et identifiant requis).');
    }
    const checker = this.checkers.get(subjectType);
    if (!checker) {
      throw new ForbiddenException(`Type d'objet sans contrôle d'accès : « ${subjectType} ».`);
    }
    if (!(await checker.canAccess(actor, subjectId))) {
      throw new ForbiddenException("Accès refusé à l'objet lié.");
    }
  }
}
