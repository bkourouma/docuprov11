import { HierarchyService } from './hierarchy.service';

describe('HierarchyService (materialized path)', () => {
  const h = new HierarchyService();

  it('builds a root path from a null parent', () => {
    expect(h.childPath(null, 5)).toBe('/5/');
    expect(h.childPath('/', 3)).toBe('/3/');
  });

  it('builds a child path under a parent', () => {
    expect(h.childPath('/1/', 7)).toBe('/1/7/');
    expect(h.childPath('/1/14/', 57)).toBe('/1/14/57/');
  });

  it('computes depth from a path', () => {
    expect(h.depthOf('/1/')).toBe(0);
    expect(h.depthOf('/1/5/')).toBe(1);
    expect(h.depthOf('/1/5/9/')).toBe(2);
  });

  it('produces a subtree LIKE pattern', () => {
    expect(h.subtreePattern('/1/5/')).toBe('/1/5/%');
  });
});
