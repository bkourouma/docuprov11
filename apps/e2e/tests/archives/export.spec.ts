/**
 * Exports de la grille de recherche (P3, FR-025 / SC-005) — ARC-18 et ARC-19.
 *
 * Ce qui est VÉRIFIÉ dans chaque fichier téléchargé par l'écran :
 *  - Excel : relu par ExcelJS — feuille « Documents », ligne d'en-tête exacte (ordre compris),
 *    une ligne par document du filtre, valeurs de la ligne attendue (type, date, dossier) ;
 *  - CSV : en-têtes exacts, une ligne par document, valeurs de la ligne attendue ;
 *  - Word : archive ZIP (`PK`), `word/document.xml` lu par JSZip — titre, en-têtes, libellés ;
 *  - PDF : signature `%PDF-`, fin `%%EOF`, au moins une page, et TEXTE extrait des flux de contenu
 *    (FlateDecode décompressé, chaînes hexadécimales PDFKit décodées en WinAnsi) — en-têtes et
 *    libellés. Extraction validée hors pile sur une sortie PDFKit 0.15 (polices standard).
 * Dans tous les formats : le document HORS filtre est absent.
 *
 * Dépendances : `exceljs` et `jszip` (déjà dans le dépôt, via `@archivage/exports`) ; le paquet
 * `@archivage/e2e` doit les déclarer en devDependencies (lot 0).
 */
import { readFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';
import type { Page } from '@playwright/test';
import { Workbook, type Row } from 'exceljs';
import JSZip from 'jszip';
import { test, expect } from '../../fixtures';
import {
  EN_TETES_EXPORT,
  attendreExport,
  attendreRecherche,
  choisirFiltre,
  creerDocumentArchive,
  creerDossier,
  creerTypeDocument,
  exporterBrut,
  lignesCsv,
  lignesResultat,
  ouvrirRecherche,
  rechercherTexte,
  type FormatExport,
} from './_helpers/documents';

// Pile E2E partagée avec quatre autres piles sur la même machine : les 60 s par défaut ne suffisent
// pas aux parcours qui préparent beaucoup de données par l'API. Aucune assertion n'est relâchée.
test.describe.configure({ timeout: 180_000 });

/** Texte des opérateurs `Tj`/`TJ` de tous les flux d'un PDF (une entrée par opérateur). */
function textePdf(pdf: Buffer): string {
  const source = pdf.toString('latin1');
  const morceaux: string[] = [];
  const debutFlux = /stream\r?\n/g;
  const decode = (hex: string) => Buffer.from(hex.replace(/\s/g, ''), 'hex').toString('latin1');
  let m: RegExpExecArray | null;
  while ((m = debutFlux.exec(source))) {
    const debut = m.index + m[0].length;
    const fin = source.indexOf('endstream', debut);
    if (fin < 0) break;
    const brut = Buffer.from(source.slice(debut, fin), 'latin1');
    let contenu: string;
    try {
      contenu = inflateSync(brut).toString('latin1');
    } catch {
      contenu = brut.toString('latin1');
    }
    const operateurs =
      /\[((?:[^\]\\]|\\.)*)\]\s*TJ|<([0-9a-fA-F\s]*)>\s*Tj|\(((?:[^)\\]|\\.)*)\)\s*Tj/g;
    let o: RegExpExecArray | null;
    while ((o = operateurs.exec(contenu))) {
      if (o[1] !== undefined) {
        let s = '';
        const parties = /<([0-9a-fA-F\s]*)>|\(((?:[^)\\]|\\.)*)\)/g;
        let p: RegExpExecArray | null;
        while ((p = parties.exec(o[1]))) s += p[1] !== undefined ? decode(p[1]) : (p[2] ?? '');
        morceaux.push(s);
      } else if (o[2] !== undefined) {
        morceaux.push(decode(o[2]));
      } else {
        morceaux.push(o[3] ?? '');
      }
    }
    debutFlux.lastIndex = fin;
  }
  return morceaux.join('\n');
}

/** Ouvre le menu « Exporter » et télécharge le format demandé ; renvoie le contenu du fichier. */
async function exporterDepuisEcran(
  page: Page,
  menu: 'Excel' | 'CSV' | 'PDF' | 'Word',
  format: FormatExport,
): Promise<{ contenu: Buffer; corps: Record<string, unknown> }> {
  const telechargement = page.waitForEvent('download');
  const reponse = attendreExport(page);
  await page.getByRole('button', { name: /Exporter/ }).hover();
  await page.getByRole('menuitem', { name: menu, exact: true }).click();
  const rep = await reponse;
  expect(rep.status(), `export ${format}`).toBe(200);
  const fichier = await telechargement;
  expect(fichier.suggestedFilename()).toBe(`documents.${format}`);
  const chemin = await fichier.path();
  const contenu = await readFile(chemin);
  expect(contenu.length).toBeGreaterThan(0);
  return { contenu, corps: (rep.request().postDataJSON() ?? {}) as Record<string, unknown> };
}

/** Valeurs d'une ligne ExcelJS, sans la case 0 (ExcelJS indexe les colonnes à partir de 1). */
function valeursLigne(ligne: Row): string[] {
  const valeurs = ligne.values as unknown[];
  return valeurs.slice(1).map((v) => (v == null ? '' : String(v)));
}

test.describe('Exports de la recherche', () => {
  test('ARC-18 export Excel, CSV, PDF et Word depuis l’écran : contenu conforme au filtre', async ({
    page,
    api,
    uniq,
  }) => {
    const jeton = uniq('ARC18');
    const typeLabel = uniq('ARC18 Type');
    const autreTypeLabel = uniq('ARC18 Autre type');
    const dossierLabel = uniq('ARC18 Dossier');
    const documentTypeId = await creerTypeDocument(api, typeLabel);
    const autreTypeId = await creerTypeDocument(api, autreTypeLabel);
    const dossierId = await creerDossier(api, dossierLabel);

    const alpha = await creerDocumentArchive(api, {
      label: `${jeton} Alpha`,
      documentTypeId,
      dossierId,
      documentDate: '2019-06-15',
    });
    const beta = await creerDocumentArchive(api, { label: `${jeton} Beta`, documentTypeId });
    const horsFiltre = await creerDocumentArchive(api, {
      label: `${jeton} Gamma`,
      documentTypeId: autreTypeId,
    });

    // Filtre courant : jeton + type → Alpha et Beta, pas Gamma.
    await ouvrirRecherche(page);
    await page.getByLabel('Recherche plein texte').fill(jeton);
    await page.getByRole('button', { name: /Filtres avancés/ }).click();
    await choisirFiltre(page, 'Type de document', typeLabel);
    const filtre = attendreRecherche(
      page,
      (c) => c.fullText === jeton && c.documentTypeId === documentTypeId,
    );
    await page.getByRole('button', { name: 'Rechercher', exact: true }).click();
    expect((await filtre).status()).toBe(200);
    await expect(lignesResultat(page, jeton)).toHaveCount(2);

    const attendus = [alpha.label, beta.label].sort();

    await test.step('Excel', async () => {
      const { contenu, corps } = await exporterDepuisEcran(page, 'Excel', 'xlsx');
      expect(corps).toMatchObject({ format: 'xlsx', fullText: jeton, documentTypeId });
      expect(contenu.subarray(0, 2).toString('latin1')).toBe('PK');
      const classeur = new Workbook();
      // Les types d'ExcelJS 4.4 visent l'ancien `Buffer` de @types/node : même objet, autre type.
      await classeur.xlsx.load(contenu as unknown as Parameters<typeof classeur.xlsx.load>[0]);
      const feuille = classeur.getWorksheet('Documents');
      expect(feuille, 'feuille « Documents »').toBeDefined();
      if (!feuille) return;
      expect(valeursLigne(feuille.getRow(1))).toEqual([...EN_TETES_EXPORT]);
      expect(feuille.rowCount).toBe(3);
      const lignes = [2, 3].map((n) => valeursLigne(feuille.getRow(n)));
      expect(lignes.map((l) => l[0]).sort()).toEqual(attendus);
      const ligneAlpha = lignes.find((l) => l[0] === alpha.label);
      expect(ligneAlpha?.[1]).toBe(typeLabel);
      expect(ligneAlpha?.[3]).toBe('2019-06-15');
      expect(ligneAlpha?.[4]).toBe(dossierLabel);
    });

    await test.step('CSV', async () => {
      const { contenu, corps } = await exporterDepuisEcran(page, 'CSV', 'csv');
      expect(corps).toMatchObject({ format: 'csv', fullText: jeton, documentTypeId });
      const lignes = lignesCsv(contenu.toString('utf8')).filter((l) => l.some((c) => c !== ''));
      expect(lignes[0]).toEqual([...EN_TETES_EXPORT]);
      expect(lignes).toHaveLength(3);
      expect(
        lignes
          .slice(1)
          .map((l) => l[0])
          .sort(),
      ).toEqual(attendus);
      const ligneAlpha = lignes.find((l) => l[0] === alpha.label);
      expect(ligneAlpha?.[1]).toBe(typeLabel);
      expect(ligneAlpha?.[3]).toBe('2019-06-15');
      expect(ligneAlpha?.[4]).toBe(dossierLabel);
    });

    await test.step('PDF', async () => {
      const { contenu, corps } = await exporterDepuisEcran(page, 'PDF', 'pdf');
      expect(corps).toMatchObject({ format: 'pdf', fullText: jeton, documentTypeId });
      expect(contenu.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      expect(contenu.toString('latin1').trimEnd().endsWith('%%EOF')).toBe(true);
      const pages = contenu.toString('latin1').match(/\/Type\s*\/Page\b/g) ?? [];
      expect(pages.length).toBeGreaterThanOrEqual(1);
      const texte = textePdf(contenu);
      expect(texte).toContain('Documents');
      expect(texte).toContain(EN_TETES_EXPORT.join('  |  '));
      expect(texte).toContain(alpha.label);
      expect(texte).toContain(beta.label);
      expect(texte).not.toContain(horsFiltre.label);
    });

    await test.step('Word', async () => {
      const { contenu, corps } = await exporterDepuisEcran(page, 'Word', 'docx');
      expect(corps).toMatchObject({ format: 'docx', fullText: jeton, documentTypeId });
      expect(contenu.subarray(0, 2).toString('latin1')).toBe('PK');
      const archive = await JSZip.loadAsync(contenu);
      const xml = await archive.file('word/document.xml')?.async('string');
      expect(xml, 'word/document.xml').toBeDefined();
      for (const entete of EN_TETES_EXPORT) expect(xml).toContain(`>${entete}<`);
      expect(xml).toContain(`>${alpha.label}<`);
      expect(xml).toContain(`>${beta.label}<`);
      expect(xml).not.toContain(horsFiltre.label);
    });

    // Le document hors filtre n'est absent d'aucun format par accident : il est bien exportable.
    const tout = await exporterBrut(api, { fullText: jeton, format: 'csv' });
    expect(tout.status()).toBe(200);
    expect((await tout.body()).toString('utf8')).toContain(horsFiltre.label);
  });

  test('ARC-19 l’export suit le tri de la grille et ignore la pagination', async ({
    page,
    api,
    uniq,
  }) => {
    const jeton = uniq('ARC19');
    for (const n of [2, 1, 3]) {
      await creerDocumentArchive(api, { label: `${jeton} ${n}` });
    }

    await ouvrirRecherche(page);
    await rechercherTexte(page, jeton);
    const entete = page.getByRole('columnheader', { name: /Libellé/ });
    await entete.click(); // croissant
    const decroissant = attendreRecherche(
      page,
      (c) => JSON.stringify(c.sort) === JSON.stringify([{ field: 'label', dir: 'desc' }]),
    );
    await entete.click(); // décroissant
    expect((await decroissant).status()).toBe(200);
    await expect(lignesResultat(page, jeton).first()).toContainText(`${jeton} 3`);

    const { contenu, corps } = await exporterDepuisEcran(page, 'CSV', 'csv');
    expect(corps).toMatchObject({ sort: [{ field: 'label', dir: 'desc' }] });
    const lignes = lignesCsv(contenu.toString('utf8')).filter((l) => l.some((c) => c !== ''));
    expect(lignes.slice(1).map((l) => l[0])).toEqual([`${jeton} 3`, `${jeton} 2`, `${jeton} 1`]);

    // Pagination ignorée (contrat OpenAPI) : une page de 1 exporte quand même les 3 lignes.
    const pagine = await exporterBrut(api, {
      fullText: jeton,
      format: 'csv',
      sort: [{ field: 'label', dir: 'asc' }],
      page: 2,
      pageSize: 1,
    });
    expect(pagine.status()).toBe(200);
    const lignesPaginees = lignesCsv((await pagine.body()).toString('utf8')).filter((l) =>
      l.some((c) => c !== ''),
    );
    expect(lignesPaginees.slice(1).map((l) => l[0])).toEqual([
      `${jeton} 1`,
      `${jeton} 2`,
      `${jeton} 3`,
    ]);
  });

  test('ARC-19 les colonnes exportées sont celles affichées dans la grille', async () => {
    // SC-005 exige 100 % de concordance des colonnes. La grille affiche Libellé, Type de document,
    // « Enregistré le » (date système), Dossier, Plan de classement ; l'export écrit Libellé, Type,
    // N° pièce, Date document (date MÉTIER), Dossier, Plan, Localisation (`EXPORT_COLUMNS` de
    // documents.controller.ts). La grille a été changée à la demande d'un utilisateur (commentaire
    // de page.tsx) sans que l'export suive : lequel fait foi ?
    test.fixme(
      true,
      'Question métier : colonnes de l’export (FR-021/PRD EF-P3-1) ou colonnes affichées (SC-005) ?',
    );
  });
});
