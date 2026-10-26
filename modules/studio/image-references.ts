const assetPath = String.raw`/api/admin/studio/image-assets/([a-f0-9]{64})`;
const exactAssetPath = new RegExp(`^${assetPath}$`);

/** Shared browser/server rule: only private, same-origin workbench images are managed. */
export const isManagedImageUrl = (src: unknown): src is string => typeof src === "string" && exactAssetPath.test(src);

export const imageAssetReferences = () => new RegExp(`${assetPath}(?![a-f0-9])`, "g");
