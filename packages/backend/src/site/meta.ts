// Small site-wide facts for the web shell (e.g. the changelog red-dot anchor).
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ChangelogResponse, SiteMeta } from "@aihot/contracts/site";
import { REPO_ROOT } from "../config.ts";
import { serverModules } from "../modules.ts";

let changelogCache: ChangelogResponse | null = null;

/** Changelog is published as a data file of the site (site/changelog.json), newest first. */
export async function loadChangelog(): Promise<ChangelogResponse> {
  const owner = serverModules().find(module => module.changelog)?.changelog;
  if (owner) return owner();
  changelogCache ??= JSON.parse(readFileSync(path.join(REPO_ROOT, "site/changelog.json"), "utf8")) as ChangelogResponse;
  return changelogCache;
}

export async function siteMeta(): Promise<SiteMeta> {
  return { changelogVersion: (await loadChangelog()).latestVersion };
}
