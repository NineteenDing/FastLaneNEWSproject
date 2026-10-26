import { expect, type Page } from "@playwright/test";

/** Open the actual settings diagnostics for the period currently visible to the user. */
export async function openTopicProcessing(page: Page) {
  const url = new URL(page.url());
  if (url.pathname === "/admin/studio/settings/processing") return;
  let batch = url.pathname.match(/\/topics\/batches\/([^/]+)$/)?.[1] ?? url.searchParams.get("batch");
  if (!batch && url.searchParams.get("view") === "history") {
    const selected = page.getByRole("complementary", { name: "历史批次", exact: true }).locator('a[aria-current="page"]');
    if (await selected.count()) batch = new URL((await selected.getAttribute("href"))!, url).searchParams.get("batch");
  }
  await page.goto(url.origin + "/admin/studio/settings/processing" + (batch ? "?batch=" + encodeURIComponent(batch) : ""));
  await expect(page.getByRole("region", { name: "选题处理状态", exact: true })).toBeVisible();
}
