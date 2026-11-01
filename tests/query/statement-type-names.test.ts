// tests/query/statement-type-names.test.ts —— 语句类型名表必须与驱动的枚举**逐值一致**
// （2026-11-01，PR #54）。
//
// 背景（实测缺陷）：`src/query/sandbox.ts` 的 `TYPE_NAMES` 此前是从任务 brief 抄的，
// 其中 `21: 'INSTALL'` 与事实相反 —— `@duckdb/node-api` 的 `StatementType` 枚举
// **21 = LOAD**（INSTALL 与 LOAD 实测都返回 21，因为 INSTALL 的语义包含 LOAD）。
// 于是 `qiyu query --sql "LOAD json"` 被拒时报「只读沙箱不接受 **INSTALL** 语句」——
// 点名的语句名与用户输入的不符（Agent 会去查 INSTALL 的文档，而它写的是 LOAD）。
// 形态归属：本仓库记录过的「枚举字面量与事实相反」（第 20 种形态）。
//
// 守卫方式：**对拍**——从驱动真实 import 枚举，与表逐值比对。这样驱动升级
// （新值/改名）也会变红，不需要人记得去改。
import { describe, it, expect } from 'vitest'
import { TYPE_NAMES } from '../../src/query/sandbox.js'

/** 驱动枚举的运行时形态：`{ INVALID: 0, SELECT: 1, … }`。 */
async function driverEnum(): Promise<Record<string, number>> {
  const mod = (await import('@duckdb/node-api')) as unknown as {
    StatementType: Record<string, number>
  }
  return mod.StatementType
}

describe('TYPE_NAMES 与驱动 StatementType 枚举逐值对拍', () => {
  it('表里每个数值都必须与枚举同名值一致（防「枚举字面量与事实相反」）', async () => {
    const en = await driverEnum()
    const mismatches: string[] = []
    for (const [numStr, name] of Object.entries(TYPE_NAMES)) {
      const num = Number(numStr)
      const fromEnum = en[name]
      if (fromEnum === undefined) {
        mismatches.push(`表里有 ${num}=${name}，但驱动枚举没有名为 ${name} 的成员`)
      } else if (fromEnum !== num) {
        mismatches.push(`表里写 ${num}=${name}，而驱动枚举 ${name}=${fromEnum}`)
      }
    }
    expect(mismatches, '与驱动枚举不一致:\n' + mismatches.join('\n')).toEqual([])
  })

  it('表必须覆盖枚举的每个数值（不留裸数字兜底 —— spec §十一要求点明类型名）', async () => {
    const en = await driverEnum()
    const missing = Object.values(en)
      .filter((v): v is number => typeof v === 'number')
      .filter((v) => TYPE_NAMES[v] === undefined)
      .sort((a, b) => a - b)
    expect(missing, `驱动有而表里缺的数值：${missing.join(', ')}`).toEqual([])
  })

  it('21 是 LOAD 不是 INSTALL（本类型缺陷的事故原文）', async () => {
    // 21 是历史上写错的那个值 —— 单独钉住，让回归时错误信息直接点名事故
    expect(TYPE_NAMES[21]).toBe('LOAD')
    const en = await driverEnum()
    expect(en.LOAD, '驱动枚举里 LOAD 的值').toBe(21)
  })
})
