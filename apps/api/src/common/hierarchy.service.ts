import { Injectable } from '@nestjs/common';

/**
 * Materialized-path helpers for the plan/location/dossier trees (D-14).
 * path looks like '/1/14/57/'; subtree = path LIKE ancestor || '%'; depth = segments - 1.
 */
@Injectable()
export class HierarchyService {
  /** Path of a node given its parent's path (or null for a root) and its own id. */
  childPath(parentPath: string | null, selfId: number): string {
    const base = parentPath && parentPath !== '/' ? parentPath : '/';
    return `${base}${selfId}/`;
  }

  /** Depth from a materialized path: '/1/' -> 0, '/1/5/' -> 1. */
  depthOf(path: string): number {
    const segments = path.split('/').filter(Boolean);
    return Math.max(0, segments.length - 1);
  }

  /** LIKE pattern selecting a node and its whole subtree. */
  subtreePattern(path: string): string {
    return `${path}%`;
  }
}
