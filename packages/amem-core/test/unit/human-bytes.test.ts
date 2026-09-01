import { describe, it, expect } from 'vitest'
import { humanBytes } from '../../src/embedding.js'

// The download reporter covers two files three orders of magnitude apart, so a
// fixed unit cannot describe both. These are the real sizes bge-m3 ships.
describe('humanBytes', () => {
  it('renders the weights in GB, unchanged from what the log already said', () => {
    expect(humanBytes(2_266_820_608)).toBe('2.27 GB')
  })

  it('renders the ONNX graph as a small file rather than 0.00 GB', () => {
    // 607_298 / 1e9 rounds to 0.00, which reads as a failed size lookup.
    expect(humanBytes(607_298)).toBe('607 kB')
  })

  it('uses MB between the two', () => {
    expect(humanBytes(25_000_000)).toBe('25.0 MB')
    expect(humanBytes(593_000_000)).toBe('593.0 MB')
  })

  it('never reports a non-zero size as zero', () => {
    for (const n of [1, 999, 1_000, 1_500, 999_999, 1_000_000, 999_999_999]) {
      expect(humanBytes(n)).not.toMatch(/^0(\.0+)? /)
    }
  })

  it('switches unit exactly at each boundary', () => {
    expect(humanBytes(999_999)).toBe('1000 kB')
    expect(humanBytes(1_000_000)).toBe('1.0 MB')
    expect(humanBytes(999_999_999)).toBe('1000.0 MB')
    expect(humanBytes(1_000_000_000)).toBe('1.00 GB')
  })
})
