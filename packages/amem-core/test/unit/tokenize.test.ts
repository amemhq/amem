import { describe, it, expect } from 'vitest'
import { simpleTokenize } from '../../src/memory.js'

describe('simpleTokenize', () => {
  it('lowercases and strips punctuation for English', () => {
    expect(simpleTokenize('Hello, World!')).toEqual(['hello', 'world'])
  })

  it('treats underscores and digits as word characters', () => {
    expect(simpleTokenize('foo_bar 123')).toEqual(['foo_bar', '123'])
  })

  it('returns an empty array for empty / punctuation-only input', () => {
    expect(simpleTokenize('')).toEqual([])
    expect(simpleTokenize('!!! ??? ...')).toEqual([])
  })

  it('segments Chinese text into multiple tokens (Jieba)', () => {
    const tokens = simpleTokenize('记忆系统很好用')
    expect(tokens.length).toBeGreaterThan(1)
    expect(tokens).toContain('记忆')
  })

  it('preserves ASCII tokens (lowercased) inside mixed CJK/ASCII text', () => {
    const tokens = simpleTokenize('检索Qdrant结果')
    expect(tokens).toContain('qdrant')
  })
})

/**
 * Japanese and Korean, pinned as they are rather than as anyone would want them.
 *
 * The branch in `simpleTokenize` tests for Han characters, so Korean and kana-only
 * Japanese never reach Jieba and fall to `[\w]+`, which matches neither script.
 * Japanese *with* kanji is the quiet one: it does reach Jieba, gets cut as though
 * it were Chinese, and comes back holding the kanji with every kana dropped —
 * output that looks like it worked.
 *
 * These assert the current behaviour so that changing it is deliberate. If someone
 * adds a segmenter, these fail, and that is the point.
 */
describe('Japanese and Korean produce no usable lexical tokens', () => {
  it('drops every kana from Japanese that contains kanji', () => {
    const t = simpleTokenize('今日はサーバーでダイヤモンドを見つけました')
    expect(t.every((x) => !/[぀-ヿ]/.test(x))).toBe(true)
    expect(t.length).toBeLessThan(4)
  })

  it('yields nothing at all for kana-only Japanese', () => {
    expect(simpleTokenize('きょうはとてもたのしかった')).toEqual([])
  })

  it('yields nothing at all for Korean', () => {
    expect(simpleTokenize('오늘 서버에서 다이아몬드를 찾았습니다')).toEqual([])
  })

  it('still tokenizes Chinese and English, so this is about those two scripts only', () => {
    expect(simpleTokenize('我今天在服务器里挖到了钻石').length).toBeGreaterThan(5)
    expect(simpleTokenize('I found diamonds today').length).toBe(4)
  })
})
