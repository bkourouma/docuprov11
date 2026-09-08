import { DashboardLayoutService } from './dashboard-layout.service';
import { CLE_AGENCEMENT, WIDGET_CATALOG } from './dashboard-widgets';
import { AgencementService } from '../../common/agencement.service';
import type { AuthUser } from '../auth/auth.types';

const user: AuthUser = { userId: 3, username: 'bo.courrier', isAdmin: false, userGroupId: 9 };

/** Rôle porteur des clés données, tel que `effectiveMenuKeys` l'attend. */
const roleAvec = (...menus: string[]) => ({
  isActive: true,
  isSystem: false,
  menus: menus.map((menuKey) => ({ menuKey })),
});

describe('DashboardLayoutService', () => {
  let prisma: {
    appUser: { findUnique: jest.Mock };
    userSetting: { findUnique: jest.Mock; upsert: jest.Mock; deleteMany: jest.Mock };
  };
  let service: DashboardLayoutService;

  /** Agencement stocké en base (ou `null` pour « jamais personnalisé »). */
  const stocke = (value: unknown | null): void => {
    prisma.userSetting.findUnique.mockResolvedValue(value === null ? null : { value });
  };
  /** Périmètre de l'utilisateur, via ses clés de menu. */
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
      avecMenus('/courriers/tableau-de-bord', '/courriers/suivi');
      stocke(null);

      const r = await service.getForUser(user);

      expect(r.parDefaut).toBe(true);
      expect(r.widgets).toHaveLength(WIDGET_CATALOG.length);
      expect(r.scope).toBe('all');
    });

    it('retombe sur le défaut si l’agencement stocké est vide ou illisible', async () => {
      avecMenus('/courriers/tableau-de-bord', '/courriers/suivi');
      // Un écran nu ressemblerait à une panne : mieux vaut le défaut.
      stocke([]);

      expect((await service.getForUser(user)).parDefaut).toBe(true);

      stocke([{ pasUnPlacement: true }, 42, null]);
      expect((await service.getForUser(user)).parDefaut).toBe(true);
    });
  });

  describe('re-filtrage des permissions À LA LECTURE', () => {
    it('masque un widget dont le périmètre n’est plus accordé, SANS l’effacer', async () => {
      // L'utilisateur avait placé « charge » (réservé au suivi permanent) ; son droit est
      // depuis retombé sur le périmètre restreint.
      avecMenus('/courriers/tableau-de-bord', '/courriers/suivi-dc');
      stocke([
        { id: 'alertes', x: 0, y: 0, w: 6, h: 4 },
        { id: 'charge', x: 0, y: 4, w: 12, h: 10 },
      ]);

      const r = await service.getForUser(user);

      expect(r.scope).toBe('imputed');
      expect(r.widgets.map((w) => w.id)).toEqual(['alertes']);
      // Le catalogue proposable ne doit pas non plus le remettre à portée de clic.
      expect(r.disponibles.some((d) => d.id === 'charge')).toBe(false);
      // Rien n'a été réécrit : si le droit revient, le widget reprend sa place.
      expect(prisma.userSetting.upsert).not.toHaveBeenCalled();
    });

    it('rend le widget dès que le périmètre est rétabli', async () => {
      avecMenus('/courriers/tableau-de-bord', '/courriers/suivi');
      stocke([
        { id: 'alertes', x: 0, y: 0, w: 6, h: 4 },
        { id: 'charge', x: 0, y: 4, w: 12, h: 10 },
      ]);

      const r = await service.getForUser(user);

      expect(r.widgets.map((w) => w.id)).toEqual(['alertes', 'charge']);
    });

    it('rend un tableau vide sans périmètre de suivi', async () => {
      avecMenus('/courriers/tableau-de-bord');
      stocke(null);

      const r = await service.getForUser(user);

      expect(r.scope).toBe('none');
      expect(r.widgets).toHaveLength(0);
      expect(r.disponibles).toHaveLength(0);
    });
  });

  describe('catalogue et instance séparés', () => {
    it('ignore un identifiant absent du catalogue', async () => {
      avecMenus('/courriers/tableau-de-bord', '/courriers/suivi');
      // Widget retiré du code depuis : il s'évapore sans migration de données.
      stocke([
        { id: 'alertes', x: 0, y: 0, w: 6, h: 4 },
        { id: 'widget-supprime-en-v2', x: 0, y: 4, w: 6, h: 4 },
      ]);

      const r = await service.getForUser(user);

      expect(r.widgets.map((w) => w.id)).toEqual(['alertes']);
    });

    it('prend titre et bornes dans le CATALOGUE, jamais dans le JSON stocké', async () => {
      avecMenus('/courriers/tableau-de-bord', '/courriers/suivi');
      stocke([{ id: 'alertes', x: 0, y: 0, w: 6, h: 4, titre: 'Libellé périmé' }]);

      const [w] = (await service.getForUser(user)).widgets;

      // Sinon un agencement ancien figerait un libellé corrigé depuis.
      expect(w.titre).toBe('Alertes');
      expect(w.minW).toBe(4);
    });

    it('ne charge que les jeux de données des widgets placés', async () => {
      avecMenus('/courriers/tableau-de-bord', '/courriers/suivi');
      stocke([
        { id: 'alertes', x: 0, y: 0, w: 6, h: 4 },
        { id: 'retards', x: 0, y: 4, w: 12, h: 12 },
      ]);

      const r = await service.getForUser(user);

      expect(r.dataKeys.sort()).toEqual(['alertes', 'retards']);
    });
  });

  describe('enregistrement', () => {
    const enregistre = (): unknown[] =>
      prisma.userSetting.upsert.mock.calls[0][0].create.value as unknown[];

    it('refuse un widget que l’utilisateur n’a pas le droit de voir', async () => {
      avecMenus('/courriers/tableau-de-bord', '/courriers/suivi-dc');
      stocke(null);

      await service.save(user, [
        { id: 'alertes', x: 0, y: 0, w: 6, h: 4 },
        // Écrire soi-même le JSON ne doit pas suffire à s'offrir la vue nominative.
        { id: 'charge', x: 0, y: 4, w: 12, h: 10 },
      ]);

      expect((enregistre() as Array<{ id: string }>).map((p) => p.id)).toEqual(['alertes']);
    });

    it('borne les tailles au minimum du catalogue', async () => {
      avecMenus('/courriers/tableau-de-bord', '/courriers/suivi');
      stocke(null);

      await service.save(user, [{ id: 'alertes', x: 99, y: -5, w: 1, h: 1 }]);

      expect(enregistre()[0]).toEqual({ id: 'alertes', x: 11, y: 0, w: 4, h: 3 });
    });

    it('dédoublonne : un même widget ne peut être placé deux fois', async () => {
      avecMenus('/courriers/tableau-de-bord', '/courriers/suivi');
      stocke(null);

      await service.save(user, [
        { id: 'alertes', x: 0, y: 0, w: 6, h: 4 },
        { id: 'alertes', x: 6, y: 0, w: 6, h: 4 },
      ]);

      expect(enregistre()).toHaveLength(1);
    });
  });

  describe('réinitialisation', () => {
    it('supprime le réglage au lieu d’y recopier le défaut du moment', async () => {
      avecMenus('/courriers/tableau-de-bord', '/courriers/suivi');
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
