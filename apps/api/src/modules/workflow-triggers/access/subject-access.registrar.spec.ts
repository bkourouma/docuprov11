import { ForbiddenException } from '@nestjs/common';
import { SubjectAccessRegistry } from '../../workflows/extension/subject-access';
import type { DocumentSubjectAccessChecker } from './document-subject-access.checker';
import type { MailSubjectAccessChecker } from './mail-subject-access.checker';
import { WorkflowSubjectAccessRegistrar } from './subject-access.registrar';

describe('WorkflowSubjectAccessRegistrar', () => {
  it('enregistre « mail » et « document » uniquement', async () => {
    const registry = new SubjectAccessRegistry();
    const mail = { subjectType: 'mail', canAccess: jest.fn().mockResolvedValue(true) };
    const document = { subjectType: 'document', canAccess: jest.fn().mockResolvedValue(true) };
    new WorkflowSubjectAccessRegistrar(
      registry,
      mail as unknown as MailSubjectAccessChecker,
      document as unknown as DocumentSubjectAccessChecker,
    ).onModuleInit();

    expect(registry.get('mail')).toBe(mail);
    expect(registry.get('document')).toBe(document);
    expect(registry.get('dossier')).toBeUndefined();
    expect(registry.get('other')).toBeUndefined();
    await expect(registry.assertAccess({ userGroupId: 1 }, 'mail', '4')).resolves.toBeUndefined();
    await expect(registry.assertAccess({ userGroupId: 1 }, 'dossier', '4')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(registry.assertAccess({ userGroupId: 1 }, 'other', '4')).rejects.toBeInstanceOf(ForbiddenException);
  });
});
