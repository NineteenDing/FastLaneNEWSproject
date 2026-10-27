export type ModelProfile = "basic" | "creative";
/** Only mechanical material understanding and translation use the configurable low-cost API. */
export function modelProfileFor(purpose: string): ModelProfile {
 return ["studio_material_analysis","studio_news_title_translation","studio_film_translation","studio_daily_edition"].includes(purpose) ? "basic" : "creative";
}
