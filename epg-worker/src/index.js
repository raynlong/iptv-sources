// EPG Worker — CF 侧定时更新，替代 GitHub Actions cron
//
// 架构：
//  - Cron Trigger（每 2 小时）抓上游 XML（m3u.ibert.me，GitHub Pages 海外可达）
//    解析生成 JSON 写入 R2（key: epg/{provider}/{date}/{name}.json），并清理 3 天前旧数据
//  - HTTP /epg/{provider}/{date}/{name}.json：
//      1) R2 命中直接返回（Cache-Control 1h）
//      2) 未命中 → DIYP API 实时兜底（epg.51zmt.top:8000，国内可达、单频道秒级）
//      3) 兜底也失败 → 404
//  即使 cron 完全停摆，HTTP 兜底仍能按需出数据，节目单不会断。

const EPG_SOURCES = [
  { f_name: '51zmt', url: 'https://m3u.ibert.me/epg/51zmt.xml' },
  { f_name: '51zmt_cc', url: 'https://m3u.ibert.me/epg/51zmt_cc.xml' },
  { f_name: '51zmt_df', url: 'https://m3u.ibert.me/epg/51zmt_df.xml' },
];

// 频道别名映射：TVBox 的 {name}=tvg-name → 51zmt 标准频道名（防止 DIYP 直接查别名串台）
const EPG_ALIASES = {
  CETV1: '中国教育1台',
  CETV2: '中国教育2台',
  CETV4: '中国教育4台',
  'CCTV高尔夫网球': '高尔夫网球',
};

const DIYP_API = 'http://epg.51zmt.top:8000/api/diyp/';
const FETCH_TIMEOUT_MS = 60000; // 上游 XML 抓取超时
const DIYP_TIMEOUT_MS = 10000; // DIYP 兜底超时
const CACHE_TTL = 'public, max-age=3600'; // 1 小时缓存

// ---------- 工具 ----------
const p2 = (n) => String(n).padStart(2, '0');

function sanitizeChannelFileName(channel) {
  return channel.replace(/[/\\:*?"<>|]/g, '_').trim() || 'channel';
}

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function jsonHeaders() {
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': CACHE_TTL,
    'Access-Control-Allow-Origin': '*',
  };
}

// ---------- XMLTV 时间解析（与 iptv-sources/src/epgs/time.ts 一致，Asia/Shanghai=UTC+8 无夏令时） ----------
function parseXmltvTimestamp(timeStr) {
  const match = /^(\d{14})(?:\s+([+-])(\d{2})(\d{2}))?$/.exec(timeStr || '');
  if (!match) return null;
  const compact = match[1];
  const year = Number(compact.slice(0, 4));
  const month = Number(compact.slice(4, 6)) - 1;
  const day = Number(compact.slice(6, 8));
  const hour = Number(compact.slice(8, 10));
  const minute = Number(compact.slice(10, 12));
  const second = Number(compact.slice(12, 14));
  const sign = match[2];
  const oh = Number(match[3] ?? '0');
  const om = Number(match[4] ?? '0');
  const totalOffset = sign === '-' ? -(oh * 60 + om) : oh * 60 + om;
  return new Date(Date.UTC(year, month, day, hour, minute - totalOffset, second));
}

function formatInEpgTimeZone(date) {
  const d = new Date(date.getTime() + 8 * 3600 * 1000); // Asia/Shanghai
  return {
    date: `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`,
    time: `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`,
  };
}

function parseXmltvTimeRange(startStr, stopStr) {
  const start = parseXmltvTimestamp(startStr);
  const stop = parseXmltvTimestamp(stopStr);
  if (!start || !stop) return null;
  const s = formatInEpgTimeZone(start);
  const e = formatInEpgTimeZone(stop);
  return { date: s.date, start: s.time, end: e.time };
}

// ---------- 轻量 XMLTV 解析 ----------
function parseXmltv(xml) {
  // channel: <channel id="X">...<display-name>NAME</display-name>...</channel>
  const idToName = {};
  const channelRe = /<channel\b([^>]*)>([\s\S]*?)<\/channel>/g;
  let m;
  while ((m = channelRe.exec(xml)) !== null) {
    const idMatch = m[1].match(/\bid\s*=\s*"([^"]*)"/);
    const id = idMatch ? idMatch[1] : '';
    if (!id) continue;
    const dn = m[2].match(/<display-name[^>]*>([\s\S]*?)<\/display-name>/);
    const name = dn ? decodeEntities(dn[1]).trim() : id;
    idToName[id] = name;
  }

  // programme: <programme channel="X" start="..." stop="...">...<title>TITLE</title>...</programme>
  const out = [];
  const progRe = /<programme\b([^>]*)>([\s\S]*?)<\/programme>/g;
  while ((m = progRe.exec(xml)) !== null) {
    const ch = (m[1].match(/\bchannel\s*=\s*"([^"]*)"/) || [])[1];
    const start = (m[1].match(/\bstart\s*=\s*"([^"]*)"/) || [])[1];
    const stop = (m[1].match(/\bstop\s*=\s*"([^"]*)"/) || [])[1];
    if (!ch || !start) continue;
    const range = parseXmltvTimeRange(start, stop);
    if (!range) continue;
    const title = (m[2].match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1];
    out.push({
      date: range.date,
      channel: idToName[ch] || ch,
      item: { start: range.start, end: range.end, title: title ? decodeEntities(title).trim() : '' },
    });
  }
  return out;
}

// ---------- DIYP 兜底 ----------
async function fetchDiyp(name, date) {
  const channel = EPG_ALIASES[name] || name;
  const url = `${DIYP_API}?ch=${encodeURIComponent(channel)}&date=${date}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(DIYP_TIMEOUT_MS) });
  if (!res.ok) return null;
  const data = await res.json();
  if (!data || !Array.isArray(data.epg_data) || data.epg_data.length === 0) return null;
  // 51zmt 对未知频道返回 channel_name="未提供"（但仍带占位数据）→ 视为无效，避免假频道 200
  const cn = String(data.channel_name || '').trim();
  if (!cn || cn === '未提供' || cn === '未找到' || /not\s*found/i.test(cn)) return null;
  data.epg_data = data.epg_data.map((p) => ({
    ...p,
    title: String(p.title || '').replace(/\s*--[\s\S]*$/, '').trim(),
  }));
  return data;
}

// ---------- R2 清理（3 天前数据） ----------
async function cleanupOld(env, provider) {
  const cutoff = new Date(Date.now() - 3 * 86400 * 1000);
  const cutoffStr = `${cutoff.getFullYear()}-${p2(cutoff.getMonth() + 1)}-${p2(cutoff.getDate())}`;
  let cursor;
  const toDelete = [];
  do {
    const listed = await env.EPG_BUCKET.list({ prefix: `epg/${provider}/`, cursor, limit: 1000 });
    for (const obj of listed.objects) {
      const parts = obj.key.split('/');
      if (parts.length >= 3 && parts[2] < cutoffStr) toDelete.push(obj.key);
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  for (let i = 0; i < toDelete.length; i += 500) {
    await env.EPG_BUCKET.delete(toDelete.slice(i, i + 500));
  }
  if (toDelete.length > 0) {
    console.log(`[CLEAN] ${provider}: deleted ${toDelete.length} old keys`);
  }
}

// ---------- Cron：抓取 + 解析 + 写 R2 ----------
async function refreshEpg(env) {
  const results = await Promise.allSettled(
    EPG_SOURCES.map(async (src) => {
      const res = await fetch(src.url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const xml = await res.text();
      const items = parseXmltv(xml);
      if (items.length === 0) throw new Error('parsed 0 items');

      const groups = new Map();
      for (const it of items) {
        const k = `${it.date}\t${it.channel}`;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(it.item);
      }

      let n = 0;
      for (const [k, list] of groups) {
        const [date, channel] = k.split('\t');
        const key = `epg/${src.f_name}/${date}/${sanitizeChannelFileName(channel)}.json`;
        await env.EPG_BUCKET.put(
          key,
          JSON.stringify({ channel_name: channel, date, epg_data: list }),
          { httpMetadata: { contentType: 'application/json' } }
        );
        n++;
      }
      await cleanupOld(env, src.f_name);
      return { name: src.f_name, count: n };
    })
  );

  for (const r of results) {
    if (r.status === 'fulfilled') {
      console.log(`[TASK] EPG ${r.value.name}: wrote ${r.value.count} files`);
    } else {
      console.error(`[TASK] EPG failed: ${r.reason?.message || r.reason}`);
    }
  }
}

// ---------- HTTP 入口 ----------
async function handleRequest(request, env) {
  const url = new URL(request.url);
  // URL.pathname 是百分号编码的，中文频道名必须解码后才能匹配 R2 key
  const pathname = decodeURIComponent(url.pathname);
  const m = pathname.match(/^\/epg\/([^/]+)\/(\d{4}-\d{2}-\d{2})\/(.+)\.json$/);
  if (!m) {
    return new Response('Not Found', { status: 404 });
  }
  const [, provider, date, name] = m;
  const key = `epg/${provider}/${date}/${name}.json`;

  // 1. R2 命中
  const obj = await env.EPG_BUCKET.get(key);
  if (obj) {
    return new Response(obj.body, { headers: jsonHeaders() });
  }

  // 2. DIYP 实时兜底
  try {
    const data = await fetchDiyp(name, date);
    if (data) {
      data.channel_name = data.channel_name || name;
      await env.EPG_BUCKET.put(key, JSON.stringify(data), {
        httpMetadata: { contentType: 'application/json' },
      });
      return new Response(JSON.stringify(data), { headers: jsonHeaders() });
    }
  } catch (e) {
    console.error(`[FALLBACK] DIYP failed for ${name}/${date}: ${e.message || e}`);
  }

  return new Response('Not Found', { status: 404 });
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshEpg(env).catch((e) => console.error('[TASK] refresh failed:', e)));
  },
  async fetch(request, env, ctx) {
    return handleRequest(request, env);
  },
};

// 供本地测试复用
export { parseXmltv, parseXmltvTimeRange, sanitizeChannelFileName, fetchDiyp, EPG_ALIASES };
