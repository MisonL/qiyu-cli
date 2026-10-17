// src/sync/day.ts
// Asia/Shanghai 自然日对齐（历史导入点，定义见 core/time）。
// G2/§6.2 联动：`--since/--until` 的日期按上海零点解析、报表日期列按上海天对齐、
// attendance/performance 的 endTime 上限是「昨天 00:00」——三处必须同源，否则
// 「同一业务日」在不同层得到不同的毫秒值（A 中-2 的键分裂根因）。
// E 起定义下沉 `src/core/time.ts`（query/ 不得 import sync/，两域共用同一实现）；
// 本文件保留为 sync 侧的历史导入点，语义与实现均以 core/time 为准。
export { SHANGHAI_OFFSET_MS, DAY_MS, shanghaiDayStart, shanghaiYesterdayStart, shanghaiDayIso } from '../core/time.js'
