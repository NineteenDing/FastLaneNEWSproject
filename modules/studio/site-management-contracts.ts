import type { ChangelogRelease } from "@aihot/contracts/site";

export interface StudioSiteAbout { title: string; subtitle: string; paragraphs: string[] }
export interface StudioSiteRelease extends ChangelogRelease { id: string; published: boolean }
export interface SiteManagement { version: number; about: StudioSiteAbout; releases: StudioSiteRelease[] }
