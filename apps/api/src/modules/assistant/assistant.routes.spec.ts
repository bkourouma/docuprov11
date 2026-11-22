import 'reflect-metadata';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ASST_ROUTE_MENU, ASST_ROUTES } from '@archivage/types';
import { MenuPermissionGuard } from '../auth/menu-permission.guard';
import { REQUIRE_ADMIN_KEY, REQUIRE_MENU_KEY } from '../auth/require-menu.decorator';
import { AssistantController } from './assistant.controller';
import { ASSISTANT_MENU } from './assistant.menus';

const METHOD_NAME: Partial<Record<RequestMethod, string>> = {
  [RequestMethod.GET]: 'GET',
  [RequestMethod.POST]: 'POST',
  [RequestMethod.DELETE]: 'DELETE',
};

interface Route {
  handler: string;
  method: string;
  /** Chemin complet, comme dans ASST_ROUTES. */
  path: string;
  menus: string[] | undefined;
  httpCode: number | undefined;
}

function controllerRoutes(): Route[] {
  const proto = AssistantController.prototype as unknown as Record<string, unknown>;
  const base = String(Reflect.getMetadata(PATH_METADATA, AssistantController));
  const classMenus = Reflect.getMetadata(REQUIRE_MENU_KEY, AssistantController) as string[] | undefined;
  const out: Route[] = [];
  for (const name of Object.getOwnPropertyNames(proto)) {
    const fn = proto[name];
    if (name === 'constructor' || typeof fn !== 'function') continue;
    const method = Reflect.getMetadata(METHOD_METADATA, fn) as RequestMethod | undefined;
    if (method === undefined) continue;
    const sub = String(Reflect.getMetadata(PATH_METADATA, fn));
    out.push({
      handler: name,
      method: METHOD_NAME[method] ?? String(method),
      path: `/${base}/${sub}`.replace(/\/+/g, '/'),
      menus: (Reflect.getMetadata(REQUIRE_MENU_KEY, fn) as string[] | undefined) ?? classMenus,
      httpCode: Reflect.getMetadata(HTTP_CODE_METADATA, fn) as number | undefined,
    });
  }
  return out;
}

const key = (r: { method: string; path: string }) => `${r.method} ${r.path}`;

describe('routes assistant : conformité à ASST_ROUTES', () => {
  const routes = controllerRoutes();

  it('le contrôleur expose exactement les 8 routes du catalogue (méthode + chemin)', () => {
    expect(ASST_ROUTES).toHaveLength(8);
    expect(routes.map(key).sort()).toEqual(ASST_ROUTES.map(key).sort());
  });

  it('statut de succès : 201 création et message, 204 suppression, 200 sinon', () => {
    for (const def of ASST_ROUTES) {
      const route = routes.find((r) => key(r) === key(def));
      // Sans @HttpCode, Nest répond 201 sur POST et 200 sur le reste.
      const effective = route?.httpCode ?? (def.method === 'POST' ? 201 : 200);
      expect({ route: key(def), status: effective }).toEqual({ route: key(def), status: def.successStatus });
    }
  });

  it('accès refusé par défaut : MenuPermissionGuard sur la classe, menu /assistant sur chaque route', () => {
    expect(((Reflect.getMetadata(GUARDS_METADATA, AssistantController) as unknown[]) ?? []).includes(MenuPermissionGuard)).toBe(true);
    expect(Reflect.getMetadata(REQUIRE_ADMIN_KEY, AssistantController)).toBeUndefined();
    for (const r of routes) {
      expect({ route: key(r), menus: r.menus }).toEqual({ route: key(r), menus: ['/assistant'] });
    }
  });

  it('le menu du catalogue est celui du contrat partagé', () => {
    expect(ASST_ROUTE_MENU).toBe('/assistant');
    expect(ASSISTANT_MENU).toBe(ASST_ROUTE_MENU);
    for (const def of ASST_ROUTES) expect(def.menu).toBe(ASSISTANT_MENU);
  });
});

// Le document est écrit en parallèle : ce bloc peut échouer tant que docs/assistant-api.md n'existe pas.
describe('docs/assistant-api.md', () => {
  const candidates = [
    join(__dirname, '../../../../../docs/assistant-api.md'),
    join(process.cwd(), 'docs/assistant-api.md'),
    join(process.cwd(), '../../docs/assistant-api.md'),
  ];
  const file = candidates.find((p) => existsSync(p));

  it('le document existe', () => {
    expect(file).toBeDefined();
  });

  it.each(ASST_ROUTES.map((r) => [key(r)] as const))('mentionne « %s »', (route) => {
    expect(file).toBeDefined();
    const text = readFileSync(file as string, 'utf-8');
    expect(text).toContain(route);
  });
});
