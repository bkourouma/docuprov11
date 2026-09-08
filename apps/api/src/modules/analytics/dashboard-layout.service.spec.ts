import { DashboardLayoutService } from './dashboard-layout.service';
import { CLE_AGENCEMENT, WIDGET_CATALOG } from './dashboard-widgets';
import { AgencementService } from '../../common/agencement.service';
import { MENU_DASHBOARD_ARCHIVES } from '../roles/menu-catalog';
import type { AuthUser } from '../auth/auth.types';

const user: AuthUser = { userId: 7, username: 'archiviste', isAdmin: false, userGroupId: 2 };

/** Rôle porteur des clés données, tel que `effectiveMenuKeys` l'attend. */
const roleAvec = (...menus: string[]) => ({
  isActive: true,
  isSystem: false,
  menus: menus.map((menuKey) => ({ menuKey })),
});

describe('DashboardLayoutService (Docu-Archives)', () => {
  let prisma: {
    appUser: { findUnique: jest.Mock };
    userSetting: { findUnique: jest.Mock; upsert: jest.Mock; deleteMany: jest.Mock };
  };
  let service: DashboardLayoutService;

  /** Agencement stocké en base (ou `null` pour « jamais personnalisé »). */
  const stocke = (value: unknown | null): void => {
    prisma.userSetting.findUnique.mockResolvedValue(value === null ? null : { value });
  };
  const avecMenus = (...menus: string[]): void => {
    prisma.appUser.findUnique.mockResolvedValue({ isAdmin: false, role: roleAvec(...menus) });
  };

  beforeEach(() => {
    prisma = {
      appUser: { findUnique: jest.fn() },
      userSetting: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({}),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    // Le socle partagé est monté POUR DE VRAI sur le Prisma simulé : ces tests continuent donc de
    // couvrir la mécanique factorisée (garde de forme, bornage, dédoublonnage), et pas seulement
    // ce qui reste propre au module.
    service = new DashboardLayoutService(
      new AgencementService(
        prisma as unknown as ConstructorParameters<typeof AgencementService>[0],
      ),
    );
  });

  describe('agencement par défaut', () => {
    it('sert le défaut quand rien n’a été personnalisé', async () => {
      avecMenus(MENU_DASHBOARD_ARCHIVES);
      stocke(null);

      const r = await service.getForUser(user);

      expect(r.parDefaut).toBe(true);
      expect(r.widgets).toHaveLength(WIDGET_CATALOG.length);
      expect(r.colonnes).toBe(12);
    });

    it('retombe sur le défaut si l’agencement stocké est vide ou illisible', async () => {
      avecMenus(MENU_DASHBOARD_ARCHIVES);
      // Un écran nu ressemblerait à une panne : mieux vaut le défaut.
      stocke([]);
      expect((await service.getForUser(user)).parDefaut).toBe(true);

      stocke([{ pasUnPlacement: true }, 42, null]);
      expect((await service.getForUser(user)).parDefaut).toBe(true);
    });

    it('reproduit la mise en page historique : les quatre répartitions restent deux par deux', async () => {
      avecMenus(MENU_DASHBOARD_ARCHIVES);
      stocke(null);

      const parId = new Map((await service.getForUser(user)).widgets.map((w) => [w.id, w]));

      // Ouvrir le mode personnalisable ne doit rien déplacer de ce que les utilisateurs connaissent.
      expect(parId.get('type')).toMatchObject({ x: 0, w: 6 });
      expect(parId.get('programme')).toMatchObject({ x: 6, w: 6 });
      expect(parId.get('type')!.y).toBe(parId.get('programme')!.y);
      expect(parId.get('localisation')!.y).toBe(parId.get('plan')!.y);
    });
  });

  describe('re-filtrage des permissions À LA LECTURE', () => {
    it('masque tous les widgets sans accès à l’écran, SANS les effacer', async () => {
      // L'utilisateur avait composé son tableau de bord ; l'accès lui a été retiré depuis.
      avecMenus('/search');
      stocke([{ id: 'kpis', x: 0, y: 0, w: 12, h: 5 }]);

      const r = await service.getForUser(user);

      expect(r.widgets).toHaveLength(0);
      expect(r.disponibles).toHaveLength(0);
      // Rien n'a été réécrit : si le droit revient, l'agencement reprend sa place.
      expect(prisma.userSetting.upsert).not.toHaveBeenCalled();
    });

    it('rend les widgets dès que l’accès est rétabli', async () => {
      avecMenus(MENU_DASHBOARD_ARCHIVES);
      stocke([{ id: 'kpis', x: 0, y: 0, w: 12, h: 5 }]);

      expect((await service.getForUser(user)).widgets.map((w) => w.id)).toEqual(['kpis']);
    });
  });

  describe('catalogue et instance séparés', () => {
    it('ignore un identifiant absent du catalogue', async () => {
      avecMenus(MENU_DASHBOARD_ARCHIVES);
      // Widget retiré du code depuis : il s'évapore sans migration de données.
      stocke([
        { id: 'kpis', x: 0, y: 0, w: 12, h: 5 },
        { id: 'widget-supprime-en-v2', x: 0, y: 5, w: 6, h: 4 },
      ]);

      expect((await service.getForUser(user)).widgets.map((w) => w.id)).toEqual(['kpis']);
    });

    it('prend titre et bornes dans le CATALOGUE, jamais dans le JSON stocké', async () => {
      avecMenus(MENU_DASHBOARD_ARCHIVES);
      stocke([{ id: 'kpis', x: 0, y: 0, w: 12, h: 5, titre: 'Libellé périmé' }]);

      const [w] = (await service.getForUser(user)).widgets;

      // Sinon un agencement ancien figerait un libellé corrigé depuis.
      expect(w.titre).toBe('Chiffres clés');
      expect(w.minW).toBe(6);
    });
  });

  describe('enregistrement', () => {
    const enregistre = (): unknown[] =>
      prisma.userSetting.upsert.mock.calls[0][0].create.value as unknown[];

    it('refuse un widget que l’utilisateur n’a pas le droit de voir', async () => {
      avecMenus('/search');
      stocke(null);

      await service.save(user, [{ id: 'kpis', x: 0, y: 0, w: 12, h: 5 }]);

      // Écrire soi-même le JSON ne doit pas suffire à s'offrir un écran auquel on n'a pas accès.
      expect(enregistre()).toHaveLength(0);
    });

    it('borne les tailles au minimum du catalogue', async () => {
      avecMenus(MENU_DASHBOARD_ARCHIVES);
      stocke(null);

      await service.save(user, [{ id: 'kpis', x: 99, y: -5, w: 1, h: 1 }]);

      expect(enregistre()[0]).toEqual({ id: 'kpis', x: 11, y: 0, w: 6, h: 4 });
    });

    it('dédoublonne : un même widget ne peut être placé deux fois', async () => {
      avecMenus(MENU_DASHBOARD_ARCHIVES);
      stocke(null);

      await service.save(user, [
        { id: 'kpis', x: 0, y: 0, w: 12, h: 5 },
        { id: 'kpis', x: 0, y: 5, w: 12, h: 5 },
      ]);

      expect(enregistre()).toHaveLength(1);
    });
  });

  describe('réinitialisation', () => {
    it('supprime le réglage au lieu d’y recopier le défaut du moment', async () => {
      avecMenus(MENU_DASHBOARD_ARCHIVES);
      stocke(null);

      await service.reset(user);

      // Recopier le défaut figerait l'utilisateur sur l'agencement d'aujourd'hui ; le supprimer
      // le fait bénéficier des évolutions livrées ensuite.
      expect(prisma.userSetting.deleteMany).toHaveBeenCalledWith({
        where: { userId: user.userId, settingKey: CLE_AGENCEMENT },
      });
      expect(prisma.userSetting.upsert).not.toHaveBeenCalled();
    });
  });
});
