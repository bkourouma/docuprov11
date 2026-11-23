import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { AuthUser } from '../auth/auth.types';
import type { MailScope } from './domain';
import { MailFicheService } from './mail-fiche.service';

// Le rendu proprement dit (gabarit, PDF) est hors sujet ici : seul le périmètre est testé.
jest.mock('@archivage/exports', () => ({
  fichePdfDoc: jest.fn(() => ({})),
  renderFichePdf: jest.fn(async () => Buffer.from('%PDF')),
  fillDocxTemplate: jest.fn(async () => Buffer.from('PK')),
}));
jest.mock('./domain', () => ({
  ...jest.requireActual('./domain'),
  buildFiche: jest.fn(() => ({ template: 'FICHE_IMPUTATION.docx', replacements: {} })),
}));

/**
 * ANO-COU-12 — Fiche d'Imputation (§09) ouverte au « Suivi DC » : la route accepte les deux
 * permissions de suivi, le service limite le Suivi DC aux courriers qui lui sont imputés.
 */
describe('MailFicheService — périmètre de la Fiche d’Imputation (§09)', () => {
  const dc: AuthUser = { userId: 1, username: 'dc', isAdmin: false, userGroupId: 9 };
  let prisma: { mail: { findFirst: jest.Mock } };
  let mails: { mailScope: jest.Mock };
  let service: MailFicheService;

  beforeEach(() => {
    prisma = { mail: { findFirst: jest.fn() } };
    mails = { mailScope: jest.fn() };
    service = new MailFicheService(prisma as never, mails as never);
    // L'assemblage des données (testé dans mail-fiche.service.spec) est neutralisé.
    jest.spyOn(service, 'getFicheInputs').mockResolvedValue({} as never);
  });

  const scope = (s: MailScope) => mails.mailScope.mockResolvedValue(s);

  it('Suivi DC, courrier imputé à l’utilisateur : PDF et DOCX rendus', async () => {
    scope('imputed');
    prisma.mail.findFirst.mockResolvedValue({ mailId: 7, inputations: [{ mailInputationId: 3 }] });

    const pdf = await service.renderPdf(7, new Date(), dc);
    const docx = await service.renderDocx(7, new Date(), dc);

    expect(pdf.filename).toMatch(/^FICHE_IMPUTATION_7_\d{14}\.pdf$/);
    expect(docx.filename).toMatch(/^FICHE_IMPUTATION_7_\d{14}\.docx$/);
    // Le lien cherché est une imputation DE l'utilisateur (son identité effective).
    expect(prisma.mail.findFirst).toHaveBeenCalledWith({
      where: { mailId: 7, isDeleted: false },
      select: {
        mailId: true,
        inputations: {
          where: { userId: 9 },
          select: { mailInputationId: true },
          take: 1,
        },
      },
    });
  });

  it('Suivi DC, courrier NON imputé : 403 « hors périmètre », rien n’est rendu', async () => {
    scope('imputed');
    prisma.mail.findFirst.mockResolvedValue({ mailId: 7, inputations: [] });

    const renders = [
      () => service.renderPdf(7, new Date(), dc),
      () => service.renderDocx(7, new Date(), dc),
    ];
    for (const render of renders) {
      const call = render();
      await expect(call).rejects.toBeInstanceOf(ForbiddenException);
      await expect(call).rejects.toThrow('Courrier hors de votre périmètre de suivi');
    }
    expect(service.getFicheInputs).not.toHaveBeenCalled();
  });

  it('Suivi DC sans identité effective : aucune imputation ne peut correspondre (403)', async () => {
    scope('imputed');
    prisma.mail.findFirst.mockResolvedValue({ mailId: 7, inputations: [] });

    await expect(
      service.renderPdf(7, new Date(), { ...dc, userGroupId: null }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.mail.findFirst.mock.calls[0][0].select.inputations.where).toEqual({
      userId: -1,
    });
  });

  it('Suivi permanent (ou admin) : aucune restriction, pas de lecture des imputations', async () => {
    scope('all');

    await expect(service.renderPdf(7, new Date(), dc)).resolves.toMatchObject({
      filename: expect.stringMatching(/\.pdf$/),
    });
    await expect(service.renderDocx(7, new Date(), dc)).resolves.toMatchObject({
      filename: expect.stringMatching(/\.docx$/),
    });
    expect(prisma.mail.findFirst).not.toHaveBeenCalled();
  });

  it('courrier inexistant : 404 en Suivi DC (existence vérifiée avant le périmètre)', async () => {
    scope('imputed');
    prisma.mail.findFirst.mockResolvedValue(null);

    await expect(service.renderPdf(99, new Date(), dc)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.renderDocx(99, new Date(), dc)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('courrier inexistant : 404 en Suivi permanent (levé par l’assemblage des données)', async () => {
    scope('all');
    (service.getFicheInputs as jest.Mock).mockRestore();
    prisma.mail.findFirst.mockResolvedValue(null);

    await expect(service.renderPdf(99, new Date(), dc)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('aucune permission de suivi : 403 sur un courrier existant', async () => {
    scope('none');
    prisma.mail.findFirst.mockResolvedValue({ mailId: 7, inputations: [{ mailInputationId: 3 }] });

    await expect(service.renderPdf(7, new Date(), dc)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
