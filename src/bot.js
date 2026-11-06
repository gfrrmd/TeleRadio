import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import { q, setSetting } from './db.js';
import * as streamer from './streamer.js';
import { UP, addTrack } from './library.js';
import { fmt } from './render.js';

const TOKEN = process.env.BOT_TOKEN;
const list = v => (v || '').split(',').map(s => s.trim()).filter(Boolean);
const SOURCES = list(process.env.SOURCE_CHAT_IDS);   // ID channel sumber musik
const ADMINS = list(process.env.BOT_ADMIN_IDS);      // ID user Telegram yang boleh pakai bot
const sleep = ms => new Promise(r => setTimeout(r, ms));
const warned = new Set();

async function call(method, params = {}) {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(`${method}: ${j.description}`);
  return j.result;
}
async function fetchFile(fileId) {
  const f = await call('getFile', { file_id: fileId });
  const r = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${f.file_path}`);
  if (!r.ok) throw new Error('Download gagal: HTTP ' + r.status);
  return r;
}
const notify = text => Promise.all(ADMINS.map(id => call('sendMessage', { chat_id: id, text }).catch(() => {})));

const AUDIO_EXT = /\.(mp3|m4a|flac|ogg|opus|wav|aac)$/i;
const audioOf = m => m.audio || (m.document && (m.document.mime_type?.startsWith('audio/') || AUDIO_EXT.test(m.document.file_name || '')) ? m.document : null);

async function ingest(msg) {
  const a = audioOf(msg);
  if (!a) return;
  const label = [a.performer, a.title || a.file_name].filter(Boolean).join(' - ') || 'audio';
  if ((await q('select 1 from tracks where tg_unique_id=$1', [a.file_unique_id])).length) return notify(`⏭ Sudah ada di playlist: ${label}`);
  const ext = path.extname(a.file_name || '').toLowerCase() || '.mp3';
  const dest = path.join(UP, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`);
  try {
    await fsp.mkdir(UP, { recursive: true });
    await pipeline(Readable.fromWeb((await fetchFile(a.file_id)).body), fs.createWriteStream(dest));
    const th = a.thumbnail || a.thumb;
    const coverBuf = th ? Buffer.from(await (await fetchFile(th.file_id)).arrayBuffer()).subarray(0) : null;
    const t = await addTrack({ filePath: dest, fileName: a.file_name, title: a.title, artist: a.performer, coverBuf, uniqueId: a.file_unique_id });
    const n = (await q('select count(*)::int c from tracks'))[0].c;
    await notify(`✅ Ditambahkan: ${t.artist || '?'} - ${t.title} (${fmt(t.duration)})\nTotal playlist: ${n} lagu`);
  } catch (e) {
    await fsp.unlink(dest).catch(() => {});
    const big = /too big/i.test(e.message) ? ' (batas download Bot API 20 MB, kompres file atau pakai Bot API server sendiri)' : '';
    await notify(`❌ Gagal menambah ${label}: ${e.message}${big}`);
  }
}

const HELP = `Perintah:
/play - mulai stream
/stop - hentikan stream
/skip - lewati lagu
/now - lagu yang sedang diputar
/list - 25 lagu pertama di playlist
/shuffle on|off
/loop on|off

Kirim/forward file audio ke chat ini untuk menambah lagu. Audio yang diposting di channel sumber otomatis masuk playlist.`;

async function command(msg) {
  const [cmd, arg] = msg.text.trim().split(/\s+/);
  const reply = text => call('sendMessage', { chat_id: msg.chat.id, text });
  try {
    switch (cmd.split('@')[0].toLowerCase()) {
      case '/start': case '/help': return await reply(HELP);
      case '/play': await streamer.start(); return await reply('▶️ Stream dimulai');
      case '/stop': await streamer.stop(); return await reply('■ Stream dihentikan');
      case '/skip': streamer.skip(); return await reply('⏭ Lagu dilewati');
      case '/now': { const s = streamer.getStatus(); return await reply(s.current ? `${s.running ? '🔴 LIVE' : '⚫'} ${s.current.artist} - ${s.current.title}` : '⚫ Stream offline'); }
      case '/list': {
        const r = await q('select title,artist,duration from tracks order by position,id limit 25');
        return await reply(r.length ? r.map((t, i) => `${i + 1}. ${t.artist ? t.artist + ' - ' : ''}${t.title} (${fmt(t.duration)})`).join('\n') : 'Playlist kosong');
      }
      case '/shuffle': case '/loop': {
        const k = cmd.slice(1).split('@')[0].toLowerCase();
        await setSetting(k, arg === 'on');
        return await reply(`${k}: ${arg === 'on' ? 'ON' : 'OFF'}`);
      }
      default: return await reply(HELP);
    }
  } catch (e) { await reply('⚠️ ' + e.message).catch(() => {}); }
}

async function handle(u) {
  const post = u.channel_post, msg = u.message;
  if (post) {
    const id = String(post.chat.id);
    if (SOURCES.includes(id)) return ingest(post);
    if (audioOf(post) && !warned.has(id)) {
      warned.add(id);
      await notify(`ℹ️ Ada audio di chat "${post.chat.title}" (ID ${id}) tapi belum diizinkan. Tambahkan ID itu ke SOURCE_CHAT_IDS di Railway.`);
    }
    return;
  }
  if (msg && msg.chat.type === 'private' && ADMINS.includes(String(msg.from?.id))) {
    return msg.text?.startsWith('/') ? command(msg) : ingest(msg);
  }
}

export async function startBot() {
  if (!TOKEN) return console.log('BOT_TOKEN kosong, bot Telegram dinonaktifkan');
  await call('deleteWebhook').catch(() => {});
  console.log('Bot aktif: @' + (await call('getMe')).username);
  let offset = 0;
  for (;;) {
    try {
      const ups = await call('getUpdates', { offset, timeout: 50, allowed_updates: ['channel_post', 'message'] });
      for (const u of ups) { offset = u.update_id + 1; await handle(u).catch(e => console.error('bot:', e.message)); }
    } catch (e) { console.error('getUpdates:', e.message); await sleep(5000); }
  }
}
