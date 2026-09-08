import {
  segmentPages,
  type OpeningCategory,
  type PageClassification,
  type PageRef,
} from '../src/processors/segment';

const p = (fileIndex: number, pageIndex = 0): PageRef => ({ fileIndex, pageIndex });
const open = (category: OpeningCategory, targetId: number, file: number): PageClassification => ({
  kind: 'opening',
  category,
  targetId,
  page: p(file),
});
const content = (file: number): PageClassification => ({ kind: 'content', page: p(file) });
const blank = (file: number): PageClassification => ({ kind: 'blank', page: p(file) });

describe('segmentPages — QR-piloted document splitting', () => {
  it('attribute intercalaires before content accumulate into ONE document', () => {
    // [DOSSIER][LOCALISATION][PLAN][TYPE] then two content pages -> one document, all attributes.
    const docs = segmentPages(
      [
        open('DOSSIER', 8, 0),
        open('LOCALISATION', 7, 1),
        open('PLAN', 6, 2),
        open('TYPE_DOCUMENT', 2, 3),
        content(4),
        content(5),
      ],
      null,
    );

    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({
      dossierId: 8,
      locationId: 7,
      planId: 6,
      documentTypeId: 2,
      untyped: false,
    });
    expect(docs[0]?.pages).toEqual([p(4), p(5)]);
  });

  it('a TYPE intercalaire between content pages splits into two documents of different types', () => {
    const docs = segmentPages(
      [
        open('DOSSIER', 8, 0),
        open('LOCALISATION', 7, 1),
        open('PLAN', 6, 2),
        open('TYPE_DOCUMENT', 2, 3),
        content(4),
        open('TYPE_DOCUMENT', 9, 5),
        content(6),
      ],
      null,
    );

    expect(docs).toHaveLength(2);
    // Sticky dossier/location/plan; the type changes via the second intercalaire.
    expect(docs[0]).toMatchObject({ dossierId: 8, locationId: 7, planId: 6, documentTypeId: 2 });
    expect(docs[0]?.pages).toEqual([p(4)]);
    expect(docs[1]).toMatchObject({ dossierId: 8, locationId: 7, planId: 6, documentTypeId: 9 });
    expect(docs[1]?.pages).toEqual([p(6)]);
  });

  it('a BLANK separator splits content into two documents that keep the running attributes', () => {
    const docs = segmentPages(
      [open('DOSSIER', 8, 0), open('TYPE_DOCUMENT', 2, 1), content(2), blank(3), content(4)],
      null,
    );

    expect(docs).toHaveLength(2);
    expect(docs[0]).toMatchObject({ dossierId: 8, documentTypeId: 2 });
    expect(docs[0]?.pages).toEqual([p(2)]);
    expect(docs[1]).toMatchObject({ dossierId: 8, documentTypeId: 2 });
    expect(docs[1]?.pages).toEqual([p(4)]);
  });

  it('a DOSSIER intercalaire prevails over the batch default for all following documents (FR-016)', () => {
    const docs = segmentPages(
      [open('DOSSIER', 500, 0), content(1), open('TYPE_DOCUMENT', 3, 2), content(3)],
      /* default dossier */ 1,
    );

    expect(docs).toHaveLength(2);
    expect(docs[0]).toMatchObject({ dossierId: 500, documentTypeId: null, untyped: true });
    expect(docs[1]).toMatchObject({ dossierId: 500, documentTypeId: 3, untyped: false });
  });

  it('a leading content page (no intercalaire in scope yet) opens an untyped document', () => {
    const docs = segmentPages([content(0), open('TYPE_DOCUMENT', 1, 1), content(2)], null);

    expect(docs).toHaveLength(2);
    expect(docs[0]).toMatchObject({ untyped: true, documentTypeId: null });
    expect(docs[0]?.pages).toEqual([p(0)]);
    expect(docs[1]).toMatchObject({ untyped: false, documentTypeId: 1 });
    expect(docs[1]?.pages).toEqual([p(2)]);
  });

  it('a stream with no intercalaire yields one untyped document seeded with the default dossier', () => {
    const docs = segmentPages([content(0), content(1)], 12);

    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ untyped: true, dossierId: 12 });
    expect(docs[0]?.pages).toEqual([p(0), p(1)]);
  });

  it('trailing intercalaires with no following content do not create empty documents', () => {
    const docs = segmentPages(
      [open('TYPE_DOCUMENT', 1, 0), content(1), open('DOSSIER', 5, 2)],
      null,
    );

    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ documentTypeId: 1 });
    expect(docs[0]?.pages).toEqual([p(1)]);
  });
});
