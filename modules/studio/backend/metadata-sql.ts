import type { Db } from "@aihot/backend/db";

/** Shared aliases: source `s`, manual profile `profile`, automatic data `metadata`. */
export const requestedHomepage = (db: Db) => db`CASE WHEN 'homepage' = ANY(profile.manual_fields) THEN profile.homepage ELSE NULL END`;

/** Cards, editing baselines and private avatar reads must agree on which snapshot is current. */
export const matchesSourceMetadata = (db: Db) => db`metadata.config_fingerprint = md5(s.kind || ':' || s.config::text)
  AND metadata.requested_homepage IS NOT DISTINCT FROM ${requestedHomepage(db)}`;
