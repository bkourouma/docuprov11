import { DashboardService } from './dashboard.service';
import type { AuthUser } from '../auth/auth.types';
import type { MailScope } from './domain';
import { dashboardFilterSchema } from './dashboard.dto';

const user: AuthUser = { userId: 1, username: 'op', isAdmin: false, userGroupId: 9 };
/** Filtre par défaut, tel que le pipe Zod le produirait pour un corps vide. */
const filtreParDefaut = dashboardFilterSchema.parse({});

describe('DashboardService', () => {
  let prisma: { $queryRaw: jest.Mock };
  let mails: { mailScope: jest.Mock };
  let service: DashboardService;

  const donnerScope = (scope: MailScope): void => {
    mails.mailScope.mockResolvedValue(scope);
  };
  /** Concatène le SQL de tous les appels, pour inspecter les fragments injectés. */
  const sqlEmis = (): string =>
    prisma.$queryRaw.mock.calls.map((c) => (c[0] as { sql?: string }).sql ?? '').join('\n');

  beforeEach(() => {
    prisma = { $queryRaw: jest.fn().mockResolvedValue([]) };
    mails = { mailScope: jest.fn() };
    service = new DashboardService(
      prisma as unknown as ConstructorParameters<typeof DashboardService>[0],
      mails as unknown as ConstructorParameters<typeof DashboardService>[1],
    );
  });

  describe('périmètre « none »', () => {
    // Sans permission de suivi, la réponse est vide — et surtout AUCUNE requête n'est émise :
    // interroger la base pour jeter le résultat serait au mieux du gaspillage, au pire une fuite
    // si un jour on oubliait de filtrer la réponse.
    it('rend des compteurs à zéro sans interroger la base', async () => {
      donnerScope('none');

      const alertes = await service.alertes(user, filtreParDefaut);
      const files = await service.files(user, filtreParDefaut);
      const synthese = await service.synthese(user, filtreParDefaut);

      expect(prisma.$queryRaw).not.toHaveBeenCalled();
      expect(alertes).toMatchObject({
        scope: 'none',
        courriersEnRetard: 0,
        imputationsEnRetard: 0,
        sansImputation: 0,
      });
      expect(files.enCours).toEqual({ count: 0, oldestDays: null });
      expect(synthese.enCours).toBe(0);
      expect(synthese.parType).toEqual([]);
    });
  });

  describe('périmètre « imputed »', () => {
    it('restreint aux courriers où l’utilisateur porte une imputation', async () => {
      donnerScope('imputed');
      await service.files(user, filtreParDefaut);

      expect(sqlEmis()).toContain('EXISTS (SELECT 1 FROM mail_inputation mi_s');
    });

    it('ne compte que les imputations de l’utilisateur dans les retards (D3)', async () => {
      donnerScope('imputed');
      await service.alertes(user, filtreParDefaut);

      expect(sqlEmis()).toContain('mi.user_id =');
    });
  });

  describe('périmètre « all »', () => {
    it('n’injecte aucune restriction de périmètre', async () => {
      donnerScope('all');
      await service.files(user, filtreParDefaut);

      expect(sqlEmis()).not.toContain('mi_s');
    });
  });

  describe('socle commun (§3.9)', () => {
    it('exclut toujours les courriers supprimés', async () => {
      donnerScope('all');
      await service.alertes(user, filtreParDefaut);

      expect(sqlEmis()).toContain('m.is_deleted = false');
    });

    it('applique la règle de visibilité (Arrivée visible même en Rédaction)', async () => {
      donnerScope('all');
      await service.alertes(user, filtreParDefaut);

      expect(sqlEmis()).toContain('m.status <> ');
      expect(sqlEmis()).toContain('OR m.mail_type = ');
    });
  });

  describe('quirks de files délibérément reproduits', () => {
    it('B5 se fonde sur le document de décharge, pas sur le drapeau mail.decharge', async () => {
      donnerScope('all');
      await service.files(user, filtreParDefaut);
      const sql = sqlEmis();

      expect(sql).toContain('FROM mail_document md');
      expect(sql).toContain('md.decharge = true');
      // Le drapeau du courrier ne doit JAMAIS servir de critère : seule la pièce signée fait foi.
      expect(sql).not.toContain('m.decharge = true');
    });

    it('B3 n’applique pas de filtre validation_direction (miroir de l’écran Validation)', async () => {
      donnerScope('all');
      await service.files(user, filtreParDefaut);

      // Le drapeau est posé en même temps que date_traited : le filtrer masquerait un courrier
      // validé mais non traité, et le compteur ne réconcilierait plus avec l'écran.
      expect(sqlEmis()).not.toContain('validation_direction');
    });
  });

  describe('flux (zone 4)', () => {
    it('remplit les périodes vides et borne la série à la fenêtre', async () => {
      donnerScope('all');
      await service.flux(user, filtreParDefaut);
      const sql = sqlEmis();

      // Sans generate_series + LEFT JOIN, les périodes sans activité disparaîtraient et la courbe
      // relierait deux dates non contiguës comme si rien ne s'était passé entre elles.
      expect(sql).toContain('generate_series');
      expect(sql).toContain('LEFT JOIN entrees');
      expect(sql).toContain('LEFT JOIN sorties');
      // generate_series inclut sa borne haute quand elle tombe juste → un seau de trop.
      expect(sql).toContain('s.bucket <');
    });

    it('amorce le cumul avec l’encours antérieur à la fenêtre', async () => {
      donnerScope('all');
      await service.flux(user, filtreParDefaut);

      // Sans amorce, la courbe repartirait de zéro à chaque changement de période.
      expect(sqlEmis()).toContain('amorce');
      expect(sqlEmis()).toContain(
        'SUM(COALESCE(e.n, 0) - COALESCE(x.n, 0)) OVER (ORDER BY s.bucket)',
      );
    });

    it('n’interroge pas la base en périmètre « none »', async () => {
      donnerScope('none');
      const r = await service.flux(user, filtreParDefaut);

      expect(prisma.$queryRaw).not.toHaveBeenCalled();
      expect(r.points).toEqual([]);
      expect(r.backlogInitial).toBe(0);
    });
  });

  describe('repartition (zone 5)', () => {
    const filtre = (dimension: Parameters<typeof service.repartition>[1]['dimension']) => ({
      ...filtreParDefaut,
      dimension,
    });

    it('joint le référentiel SANS filtrer sur is_active', async () => {
      donnerScope('all');
      await service.repartition(user, filtre('correspondant'));
      const sql = sqlEmis();

      // Un référentiel désactivé reste référencé par les courriers historiques : filtrer sur
      // l'actif les ferait disparaître du camembert et le total ne réconcilierait plus.
      expect(sql).toContain('LEFT JOIN external_entity ee');
      expect(sql).not.toContain('is_active');
    });

    it('traduit les codes numériques en libellés métier', async () => {
      donnerScope('all');
      prisma.$queryRaw.mockResolvedValueOnce([
        { cle: '0', valeur: 5 },
        { cle: '3', valeur: 2 },
      ]);

      const r = await service.repartition(user, filtre('statut'));

      // Trier des chaînes « 0 », « 1 »… serait illisible : la traduction précède le Top N.
      expect(r.tranches.map((t) => t.label)).toEqual(['Rédaction', 'Traité']);
      expect(r.total).toBe(7);
    });

    it('épingle la tranche non renseignée en dernier et conserve le total', async () => {
      donnerScope('all');
      prisma.$queryRaw.mockResolvedValueOnce([
        { cle: null, valeur: 40 },
        { cle: 'Ministère', valeur: 3 },
      ]);

      const r = await service.repartition(user, filtre('correspondant'));

      expect(r.tranches.at(-1)).toEqual({ label: '— Sans correspondant —', valeur: 40 });
      expect(r.tranches.reduce((a, t) => a + t.valeur, 0)).toBe(r.total);
    });

    it('adapte le libellé de la tranche nulle à la dimension', async () => {
      donnerScope('all');
      prisma.$queryRaw.mockResolvedValueOnce([{ cle: null, valeur: 9 }]);

      const r = await service.repartition(user, filtre('service'));

      // « Non rattaché » dit la cause (rôle sans organigramme), « Non renseigné » ne dirait rien.
      expect(r.tranches[0].label).toBe('— Non rattaché —');
    });
  });

  describe('retards (zone 6a)', () => {
    it('agrège par jour et laisse le domaine décider des tranches', async () => {
      donnerScope('all');
      // Une valeur par jour distinct, pas une ligne par courrier : le volume reste borné.
      prisma.$queryRaw
        .mockResolvedValueOnce([
          { j: -10, n: 3 }, // retard
          { j: 0, n: 2 }, // aujourd'hui
          { j: 5, n: 4 }, // J4–J7 — aucun rappel ne se déclenche à J-5
          { j: 30, n: 1 }, // au-delà
        ])
        .mockResolvedValueOnce([
          { a: 3, n: 2 },
          { a: 40, n: 5 },
        ])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ n: 7 }]);

      const r = await service.retards(user, filtreParDefaut);
      const par = Object.fromEntries(r.paliers.map((b) => [b.cle, b.count]));

      expect(par).toMatchObject({ retard: 3, aujourd_hui: 2, j4_j7: 4, au_dela: 1 });
      // Les tranches vides sont rendues à zéro : une tranche absente se lirait « pas de données ».
      expect(par.j1_j3).toBe(0);
      expect(r.sansEcheance).toBe(7);
    });

    it('rend toutes les tranches d’ancienneté, même vides', async () => {
      donnerScope('all');
      prisma.$queryRaw
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ a: 40, n: 5 }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ n: 0 }]);

      const r = await service.retards(user, filtreParDefaut);

      expect(r.anciennete.map((b) => b.cle)).toEqual([
        'moins_7',
        'entre_7_15',
        'entre_16_30',
        'plus_30',
      ]);
      expect(r.anciennete.find((b) => b.cle === 'plus_30')?.count).toBe(5);
    });
  });

  describe('delais (zone 6b)', () => {
    const reponsesDelais = (
      sla: Array<{
        mail_type: number;
        duree_ext: number | null;
        duree_int: number | null;
        d: number | null;
        n: number;
      }>,
      objetsSansDuree = 0,
    ): void => {
      prisma.$queryRaw
        .mockResolvedValueOnce([{ mediane: 1, p90: 3, n: 10 }]) // C1
        .mockResolvedValueOnce([{ mediane: 12, p90: 30, n: 40 }]) // C3
        .mockResolvedValueOnce(sla) // C4
        .mockResolvedValueOnce([{ n: objetsSansDuree }]) // G4
        .mockResolvedValueOnce([]); // C5
    };

    it('écarte du SLA les objets sans durée au lieu de les compter en échec', async () => {
      donnerScope('all');
      reponsesDelais(
        [
          { mail_type: 0, duree_ext: 10, duree_int: null, d: 5, n: 3 }, // dans les délais
          { mail_type: 0, duree_ext: 10, duree_int: null, d: 20, n: 2 }, // hors délais
          { mail_type: 0, duree_ext: 0, duree_int: 0, d: 99, n: 4 }, // NON configuré
        ],
        2,
      );

      const d = await service.delais(user, filtreParDefaut);

      // Compter les 4 non configurés en échec ferait chuter l'indicateur sans raison réelle.
      expect(d.sla).toMatchObject({
        configure: true,
        dansLesDelais: 3,
        horsDelais: 2,
        nonEvalues: 4,
        objetsSansDuree: 2,
      });
      // L'écran « Objets de courrier » étant masqué, aucun lien n'est proposé : il serait
      // inatteignable pour un non-admin.
      expect(d.sla.lienConfiguration).toBeNull();
    });

    it('rend configure=false quand aucune durée n’est exploitable', async () => {
      donnerScope('all');
      reponsesDelais([{ mail_type: 0, duree_ext: 0, duree_int: 0, d: 5, n: 6 }], 3);

      const d = await service.delais(user, filtreParDefaut);

      // L'écran affiche alors « SLA non configuré » + le geste correctif, pas un graphique vide.
      expect(d.sla.configure).toBe(false);
      expect(d.sla.nonEvalues).toBe(6);
      expect(d.sla.objetsSansDuree).toBe(3);
    });

    it('sépare les imputations auto-traitées des autres', async () => {
      donnerScope('all');
      prisma.$queryRaw
        .mockResolvedValueOnce([{ mediane: 1, p90: 3, n: 10 }])
        .mockResolvedValueOnce([{ mediane: 12, p90: 30, n: 40 }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ n: 0 }])
        .mockResolvedValueOnce([
          { suivi: true, mediane: 0, p90: 1, n: 14 },
          { suivi: false, mediane: 11, p90: 23, n: 28 },
        ]);

      const d = await service.delais(user, filtreParDefaut);

      // Fusionner les deux ferait passer l'auto-traitement à la lecture pour une performance.
      expect(d.imputations.auto).toEqual({ medianeJours: 0, p90Jours: 1, n: 14 });
      expect(d.imputations.manuel).toEqual({ medianeJours: 11, p90Jours: 23, n: 28 });
    });

    it('ne calcule rien en périmètre « none »', async () => {
      donnerScope('none');
      const d = await service.delais(user, filtreParDefaut);

      expect(prisma.$queryRaw).not.toHaveBeenCalled();
      expect(d.sla.configure).toBe(false);
      expect(d.traitementGlobal.n).toBe(0);
    });
  });

  describe('charge (zone 7) — restitution nominative', () => {
    it('refuse hors périmètre global, sans interroger la base', async () => {
      // La restriction vit dans le service, pas dans l'écran : un appel direct à l'endpoint ne
      // doit pas livrer le classement des collègues à un agent.
      for (const scope of ['imputed', 'none'] as const) {
        prisma.$queryRaw.mockClear();
        donnerScope(scope);
        await expect(service.charge(user, filtreParDefaut)).rejects.toThrow();
        expect(prisma.$queryRaw).not.toHaveBeenCalled();
      }
    });

    it('tait le délai médian sous le seuil d’effectif', async () => {
      donnerScope('all');
      prisma.$queryRaw
        .mockResolvedValueOnce([
          {
            user_group_id: 1,
            nom: 'Awa Ouattara',
            username: 'awa',
            groupe: "Bureau d'Ordre",
            ouvertes: 15,
            traitees: 3,
            en_retard: 4,
            mediane: 7,
            n: 3, // sous le seuil
          },
          {
            user_group_id: 2,
            nom: 'Bertin Kouassi',
            username: 'bertin',
            groupe: null,
            ouvertes: 14,
            traitees: 5,
            en_retard: 2,
            mediane: 4,
            n: 5, // au seuil
          },
        ])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ ouvertes: 0 }]);

      const c = await service.charge(user, filtreParDefaut);

      // Un percentile sur 3 dossiers n'est pas une performance ; dans un classement il le
      // deviendrait. Les compteurs, eux, restent affichés : ce sont des faits.
      expect(c.agents[0].delaiMedianJours).toBeNull();
      expect(c.agents[0].ouvertes).toBe(15);
      expect(c.agents[1].delaiMedianJours).toBe(4);
      expect(c.seuilEffectif).toBe(5);
      // Le libellé lève l'ambiguïté quand un même agent porte plusieurs groupes.
      expect(c.agents[0].label).toBe("Awa Ouattara — Bureau d'Ordre");
      expect(c.agents[1].label).toBe('Bertin Kouassi');
    });

    it('expose la tranche « Non rattaché » plutôt que de l’écarter', async () => {
      donnerScope('all');
      prisma.$queryRaw
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          { organigramme_id: 3, label: 'Direction Générale', depth: 0, ouvertes: 40 },
        ])
        .mockResolvedValueOnce([{ ouvertes: 60 }]);

      const c = await service.charge(user, filtreParDefaut);

      // Un WHERE organigramme_id IS NOT NULL silencieux ferait disparaître 60 imputations du
      // total, et l'absence de rattachement est précisément l'information utile (G9).
      expect(c.services.at(-1)).toEqual({
        organigrammeId: null,
        label: '— Non rattaché —',
        depth: 0,
        ouvertes: 60,
      });
    });

    it('n’ajoute pas la tranche « Non rattaché » quand elle est vide', async () => {
      donnerScope('all');
      prisma.$queryRaw
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          { organigramme_id: 3, label: 'Direction Générale', depth: 0, ouvertes: 40 },
        ])
        .mockResolvedValueOnce([{ ouvertes: 0 }]);

      const c = await service.charge(user, filtreParDefaut);

      expect(c.services).toHaveLength(1);
    });
  });

  describe('hygiene (zone 9)', () => {
    it('énonce la conséquence de chaque défaut, pas seulement son compteur', async () => {
      donnerScope('all');
      prisma.$queryRaw.mockResolvedValueOnce([
        { g1: 17, g2: 36, g3: 0, g4: 2, g5: 0, g6: 0, g7: 86, g8: 1, g9: 22 },
      ]);

      const h = await service.hygiene(user, filtreParDefaut);

      expect(h.indicateurs).toHaveLength(9);
      // Un compteur nu n'appelle aucune action ; la conséquence, si.
      expect(h.indicateurs.every((i) => i.consequence.length > 0)).toBe(true);
      expect(h.indicateurs.find((i) => i.cle === 'g1')?.count).toBe(17);
      expect(h.indicateurs.find((i) => i.cle === 'g9')?.count).toBe(22);
    });

    it('ne propose jamais un lien vers un écran masqué', async () => {
      donnerScope('all');
      prisma.$queryRaw.mockResolvedValueOnce([
        { g1: 0, g2: 0, g3: 0, g4: 5, g5: 0, g6: 0, g7: 0, g8: 3, g9: 0 },
      ]);

      const h = await service.hygiene(user, filtreParDefaut);
      const lien = (cle: string) => h.indicateurs.find((i) => i.cle === cle)?.lien;

      // « Objets de courrier » est dans HIDDEN_MENU_KEYS : non assignable à un rôle, donc un lien
      // y menant serait un cul-de-sac pour tout non-admin.
      expect(lien('g4')).toBeNull();
      // Les écrans ouverts, eux, restent cliquables.
      expect(lien('g8')).toBe('/admin/courriers/entites-externes');
      expect(lien('g9')).toBe('/admin/courriers/role-organigramme');
      // Pas d'écran dédié pour la suppression logique : mieux vaut null qu'un lien mensonger.
      expect(lien('g6')).toBeNull();
    });

    it('n’interroge pas la base en périmètre « none »', async () => {
      donnerScope('none');
      const h = await service.hygiene(user, filtreParDefaut);

      expect(prisma.$queryRaw).not.toHaveBeenCalled();
      expect(h.indicateurs).toEqual([]);
    });
  });

  describe('filtres de dimension', () => {
    it('remonte les descendants pour un filtre par service', async () => {
      donnerScope('all');
      await service.alertes(user, { ...filtreParDefaut, organigrammeId: 4 });

      // Filtrer sur le seul nœud exact ne rendrait rien pour une direction dont le courrier est
      // porté par ses services.
      expect(sqlEmis()).toContain("enfant.path LIKE racine.path || '%'");
    });

    it('n’ajoute aucune condition quand aucun filtre n’est fourni', async () => {
      donnerScope('all');
      await service.alertes(user, filtreParDefaut);

      expect(sqlEmis()).not.toContain('m.external_entity_id =');
      expect(sqlEmis()).not.toContain('m.organigramme_id IN');
    });
  });
});
