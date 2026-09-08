import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import JSZip from 'jszip';
import { fillDocxTemplate, findDocxTokens } from './docx-template';

/**
 * Le VRAI gabarit du Sénat. C'est le seul test qui prouve quoi que ce soit : Word y éclate les
 * jetons sur plusieurs runs, ce qu'un gabarit fabriqué pour le test ne reproduirait pas.
 */
const TEMPLATE = join(__dirname, '../../../apps/api/assets/templates/FICHE_IMPUTATION.docx');

/** Texte lisible d'un .docx, paragraphe par paragraphe (runs recomposés). */
async function docxText(buf: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buf);
  const xml = await zip.file('word/document.xml')!.async('string');
  const paras = xml.match(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g) ?? [];
  return paras
    .map((p) => [...p.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((m) => m[1]).join(''))
    .join('\n');
}

describe('fillDocxTemplate — contre le vrai gabarit FICHE_IMPUTATION.docx', () => {
  let template: Buffer;

  beforeAll(async () => {
    template = await readFile(TEMPLATE);
  });

  it('le gabarit porte bien des jetons éclatés entre runs (sinon ce test ne prouve rien)', async () => {
    const zip = await JSZip.loadAsync(template);
    const xml = await zip.file('word/document.xml')!.async('string');
    // Le jeton entier n'existe PAS dans le XML brut : il est découpé.
    expect(xml).not.toContain('%date_arrivee%');
    // …mais il est bien présent une fois les runs recomposés.
    expect(await findDocxTokens(template)).toContain('%date_arrivee%');
  });

  it('substitue les jetons éclatés', async () => {
    const out = await fillDocxTemplate(template, {
      '%date_arrivee%': '16/07/2026',
      '%numero_enregistrement%': '00042',
      '%correspondant%': 'Ministère des Finances',
      '%objet%': 'Demande de subvention 2026',
    });
    const text = await docxText(out);
    expect(text).toContain('16/07/2026');
    expect(text).toContain('00042');
    expect(text).toContain('Ministère des Finances');
    expect(text).toContain('Demande de subvention 2026');
    expect(text).not.toContain('%date_arrivee%');
    expect(text).not.toContain('%objet%');
  });

  it('substitue aussi les jetons entiers dans un seul run', async () => {
    const out = await fillDocxTemplate(template, { '%description%': 'courrier-scanne' });
    expect(await docxText(out)).toContain('courrier-scanne');
  });

  it('laisse intacts les jetons non fournis (cas du gabarit alternatif)', async () => {
    const out = await fillDocxTemplate(template, { '%objet%': 'X' });
    expect(await findDocxTokens(out)).toContain('%copies%');
  });

  it('conserve le texte fixe du gabarit', async () => {
    const out = await fillDocxTemplate(template, { '%objet%': 'X' });
    const text = await docxText(out);
    expect(text).toContain('FICHE DE TRAITEMENT DU COURRIER');
    expect(text).toContain('I. INFORMATIONS GÉNÉRALES');
    expect(text).toContain('IV. HISTORIQUE DE TRAITEMENT DU COURRIER');
  });

  it('rend un .docx toujours valide (zip + parties Word préservées)', async () => {
    const out = await fillDocxTemplate(template, { '%objet%': 'X' });
    const zip = await JSZip.loadAsync(out);
    expect(zip.file('word/document.xml')).not.toBeNull();
    expect(zip.file('word/styles.xml')).not.toBeNull();
    expect(zip.file('[Content_Types].xml')).not.toBeNull();
    // La signature ZIP « PK » : le fichier s'ouvre bien comme une archive.
    expect(out.subarray(0, 2).toString()).toBe('PK');
  });

  it('échappe le XML : une valeur avec & ou < ne casse pas le document', async () => {
    const out = await fillDocxTemplate(template, { '%objet%': 'Fourniture & <maintenance>' });
    const zip = await JSZip.loadAsync(out);
    const xml = await zip.file('word/document.xml')!.async('string');
    expect(xml).toContain('Fourniture &amp; &lt;maintenance&gt;');
    // Le document reste parsable : autant de balises ouvrantes que fermantes.
    expect((xml.match(/<w:t[ >]/g) ?? []).length).toBe((xml.match(/<\/w:t>/g) ?? []).length);
  });

  it('rend les valeurs multi-lignes en sauts de ligne Word', async () => {
    const out = await fillDocxTemplate(template, { '%copies%': '- Paul Copie\n- Marie Copie' });
    const zip = await JSZip.loadAsync(out);
    const xml = await zip.file('word/document.xml')!.async('string');
    expect(xml).toContain('<w:br/>');
    const text = await docxText(out);
    expect(text).toContain('- Paul Copie');
    expect(text).toContain('- Marie Copie');
  });

  it('une valeur vide efface le jeton sans laisser de trace', async () => {
    const out = await fillDocxTemplate(template, { '%numero_origine%': '' });
    const text = await docxText(out);
    expect(text).not.toContain('%numero_origine%');
  });

  it('rejette un fichier qui n’est pas un .docx', async () => {
    const notDocx = await new JSZip().file('hello.txt', 'x').generateAsync({ type: 'nodebuffer' });
    await expect(fillDocxTemplate(notDocx, {})).rejects.toThrow(/word\/document\.xml/);
  });
});
