import { toCsv, toDocx, toPdf, toXlsx, type ExportRequest } from '../src';

const req: ExportRequest = {
  title: 'Documents',
  columns: [
    { key: 'label', header: 'Libellé' },
    { key: 'cote', header: 'Cote' },
  ],
  rows: [
    { label: 'Facture 2026', cote: 'C-001' },
    { label: 'Contrat annuel', cote: 'C-002' },
  ],
};

const hex = (b: Buffer, n: number) => b.subarray(0, n).toString('hex');

describe('grid exports', () => {
  it('xlsx is a valid zip (PK header)', async () => {
    const b = await toXlsx(req);
    expect(hex(b, 2)).toBe('504b');
  });

  it('csv contains headers and data', async () => {
    const s = (await toCsv(req)).toString('utf8');
    expect(s).toContain('Libellé');
    expect(s).toContain('Facture 2026');
    expect(s).toContain('C-002');
  });

  it('docx is a valid zip (PK header)', async () => {
    expect(hex(await toDocx(req), 2)).toBe('504b');
  });

  it('pdf starts with %PDF', async () => {
    expect((await toPdf(req)).subarray(0, 4).toString('ascii')).toBe('%PDF');
  });
});
