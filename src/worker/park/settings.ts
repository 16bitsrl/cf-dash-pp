import type { CfApi } from "../lib/cf";
import { now } from "../lib/db";
import { cleanParkSettings, fromLegacy, publishParking, readPublishedSettings, type ParkSettings } from "./publish";

type Row = { data: string; published_at: number | null; updated_at: number | null; updated_by: string | null };
type LegacyRow = { brand: string | null; scope: "all" | "listed"; include: string; exclude: string; published_at: number | null; updated_at: number | null; updated_by: string | null };

/**
 * The settings published in the account's parking Worker. Accounts saved before the settings
 * travelled with the Worker still have them only here, until the next save.
 */
export async function loadParkSettings(db: D1Database, api: CfApi, accountId: string) {
  const published = await readPublishedSettings(api, accountId);
  if (published) return { ...published, publishedAt: published.updatedAt };
  const row = await db.prepare("SELECT * FROM park_pages WHERE account_id = ?").bind(accountId).first<Row>();
  if (row) return { settings: cleanParkSettings(JSON.parse(row.data)), publishedAt: row.published_at, updatedAt: row.updated_at, updatedBy: row.updated_by };
  const old = await db.prepare("SELECT * FROM park_settings WHERE account_id = ?").bind(accountId).first<LegacyRow>();
  if (!old) return { settings: cleanParkSettings({ pages: [], defaultPage: "", assign: {} }), publishedAt: null, updatedAt: null, updatedBy: null };
  return {
    settings: fromLegacy({ brand: old.brand ? JSON.parse(old.brand) : null, scope: old.scope, include: JSON.parse(old.include), exclude: JSON.parse(old.exclude) }),
    publishedAt: old.published_at,
    updatedAt: old.updated_at,
    updatedBy: old.updated_by,
  };
}

/** Publishes the parking pages with these settings, which are saved inside the Worker. */
export async function saveAndPublish(api: CfApi, accountId: string, s: ParkSettings, actor: string) {
  await publishParking(api, accountId, s, { updatedAt: now(), updatedBy: actor });
}

/** Publishes the parking pages if the account does not have them yet. */
export async function ensureParkingPublished(db: D1Database, api: CfApi, accountId: string, published: boolean, actor: string) {
  if (published) return false;
  const { settings } = await loadParkSettings(db, api, accountId);
  await saveAndPublish(api, accountId, settings, actor);
  return true;
}
