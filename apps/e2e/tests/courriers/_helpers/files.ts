/**
 * Fichiers de test : PDF minimal VALIDE (1 page, une ligne de texte, table xref exacte), écrit à la
 * main pour ne dépendre d'aucune bibliothèque dans `apps/e2e`.
 *
 * Hypothèses à vérifier en phase B :
 *  - `api.upload(path, { field, file, fields })` accepte `file` au format Playwright
 *    `{ name, mimeType, buffer }` (forme de `pdfUpload`). `setInputFiles` accepte la même forme.
 *  - Le dépôt §07 n'inspecte que l'extension (`.pdf`) : le contenu n'est pas validé côté API,
 *    mais la visionneuse (pdf.js) et la promotion GED reçoivent un vrai PDF.
 */

/** Texte PDF littéral : ASCII imprimable seulement, parenthèses et antislash échappés. */
function pdfText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\x20-\x7e]/g, '?')
    .replace(/([\\()])/g, '\\$1');
}

export function samplePdf(text = 'Courrier de test E2E'): Buffer {
  const content = `BT /F1 18 Tf 72 720 Td (${pdfText(text)}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];

  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) body += `${String(off).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

export function pdfUpload(
  name = 'courrier-e2e.pdf',
  text?: string,
): { name: string; mimeType: 'application/pdf'; buffer: Buffer } {
  return { name, mimeType: 'application/pdf', buffer: samplePdf(text ?? name) };
}
