import {
  collection,
  documentId,
  getDocs,
  limit,
  orderBy,
  query,
  startAfter,
  where,
} from 'firebase/firestore';

import type { Firestore, QueryConstraint } from 'firebase/firestore';

export type CatalogScene = {
  id: string;
  title: string;
  accessMode: 'organization' | 'assigned';
  publishedRevisionId: string;
};
export type CatalogCursors = { organization: string | null; assigned: string | null };

// Each authorized query needs its own cursor. null marks an exhausted query.
export async function listOrganizationScenes(
  db: Firestore,
  orgId: string,
  uid: string,
  cursors?: CatalogCursors,
) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(orgId) || !uid) throw new Error('Invalid catalog identity.');
  const scenes = collection(db, 'organizations', orgId, 'scenes');
  async function page(mode: 'organization' | 'assigned', after: string | null | undefined) {
    if (after === null) return { scenes: [] as CatalogScene[], next: null };
    if (after !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(after))
      throw new Error('Invalid catalog cursor.');
    const filters: QueryConstraint[] = [
      where('status', '==', 'published'),
      where('accessMode', '==', mode),
      orderBy(documentId()),
      limit(25),
    ];
    if (mode === 'assigned') filters.push(where('assignedUserIds', 'array-contains', uid));
    if (after) filters.push(startAfter(after));
    const result = await getDocs(query(scenes, ...filters));
    return {
      scenes: result.docs.map((doc) => ({
        id: doc.id,
        title: doc.get('title') as string,
        accessMode: doc.get('accessMode') as CatalogScene['accessMode'],
        publishedRevisionId: doc.get('publishedRevisionId') as string,
      })),
      next: result.size === 25 ? result.docs.at(-1)!.id : null,
    };
  }
  const [organization, assigned] = await Promise.all([
    page('organization', cursors?.organization),
    page('assigned', cursors?.assigned),
  ]);
  return {
    scenes: [
      ...new Map(
        [...organization.scenes, ...assigned.scenes].map((scene) => [scene.id, scene]),
      ).values(),
    ].sort((a, b) => a.id.localeCompare(b.id, 'en')),
    next: { organization: organization.next, assigned: assigned.next },
  };
}
