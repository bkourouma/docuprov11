import { SubjectAccessRegistry, type SubjectAccessChecker } from './subject-access';

const base = { subjectType: 'mail', canAccess: () => Promise.resolve(true) };

describe('SubjectAccessRegistry.resolveOwner', () => {
  it('renvoie null sans contrôleur enregistré', async () => {
    await expect(new SubjectAccessRegistry().resolveOwner('mail', '1')).resolves.toBeNull();
  });

  it('renvoie null si le contrôleur n\'a pas de resolveOwner', async () => {
    const registry = new SubjectAccessRegistry();
    registry.register(base as SubjectAccessChecker);
    await expect(registry.resolveOwner('mail', '1')).resolves.toBeNull();
  });

  it('renvoie null (sans lever) si le contrôleur lève', async () => {
    const registry = new SubjectAccessRegistry();
    registry.register({ ...base, resolveOwner: () => Promise.reject(new Error('boom')) });
    await expect(registry.resolveOwner('mail', '1')).resolves.toBeNull();
  });

  it('renvoie le propriétaire du contrôleur (cas nominal)', async () => {
    const registry = new SubjectAccessRegistry();
    const resolveOwner = jest.fn().mockResolvedValue(42);
    registry.register({ ...base, resolveOwner });
    await expect(registry.resolveOwner('mail', '7')).resolves.toBe(42);
    expect(resolveOwner).toHaveBeenCalledWith('7');
  });

  it('renvoie null si le contrôleur renvoie null', async () => {
    const registry = new SubjectAccessRegistry();
    registry.register({ ...base, resolveOwner: () => Promise.resolve(null) });
    await expect(registry.resolveOwner('mail', '7')).resolves.toBeNull();
  });
});
