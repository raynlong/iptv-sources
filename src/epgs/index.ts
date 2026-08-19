// import { with_github_raw_url_proxy } from '../sources';
import type { TEPGSource } from './utils';

export const epgs_sources: TEPGSource[] = [
  // 112114 原始源（epg.112114.xyz）在 Cloudflare 海外构建环境不可达，
  // 其 GitHub 镜像又为陈旧快照（2025-11），故不纳入。主源改用 51zmt 海外镜像（实时）。
  // {
  //     name: "fanmingming/live",
  //     f_name: "fmml",
  //     url: "https://raw.githubusercontent.com/fanmingming/live/main/e.xml",
  // },
  {
    name: '51zmt.top',
    f_name: '51zmt',
    url: 'https://m3u.ibert.me/epg/51zmt.xml',
  },
  {
    name: '51zmt.top cc',
    f_name: '51zmt_cc',
    url: 'https://m3u.ibert.me/epg/51zmt_cc.xml',
  },
  {
    name: '51zmt.top difang',
    f_name: '51zmt_df',
    url: 'https://m3u.ibert.me/epg/51zmt_df.xml',
  },
];
