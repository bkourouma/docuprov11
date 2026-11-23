import { NotFoundException } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import type { AuthUser } from '../auth/auth.types';

// Seuls les jetons d'injection comptent ici : les vrais services tireraient Prisma, ExcelJS…
jest.mock('@archivage/exports', () => ({ exportRows: jest.fn() }));
jest.mock('@archivage/storage', () => ({ DiskFileStore: class {} }));
jest.mock('../search/search.service', () => ({ SearchService: class {} }));
jest.mock('./documents.service', () => ({ DocumentsService: class {}, actorName: () => 'x' }));
jest.mock('./document-tabs.service', () => ({ DocumentTabsService: class {} }));
jest.mock('./sealing-key.service', () => ({ SealingKeyService: class {} }));

import { DocumentsController } from './documents.controller';

const user: AuthUser = { userId: 7, username: 'agent', isAdmin: false, userGroupId: 70 };
const DOC = 42;

/**
 * Routes `:id/...` des onglets de la fiche : chacune doit refuser (404) un compte qui ne peut pas
 * ouvrir le document, AVANT de déléguer au service. `[méthode du contrôleur, appel, méthode du
 * service d'onglets attendue]`.
 */
type Call = (c: DocumentsController) => Promise<unknown>;
const GUARDED: Array<[string, Call, string]> = [
  ['lifeCycle', (c) => c.lifeCycle(DOC, user), 'getLifeCycle'],
  [
    'saveLifeCycle',
    (c) =>
      c.saveLifeCycle(DOC, { usefulnessLifespan: '2030-01-01', complianceLifespan: '2031-01-01' }, user),
    'saveLifeCycle',
  ],
  ['permissions', (c) => c.permissions(DOC, user), 'listPermissions'],
  [
    'grantPermission',
    (c) => c.grantPermission(DOC, { userGroupId: 70, permissionLevelId: 5 }, user),
    'grantPermission',
  ],
  ['revokePermission', (c) => c.revokePermission(DOC, 9, user), 'revokePermission'],
  ['confidentialite', (c) => c.confidentialite(DOC, user), 'getConfidentialite'],
  [
    'setConfidentialite',
    (c) => c.setConfidentialite(DOC, { confidentialiteId: null }, user),
    'setConfidentialite',
  ],
  ['lendings', (c) => c.lendings(DOC, user), 'listLendings'],
  ['integrity', (c) => c.integrity(DOC, user), 'getIntegrity'],
  ['verifyIntegrity', (c) => c.verifyIntegrity(DOC, user), 'verifyIntegrity'],
  ['seal', (c) => c.seal(DOC, user), 'verifySeal'],
  ['applySeal', (c) => c.applySeal(DOC, user), 'sealDocument'],
  ['scanning', (c) => c.scanning(DOC, user), 'getScanningSettings'],
  ['history', (c) => c.history(DOC, user), 'listHistory'],
];

/**
 * Routes `:id…` volontairement HORS de la garde du contrôleur, avec la raison. Toute nouvelle
 * route `:id/...` doit entrer dans l'une des deux listes : le test ci-dessous échoue sinon.
 */
const EXEMPT: Record<string, string> = {
  getOne: '`DocumentsService.getDetail` appelle `canAccess` lui-même',
  content: '`DocumentsService.getFileForDownload` appelle `canAccess` lui-même',
  remove: '`AdminGuard` : réservé aux administrateurs, qui passent `canAccess`',
  indexation:
    '`DocumentsService.indexDocument` appelle `canAccess` lui-même (puis contrôle le niveau effectif)',
};

function build(canAccess: boolean) {
  const tabMethods = Object.fromEntries(
    GUARDED.map(([, , m]) => [m, jest.fn().mockResolvedValue({ ok: m })]),
  );
  const documents = { canAccess: jest.fn().mockResolvedValue(canAccess) };
  const sealingKey = { get: jest.fn().mockResolvedValue({ fingerprint: 'fp' }) };
  const config = { getOrThrow: jest.fn().mockReturnValue('/tmp/archives') };
  const controller = new DocumentsController(
    {} as never,
    documents as never,
    tabMethods as never,
    sealingKey as never,
    config as never,
  );
  return { controller, documents, tabMethods };
}

describe('DocumentsController : onglets de la fiche réservés à qui peut l’ouvrir', () => {
  it.each(GUARDED)('%s → 404 « Document introuvable » sans appeler le service', async (_n, call, m) => {
    const { controller, documents, tabMethods } = build(false);
    await expect(call(controller)).rejects.toBeInstanceOf(NotFoundException);
    await expect(call(controller)).rejects.toThrow('Document introuvable');
    expect(documents.canAccess).toHaveBeenCalledWith(DOC, user);
    expect(tabMethods[m]).not.toHaveBeenCalled();
  });

  it.each(GUARDED)('%s → délègue au service quand l’accès est accordé', async (_n, call, m) => {
    const { controller, documents, tabMethods } = build(true);
    await expect(call(controller)).resolves.toEqual({ ok: m });
    expect(documents.canAccess).toHaveBeenCalledWith(DOC, user);
    expect(tabMethods[m]).toHaveBeenCalledTimes(1);
  });

  it('chaque route gardée reçoit bien l’utilisateur courant (@CurrentUser)', () => {
    for (const [name] of GUARDED) {
      const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, DocumentsController, name) as Record<
        string,
        unknown
      >;
      const custom = Object.keys(args ?? {}).filter((k) => k.includes('__customRouteArgs__'));
      expect({ name, custom: custom.length }).toEqual({ name, custom: 1 });
    }
  });

  it('toute route `:id…` du contrôleur est gardée ou explicitement exemptée', () => {
    const proto = DocumentsController.prototype as unknown as Record<string, object>;
    const routes = Object.getOwnPropertyNames(DocumentsController.prototype)
      .filter((n) => n !== 'constructor')
      .filter((n) => Reflect.getMetadata(METHOD_METADATA, proto[n]) !== undefined)
      .filter((n) => String(Reflect.getMetadata(PATH_METADATA, proto[n])).startsWith(':id'));
    const covered = new Set([...GUARDED.map(([n]) => n), ...Object.keys(EXEMPT)]);
    expect(routes.filter((n) => !covered.has(n))).toEqual([]);
    // Et la liste des routes gardées ne cite pas de méthode fantôme.
    for (const [n] of GUARDED) expect(routes).toContain(n);
  });
});
