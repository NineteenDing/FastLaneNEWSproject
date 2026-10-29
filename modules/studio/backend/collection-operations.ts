import { z } from "zod";
import { audit, Conflict } from "@aihot/backend/audit";
import { collectionControlState, saveCollectionControl, CollectionControlConflict } from "@aihot/backend/operations/collection-control";

import {mediaControlState,saveMediaControl,MediaControlConflict} from "./media-control.ts";
export const collectionOperations = () => ({...collectionControlState(),media:mediaControlState()});
export async function saveCollectionOperations(input: unknown, actor: string) {
  const value = z.object({ version: z.number().int().nonnegative(), enabled: z.boolean(), target:z.enum(["collection","media"]).default("collection") }).strict().parse(input);
  const before = collectionOperations();
  try {
    const saved = value.target === "media" ? saveMediaControl(value,actor) : saveCollectionControl(value, actor);
    await audit(actor, "studio.collection.operations", "studio.collection.operations", null, before, saved);
    return saved;
  } catch (error) { if (error instanceof CollectionControlConflict || error instanceof MediaControlConflict) throw new Conflict(error.message); throw error; }
}
