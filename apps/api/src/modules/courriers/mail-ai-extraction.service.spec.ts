import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { GedAiTask } from '@archivage/types';
import {
  AiMaskingRequiredError,
  AiProviderError,
  AiUnsupportedInputError,
} from '../ai/ai.types';
import { MailAiExtractionService } from './mail-ai-extraction.service';

const valid = {
  title: 'Demande',
  date: '2026-01-02',
  reference: 'R1',
  externalEntityId: 5,
  externalEntityLabel: 'Ministere',
  destinataireRoleId: 7,
  description: 'Resume',
};

function setup() {
  const ai = { status: jest.fn().mockResolvedValue({ enabled: true, mode: 2 }), run: jest.fn() };
  const mails = { listDestinataireRoles: jest.fn().mockResolvedValue([{ roleId: 7, label: 'DG' }]) };
  const refs = {
    listExternalEntities: jest.fn().mockResolvedValue([{ externalEntityId: 5, label: 'Ministere' }]),
  };
  const extractor = {
    isOperational: jest.fn().mockReturnValue(true),
    extractText: jest.fn().mockResolvedValue('Objet : demande de subvention'),
  };
  const service = new MailAiExtractionService(ai as never, mails as never, refs as never, extractor as never);
  return { ai, extractor, service };
}

const scan = (name = 'a.pdf', size = 10) => ({
  originalname: name,
  buffer: Buffer.from('x'),
  size,
});

/** Simule AiService.run : applique `parse` au JSON fourni, comme le vrai service. */
const runWith = (raw: string) => async (opts: { parse: (r: string) => unknown }) => ({
  disabled: false,
  data: opts.parse(raw),
});

describe('MailAiExtractionService', () => {
  it('refuse un fichier absent (400)', async () => {
    await expect(setup().service.extract(undefined)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuse une extension non gérée (400)', async () => {
    const { ai, service } = setup();
    await expect(service.extract(scan('a.tiff'))).rejects.toBeInstanceOf(BadRequestException);
    expect(ai.run).not.toHaveBeenCalled();
  });

  it('refuse un fichier de plus de 10 Mo (400)', async () => {
    await expect(setup().service.extract(scan('a.pdf', 10 * 1024 * 1024 + 1))).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('transmet la requête attendue et renvoie la sortie', async () => {
    const { ai, extractor, service } = setup();
    ai.run.mockImplementation(runWith(JSON.stringify(valid)));
    const out = await service.extract(scan('scan.PNG'));
    expect(extractor.extractText).toHaveBeenCalledWith({ buffer: expect.any(Buffer), mediaType: 'image/png' });
    expect(out).toEqual(valid);
    const opts = ai.run.mock.calls[0][0];
    expect(opts.task).toBe(GedAiTask.ExtractionMetadonnees);
    expect(opts.autoApply).toBe(false);
    expect(opts.minTimeoutSeconds).toBe(180);
    expect(opts.allowUnmaskedAttachments).toBeUndefined();
    expect(opts.request.attachments).toBeUndefined();
    expect(opts.request.text).toContain('Objet : demande de subvention');
    expect(opts.request.text).toContain('5 — Ministere');
    expect(opts.request.text).toContain('7 — DG');
    expect(opts.request.jsonSchema.name).toBe('mail_extraction');
    expect(opts.request.jsonSchema.schema.additionalProperties).toBe(false);
  });

  it('texte vide => erreur sans appel IA', async () => {
    const { ai, extractor, service } = setup();
    extractor.extractText.mockRejectedValue(new BadRequestException('Aucun texte lisible'));
    await expect(service.extract(scan())).rejects.toBeInstanceOf(BadRequestException);
    expect(ai.run).not.toHaveBeenCalled();
  });

  it('un PDF est lu comme application/pdf', async () => {
    const { ai, extractor, service } = setup();
    ai.run.mockImplementation(runWith(JSON.stringify(valid)));
    await service.extract(scan('a.pdf'));
    expect(extractor.extractText).toHaveBeenCalledWith({ buffer: expect.any(Buffer), mediaType: 'application/pdf' });
  });


  it('met à null les identifiants hors des listes', async () => {
    const { ai, service } = setup();
    ai.run.mockImplementation(
      runWith(JSON.stringify({ ...valid, externalEntityId: 99, destinataireRoleId: 98 })),
    );
    const out = await service.extract(scan());
    expect(out.externalEntityId).toBeNull();
    expect(out.destinataireRoleId).toBeNull();
  });

  it('IA désactivée => 503', async () => {
    const { ai, service } = setup();
    ai.run.mockResolvedValue({ disabled: true, message: 'off' });
    await expect(service.extract(scan())).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it("IA coupée => 503 sans lecture OCR locale ni appel IA", async () => {
    const { ai, extractor, service } = setup();
    ai.status.mockResolvedValue({ enabled: false, mode: 0 });
    await expect(service.extract(scan())).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(extractor.extractText).not.toHaveBeenCalled();
    expect(ai.run).not.toHaveBeenCalled();
  });

  it('AiMaskingRequiredError => 503 au message clair', async () => {
    const { ai, service } = setup();
    ai.run.mockRejectedValue(new AiMaskingRequiredError('x'));
    const p = service.extract(scan());
    await expect(p).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(p).rejects.toThrow(/n'a pas pu être masqué/);
  });

  it('AiUnsupportedInputError => 400 avec son message', async () => {
    const { ai, service } = setup();
    ai.run.mockRejectedValue(new AiUnsupportedInputError('PDF non supporté'));
    const p = service.extract(scan());
    await expect(p).rejects.toBeInstanceOf(BadRequestException);
    await expect(p).rejects.toThrow('PDF non supporté');
  });

  it('AiProviderError => 503', async () => {
    const { ai, service } = setup();
    ai.run.mockRejectedValue(new AiProviderError('boom'));
    const p = service.extract(scan());
    await expect(p).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(p).rejects.toThrow(/a échoué/);
  });

  it('JSON invalide => 503', async () => {
    const { ai, service } = setup();
    ai.run.mockImplementation(runWith('pas du json'));
    const p = service.extract(scan());
    await expect(p).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(p).rejects.toThrow(/n'a pas pu être analysé/);
  });

  it("isEnabled : faux si l'extracteur local est inutilisable", async () => {
    const { ai, extractor, service } = setup();
    extractor.isOperational.mockReturnValue(false);
    ai.status.mockResolvedValue({ enabled: true, mode: 2 });
    expect(await service.isEnabled()).toBe(false);
  });

  it('isEnabled reflète status()', async () => {
    const { ai, service } = setup();
    ai.status.mockResolvedValueOnce({ enabled: true, mode: 2 });
    expect(await service.isEnabled()).toBe(true);
    ai.status.mockResolvedValueOnce({ enabled: false, mode: 0 });
    expect(await service.isEnabled()).toBe(false);
  });
});
