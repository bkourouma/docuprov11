// QR contract P1 <-> P2. See specs/001-archivage-qr/contracts/qr-payload.md (D-18).
// Wire format (delimited, ASCII, versioned): DOCUPRO|1|INTERCALAIRE|{category}|{id}

export const QR_NAMESPACE = 'DOCUPRO';
export const QR_VERSION = 1;
export const QR_OBJECT = 'INTERCALAIRE';
export const QR_DELIMITER = '|';

export const INTERCALAIRE_CATEGORIES = [
  'TYPE_DOCUMENT',
  'PLAN',
  'LOCALISATION',
  'DOSSIER',
  'BLANK',
] as const;

export type IntercalaireCategoryCode = (typeof INTERCALAIRE_CATEGORIES)[number];

export interface IntercalairePayload {
  category: IntercalaireCategoryCode;
  /** Target element id; always 0 for BLANK. */
  id: number;
}

export type ParseResult =
  | { status: 'ok'; payload: IntercalairePayload }
  /** Foreign / irrelevant QR — treat the page as "no QR". */
  | { status: 'ignore'; reason: string }
  /** Our namespace but malformed — reject (log), treat as "no QR". */
  | { status: 'reject'; reason: string };

function isCategory(value: string): value is IntercalaireCategoryCode {
  return (INTERCALAIRE_CATEGORIES as readonly string[]).includes(value);
}

/** True for the four "opening" categories (everything except BLANK). */
export function isOpeningCategory(category: IntercalaireCategoryCode): boolean {
  return category !== 'BLANK';
}

/** Build the QR payload string for an intercalaire sheet (P1). */
export function formatPayload(category: IntercalaireCategoryCode, id: number): string {
  const effectiveId = category === 'BLANK' ? 0 : id;
  if (category !== 'BLANK' && (!Number.isInteger(id) || id <= 0)) {
    throw new Error(`Invalid id for category ${category}: ${id}`);
  }
  return [QR_NAMESPACE, String(QR_VERSION), QR_OBJECT, category, String(effectiveId)].join(QR_DELIMITER);
}

/** Parse and validate a decoded QR string (P2). Never throws. */
export function parsePayload(raw: string): ParseResult {
  const parts = raw.split(QR_DELIMITER);
  if (parts.length !== 5) {
    return { status: 'ignore', reason: 'unexpected segment count' };
  }
  const [ns, version, object, category, idRaw] = parts as [string, string, string, string, string];

  if (ns !== QR_NAMESPACE) return { status: 'ignore', reason: `foreign namespace "${ns}"` };
  if (object !== QR_OBJECT) return { status: 'ignore', reason: `unexpected object "${object}"` };
  if (version !== String(QR_VERSION)) return { status: 'reject', reason: `unknown version "${version}"` };
  if (!isCategory(category)) return { status: 'reject', reason: `unknown category "${category}"` };

  const id = Number(idRaw);
  if (!Number.isInteger(id) || id < 0) return { status: 'reject', reason: `invalid id "${idRaw}"` };
  if (category === 'BLANK' && id !== 0) return { status: 'reject', reason: 'BLANK must carry id 0' };
  if (category !== 'BLANK' && id === 0) return { status: 'reject', reason: `${category} requires a non-zero id` };

  return { status: 'ok', payload: { category, id } };
}
