import { MailActionCode, MailInputationTypeId, MailStatus, MailType } from '@archivage/types';
import { MailsService } from './mails.service';
import type { AuthUser } from '../auth/auth.types';

const user: AuthUser = { userId: 1, username: 'op', isAdmin: false, userGroupId: 9 };

describe('MailsService', () => {
  let prisma: {
    mail: {
      findMany: jest.Mock;
      findFirst: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
      count: jest.Mock;
    };
    mailInputation: { updateMany: jest.Mock };
    /** Affecté à la volée par les tests qui traversent une transaction. */
    $transaction?: jest.Mock;
    mailActionLog: { create: jest.Mock };
    appUser: { findUnique: jest.Mock };
    appUserGroup: { findMany: jest.Mock; findUnique: jest.Mock };
    role: { findMany: jest.Mock };
  };
  let notifications: { create: jest.Mock; createMany: jest.Mock };
  let scanned: { promoteToDocument: jest.Mock };
  let service: MailsService;

  beforeEach(() => {
    prisma = {
      mail: {
        findMany: jest.fn(),
        findFirst: jest.fn(),
        findUnique: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        count: jest.fn(),
      },
      mailInputation: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      mailActionLog: { create: jest.fn().mockResolvedValue({}) },
      appUser: { findUnique: jest.fn().mockResolvedValue({ roleId: null }) },
      appUserGroup: {
        findMany: jest.fn(),
        // Résolu par défaut : `actorName` lit cette table pour les libellés de notification.
        findUnique: jest.fn().mockResolvedValue(null),
      },
      role: { findMany: jest.fn() },
    };
    notifications = {
      create: jest.fn().mockResolvedValue({}),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    };
    scanned = { promoteToDocument: jest.fn() };
    service = new MailsService(prisma as never, notifications as never, scanned as never);
  });

  describe('listControle (§06)', () => {
    it('ne retient que les courriers adressés à l’acteur nommé connecté', async () => {
      prisma.mail.count.mockResolvedValue(0);
      prisma.mail.findMany.mockResolvedValue([]);
      prisma.appUser.findUnique.mockResolvedValue({ roleId: null });

      await service.listControle(user, { page: 1, pageSize: 25 });

      const expectedWhere = {
        isDeleted: false,
        valider: false,
        AND: [
          { OR: [{ status: { not: MailStatus.Redaction } }, { mailType: MailType.Arrivee }] },
          { OR: [{ destinataireExpediteur: 9 }] },
        ],
      };
      expect(prisma.mail.count).toHaveBeenCalledWith({ where: expectedWhere });
      expect(prisma.mail.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expectedWhere, skip: 0, take: 25 }),
      );
    });

    // Destinataire-rôle (§05) : un courrier adressé au rôle apparaît pour quiconque porte ce rôle,
    // pas seulement pour un acteur nommé précis.
    it('retient aussi les courriers adressés au rôle porté par l’utilisateur', async () => {
      prisma.mail.count.mockResolvedValue(0);
      prisma.mail.findMany.mockResolvedValue([]);
      prisma.appUser.findUnique.mockResolvedValue({ roleId: 4 });

      await service.listControle(user, { page: 1, pageSize: 25 });

      expect(prisma.mail.count).toHaveBeenCalledWith({
        where: expect.objectContaining({
          AND: expect.arrayContaining([
            { OR: [{ destinataireExpediteur: 9 }, { destinataireRoleId: 4 }] },
          ]),
        }),
      });
    });

    // userGroupId absent (compte sans groupe) : aucun acteur nommé ne correspond, et on ne
    // résout même pas de rôle — un tel compte ne doit jamais voir un courrier qui n'est pas le sien.
    it('sans userGroupId, ne retient rien (aucun acteur nommé ne peut correspondre)', async () => {
      prisma.mail.count.mockResolvedValue(0);
      prisma.mail.findMany.mockResolvedValue([]);
      const noGroup: AuthUser = { ...user, userGroupId: null };

      await service.listControle(noGroup, { page: 1, pageSize: 25 });

      expect(prisma.appUser.findUnique).not.toHaveBeenCalled();
      expect(prisma.mail.count).toHaveBeenCalledWith({
        where: expect.objectContaining({
          AND: expect.arrayContaining([{ OR: [{ destinataireExpediteur: -1 }] }]),
        }),
      });
    });
  });

  // §08 : au parapheur, chacun ne voit que SA branche de la chaîne d'imputations. Le destinataire
  // principal, qui pilote le courrier, en voit le déroulé complet.
  describe('getById — réduction des imputations (parapheur §08)', () => {
    // imputation #1 : adressée à moi (9) · #2 : créée par moi · #3 : entre tiers (invisible)
    const mailWithChain = {
      mailId: 1,
      title: 'Objet',
      destinataireExpediteur: 5,
      destinataireRoleId: null,
      inputations: [
        { mailInputationId: 1, userId: 9, createdBy: 5 },
        { mailInputationId: 2, userId: 7, createdBy: 9 },
        { mailInputationId: 3, userId: 7, createdBy: 5 },
      ],
    };

    it('sans restriction demandée, renvoie toute la chaîne (Recherche §11)', async () => {
      prisma.mail.findFirst.mockResolvedValue(mailWithChain);

      const res = await service.getById(1, user, false);

      expect(res.inputations).toHaveLength(3);
    });

    it('avec restriction, ne garde que mes imputations et celles que j’ai créées', async () => {
      prisma.mail.findFirst.mockResolvedValue(mailWithChain);

      const res = await service.getById(1, user, true);

      expect(res.inputations.map((i) => i.mailInputationId)).toEqual([1, 2]);
    });

    it('le destinataire principal échappe à la restriction', async () => {
      prisma.mail.findFirst.mockResolvedValue(mailWithChain);
      const destinataire: AuthUser = { ...user, userGroupId: 5 };

      const res = await service.getById(1, destinataire, true);

      expect(res.inputations).toHaveLength(3);
    });

    it('l’admin échappe à la restriction sans lire le rôle', async () => {
      prisma.mail.findFirst.mockResolvedValue(mailWithChain);

      const res = await service.getById(1, { ...user, isAdmin: true }, true);

      expect(res.inputations).toHaveLength(3);
      expect(prisma.appUserGroup.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('listValidationDirection (§10)', () => {
    // Sortie de file sur `dateTraited` et rien d'autre : c'est ici qu'on marque le courrier traité.
    // Filtrer sur `validationDirection` masquerait un courrier validé Direction resté non traité.
    it('liste les courriers validés au contrôle et non traités, sans filtre sur validationDirection', async () => {
      prisma.mail.count.mockResolvedValue(0);
      prisma.mail.findMany.mockResolvedValue([]);

      await service.listValidationDirection({ page: 1, pageSize: 25 });

      const expectedWhere = { isDeleted: false, valider: true, dateTraited: null };
      expect(prisma.mail.count).toHaveBeenCalledWith({ where: expectedWhere });
      expect(prisma.mail.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expectedWhere }),
      );
    });
  });

  describe('listParapheur (§08) — boîte de travail personnelle', () => {
    it('ne retient que les courriers avec une imputation non traitée à l’utilisateur connecté', async () => {
      prisma.mail.count.mockResolvedValue(0);
      prisma.mail.findMany.mockResolvedValue([]);

      await service.listParapheur(user, { page: 1, pageSize: 25 });

      const expectedWhere = {
        isDeleted: false,
        OR: [{ status: { not: MailStatus.Redaction } }, { mailType: MailType.Arrivee }],
        inputations: {
          some: {
            userId: 9,
            dateTreated: null,
            mailInputationTypeId: { not: MailInputationTypeId.EnCopie },
          },
        },
      };
      expect(prisma.mail.count).toHaveBeenCalledWith({ where: expectedWhere });
      expect(prisma.mail.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expectedWhere, skip: 0, take: 25 }),
      );
    });

    // « En Copie » (type 17) est une mise en connaissance, pas une charge de travail : elle ne doit
    // jamais à elle seule faire entrer un courrier dans le parapheur (il reste visible au Suivi).
    it('exclut les imputations « En Copie »', async () => {
      prisma.mail.count.mockResolvedValue(0);
      prisma.mail.findMany.mockResolvedValue([]);

      await service.listParapheur(user, { page: 1, pageSize: 25 });

      const where = prisma.mail.count.mock.calls[0][0].where as {
        inputations: { some: { mailInputationTypeId: unknown } };
      };
      expect(where.inputations.some.mailInputationTypeId).toEqual({
        not: MailInputationTypeId.EnCopie,
      });
    });

    // userGroupId absent (compte sans groupe) : ne doit jamais matcher une imputation « anonyme »
    // (userId n'est jamais NULL sur mail_inputation, mais on garde le même garde-fou que Contrôle).
    it('sans userGroupId, ne retient rien', async () => {
      prisma.mail.count.mockResolvedValue(0);
      prisma.mail.findMany.mockResolvedValue([]);
      const noGroup: AuthUser = { ...user, userGroupId: null };

      await service.listParapheur(noGroup, { page: 1, pageSize: 25 });

      expect(prisma.mail.count).toHaveBeenCalledWith({
        where: expect.objectContaining({
          inputations: expect.objectContaining({
            some: expect.objectContaining({ userId: -1, dateTreated: null }),
          }),
        }),
      });
    });
  });

  // §09/§10 : « Suivi permanent » voit tout, « Suivi des Courriers DC » seulement ses imputations,
  // et sans permission de suivi la file est VIDE (et non ouverte par défaut).
  describe('périmètre de suivi (Suivi §09 / Validation §10)', () => {
    const withMenus = (...menuKeys: string[]) =>
      prisma.appUser.findUnique.mockResolvedValue({
        isAdmin: false,
        role: { isActive: true, isSystem: false, menus: menuKeys.map((menuKey) => ({ menuKey })) },
      });

    it('« Suivi permanent » : aucune restriction personnelle sur listSuivi', async () => {
      withMenus('/courriers/suivi');
      prisma.mail.count.mockResolvedValue(0);
      prisma.mail.findMany.mockResolvedValue([]);

      await service.listSuivi(user, { page: 1, pageSize: 25 });

      expect(prisma.mail.count).toHaveBeenCalledWith({
        where: expect.objectContaining({ isDeleted: false, dateTraited: null }),
      });
      const where = prisma.mail.count.mock.calls[0][0].where as Record<string, unknown>;
      expect(where.inputations).toBeUndefined();
    });

    it('« DC » seul : listSuivi se limite aux courriers où l’utilisateur a une imputation', async () => {
      withMenus('/courriers/suivi-dc');
      prisma.mail.count.mockResolvedValue(0);
      prisma.mail.findMany.mockResolvedValue([]);

      await service.listSuivi(user, { page: 1, pageSize: 25 });

      expect(prisma.mail.count).toHaveBeenCalledWith({
        where: expect.objectContaining({ inputations: { some: { userId: 9 } } }),
      });
    });

    // Toute imputation compte, traitée ou non : c'est l'existence du lien qui donne la visibilité.
    it('« DC » ne filtre pas sur dateTreated (contrairement au parapheur)', async () => {
      withMenus('/courriers/suivi-dc');
      prisma.mail.count.mockResolvedValue(0);
      prisma.mail.findMany.mockResolvedValue([]);

      await service.listSuivi(user, { page: 1, pageSize: 25 });

      const where = prisma.mail.count.mock.calls[0][0].where as {
        inputations: { some: Record<string, unknown> };
      };
      expect(where.inputations.some).not.toHaveProperty('dateTreated');
    });

    // La Validation (§10) est gardée par son SEUL menu : la soumettre au périmètre de suivi rendait
    // la liste vide pour un rôle ayant la Validation sans permission de suivi.
    it('listValidationDirection ignore le périmètre de suivi', async () => {
      withMenus('/courriers/suivi-dc', '/courriers/validation');
      prisma.mail.count.mockResolvedValue(0);
      prisma.mail.findMany.mockResolvedValue([]);

      await service.listValidationDirection({ page: 1, pageSize: 25 });

      const where = prisma.mail.count.mock.calls[0][0].where as Record<string, unknown>;
      expect(where.inputations).toBeUndefined();
    });

    it('aucune permission de suivi : liste vide sans interroger la base', async () => {
      withMenus('/courriers/validation');

      await expect(service.listSuivi(user, { page: 1, pageSize: 25 })).resolves.toEqual({
        total: 0,
        page: 1,
        pageSize: 25,
        rows: [],
      });
      expect(prisma.mail.count).not.toHaveBeenCalled();
      expect(prisma.mail.findMany).not.toHaveBeenCalled();
    });

    it('admin : périmètre complet sans lecture du rôle', async () => {
      prisma.mail.count.mockResolvedValue(0);
      prisma.mail.findMany.mockResolvedValue([]);

      await service.listSuivi({ ...user, isAdmin: true }, { page: 1, pageSize: 25 });

      const where = prisma.mail.count.mock.calls[0][0].where as Record<string, unknown>;
      expect(where.inputations).toBeUndefined();
    });
  });

  describe('validationDirection (§10)', () => {
    // Valider en Direction déclare le courrier traité : sans ça, il resterait indéfiniment dans
    // le parapheur personnel de chacun de ses destinataires (§08, filtré sur dateTreated: null).
    it('traite toutes les imputations de chaque courrier validé (pas seulement le drapeau)', async () => {
      prisma.mail.updateMany.mockResolvedValue({ count: 2 });
      prisma.mail.findMany.mockResolvedValue([
        {
          mailId: 1,
          title: 'A',
          destinataireExpediteur: 5,
          destinataireRoleId: null,
          inputations: [],
        },
        {
          mailId: 2,
          title: 'B',
          destinataireExpediteur: 6,
          destinataireRoleId: null,
          inputations: [],
        },
      ]);

      await service.validationDirection([1, 2], user);

      expect(prisma.mail.updateMany).toHaveBeenCalledWith({
        where: { mailId: { in: [1, 2] }, isDeleted: false },
        data: expect.objectContaining({
          validationDirection: true,
          status: MailStatus.Traite,
          dateTraited: expect.any(Date),
        }),
      });
      expect(prisma.mailInputation.updateMany).toHaveBeenCalledWith({
        where: { mailId: { in: [1, 2] }, dateTreated: null },
        data: { dateTreated: expect.any(Date) },
      });
    });

    // Le message annonce à chacun à quel titre il est concerné (§10 `roleMessage` du source).
    describe('rôle annoncé à chaque destinataire', () => {
      const mailAvecRoles = {
        mailId: 1,
        title: 'Objet',
        destinataireExpediteur: 5,
        destinataireRoleId: null,
        inputations: [
          { userId: 7, mailInputationTypeId: MailInputationTypeId.EnCopie },
          { userId: 8, mailInputationTypeId: 10 },
        ],
      };

      it('groupe les destinataires par rôle, un message par groupe', async () => {
        prisma.mail.updateMany.mockResolvedValue({ count: 1 });
        prisma.mail.findMany.mockResolvedValue([mailAvecRoles]);
        prisma.appUserGroup.findUnique.mockResolvedValue({
          user: { fullName: 'Ibrahim KABLAN' },
        });

        await service.validationDirection([1], user);

        // Le rôle est porté par le CORPS DE L'E-MAIL ; le message in-app reste court et uniforme.
        const parRole = notifications.createMany.mock.calls.map((c) => [c[0], c[3].emailBody]);
        expect(parRole).toEqual(
          expect.arrayContaining([
            [[5], expect.stringContaining('destinataire principal')],
            [[7], expect.stringContaining('personne en copie')],
            [[8], expect.stringContaining('personne imputée')],
          ]),
        );
        // In-app : même libellé pour tous, la cloche n'affiche qu'une ligne.
        for (const call of notifications.createMany.mock.calls) {
          expect(call[1]).toBe('Validation Direction : Objet');
        }
      });

      // Un acteur cumulant deux rôles ne doit recevoir QU'UN message, le plus prioritaire —
      // sinon il reçoit deux e-mails contradictoires pour un seul courrier.
      it('classe un acteur cumulant deux rôles selon la priorité (destinataire d’abord)', async () => {
        prisma.mail.updateMany.mockResolvedValue({ count: 1 });
        prisma.mail.findMany.mockResolvedValue([
          {
            ...mailAvecRoles,
            // L'acteur 5 est destinataire ET en copie.
            inputations: [{ userId: 5, mailInputationTypeId: MailInputationTypeId.EnCopie }],
          },
        ]);

        await service.validationDirection([1], user);

        const cibles = notifications.createMany.mock.calls.flatMap((c) => c[0] as number[]);
        expect(cibles).toEqual([5]); // une seule fois, pas deux
        expect(notifications.createMany.mock.calls[0][3].emailBody).toContain(
          'destinataire principal',
        );
      });

      it('joint le validateur et la date de validation à l’e-mail', async () => {
        prisma.mail.updateMany.mockResolvedValue({ count: 1 });
        prisma.mail.findMany.mockResolvedValue([mailAvecRoles]);
        prisma.appUserGroup.findUnique.mockResolvedValue({
          user: { fullName: 'Ibrahim KABLAN' },
        });

        await service.validationDirection([1], user);

        const opts = notifications.createMany.mock.calls[0][3];
        expect(opts.severity).toBe('success');
        expect(opts.extraDetails).toEqual([
          { label: 'Validé par', value: 'Ibrahim KABLAN', strong: true },
          { label: 'Date de validation', value: expect.any(String) },
        ]);
      });
    });
  });

  describe('listActors (lookup destinataire/imputé)', () => {
    it('libelle « Nom — Groupe », trie en français et exclut les comptes désactivés', async () => {
      prisma.appUserGroup.findMany.mockResolvedValue([
        {
          userGroupId: 2,
          user: { fullName: 'Zoé Martin', username: 'zmartin', roleId: 3 },
          group: { name: 'Direction' },
        },
        {
          userGroupId: 1,
          user: { fullName: '  ', username: 'aduval', roleId: null },
          group: { name: 'Bureau ordre' },
        },
      ]);

      await expect(service.listActors()).resolves.toEqual([
        { userGroupId: 1, label: 'aduval — Bureau ordre', roleId: null }, // fullName vide → repli username
        { userGroupId: 2, label: 'Zoé Martin — Direction', roleId: 3 },
      ]);
      expect(prisma.appUserGroup.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { user: { isDisabled: false } } }),
      );
    });
  });

  describe('listDechargesEnAttente (§13)', () => {
    // Le critère est l'absence de pièce signée (mail_document.decharge = true), et non le drapeau
    // `Decharge` du courrier : c'est le document qui prouve la remise.
    it('ne liste que les Départs sans document de décharge rattaché', async () => {
      prisma.mail.findMany.mockResolvedValue([]);

      await service.listDechargesEnAttente();

      expect(prisma.mail.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            isDeleted: false,
            mailType: MailType.Depart,
            documents: { none: { decharge: true } },
          },
        }),
      );
    });
  });

  describe('numérotation NReference', () => {
    it('Arrivée : registre global hors Départ, max+1 en D5', async () => {
      prisma.mail.findMany.mockResolvedValue([{ nReference: '00003' }, { nReference: '00001' }]);
      await expect(service.previewNextArriveeReference()).resolves.toBe('00004');
      expect(prisma.mail.findMany).toHaveBeenCalledWith({
        where: { mailType: { not: MailType.Depart }, nReference: { not: null } },
        select: { nReference: true },
      });
    });

    it('Départ : numérotation par type, repli 00001 si aucun', async () => {
      prisma.mail.findMany.mockResolvedValue([]);
      await expect(service.previewNextDepartReference(7)).resolves.toBe('00001');
      expect(prisma.mail.findMany).toHaveBeenCalledWith({
        where: { mailType: MailType.Depart, mailDepartTypeId: 7, nReference: { not: null } },
        select: { nReference: true },
      });
    });
  });

  describe('listDestinataireRoles (lookup destinataire §05)', () => {
    it('liste les rôles triés, avec le nombre d’utilisateurs qui recevront le courrier', async () => {
      prisma.role.findMany.mockResolvedValue([
        { roleId: 2, name: 'Direction Générale', _count: { users: 2 } },
        { roleId: 1, name: 'Bureau d’ordre', _count: { users: 0 } },
      ]);

      await expect(service.listDestinataireRoles()).resolves.toEqual([
        { roleId: 1, label: 'Bureau d’ordre', userCount: 0 },
        { roleId: 2, label: 'Direction Générale', userCount: 2 },
      ]);
    });

    // Le rôle système est technique (comptes d'administration), pas une fonction du circuit
    // courrier : il n'a rien à faire dans la liste des destinataires. Filtré sur `isSystem` plutôt
    // que sur le libellé, qui est renommable depuis l'écran des rôles.
    it('exclut les rôles inactifs ET le rôle système', async () => {
      prisma.role.findMany.mockResolvedValue([]);

      await service.listDestinataireRoles();

      expect(prisma.role.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { isActive: true, isSystem: false } }),
      );
    });
  });

  describe('valider (§06)', () => {
    it('positionne Valider=true, notifie le destinataire et journalise le contrôle', async () => {
      prisma.mail.findFirst.mockResolvedValue({
        destinataireExpediteur: 5,
        destinataireRoleId: null,
      });
      prisma.mail.update.mockResolvedValue({
        mailId: 1,
        title: 'Objet',
        destinataireExpediteur: 5,
        destinataireRoleId: null,
      });

      await service.valider(1, user);

      expect(prisma.mail.update).toHaveBeenCalledWith({
        where: { mailId: 1 },
        data: expect.objectContaining({ valider: true, modifiedBy: 9 }),
      });
      expect(notifications.createMany).toHaveBeenCalledWith(
        [5],
        expect.any(String),
        {
          type: 'mail',
          id: 1,
        },
        expect.objectContaining({ subject: expect.any(String) }),
      );
      expect(prisma.mailActionLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          mailId: 1,
          actionCode: MailActionCode.Controle,
          userGroupId: 9,
        }),
      });
    });

    // §05 : le destinataire d'un Arrivée est un rôle — « notifier le destinataire » veut dire
    // notifier chacun de ses porteurs, sans quoi le courrier n'atteindrait personne.
    it('destinataire-rôle : notifie tous les utilisateurs qui portent le rôle', async () => {
      prisma.mail.findFirst.mockResolvedValue({
        destinataireExpediteur: null,
        destinataireRoleId: 4,
      });
      prisma.mail.update.mockResolvedValue({
        mailId: 1,
        title: 'Objet',
        destinataireExpediteur: null,
        destinataireRoleId: 4,
      });
      prisma.appUserGroup.findMany.mockResolvedValue([
        { userGroupId: 30, userId: 300 },
        { userGroupId: 31, userId: 301 },
      ]);

      await service.valider(1, user);

      expect(prisma.appUserGroup.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { user: { roleId: 4, isDisabled: false } } }),
      );
      expect(notifications.createMany).toHaveBeenCalledWith(
        [30, 31],
        expect.any(String),
        {
          type: 'mail',
          id: 1,
        },
        expect.objectContaining({ subject: expect.any(String) }),
      );
    });

    // Le bouton « Valider » n'existe plus : c'est l'imputation du destinataire qui déclenche le
    // contrôle. Le garde-fou est qu'un tiers imputant le courrier ne doit PAS le valider.
    describe('autoValiderOnImputation', () => {
      it('valide le courrier quand l’imputant est le destinataire nommé', async () => {
        prisma.mail.findFirst.mockResolvedValue({
          destinataireExpediteur: 9,
          destinataireRoleId: null,
        });
        prisma.mail.update.mockResolvedValue({
          mailId: 1,
          title: 'Objet',
          destinataireExpediteur: 9,
          destinataireRoleId: null,
        });

        await expect(service.autoValiderOnImputation(1, user)).resolves.toBe(true);
        expect(prisma.mail.update).toHaveBeenCalledWith({
          where: { mailId: 1 },
          data: expect.objectContaining({ valider: true }),
        });
      });

      it('valide quand l’imputant porte le rôle destinataire (§05)', async () => {
        prisma.mail.findFirst.mockResolvedValue({
          destinataireExpediteur: null,
          destinataireRoleId: 4,
        });
        prisma.appUserGroup.findUnique.mockResolvedValue({ user: { roleId: 4 } });
        prisma.appUserGroup.findMany.mockResolvedValue([{ userGroupId: 9, userId: 100 }]);
        prisma.mail.update.mockResolvedValue({
          mailId: 1,
          title: 'Objet',
          destinataireExpediteur: null,
          destinataireRoleId: 4,
        });

        await expect(service.autoValiderOnImputation(1, user)).resolves.toBe(true);
        expect(prisma.mail.update).toHaveBeenCalled();
      });

      it('ne valide pas quand l’imputant n’est pas le destinataire', async () => {
        prisma.mail.findFirst.mockResolvedValue({
          destinataireExpediteur: 5,
          destinataireRoleId: null,
        });

        await expect(service.autoValiderOnImputation(1, user)).resolves.toBe(false);
        expect(prisma.mail.update).not.toHaveBeenCalled();
      });

      // `findFirst` filtre déjà `valider: false` : un courrier déjà contrôlé ne repasse pas par là
      // (sinon chaque imputation rejouerait notification + journal de contrôle).
      it('ne fait rien quand le courrier est déjà validé', async () => {
        prisma.mail.findFirst.mockResolvedValue(null);

        await expect(service.autoValiderOnImputation(1, user)).resolves.toBe(false);
        expect(prisma.mail.update).not.toHaveBeenCalled();
        expect(prisma.mailActionLog.create).not.toHaveBeenCalled();
      });
    });

    // Une personne présente dans plusieurs groupes porte plusieurs `app_user_group` : sans
    // dédoublonnage par personne, elle recevrait le même courrier une fois par groupe.
    it('destinataire-rôle : une seule notification par personne multi-groupes', async () => {
      prisma.mail.findFirst.mockResolvedValue({
        destinataireExpediteur: null,
        destinataireRoleId: 4,
      });
      prisma.mail.update.mockResolvedValue({
        mailId: 1,
        title: 'Objet',
        destinataireExpediteur: null,
        destinataireRoleId: 4,
      });
      prisma.appUserGroup.findMany.mockResolvedValue([
        { userGroupId: 30, userId: 300 }, // identité par défaut (tri isDefault desc)
        { userGroupId: 99, userId: 300 }, // même personne, autre groupe
      ]);

      await service.valider(1, user);

      expect(notifications.createMany).toHaveBeenCalledWith(
        [30],
        expect.any(String),
        {
          type: 'mail',
          id: 1,
        },
        expect.objectContaining({ subject: expect.any(String) }),
      );
    });
  });

  // §13 : la décharge clôt l'échange. Les acteurs du courrier D'ORIGINE doivent l'apprendre —
  // sans quoi ils restent sur « réponse envoyée » sans savoir qu'elle a été reçue.
  describe('integrateDecharge — notification des acteurs du courrier parent', () => {
    /** Mocks minimaux de la transaction d'intégration. `mailParent` pilote le cas testé. */
    const armer = (mailParent: number | null) => {
      const tx = {
        mailDocument: { upsert: jest.fn().mockResolvedValue({}) },
        mail: {
          update: jest.fn().mockResolvedValue({
            mailId: 50,
            title: 'Réponse au courrier',
            mailParent,
            destinataireExpediteur: 3,
            destinataireRoleId: null,
          }),
        },
        mailScannedDocument: { update: jest.fn() },
      };
      prisma.$transaction = jest.fn(async (cb: (t: typeof tx) => unknown) => cb(tx));
      prisma.mail.findFirst.mockResolvedValue({
        title: 'Réponse au courrier',
        destinataireExpediteur: 3,
        destinataireRoleId: null,
      });
      return tx;
    };

    it('prévient tous les acteurs du parent (destinataire + imputés), en ciblant le parent', async () => {
      armer(7);
      prisma.mail.findUnique
        .mockResolvedValueOnce({ title: 'Demande initiale' }) // libellé du parent
        .mockResolvedValueOnce({
          // audience du parent
          destinataireExpediteur: 5,
          destinataireRoleId: null,
          inputations: [{ userId: 8 }, { userId: 9 }],
        });

      await service.integrateDecharge(50, { documentId: 12 }, user);

      const appel = notifications.createMany.mock.calls.find(
        (c) => c[3]?.subject === 'Décharge reçue',
      );
      expect(appel).toBeDefined();
      expect(appel![0]).toEqual([5, 8, 9]);
      // Cible = le courrier d'origine, pas la réponse : c'est celui que les acteurs connaissent.
      expect(appel![2]).toEqual({ type: 'mail', id: 7 });
    });

    // Départ autonome : personne n'était associé en amont, on ne notifie que son destinataire.
    it('sans courrier parent, ne notifie pas d’acteurs supplémentaires', async () => {
      armer(null);

      await service.integrateDecharge(50, { documentId: 12 }, user);

      const appel = notifications.createMany.mock.calls.find(
        (c) => c[3]?.subject === 'Décharge reçue',
      );
      expect(appel).toBeUndefined();
    });
  });

  describe('softDelete', () => {
    it('marque is_deleted (statut inchangé, fidèle à la source) sans suppression physique', async () => {
      prisma.mail.findFirst.mockResolvedValue({ mailId: 1 });
      prisma.mail.update.mockResolvedValue({ mailId: 1 });

      await service.softDelete(1, user);

      expect(prisma.mail.update).toHaveBeenCalledWith({
        where: { mailId: 1 },
        data: expect.objectContaining({ isDeleted: true, modifiedBy: 9 }),
      });
    });
  });
});
