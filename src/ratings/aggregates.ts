import type { EntityManager } from 'typeorm';

/**
 * Recomputes `avg_rating` and `rating_count` for the given places from the
 * ratings table. Recomputing is a little more work than adjusting the old
 * numbers, but it can never drift, and a place has few enough ratings per
 * write for that to be fine.
 */
export async function recomputePlaceAggregates(
  manager: EntityManager,
  placeIds: string[],
): Promise<void> {
  if (placeIds.length === 0) return;
  await manager.query(
    `UPDATE places p
        SET avg_rating = COALESCE(s.avg, 0),
            rating_count = COALESCE(s.cnt, 0)
       FROM (
         SELECT p2.id, AVG(r.stars)::float8 AS avg, COUNT(r.id)::int AS cnt
           FROM places p2
           LEFT JOIN ratings r ON r.place_id = p2.id
          WHERE p2.id = ANY($1::uuid[])
          GROUP BY p2.id
       ) s
      WHERE p.id = s.id`,
    [placeIds],
  );
}
