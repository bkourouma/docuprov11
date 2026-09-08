// QR decoding (T027) via zxing-wasm. zxing-wasm is ESM-only; load it with a real
// dynamic import that survives CommonJS downleveling.
const esmImport = new Function('specifier', 'return import(specifier)') as <T = unknown>(
  specifier: string,
) => Promise<T>;

export interface DecodableImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

interface ZXingReader {
  readBarcodes: (input: unknown, options?: unknown) => Promise<Array<{ text: string }>>;
}

let readerPromise: Promise<ZXingReader> | null = null;
function loadReader(): Promise<ZXingReader> {
  readerPromise ??= esmImport<ZXingReader>('zxing-wasm/reader');
  return readerPromise;
}

const QR_OPTIONS = { formats: ['QRCode'], tryHarder: true };

/** Decode QR codes from a raw RGBA image (e.g. a rasterized PDF page). */
export async function decodeQrFromImage(image: DecodableImage): Promise<string[]> {
  const { readBarcodes } = await loadReader();
  const results = await readBarcodes(image, QR_OPTIONS);
  return results.map((r) => r.text).filter((t) => t.length > 0);
}

/** Decode QR codes from an encoded image (PNG/JPEG bytes). */
export async function decodeQrFromPng(png: Uint8Array): Promise<string[]> {
  const { readBarcodes } = await loadReader();
  const results = await readBarcodes(new Blob([png]), QR_OPTIONS);
  return results.map((r) => r.text).filter((t) => t.length > 0);
}
