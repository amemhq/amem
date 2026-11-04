/**
 * A byte count in the unit that makes it readable.
 *
 * The two files this reports on differ by three orders of magnitude — bge-m3
 * ships a 607 kB graph next to 2.27 GB of weights — so a fixed unit cannot
 * describe both. Hardcoded GB rendered the graph as "0.00 GB", which reads as a
 * failed size lookup rather than a small file.
 */
export function humanBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`
  // Bytes get their own branch for the same reason GB was wrong: rounding a
  // small number into a large unit prints a zero, and a zero reads as a broken
  // size rather than a small file.
  if (n >= 1e3) return `${Math.round(n / 1e3)} kB`
  return `${n} B`
}
