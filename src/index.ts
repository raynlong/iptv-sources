import { epgs_sources } from './epgs';
import {
  cleanFiles,
  getContent,
  writeEpgJsonByDate,
  writeEpgXML,
} from './file';

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

    console.log(`[TASK] EPG build finished`);
  } catch (err) {
    console.error(err);
  }
})();
