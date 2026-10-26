import { collectionEnabled } from "@aihot/backend/operations/collection-control";
console.log(JSON.stringify({ enabled: collectionEnabled() }));
