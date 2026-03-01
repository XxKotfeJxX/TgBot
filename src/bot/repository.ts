import { Pool } from "pg";
import {
  INLINE_FETCH_LIMIT,
  computeDecayedPopScore,
  normalizeMediaType,
  normalizePendingPhotos,
  parseAssetIdFromInlineResultId,
  parseMediaTypeFromInlineResultId,
  sortInlineRows,
  type InsertBatchResult,
  type PendingPhoto,
  type PhotoRow,
  type SavedAsset
} from "../core";

export interface BotRepository {
  initDb(): Promise<void>;
  close(): Promise<void>;
  getPhotosCount(userId: number): Promise<number>;
  getPhotosPage(userId: number, limit: number, offset: number): Promise<PhotoRow[]>;
  getPhotoByNumber(userId: number, offset: number): Promise<PhotoRow | undefined>;
  getRecentPhotos(userId: number, limit: number): Promise<PhotoRow[]>;
  getRankedInlineRows(userId: number): Promise<PhotoRow[]>;
  deletePhotoById(photoId: number, userId: number): Promise<void>;
  insertPhotosWithDescription(userId: number, photos: PendingPhoto[], description: string): Promise<InsertBatchResult>;
  loadFavoriteAssetIdSet(userId: number, assetIds: number[]): Promise<Set<number>>;
  applyFavoriteFlags(userId: number, rows: PhotoRow[]): Promise<PhotoRow[]>;
  toggleFavorite(userId: number, assetId: number): Promise<boolean>;
  trackChosenInlineResult(userId: number, resultId: string, query: string): Promise<void>;
}

export function createDbPool(databaseUrl: string): Pool {
  return new Pool({
    connectionString: databaseUrl,
    ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false }
  });
}

export function createBotRepository(db: Pool): BotRepository {
  async function initDb(): Promise<void> {
    await db.query(`
      CREATE TABLE IF NOT EXISTS photos (
        id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        user_id BIGINT NOT NULL,
        file_id TEXT NOT NULL,
        file_unique_id TEXT NOT NULL,
        media_type TEXT NOT NULL DEFAULT 'photo',
        pop_score DOUBLE PRECISION NOT NULL DEFAULT 0,
        last_used_at TIMESTAMPTZ,
        description TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT uq_photos_user_unique UNIQUE (user_id, file_unique_id)
      );
    `);

    await db.query(`
      ALTER TABLE photos
      ADD COLUMN IF NOT EXISTS media_type TEXT NOT NULL DEFAULT 'photo';
    `);

    await db.query(`
      ALTER TABLE photos
      ADD COLUMN IF NOT EXISTS pop_score DOUBLE PRECISION NOT NULL DEFAULT 0;
    `);

    await db.query(`
      ALTER TABLE photos
      ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_photos_user_id
      ON photos(user_id);
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_photos_user_description
      ON photos(user_id, description);
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_photos_user_usage
      ON photos(user_id, pop_score DESC, last_used_at DESC);
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS favorites (
        user_id BIGINT NOT NULL,
        asset_id INTEGER NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, asset_id),
        CONSTRAINT fk_favorites_asset
          FOREIGN KEY (asset_id)
          REFERENCES photos(id)
          ON DELETE CASCADE
      );
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_favorites_user_created
      ON favorites(user_id, created_at DESC);
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS inline_usage (
        id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        user_id BIGINT NOT NULL,
        result_id TEXT NOT NULL,
        media_type TEXT NOT NULL,
        query TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_inline_usage_user_created
      ON inline_usage(user_id, created_at DESC);
    `);
  }

  async function close(): Promise<void> {
    await db.end();
  }

  async function getPhotosCount(userId: number): Promise<number> {
    const result = await db.query<{ total: number }>(
      `
        SELECT COUNT(*)::int AS total
        FROM photos
        WHERE user_id = $1
      `,
      [userId]
    );

    return Number(result.rows[0]?.total || 0);
  }

  async function getPhotosPage(userId: number, limit: number, offset: number): Promise<PhotoRow[]> {
    const result = await db.query<PhotoRow>(
      `
        SELECT id, file_id, description, media_type
        FROM photos
        WHERE user_id = $1
        ORDER BY id ASC
        LIMIT $2 OFFSET $3
      `,
      [userId, limit, offset]
    );

    return result.rows.map((row) => ({
      id: Number(row.id),
      file_id: row.file_id,
      description: row.description,
      media_type: normalizeMediaType((row as any).media_type)
    }));
  }

  async function getPhotoByNumber(userId: number, offset: number): Promise<PhotoRow | undefined> {
    const result = await db.query<PhotoRow>(
      `
        SELECT id, file_id, description, media_type
        FROM photos
        WHERE user_id = $1
        ORDER BY id ASC
        LIMIT 1 OFFSET $2
      `,
      [userId, offset]
    );

    const row = result.rows[0];
    if (!row) return undefined;

    return {
      id: Number(row.id),
      file_id: row.file_id,
      description: row.description,
      media_type: normalizeMediaType((row as any).media_type)
    };
  }

  async function getRecentPhotos(userId: number, limit: number): Promise<PhotoRow[]> {
    const result = await db.query<PhotoRow>(
      `
        SELECT id, file_id, description, media_type, pop_score, last_used_at
        FROM photos
        WHERE user_id = $1
        ORDER BY id DESC
        LIMIT $2
      `,
      [userId, limit]
    );

    return result.rows.map((row) => ({
      id: Number(row.id),
      file_id: row.file_id,
      description: row.description,
      media_type: normalizeMediaType((row as any).media_type),
      pop_score: Number((row as any).pop_score || 0),
      last_used_at: ((row as any).last_used_at as string | null) || null
    }));
  }

  async function getRankedInlineRows(userId: number): Promise<PhotoRow[]> {
    const sourceRows = await getRecentPhotos(userId, INLINE_FETCH_LIMIT);
    const rowsWithFavorites = await applyFavoriteFlags(userId, sourceRows);
    return sortInlineRows(rowsWithFavorites, "");
  }

  async function deletePhotoById(photoId: number, userId: number): Promise<void> {
    await db.query(
      `
        DELETE FROM photos
        WHERE id = $1 AND user_id = $2
      `,
      [photoId, userId]
    );
  }

  async function insertPhotosWithDescription(
    userId: number,
    photos: PendingPhoto[],
    description: string
  ): Promise<InsertBatchResult> {
    const uniquePhotos = normalizePendingPhotos(photos);
    if (!uniquePhotos.length) {
      return { saved: 0, skipped: 0, savedAssets: [] };
    }

    const client = await db.connect();
    try {
      await client.query("BEGIN");

      let saved = 0;
      let skipped = 0;
      const savedAssets: SavedAsset[] = [];

      for (const photo of uniquePhotos) {
        const result = await client.query<{ id: number; file_id: string }>(
          `
            INSERT INTO photos (user_id, file_id, file_unique_id, media_type, description)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (user_id, file_unique_id) DO NOTHING
            RETURNING id, file_id, media_type
          `,
          [userId, photo.fileId, photo.fileUniqueId, photo.mediaType, description]
        );

        if ((result.rowCount || 0) > 0) {
          saved += 1;
          savedAssets.push({
            id: Number(result.rows[0].id),
            fileId: String(result.rows[0].file_id),
            mediaType: normalizeMediaType((result.rows[0] as any).media_type)
          });
        } else {
          skipped += 1;
        }
      }

      await client.query("COMMIT");
      return { saved, skipped, savedAssets };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async function loadFavoriteAssetIdSet(userId: number, assetIds: number[]): Promise<Set<number>> {
    if (!assetIds.length) return new Set<number>();

    const result = await db.query<{ asset_id: string | number }>(
      `
        SELECT asset_id
        FROM favorites
        WHERE user_id = $1 AND asset_id = ANY($2::int[])
      `,
      [userId, assetIds]
    );

    return new Set(result.rows.map((row) => Number(row.asset_id)));
  }

  async function applyFavoriteFlags(userId: number, rows: PhotoRow[]): Promise<PhotoRow[]> {
    const favoriteIds = await loadFavoriteAssetIdSet(
      userId,
      rows.map((row) => row.id)
    );

    return rows.map((row) => ({
      ...row,
      is_favorite: favoriteIds.has(row.id)
    }));
  }

  async function toggleFavorite(userId: number, assetId: number): Promise<boolean> {
    const ownedAsset = await db.query<{ id: number }>(
      `
        SELECT id
        FROM photos
        WHERE id = $1 AND user_id = $2
        LIMIT 1
      `,
      [assetId, userId]
    );

    if (!ownedAsset.rows.length) {
      throw new Error("Asset not found");
    }

    const existing = await db.query<{ asset_id: number }>(
      `
        SELECT asset_id
        FROM favorites
        WHERE user_id = $1 AND asset_id = $2
        LIMIT 1
      `,
      [userId, assetId]
    );

    if (existing.rows.length) {
      await db.query(
        `
          DELETE FROM favorites
          WHERE user_id = $1 AND asset_id = $2
        `,
        [userId, assetId]
      );
      return false;
    }

    await db.query(
      `
        INSERT INTO favorites (user_id, asset_id)
        VALUES ($1, $2)
        ON CONFLICT (user_id, asset_id) DO NOTHING
      `,
      [userId, assetId]
    );

    return true;
  }

  async function applyInlineUsageToAsset(userId: number, assetId: number): Promise<void> {
    const selected = await db.query<{ id: number; pop_score: number; last_used_at: string | null }>(
      `
        SELECT id, pop_score, last_used_at
        FROM photos
        WHERE id = $1 AND user_id = $2
        LIMIT 1
      `,
      [assetId, userId]
    );

    if (!selected.rows.length) return;
    const row = selected.rows[0];
    const newScore = computeDecayedPopScore(Number(row.pop_score || 0), row.last_used_at || null);

    await db.query(
      `
        UPDATE photos
        SET pop_score = $1, last_used_at = NOW()
        WHERE id = $2 AND user_id = $3
      `,
      [newScore, assetId, userId]
    );
  }

  async function trackChosenInlineResult(userId: number, resultId: string, query: string): Promise<void> {
    const assetId = parseAssetIdFromInlineResultId(resultId);
    if (assetId) {
      await applyInlineUsageToAsset(userId, assetId);
    }

    await db.query(
      `
        INSERT INTO inline_usage (user_id, result_id, media_type, query)
        VALUES ($1, $2, $3, $4)
      `,
      [userId, resultId, parseMediaTypeFromInlineResultId(resultId), query]
    );
  }

  return {
    initDb,
    close,
    getPhotosCount,
    getPhotosPage,
    getPhotoByNumber,
    getRecentPhotos,
    getRankedInlineRows,
    deletePhotoById,
    insertPhotosWithDescription,
    loadFavoriteAssetIdSet,
    applyFavoriteFlags,
    toggleFavorite,
    trackChosenInlineResult
  };
}
