// QR bitmap generation (T041) via qrcode. Error-correction level Q (25%) and a quiet
// zone of >=4 modules per the QR contract / print recommendations (D-18).
import QRCode from 'qrcode';

export interface QrPngOptions {
  errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H';
  /** Pixels per module. */
  scale?: number;
  /** Quiet-zone width in modules. */
  margin?: number;
}

export function generateQrPng(payload: string, options: QrPngOptions = {}): Promise<Buffer> {
  return QRCode.toBuffer(payload, {
    type: 'png',
    errorCorrectionLevel: options.errorCorrectionLevel ?? 'Q',
    margin: options.margin ?? 4,
    scale: options.scale ?? 8,
  });
}
