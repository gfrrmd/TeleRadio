import express from 'express';
import multer from 'multer';
import path from 'path';
import crypto from 'crypto';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { parseFile, selectCover } from 'music-metadata';
import { q, init, getSetting, setSetting } from './db.js';
import * as streamer from './streamer.js';
import { startBot } from './bot.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(process.env.DATA_DIR || './data');
const UP = path.join(DATA, 'uploads'), COV = path.join(DATA, 'covers');
await fs.mkdir(UP, { recursive: true }); await fs.mkdir(COV, { recursive: true });
await init();

const app = express();
app.use(express.json());
const sessions = new Set();
const sid = req => (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('sid='))?.slice(4);
const auth = (req, res, next) => (sessions.has(sid(req)) ? next() : res.status(401).json({ error: 'Belum login' }));
const wrap = fn => (req, res) => fn(req, res).catch(e => { console.error(e); res.status(500).json({ error: e.message }); });

app.post('/api/login', wrap(async (req, res) => {
  const a = Buffer.from(String(req.body.password || '')), b = Buffer.from(process.env.ADMIN_PASSWORD || '');
  const ok = b.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) { await new Promise(r => setTimeout(r, 800)); return res.status(401).json({ error: 'Password salah' }); }
  const id = crypto.randomBytes(24).toString('hex'); sessions.add(id);
  res.setHeader('Set-Cookie', `sid=${id}; HttpOnly; Path=/; SameSite=Lax; Max-Age=604800${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
  res.json({ ok: true });
}));
app.post('/api/logout', (req, res) => { sessions.delete(sid(req)); res.json({ ok: true }); });
app.get('/api/me', auth, (_, res) => res.json({ ok: true }));
app.get('/api/status', (_, res) => res.json(streamer.getStatus()));
app.get('/cover/:id', wrap(async (req, res) => {
  const r = await q('select cover_path from tracks where id=$1', [req.params.id]);
  if (!r[0]?.cover_path) return res.status(404).end();
  res.sendFile(r[0].cover_path);
}));

const upload = multer({
  storage: multer.diskStorage({
    destination: (_, __, cb) => cb(null, UP),
    filename: (_, f, cb) => cb(null, Date.now() + '-' + crypto.randomBytes(4).toString('hex') + path.extname(f.originalname).toLowerCase()),
  }),
  limits: { fileSize: 100 * 1024 * 1024 },
});
const saveCover = async buf => { const p = path.join(COV, Date.now() + '-' + crypto.randomBytes(4).toString('hex') + '.img'); await fs.writeFile(p, buf); return p; };

app.get('/api/tracks', auth, wrap(async (_, res) => res.json(await q('select id,title,artist,duration,position,(cover_path is not null) as has_cover from tracks order by position,id'))));

app.post('/api/tracks', auth, upload.fields([{ name: 'audio', maxCount: 50 }, { name: 'cover', maxCount: 1 }]), wrap(async (req, res) => {
  const audios = req.files?.audio || [];
  if (!audios.length) return res.status(400).json({ error: 'Tidak ada file audio' });
  const manualCover = req.files?.cover?.[0];
  let added = 0;
  for (const f of audios) {
    try {
      const meta = await parseFile(f.path);
      let cover = null;
      if (manualCover && audios.length === 1) cover = await saveCover(await fs.readFile(manualCover.path));
      else { const pic = selectCover(meta.common.picture); if (pic) cover = await saveCover(Buffer.from(pic.data)); }
      const title = (audios.length === 1 && req.body.title) || meta.common.title || path.parse(f.originalname).name;
      const artist = (audios.length === 1 && req.body.artist) || meta.common.artist || '';
      const pos = (await q('select coalesce(max(position),0)+1 p from tracks'))[0].p;
      await q('insert into tracks(title,artist,duration,audio_path,cover_path,position) values($1,$2,$3,$4,$5,$6)',
        [title, artist, meta.format.duration || 0, f.path, cover, pos]);
      added++;
    } catch (e) { await fs.unlink(f.path).catch(() => {}); console.error('Gagal baca', f.originalname, e.message); }
  }
  if (manualCover) await fs.unlink(manualCover.path).catch(() => {});
  res.json({ added });
}));

app.patch('/api/tracks/:id', auth, wrap(async (req, res) => {
  await q('update tracks set title=coalesce($1,title), artist=coalesce($2,artist) where id=$3', [req.body.title ?? null, req.body.artist ?? null, req.params.id]);
  res.json({ ok: true });
}));
app.post('/api/tracks/:id/cover', auth, upload.single('cover'), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'File kosong' });
  const old = (await q('select cover_path from tracks where id=$1', [req.params.id]))[0]?.cover_path;
  const p = await saveCover(await fs.readFile(req.file.path)); await fs.unlink(req.file.path).catch(() => {});
  await q('update tracks set cover_path=$1 where id=$2', [p, req.params.id]);
  if (old) fs.unlink(old).catch(() => {});
  res.json({ ok: true });
}));
app.delete('/api/tracks/:id', auth, wrap(async (req, res) => {
  const r = await q('delete from tracks where id=$1 returning audio_path,cover_path', [req.params.id]);
  for (const p of [r[0]?.audio_path, r[0]?.cover_path]) if (p) fs.unlink(p).catch(() => {});
  res.json({ ok: true });
}));
app.post('/api/tracks/reorder', auth, wrap(async (req, res) => {
  const ids = req.body.ids || [];
  for (let i = 0; i < ids.length; i++) await q('update tracks set position=$1 where id=$2', [i + 1, ids[i]]);
  res.json({ ok: true });
}));

app.post('/api/stream/start', auth, wrap(async (_, res) => { await streamer.start(); res.json({ ok: true }); }));
app.post('/api/stream/stop', auth, wrap(async (_, res) => { await streamer.stop(); res.json({ ok: true }); }));
app.post('/api/stream/skip', auth, (_, res) => { streamer.skip(); res.json({ ok: true }); });
app.post('/api/stream/play/:id', auth, wrap(async (req, res) => { await streamer.start(); streamer.playNow(Number(req.params.id)); res.json({ ok: true }); }));
app.get('/api/logs', auth, (_, res) => res.json(streamer.logs));
app.get('/api/settings', auth, wrap(async (_, res) => res.json({ shuffle: (await getSetting('shuffle', 'false')) === 'true', loop: (await getSetting('loop', 'true')) === 'true' })));
app.post('/api/settings', auth, wrap(async (req, res) => {
  if ('shuffle' in req.body) await setSetting('shuffle', !!req.body.shuffle);
  if ('loop' in req.body) await setSetting('loop', !!req.body.loop);
  res.json({ ok: true });
}));

app.get('/admin', (_, res) => res.sendFile(path.join(__dirname, '../public/admin.html')));
app.use(express.static(path.join(__dirname, '../public')));

const port = process.env.PORT || 3000;
app.listen(port, () => { console.log('Server jalan di port ' + port); streamer.autoStart(); startBot().catch(e => console.error('Bot berhenti:', e.message)); });
process.on('SIGTERM', () => process.exit(0));
