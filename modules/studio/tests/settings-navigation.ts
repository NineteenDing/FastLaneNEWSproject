import { expect, type Page } from "@playwright/test";

/** Exercise the actual settings navigation while preserving another page's unsaved form. */
export async function inSettingsSection(page: Page, section: string, action: () => Promise<unknown>) {
  const previous = new URL(page.url()).pathname.split("/").at(-1)!;
  const returnSection = previous === "settings" ? "models" : previous;
  const link = (id: string) => page.getByRole("navigation", { name: "设置分类" }).locator(`a[href="/admin/studio/settings/${id}"]`);
  async function visit(id: string) {
    await link(id).click();
    await page.waitForURL(url => url.pathname === `/admin/studio/settings/${id}`);
    await expect(link(id)).toHaveAttribute("aria-current", "page");
  }
  if (returnSection === section) return action();
  await visit(section);
  try { return await action(); }
  finally { await visit(returnSection); }
}
