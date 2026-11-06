import path from 'path';
import crypto from 'crypto';
import fs from 'fs/promises';
import { parseFile, selectCover } from 'music-metadata';
import { q } from './db.js';

const DATA = path.resolve(process.env.DATA_DIR || './data');
export const UP = path.join(DATA, 'uploads'), COV = path.join(DATA, 'covers');

export async function saveCover(buf) {
  await fs.mkdir(COV, { recursive: true });
  const p = path.join(COV, Date.now() + '-' + crypto.randomBytes(4).toString('hex') + '.img');
  await fs.writeFile(p, buf);
  return p;
}

// Tambah lagu dari file yang sudah ada di disk. Cover: tag ID3 dulu, lalu coverBuf (thumbnail Telegram).
export async function addTrack({ filePath, fileName, title, artist, coverBuf, uniqueId }) {
  const meta = await parseFile(filePath);
  const pic = selectCover(meta.common.picture);
  const cover = pic ? await saveCover(Buffer.from(pic.data)) : coverBuf ? await saveCover(coverBuf) : null;
  const t = meta.common.title || title || path.parse(fileName || 'Unknown').name;
  const a = meta.common.artist || artist || '';
  const pos = (await q('select coalesce(max(position),0)+1 p from tracks'))[0].p;
  await q('insert into tracks(title,artist,duration,audio_path,cover_path,position,tg_unique_id) values($1,$2,$3,$4,$5,$6,$7)',
    [t, a, meta.format.duration || 0, filePath, cover, pos, uniqueId || null]);
  return { title: t, artist: a, duration: meta.format.duration || 0 };
}
