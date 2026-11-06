import sharp from 'sharp';
import fs from 'fs/promises';

const esc = s => String(s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
export const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

const defaultCover = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6d28d9"/><stop offset="1" stop-color="#0ea5e9"/></linearGradient></defs><rect width="600" height="600" fill="url(#g)"/><text x="300" y="400" font-size="320" text-anchor="middle" fill="#fff" fill-opacity=".85" font-family="DejaVu Sans">♪</text></svg>`;

export async function renderCard(track, out) {
  let base = null;
  if (track.cover_path) base = await fs.readFile(track.cover_path).catch(() => null);
  if (base) { try { await sharp(base).metadata(); } catch { base = null; } }
  if (!base) base = await sharp(Buffer.from(defaultCover)).png().toBuffer();

  const bg = await sharp(base).resize(1280, 720, { fit: 'cover' }).blur(40).modulate({ brightness: 0.45 }).png().toBuffer();
  const cover = await sharp(base).resize(400, 400, { fit: 'cover' }).png().toBuffer();
  const station = esc(process.env.STATION_NAME || 'Radio 24/7');
  const text = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" font-family="DejaVu Sans">
    <text x="60" y="70" font-size="28" fill="#fff" fill-opacity=".8">● ${station}</text>
    <text x="580" y="250" font-size="22" fill="#a5b4fc" letter-spacing="4">NOW PLAYING</text>
    <text x="580" y="320" font-size="46" font-weight="bold" fill="#fff">${esc(cut(track.title, 28))}</text>
    <text x="580" y="375" font-size="30" fill="#d1d5db">${esc(cut(track.artist || 'Unknown Artist', 36))}</text>
    <rect x="160" y="640" width="960" height="8" fill="#555"/>
    <text x="1120" y="626" font-size="26" fill="#fff" text-anchor="end">${fmt(track.duration)}</text>
  </svg>`;
  await sharp(bg).composite([{ input: cover, left: 120, top: 160 }, { input: Buffer.from(text), left: 0, top: 0 }]).png().toFile(out);
}
