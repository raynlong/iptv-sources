// 本地测试：验证 Worker 核心逻辑（XML 解析 + 分组 + 输出格式与线上一致）
// 用法: node test/test-local.js <xml文件路径> [频道名]
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseXmltv, sanitizeChannelFileName, fetchDiyp } from '../src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const xmlPath = process.argv[2] || path.join(__dirname, '..', '..', '..', '..', 'AppData', 'Local', 'Temp', '51zmt_full.xml');
const targetChannel = process.argv[3] || 'CCTV1';

console.log('=== 1. 解析 XML ===');
const xml = fs.readFileSync(xmlPath, 'utf-8');
const items = parseXmltv(xml);
console.log(`解析出 ${items.length} 条节目记录`);

// 统计日期
const dates = new Set(items.map((i) => i.date));
console.log('覆盖日期:', [...dates].sort().join(', '));

// 频道数
const channels = new Set(items.map((i) => i.channel));
console.log('频道数:', channels.size);

// 目标频道分组
const target = items.filter((i) => i.channel === targetChannel);
console.log(`\n=== 2. 频道 ${targetChannel}: ${target.length} 条 ===`);
const byDate = {};
for (const it of target) {
  (byDate[it.date] ||= []).push(it.item);
}
for (const [d, list] of Object.entries(byDate)) {
  console.log(`  ${d}: ${list.length} 条`);
  const fname = sanitizeChannelFileName(targetChannel);
  const out = JSON.stringify({ channel_name: targetChannel, date: d, epg_data: list }, null, 2);
  console.log(`  生成文件: epg/51zmt/${d}/${fname}.json (${out.length} 字节)`);
  if (d === new Date().toISOString().slice(0, 10)) {
    fs.writeFileSync(path.join(__dirname, 'test-output.json'), out);
  }
  // 打印前 3 条
  list.slice(0, 3).forEach((p) => console.log(`    ${p.start} - ${p.end} | ${p.title}`));
}

console.log('\n=== 3. 别名映射测试 ===');
for (const alias of ['CETV1', '中国教育1台']) {
  const data = await fetchDiyp(alias, '2026-08-22');
  if (data) {
    console.log(`${alias} => ${data.channel_name}, ${data.epg_data.length} 条`);
    console.log('  首条 title:', data.epg_data[0]?.title);
  } else {
    console.log(`${alias} => 无数据`);
  }
}
console.log('\n测试完成');
