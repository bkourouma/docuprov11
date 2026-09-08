import { NotFoundException } from '@nestjs/common';
import { MailStatus, MailType } from '@archivage/types';
import { MailFicheService } from './mail-fiche.service';

const actor = (fullName: string | null, username = 'u') => ({ user: { fullName, username } });

describe('MailFicheService — données de la Fiche d’Imputation (§09)', () => {
  let prisma: { mail: { findFirst: jest.Mock } };
  let service: MailFicheService;

  beforeEach(() => {
    prisma = { mail: { findFirst: jest.fn() } };
    service = new MailFicheService(prisma as never);
  });

  const baseMail = {
    mailId: 7,
    title: 'Demande de subvention',
    reference: 'REF-88',
    nReference: '00042',
    date: new Date('2026-07-10T00:00:00.000Z'),
    dateButoire: new Date('2026-07-23T00:00:00.000Z'),
    dateDecharge: null,
    dateEnregistrementCourrier: new Date('2026-07-16T08:00:00.000Z'),
    createdAt: new Date('2026-07-16T08:05:00.000Z'),
    mailType: MailType.Arrivee,
    status: MailStatus.Traite,
    destinataireExpediteur: 3,
    externalEntity: { label: 'Ministère des Finances' },
    nature: { label: 'Officiel' },
    confidentialite: { label: 'Restreint' },
    objet: { label: 'Demande' },
    organigramme: { label: 'Direction Générale' },
    parent: null,
    destinataire: actor('Admin Système'),
    createdByUser: actor('Agent BO'),
    description: 'Corps du courrier',
    inputations: [],
  };

  it('projette les champs du GetMailForViewDto documenté', async () => {
    prisma.mail.findFirst.mockResolvedValue(baseMail);

    const f = await service.getFicheData(7);

    expect(f).toMatchObject({
      mailId: 7,
      title: 'Demande de subvention',
      reference: 'REF-88',
      nReference: '00042',
      confidentialitesName: 'Restreint',
      externalEntityName: 'Ministère des Finances',
      mailNature: 'Officiel',
      mailObjet: 'Demande',
      direction: 'Direction Générale', // `Direction` du source = organigramme
      destinataireFullName: 'Admin Système',
      destinataireExpediteurId: 3,
      userCreated: 'Agent BO',
      mailDisplayProperty: null,
    });
    expect(f.statut).toBe('Traité');
    expect(f.mailTypeName).toBe('Arrivée');
  });

  it('ne lit que les courriers non supprimés', async () => {
    prisma.mail.findFirst.mockResolvedValue(baseMail);
    await service.getFicheData(7);
    expect(prisma.mail.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { mailId: 7, isDeleted: false } }),
    );
  });

  it('lève NotFound sur un courrier inexistant', async () => {
    prisma.mail.findFirst.mockResolvedValue(null);
    await expect(service.getFicheData(99)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('LastImputation* = la DERNIÈRE imputation NON TRAITÉE (projection §08)', async () => {
    prisma.mail.findFirst.mockResolvedValue({
      ...baseMail,
      inputations: [
        {
          mailInputationId: 1,
          type: { label: 'En Copie' },
          user: actor('Copie Agent'),
          instructions: null,
          deadline: null,
          dateTreated: new Date('2026-07-16T09:00:00.000Z'),
        },
        {
          mailInputationId: 2,
          type: { label: 'Pour Suivi' },
          user: actor('Suivi Agent'),
          instructions: 'À traiter',
          deadline: new Date('2026-07-18T09:00:00.000Z'),
          dateTreated: null,
        },
        {
          mailInputationId: 3,
          type: { label: 'Validation DG' },
          user: actor('DG'),
          instructions: null,
          deadline: new Date('2026-07-19T09:00:00.000Z'),
          dateTreated: null,
        },
      ],
    });

    const f = await service.getFicheData(7);

    // La dernière NON traitée est l'imputation 3, pas l'imputation 2 ni la 1 (traitée).
    expect(f.lastImputationFullName).toBe('DG');
    expect(f.inputationTypeName).toBe('Validation DG');
    expect(f.deadline).toEqual(new Date('2026-07-19T09:00:00.000Z'));
    // Le détail complet reste disponible pour un tableau du gabarit.
    expect(f.imputations).toHaveLength(3);
    expect(f.imputations[1]).toMatchObject({ typeName: 'Pour Suivi', instructions: 'À traiter' });
  });

  it('sans imputation ouverte, les champs « dernière imputation » sont nuls', async () => {
    prisma.mail.findFirst.mockResolvedValue({
      ...baseMail,
      inputations: [
        {
          mailInputationId: 1,
          type: { label: 'En Copie' },
          user: actor('Copie'),
          instructions: null,
          deadline: null,
          dateTreated: new Date('2026-07-16T09:00:00.000Z'),
        },
      ],
    });

    const f = await service.getFicheData(7);

    expect(f.lastImputationFullName).toBeNull();
    expect(f.inputationTypeName).toBeNull();
    expect(f.deadline).toBeNull();
  });

  it('retombe sur le username quand le nom complet manque', async () => {
    prisma.mail.findFirst.mockResolvedValue({
      ...baseMail,
      destinataire: actor(null, 'agent.bo'),
      createdByUser: actor('   ', 'sys'),
    });

    const f = await service.getFicheData(7);

    expect(f.destinataireFullName).toBe('agent.bo');
    expect(f.userCreated).toBe('sys'); // un nom blanc ne doit pas produire une fiche vide
  });

  it('reprend le libellé du courrier parent (MailDisplayProperty)', async () => {
    prisma.mail.findFirst.mockResolvedValue({ ...baseMail, parent: { title: 'Courrier initial' } });
    const f = await service.getFicheData(7);
    expect(f.mailDisplayProperty).toBe('Courrier initial');
  });
});
