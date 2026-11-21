import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { MenuPermissionGuard } from '../auth/menu-permission.guard';
import { REQUIRE_ADMIN_KEY, REQUIRE_MENU_KEY } from '../auth/require-menu.decorator';
import { DefinitionsController } from './definitions.controller';
import { InboxController } from './inbox.controller';
import { InstancesController } from './instances.controller';
import { WORKFLOWS_MENUS } from './workflows.menus';

interface Route {
  controller: string;
  handler: string;
  method: RequestMethod;
  path: string;
  menus: string[] | undefined;
  admin: boolean;
}

function routesOf(ctrl: new (...a: never[]) => object): Route[] {
  const proto = ctrl.prototype as Record<string, unknown>;
  const out: Route[] = [];
  for (const name of Object.getOwnPropertyNames(proto)) {
    const fn = proto[name];
    if (name === 'constructor' || typeof fn !== 'function') continue;
    const method = Reflect.getMetadata(METHOD_METADATA, fn) as RequestMethod | undefined;
    if (method === undefined) continue;
    const handlerMenus = Reflect.getMetadata(REQUIRE_MENU_KEY, fn) as string[] | undefined;
    const classMenus = Reflect.getMetadata(REQUIRE_MENU_KEY, ctrl) as string[] | undefined;
    out.push({
      controller: ctrl.name,
      handler: name,
      method,
      path: String(Reflect.getMetadata(PATH_METADATA, fn)),
      menus: handlerMenus ?? classMenus,
      admin: !!(Reflect.getMetadata(REQUIRE_ADMIN_KEY, fn) ?? Reflect.getMetadata(REQUIRE_ADMIN_KEY, ctrl)),
    });
  }
  return out;
}

const guarded = (c: new (...a: never[]) => object) =>
  ((Reflect.getMetadata(GUARDS_METADATA, c) as unknown[]) ?? []).includes(MenuPermissionGuard);

describe('routes workflows : accès refusé par défaut', () => {
  it('définitions et instances sont derrière MenuPermissionGuard, la boîte non (JwtAuthGuard global)', () => {
    expect(guarded(DefinitionsController)).toBe(true);
    expect(guarded(InstancesController)).toBe(true);
    expect(guarded(InboxController)).toBe(false);
  });

  it('toute route d’écriture (hors boîte) exige un menu ou l’administrateur', () => {
    const writes = [...routesOf(DefinitionsController), ...routesOf(InstancesController)].filter(
      (r) => r.method !== RequestMethod.GET,
    );
    expect(writes.length).toBeGreaterThan(0);
    for (const r of writes) {
      const ok = r.admin || (r.menus?.length ?? 0) > 0;
      expect({ route: `${r.controller}.${r.handler}`, ok }).toEqual({ route: `${r.controller}.${r.handler}`, ok: true });
    }
  });

  it('seules les routes de la boîte et le détail d’instance (lecture) n’exigent aucun menu', () => {
    const noMenu = [
      ...routesOf(DefinitionsController),
      ...routesOf(InstancesController),
      ...routesOf(InboxController),
    ]
      .filter((r) => !r.admin && !(r.menus?.length ?? 0))
      .map((r) => `${r.controller}.${r.handler}`)
      .sort();
    const inbox = routesOf(InboxController).map((r) => `InboxController.${r.handler}`);
    expect(noMenu).toEqual([...inbox, 'InstancesController.detail'].sort());
  });

  it('le lancement exige LANCER ; annuler / suspendre / reprendre : LANCER ou ADMIN', () => {
    const byHandler = Object.fromEntries(routesOf(InstancesController).map((r) => [r.handler, r]));
    expect(byHandler.launch?.menus).toEqual([WORKFLOWS_MENUS.launch]);
    for (const h of ['cancel', 'suspend', 'resume', 'list']) {
      expect(byHandler[h]?.menus).toEqual([WORKFLOWS_MENUS.launch, WORKFLOWS_MENUS.admin]);
    }
  });

  it('la boîte expose claim / complete / reject / delegate sur :itemId', () => {
    const paths = routesOf(InboxController).map((r) => r.path).sort();
    expect(paths).toEqual([':itemId/claim', ':itemId/complete', ':itemId/delegate', ':itemId/reject', '/'].sort());
  });
});
