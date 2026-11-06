import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined });
export const q = (t, p) => pool.query(t, p).then(r => r.rows);
export async function init() {
  await q(`create table if not exists tracks(
    id serial primary key, title text not null, artist text not null default '',
    duration real not null, audio_path text not null, cover_path text,
    position int not null default 0, created_at timestamptz default now())`);
  await q('alter table tracks add column if not exists tg_unique_id text');
  await q('create unique index if not exists tracks_tg_uq on tracks(tg_unique_id) where tg_unique_id is not null');
  await q(`create table if not exists settings(key text primary key, value text)`);
}
export async function getSetting(k, d) { const r = await q('select value from settings where key=$1', [k]); return r.length ? r[0].value : d; }
export const setSetting = (k, v) => q('insert into settings(key,value) values($1,$2) on conflict(key) do update set value=excluded.value', [k, String(v)]);
