import type { Db } from "@aihot/backend/db";

/** Decimal GB, per the user's 38.7GB / 4.7GB decision. No placeholder file is allocated. ADR-0005. */
export const diskBudget = { keepFreeBytes: 4_700_000_000, warningBytes: 8_000_000_000,
  heavyPauseBytes: 6_000_000_000, recoveryBytes: 6_000_000_000 } as const;

/** Pending image publication and temporary tasks compete for the same physical free space. */
export async function reservedStorageBytes(db: Db): Promise<number> {
  const [row] = await db`SELECT coalesce((SELECT sum(bytes) FROM studio_storage_workspaces), 0)
    + coalesce((SELECT sum(bytes) FROM studio_image_assets WHERE state = 'staging'), 0) AS bytes`;
  return Number(row!.bytes);
}
