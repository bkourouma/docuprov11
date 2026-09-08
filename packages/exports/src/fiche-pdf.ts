// Rendu PDF de la Fiche d'Imputation (§09).
//
// ÉCART ASSUMÉ vs source : le source produit son PDF en CONVERTISSANT le .docx rempli
// (Syncfusion DocIORenderer). La stack V6 est « 100 % libs OSS » et n'embarque aucun convertisseur
// DOCX→PDF : on re-rend donc la fiche avec PDFKit à partir des MÊMES substitutions. Même contenu,
// même ordre de sections, mise en page approchante — arbitrage validé.
//
// Police : DejaVuSans. Les polices standard de PDFKit sont limitées à WinAnsi, qui ne contient PAS
// « ☐ » (U+2610) — or les replis du §09 en sont truffés (« ☐ Rôle »). Vérifié : ni Liberation, ni
// Noto latin, ni même Arial/Segoe UI ne portent ce glyphe (Windows le rend par repli de police, ce
// que PDFKit ne sait pas faire). DejaVu le porte, et sa licence Bitstream Vera autorise la
// redistribution.

import { createRequire } from 'node:module';
import PDFDocument from 'pdfkit';

const require_ = createRequire(__filename);

/** Chemin de la police embarquée, résolu depuis le paquet (pas de binaire versionné). */
function dejaVuPath(weight: 'regular' | 'bold'): string {
  const pkg = require_.resolve('dejavu-fonts-ttf/package.json');
  const dir = pkg.slice(0, pkg.lastIndexOf('package.json'));
  return `${dir}ttf/DejaVuSans${weight === 'bold' ? '-Bold' : ''}.ttf`;
}

/** Une ligne « libellé : valeur » de la fiche. */
export interface FicheField {
  label: string;
  value: string;
}
export interface FicheSection {
  title: string;
  fields?: FicheField[];
  /** Bloc de texte brut (historique tabulé, ou mentions du formulaire vierge). */
  block?: string;
}
export interface FichePdfDoc {
  title: string;
  sections: FicheSection[];
}

/**
 * Construit la structure du PDF depuis les substitutions du gabarit : les deux rendus (DOCX et PDF)
 * partent ainsi des mêmes valeurs, et ne peuvent pas diverger sur le fond.
 */
export function fichePdfDoc(template: string, r: Record<string, string>): FichePdfDoc {
  const isAlternate = template.includes('Copie');
  const sections: FicheSection[] = [
    {
      title: 'I. INFORMATIONS GÉNÉRALES',
      fields: [
        { label: 'Date d’arrivée du courrier', value: r['%date_arrivee%'] ?? '' },
        { label: 'Date du courrier', value: r['%date_courrier%'] ?? '' },
        { label: 'Numéro d’enregistrement', value: r['%numero_enregistrement%'] ?? '' },
        { label: 'N° d’origine', value: r['%numero_origine%'] ?? '' },
        { label: 'Provenance', value: r['%correspondant%'] ?? '' },
        { label: 'Destinataire', value: r['%destinataire%'] ?? '' },
        { label: 'Objet du courrier', value: r['%objet%'] ?? '' },
        { label: 'Pièces jointes', value: r['%description%'] ?? '' },
      ],
    },
  ];

  // Le gabarit alternatif est un formulaire vierge : mêmes intitulés, sans valeur (§09, règle 2).
  sections.push(
    isAlternate
      ? { title: 'II. IMPUTATION DU COURRIER', block: 'DESTINATAIRES\n\nINSTRUCTIONS' }
      : {
          title: 'II. IMPUTATION DU COURRIER',
          fields: [
            { label: 'Imputations principales', value: r['%imputations%'] ?? '' },
            { label: 'Instruction', value: r['%instructions%'] ?? '' },
            { label: 'Date butoire', value: r['%datebutoire%'] ?? '' },
            { label: 'Copie à', value: r['%copies%'] ?? '' },
          ],
        },
  );

  sections.push({
    title: 'III. TRAITEMENT DU COURRIER',
    fields: [
      { label: 'Agent du Service courrier', value: r['%name_stamp%'] ?? '' },
      { label: 'Date', value: r['%date_now%'] ?? '' },
    ],
  });

  // Le formulaire vierge n'a pas de section historique.
  if (!isAlternate) {
    sections.push({
      title: 'IV. HISTORIQUE DE TRAITEMENT DU COURRIER',
      block: r['%grid_historique%'] ?? '',
    });
  }

  return { title: 'FICHE DE TRAITEMENT DU COURRIER', sections };
}

/**
 * Habillage « Plus Admin » (relook 002) — valeurs recopiées des tokens du front, que ce paquet Node
 * ne peut pas importer et que PDFKit ne saurait de toute façon pas résoudre (il veut un hex).
 *
 * `rule` : le token de bordure de carte est `#e4e9f0` (1,22:1), pensé pour un écran. Sur une fiche
 * IMPRIMÉE puis archivée — et souvent photocopiée — ce gris s'efface complètement : les filets de
 * section deviendraient invisibles alors qu'ils portent la structure du formulaire. On retient donc
 * `#8d95a5`, le token `borderControl` (3,01:1 sur blanc, seuil WCAG 1.4.11 des éléments non
 * textuels), qui reste discret à l'écran et survit à l'impression. Écart assumé et documenté.
 */
const BRAND = {
  primary: '#0033c4', // titre de la fiche
  text: '#030303', // corps
  rule: '#8d95a5', // filets de section (cf. ci-dessus)
} as const;

/** Rend la fiche en PDF. */
export function renderFichePdf(doc: FichePdfDoc): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({ size: 'A4', margin: 48 });
    const chunks: Buffer[] = [];
    pdf.on('data', (c: Buffer) => chunks.push(c));
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);

    pdf.registerFont('DejaVu', dejaVuPath('regular'));
    pdf.registerFont('DejaVu-Bold', dejaVuPath('bold'));

    pdf
      .font('DejaVu-Bold')
      .fontSize(14)
      .fillColor(BRAND.primary)
      .text(doc.title, { align: 'center' });
    pdf.moveDown(1);

    // Le reste du document reste en noir de corps : la couleur de marque se limite au titre
    // (document imprimé et archivé — pas d'aplat ni de série de couleurs).
    pdf.fillColor(BRAND.text);

    for (const section of doc.sections) {
      pdf.font('DejaVu-Bold').fontSize(11).text(section.title);
      pdf
        .moveTo(pdf.x, pdf.y + 2)
        .lineTo(pdf.page.width - pdf.page.margins.right, pdf.y + 2)
        .lineWidth(0.5)
        .strokeColor(BRAND.rule)
        .stroke();
      pdf.moveDown(0.6);

      for (const f of section.fields ?? []) {
        pdf.font('DejaVu-Bold').fontSize(9).text(`${f.label} : `, { continued: true });
        // Une valeur multi-ligne (imputations, copies…) doit rester lisible : PDFKit gère le \n.
        pdf.font('DejaVu').text(f.value || '—');
        pdf.moveDown(0.25);
      }

      if (section.block !== undefined) {
        pdf
          .font('DejaVu')
          .fontSize(8)
          .text(section.block || '—');
      }
      pdf.moveDown(0.8);
    }

    pdf.end();
  });
}
