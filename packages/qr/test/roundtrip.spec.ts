import { formatPayload, parsePayload } from '../src/payload';
import { generateQrPng } from '../src/generator';
import { decodeQrFromPng } from '../src/reader';

// Exercises the real qrcode -> zxing-wasm path (also validates the Phase 3 reader, T027).
describe('QR generate <-> decode round-trip', () => {
  it('decodes a generated intercalaire QR back to the same payload', async () => {
    const payload = formatPayload('DOSSIER', 1387);
    const png = await generateQrPng(payload, { scale: 8, margin: 4 });
    const decoded = await decodeQrFromPng(new Uint8Array(png));
    expect(decoded).toContain(payload);
    expect(parsePayload(decoded[0]!)).toEqual({
      status: 'ok',
      payload: { category: 'DOSSIER', id: 1387 },
    });
  }, 30000);

  it('round-trips a BLANK separator', async () => {
    const payload = formatPayload('BLANK', 0);
    const png = await generateQrPng(payload);
    const decoded = await decodeQrFromPng(new Uint8Array(png));
    expect(decoded).toContain(payload);
  }, 30000);
});
