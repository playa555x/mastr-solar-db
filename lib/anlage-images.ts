// Anlage-Bilder: Foto-Dokumentation pro Anlage.
// Storage auf Disk (NICHT in DB) — Pfad: ${UPLOADS_DIR}/anlage-images/{anlage_id}/{uuid}.{ext}
// DB hält nur Metadaten + Pfad.

import type { Database } from "bun:sqlite";

export const ALLOWED_IMAGE_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB

export function ensureAnlageImagesTable(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS anlage_images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      anlage_id INTEGER NOT NULL,
      stored_path TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      caption TEXT,
      uploaded_by INTEGER NOT NULL,
      uploaded_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (anlage_id) REFERENCES anlagen(id) ON DELETE CASCADE,
      FOREIGN KEY (uploaded_by) REFERENCES users(id)
    )
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_anlage_images_anlage ON anlage_images(anlage_id)");
  db.run("CREATE INDEX IF NOT EXISTS idx_anlage_images_uploader ON anlage_images(uploaded_by)");
}

export interface AnlageImage {
  id: number;
  anlage_id: number;
  stored_path: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  caption: string | null;
  uploaded_by: number;
  uploaded_at: string;
}

export interface AnlageImageView {
  id: number;
  anlage_id: number;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  caption: string | null;
  uploaded_by: number;
  uploaded_by_name: string | null;
  uploaded_at: string;
  url: string;
}

/**
 * Mapping ohne stored_path (interne Pfade nie an Client leaken).
 */
export function toAnlageImageView(row: any): AnlageImageView {
  return {
    id: row.id,
    anlage_id: row.anlage_id,
    original_name: row.original_name,
    mime_type: row.mime_type,
    size_bytes: row.size_bytes,
    caption: row.caption,
    uploaded_by: row.uploaded_by,
    uploaded_by_name: row.uploaded_by_name || null,
    uploaded_at: row.uploaded_at,
    url: `/api/anlagen/${row.anlage_id}/images/${row.id}`,
  };
}
