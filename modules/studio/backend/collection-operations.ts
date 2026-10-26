import { z } from "zod";
import { audit, Conflict } from "@aihot/backend/audit";
import { collectionControlState, saveCollectionControl, CollectionControlConflict } from "@aihot/backend/operations/collection-control";

export const collectionOperations = collectionControlState;
export async function saveCollectionOperations(input: unknown, actor: string) {
  const value = z.object({ version: z.number().int().nonnegative(), enabled: z.boolean() }).strict().parse(input);
  const before = collectionOperations();
  try {
    const saved = saveCollectionControl(value, actor);
    await audit(actor, "studio.collection.operations", "studio.collection.operations", null, before, saved);
    return saved;
  } catch (error) { if (error instanceof CollectionControlConflict) throw new Conflict(error.message); throw error; }
}
