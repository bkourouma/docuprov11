import { Prisma } from '@prisma/client';
import { GED_EMBEDDING_DIMENSION } from '@archivage/types';
import { buildNearestChunksQuery, toVectorLiteral } from './semantic-vector.sql';

const vec = (n = GED_EMBEDDING_DIMENSION, v = 0.5) => Array.from({ length: n }, () => v);

describe('toVectorLiteral', () => {
  it('formate un vecteur valide en [a,b,...]', () => {
    const lit = toVectorLiteral(vec(GED_EMBEDDING_DIMENSION, 0.25));
    expect(lit.startsWith('[0.25,0.25')).toBe(true);
    expect(lit.endsWith(']')).toBe(true);
    expect(lit.split(',')).toHaveLength(GED_EMBEDDING_DIMENSION);
  });

  it('refuse une mauvaise longueur', () => {
    expect(() => toVectorLiteral(vec(3))).toThrow();
    expect(() => toVectorLiteral([])).toThrow();
  });

  it('refuse NaN et Infinity', () => {
    const a = vec();
    a[10] = Number.NaN;
    expect(() => toVectorLiteral(a)).toThrow();
    const b = vec();
    b[0] = Number.POSITIVE_INFINITY;
    expect(() => toVectorLiteral(b)).toThrow();
  });
});

describe('buildNearestChunksQuery', () => {
  const accessFilter = Prisma.sql`(d.is_archived = true AND d.marker_droits = ${42})`;
  const build = (over: Partial<Parameters<typeof buildNearestChunksQuery>[0]> = {}) =>
    buildNearestChunksQuery({
      queryVector: vec(),
      embeddingModel: 'bge-m3',
      accessFilter,
      limit: 7,
      ...over,
    });

  it('contient distance cosinus, ORDER BY, LIMIT, modèle et version courante', () => {
    const sql = build().sql;
    expect(sql).toContain('<=>');
    expect(sql).toContain('ORDER BY c.embedding <=>');
    expect(sql).toContain('LIMIT');
    expect(sql).toContain('c.embedding_model =');
    expect(sql).toContain('c.document_id IS NOT NULL');
    expect(sql).toContain('dv.is_current = true');
    // R3 : la version doit appartenir au même document que le segment.
    expect(sql).toContain('dv.document_id = c.document_id');
    expect(sql).toContain('dv.version_number');
    expect(sql).toContain('AS score');
  });

  it('place le filtre de droits dans le WHERE, avant ORDER BY', () => {
    const sql = build().sql;
    const where = sql.indexOf('WHERE');
    const filter = sql.indexOf('d.marker_droits');
    const order = sql.indexOf('ORDER BY');
    expect(where).toBeGreaterThan(-1);
    expect(filter).toBeGreaterThan(where);
    expect(filter).toBeLessThan(order);
  });

  it('lie vecteur, modèle, filtre et limite en paramètres', () => {
    const q = build();
    const literal = toVectorLiteral(vec());
    // 1 score, 2 modèle, 3 filtre (42), 4 tri (même vecteur), 5 limite.
    expect(q.values).toEqual([literal, 'bge-m3', 42, literal, 7]);
    expect(q.sql).not.toContain(literal);
    expect(q.sql).not.toContain('bge-m3');
  });

  it('ne concatène jamais un modèle hostile dans le SQL', () => {
    const evil = "x'; DROP TABLE document; --";
    const q = build({ embeddingModel: evil });
    expect(q.sql).not.toContain('DROP TABLE');
    expect(q.values).toContain(evil);
  });

  it('refuse une limite invalide et un vecteur invalide', () => {
    expect(() => build({ limit: 0 })).toThrow();
    expect(() => build({ limit: 1.5 })).toThrow();
    expect(() => build({ queryVector: vec(2) })).toThrow();
  });
});
