import sanitizeHtml from 'sanitize-html';

const ALLOWED_TAGS = [
  'p', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
  'strong', 'em', 'u', 's', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'span',
];

/** Balises dont le CONTENU TEXTE est supprimé (et pas seulement la balise). */
const NON_TEXT_TAGS = [
  'script', 'style', 'textarea', 'option', 'noscript', 'iframe', 'object', 'embed', 'template',
  'svg', 'math', 'head', 'title', 'frameset', 'noframes', 'xmp', 'applet',
];

const COMMENT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MENTION_ID = /^[0-9]{1,15}$/;
const MAX_LABEL_LENGTH = 200;
const MAX_COLSPAN = 50;
const MAX_ROWSPAN = 1000;

const boundedInt = (raw: string | undefined, max: number): string | undefined => {
  if (raw === undefined || !/^[0-9]{1,4}$/.test(raw.trim())) return undefined;
  const n = Number(raw.trim());
  if (n < 1) return undefined;
  return String(Math.min(n, max));
};

/**
 * Assainit du HTML (liste blanche stricte : pas de script, style, on*, javascript:, iframe,
 * image, formulaire...). Le texte inerte des balises supprimées est conservé, sauf pour
 * script/style et les balises « non texte » ci-dessus dont le contenu est supprimé.
 */
export const sanitizeEditorHtml = (html: string): string => {
  if (typeof html !== 'string' || html.length === 0) return '';
  return sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {
      a: ['href', 'rel'],
      th: ['colspan', 'rowspan'],
      td: ['colspan', 'rowspan'],
      span: ['data-comment-id', 'data-type', 'data-id', 'data-label', 'class'],
    },
    allowedClasses: { span: ['mention'] },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: {},
    allowedSchemesAppliedToAttributes: ['href'],
    allowProtocolRelative: false,
    disallowedTagsMode: 'discard',
    nonTextTags: NON_TEXT_TAGS,
    parseStyleAttributes: false,
    transformTags: {
      a: (tagName, attribs) => {
        const out: Record<string, string> = { rel: 'noopener noreferrer' };
        if (attribs.href !== undefined) out.href = attribs.href;
        return { tagName, attribs: out };
      },
      th: (tagName, attribs) => ({ tagName, attribs: tableSpans(attribs) }),
      td: (tagName, attribs) => ({ tagName, attribs: tableSpans(attribs) }),
      span: (tagName, attribs) => ({ tagName, attribs: spanAttributes(attribs) }),
    },
  }).trim();
};

const tableSpans = (attribs: Record<string, string>): Record<string, string> => {
  const out: Record<string, string> = {};
  const colspan = boundedInt(attribs.colspan, MAX_COLSPAN);
  const rowspan = boundedInt(attribs.rowspan, MAX_ROWSPAN);
  if (colspan && colspan !== '1') out.colspan = colspan;
  if (rowspan && rowspan !== '1') out.rowspan = rowspan;
  return out;
};

/** Un span n'est conservé que comme ancre de commentaire ou comme mention bien formée. */
const spanAttributes = (attribs: Record<string, string>): Record<string, string> => {
  const out: Record<string, string> = {};
  const commentId = attribs['data-comment-id'];
  if (commentId !== undefined && COMMENT_ID.test(commentId)) {
    out['data-comment-id'] = commentId;
  }
  if (attribs['data-type'] === 'mention') {
    const id = attribs['data-id'];
    if (id !== undefined && MENTION_ID.test(id)) {
      out['data-type'] = 'mention';
      out['data-id'] = id;
      const label = attribs['data-label'];
      if (label !== undefined) out['data-label'] = label.slice(0, MAX_LABEL_LENGTH);
      out.class = 'mention';
    }
  }
  return out;
};
