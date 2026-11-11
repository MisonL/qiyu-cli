import { describe, expect, it } from 'vitest'
import { queryCallArgs } from '../../src/query/mask.js'

describe('query() 的词法定位与静态实参', () => {
  it.each([
    ["SELECT * FROM query('SELECT 1')", ['SELECT 1']],
    ['SELECT * FROM "QuErY"($q$SELECT 1$q$)', ['SELECT 1']],
    ['SELECT * FROM query((/* 外 /* 内 */ */ $$SELECT 1$$))', ['SELECT 1']],
    ["SELECT * FROM query(CAST(('SELECT 1') AS VARCHAR))", ['SELECT 1']],
    ["SELECT * FROM query('SELECT ''x'' AS s')", ["SELECT 'x' AS s"]],
  ])('%s：只展开完整的静态字符串表达式', (sql, want) => {
    expect(queryCallArgs(sql as string)).toEqual(want)
  })

  it.each([
    `SELECT $$"query"('SELECT 1')$$ AS label`,
    `SELECT '"query"(''SELECT 1'')' AS label`,
    `SELECT 1 /* "query"('SELECT 1') */`,
    `SELECT 1 -- "query"('SELECT 1')`,
    `SELECT * FROM x$query('SELECT 1')`,
    `SELECT * FROM 中文query('SELECT 1')`,
    `SELECT * FROM query$q$('SELECT 1')`,
    `SELECT * FROM query中文('SELECT 1')`,
  ])('%s：字面量、注释、较长标识符中的伪调用不展开', (sql) => {
    expect(queryCallArgs(sql)).toEqual([])
  })

  it.each([
    `SELECT * FROM query('SELECT ' || '1')`,
    `SELECT * FROM query(CAST('SELECT 1' AS VARCHAR) || ' UNION ALL SELECT 2')`,
    `SELECT * FROM query(upper('select 1'))`,
  ])('%s：无法静态展开整个表达式时不冒认它的前缀', (sql) => {
    expect(queryCallArgs(sql)).toEqual([])
  })
})
