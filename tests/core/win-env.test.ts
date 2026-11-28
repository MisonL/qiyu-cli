// Windows 子进程环境白名单：读面 probe 与写序脚本共用同一份（CodeRabbit 2026-11-28 发现 probe 仍整份继承）。
import { describe, expect, it } from 'vitest'
import { pickSafeEnv } from '../../src/core/win-env.js'

describe('pickSafeEnv', () => {
  it('只留系统变量；业务/凭证变量一律不传', () => {
    const out = pickSafeEnv({
      PATH: 'C:\\Windows',
      SystemRoot: 'C:\\Windows',
      TEMP: 'C:\\T',
      QIYU_APP_KEY: 'key-leak-sentinel',
      QIYU_APP_SECRET: 'secret-leak-sentinel',
      QIYU_PROFILE: 'work',
      QIYU_STORE_PATH: 'D:\\db.duckdb',
    } as NodeJS.ProcessEnv)
    expect(out).toMatchObject({ PATH: 'C:\\Windows', SystemRoot: 'C:\\Windows', TEMP: 'C:\\T' })
    const text = JSON.stringify(out)
    for (const k of ['QIYU_APP_KEY', 'QIYU_APP_SECRET', 'QIYU_PROFILE', 'QIYU_STORE_PATH', 'leak-sentinel']) {
      expect(text, k).not.toContain(k)
    }
  })
})
