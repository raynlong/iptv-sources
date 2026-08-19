import { epgs_sources } from './epgs';
import {
  cleanFiles,
  generateEpgAlias,
  getContent,
  writeEpgJsonByDate,
  writeEpgXML,
} from './file';

// EPG 频道名别名映射：TVBox 的 {name} 取 m3u 的 tvg-name（如 CETV1），
// 但 51zmt 源里标准频道名是「中国教育1台」。这里为别名额外生成一份同内容 JSON，
// 让 TVBox 用原名请求时也能命中节目单。m3u 完全不动（方案 B）。
const EPG_ALIASES: Record<string, string> = {
  CETV1: '中国教育1台',
  CETV2: '中国教育2台',
  CETV4: '中国教育4台',
  'CCTV高尔夫网球': '高尔夫网球',
};

cleanFiles();

// EPG-only 构建：只生成电子节目指南静态 JSON，不抓取直播源
// 输出：m3u/epg/{provider}/{YYYY-MM-DD}/{频道名}.json（TVBox 的 {date}/{name} 占位符直接命中）
(async () => {
  try {
    await Promise.allSettled(
      epgs_sources.map(async (epg_sr) => {
        console.log(`[TASK] Fetch EPG ${epg_sr.name}`);
        try {
          const [ok, text] = await getContent(epg_sr);
          if (ok && !!text) {
            console.log(`[TASK] Fetch EPG from ${epg_sr.name} finished`);
            await writeEpgXML(epg_sr.f_name, text as string);
            return ['normal'];
          }
          console.log(`[WARNING] EPG ${epg_sr.name} get failed!`);
          return [void 0];
        } catch (e) {
          console.warn('Error fetching EPG', e, epg_sr);
          console.log(`[WARNING] EPG ${epg_sr.name} get failed!`);
          return [void 0];
        }
      })
    );

    console.log(`[TASK] Split EPG XML into TVBox JSON by date/channel`);
    await writeEpgJsonByDate();

    console.log(`[TASK] Generate EPG alias JSON for channel-name mapping`);
    generateEpgAlias(EPG_ALIASES);

    console.log(`[TASK] EPG build finished`);
  } catch (err) {
    console.error(err);
  }
})();
