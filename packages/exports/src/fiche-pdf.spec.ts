import { fichePdfDoc, renderFichePdf } from './fiche-pdf';

const replacements: Record<string, string> = {
  '%date_arrivee%': '16/07/2026',
  '%date_courrier%': '10/07/2026',
  '%numero_enregistrement%': '00042',
  '%numero_origine%': 'REF-88',
  '%correspondant%': 'Ministère des Finances',
  '%destinataire%': 'Admin Système',
  '%objet%': 'Demande de subvention 2026',
  '%description%': 'courrier-scanne',
  '%imputations%': 'Jean Agent',
  '%instructions%': 'Pour Suivi',
  '%datebutoire%': '18/07/2026',
  '%copies%': '- Paul Copie',
  '%name_stamp%': 'Agent BO',
  '%date_now%': '16/07/2026',
  '%grid_historique%': 'Date/Heure\t\tUtilisateur\t\tAction\t\tDétails',
};

describe('fichePdfDoc — structure alignée sur le gabarit', () => {
  it('reprend les 4 sections du gabarit normal, dans l’ordre', () => {
    const doc = fichePdfDoc('FICHE_IMPUTATION.docx', replacements);
    expect(doc.title).toBe('FICHE DE TRAITEMENT DU COURRIER');
    expect(doc.sections.map((s) => s.title)).toEqual([
      'I. INFORMATIONS GÉNÉRALES',
      'II. IMPUTATION DU COURRIER',
      'III. TRAITEMENT DU COURRIER',
      'IV. HISTORIQUE DE TRAITEMENT DU COURRIER',
    ]);
  });

  it('puise ses valeurs dans les MÊMES substitutions que le DOCX (pas de divergence de fond)', () => {
    const doc = fichePdfDoc('FICHE_IMPUTATION.docx', replacements);
    const infos = doc.sections[0]?.fields ?? [];
    expect(infos.find((f) => f.label === 'Objet du courrier')?.value).toBe(
      'Demande de subvention 2026',
    );
    // Règle 1 : « Pièces jointes » porte le nom du fichier joint.
    expect(infos.find((f) => f.label === 'Pièces jointes')?.value).toBe('courrier-scanne');
  });

  it('sur le gabarit alternatif : formulaire vierge et PAS de section historique', () => {
    const doc = fichePdfDoc('FICHE_IMPUTATION - Copie.docx', replacements);
    expect(doc.sections.map((s) => s.title)).toEqual([
      'I. INFORMATIONS GÉNÉRALES',
      'II. IMPUTATION DU COURRIER',
      'III. TRAITEMENT DU COURRIER',
    ]);
    expect(doc.sections[1]?.block).toContain('DESTINATAIRES');
    expect(doc.sections[1]?.fields).toBeUndefined();
  });
});

describe('renderFichePdf', () => {
  it('produit un PDF valide', async () => {
    const buf = await renderFichePdf(fichePdfDoc('FICHE_IMPUTATION.docx', replacements));
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(buf.length).toBeGreaterThan(1000);
  });

  it('embarque la police : accents ET ☐ rendus (le piège WinAnsi)', async () => {
    // Sans police embarquée, PDFKit lève sur « ☐ » ou le rend en .notdef silencieusement.
    const buf = await renderFichePdf(
      fichePdfDoc('FICHE_IMPUTATION.docx', {
        ...replacements,
        '%imputations%': '☐ Directeur\n☐ Secrétaire',
        '%instructions%': '- ☐ Pour Suivi',
      }),
    );
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
    // La police est bien embarquée dans le PDF (sous-ensemble DejaVu).
    expect(buf.toString('latin1')).toMatch(/DejaVuSans/);
  });

  it('rend le formulaire vierge sans échouer', async () => {
    const buf = await renderFichePdf(fichePdfDoc('FICHE_IMPUTATION - Copie.docx', replacements));
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('tolère des valeurs vides', async () => {
    const buf = await renderFichePdf(fichePdfDoc('FICHE_IMPUTATION.docx', {}));
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
  });
});
