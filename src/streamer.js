import { spawn } from 'child_process';
import fs from 'fs/promises';
import { q, getSetting, setSetting } from './db.js';
import { renderCard } from './render.js';

const FONT = process.env.FONT_FILE || '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
const sleep = ms => new Promise(r => setTimeout(r, ms));
export const logs = [];
const log = m => { logs.push(`${new Date().toISOString().slice(11, 19)} ${m}`); if (logs.length > 200) logs.shift(); console.log(m); };

const state = { running: false, current: null, startedAt: 0, lastError: null };
let pusher = null, trackProc = null, stopFlag = false, loopPromise = null;
let jump = null, lastId = null, offset = 0, pusherDied = false;

function rtmpUrl() {
  const base = (process.env.TELEGRAM_RTMPS_URL || '').trim().replace(/\/+$/, '');
  const key = (process.env.TELEGRAM_STREAM_KEY || '').trim();
  if (!base || !key) throw new Error('TELEGRAM_RTMPS_URL / TELEGRAM_STREAM_KEY belum diisi');
  return `${base}/${key}`;
}

function startPusher() {
  const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'warning', '-fflags', '+genpts', '-f', 'mpegts', '-i', 'pipe:0',
    '-c', 'copy', '-f', 'flv', '-flvflags', 'no_duration_filesize', rtmpUrl()], { stdio: ['pipe', 'ignore', 'pipe'] });
  pusher = p;
  p.stdin.on('error', () => {});
  p.stderr.on('data', d => log('[push] ' + d.toString().trim()));
  p.on('exit', code => {
    log('pusher keluar, kode ' + code);
    if (pusher === p) { pusher = null; pusherDied = true; }
    if (trackProc) trackProc.kill('SIGKILL');
  });
}

async function pickNext() {
  const tracks = await q('select * from tracks order by position,id');
  if (!tracks.length) return null;
  if (jump) { const t = tracks.find(x => x.id === jump); jump = null; if (t) return t; }
  if ((await getSetting('shuffle', 'false')) === 'true') {
    const pool = tracks.length > 1 ? tracks.filter(t => t.id !== lastId) : tracks;
    return pool[Math.floor(Math.random() * pool.length)];
  }
  const i = tracks.findIndex(t => t.id === lastId);
  if (i === -1) return tracks[0];
  if (i + 1 < tracks.length) return tracks[i + 1];
  return (await getSetting('loop', 'true')) === 'true' ? tracks[0] : null;
}

async function playTrack(t) {
  const card = `/tmp/card-${t.id}.png`;
  await renderCard(t, card);
  const dur = Math.max(1, t.duration).toFixed(2);
  const filter = [
    '[0:v]split=2[bg][bg2]',
    '[bg2]crop=160:8:0:640[left]',
    `[bg][1:v]overlay=x='160-960+min(960*t/${dur},960)':y=640[a]`,
    '[a][left]overlay=0:640[b]',
    `[b]drawtext=fontfile=${FONT}:text='%{eif\\:t/60\\:d}\\:%{eif\\:mod(t,60)\\:d\\:2}':x=160:y=600:fontsize=26:fontcolor=white,format=yuv420p[v]`,
  ].join(';');
  const args = ['-hide_banner', '-loglevel', 'error',
    '-re', '-loop', '1', '-framerate', '5', '-i', card,
    '-re', '-f', 'lavfi', '-i', 'color=c=white:s=960x8:r=5',
    '-re', '-i', t.audio_path,
    '-filter_complex', filter, '-map', '[v]', '-map', '2:a',
    '-r', '5', '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'stillimage', '-profile:v', 'main',
    '-b:v', '700k', '-maxrate', '700k', '-bufsize', '1400k', '-g', '10', '-keyint_min', '10', '-sc_threshold', '0',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
    '-shortest', '-output_ts_offset', String(offset), '-f', 'mpegts', 'pipe:1'];

  state.current = { id: t.id, title: t.title, artist: t.artist, duration: t.duration, hasCover: !!t.cover_path };
  state.startedAt = Date.now();
  log(`▶ ${t.artist} - ${t.title}`);
  const p = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  trackProc = p;
  p.stdout.on('error', () => {});
  p.stdout.pipe(pusher.stdin, { end: false });
  p.stderr.on('data', d => log('[track] ' + d.toString().trim()));
  const code = await new Promise(r => p.on('exit', r));
  p.stdout.unpipe();
  trackProc = null;
  fs.unlink(card).catch(() => {});
  const played = (Date.now() - state.startedAt) / 1000;
  offset += code === 0 ? t.duration : played;
  if (played < 2 && !stopFlag) await sleep(2000);
}

async function run() {
  try {
    while (!stopFlag) {
      if (!pusher) {
        if (pusherDied) { await sleep(5000); if (stopFlag) break; }
        pusherDied = false; offset = 0;
        try { startPusher(); } catch (e) { state.lastError = e.message; log(e.message); await sleep(5000); continue; }
      }
      const t = await pickNext();
      if (!t) { log('Tidak ada lagu untuk diputar, stream berhenti'); await setSetting('running', false); break; }
      lastId = t.id;
      try { await playTrack(t); } catch (e) { state.lastError = e.message; log('Error: ' + e.message); await sleep(2000); }
    }
  } finally {
    if (pusher) { const p = pusher; pusher = null; p.kill('SIGKILL'); }
    state.running = false; state.current = null;
  }
}

export async function start() {
  if (state.running) return;
  const n = await q('select count(*)::int c from tracks');
  if (!n[0].c) throw new Error('Playlist masih kosong');
  rtmpUrl();
  state.running = true; state.lastError = null; stopFlag = false; pusherDied = false;
  await setSetting('running', true);
  loopPromise = run();
}
export async function stop() {
  stopFlag = true;
  await setSetting('running', false);
  if (trackProc) trackProc.kill('SIGKILL');
  if (pusher) pusher.kill('SIGKILL');
  await loopPromise;
}
export const skip = () => { if (trackProc) trackProc.kill('SIGKILL'); };
export const playNow = id => { jump = id; skip(); };
export const getStatus = () => ({
  running: state.running, station: process.env.STATION_NAME || 'Radio 24/7', lastError: state.lastError,
  current: state.current, elapsed: state.current ? (Date.now() - state.startedAt) / 1000 : 0,
});
export async function autoStart() {
  if ((await getSetting('running', 'false')) === 'true') { log('Auto-start stream setelah restart'); await start().catch(e => log(e.message)); }
}
