/**
 * data-block.ts — escaping for untrusted text that goes into a prompt or a tool result.
 *
 * Stored notes and chat turns can contain anything, including text that looks like the closing
 * tag of the block they sit in. Only the "<" of a tag the prompts use as a data marker is
 * replaced; all other text is unchanged. This is the one implementation: the engine's own
 * prompts and the plugin's memory_search output both use it.
 */

/** Tag names used as data markers. Add a name here when a prompt starts using a new one. */
const MARKER_TAGS = 'memor(?:ies|y)|conversation|turn'
const MARKER = new RegExp(`<(?=\\s*\\/?\\s*(?:${MARKER_TAGS}))`, 'gi')

/** Replace the "<" of anything that reads as a marker tag, with optional space after "<" or "</". */
export function escapeContent(text: string): string {
  return text.replace(MARKER, '&lt;')
}

export function escapeAttr(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** One element: `<name attr="v">escaped content</name>`. */
export function dataTag(name: string, content: string, attrs: Record<string, string | number> = {}): string {
  const attrText = Object.entries(attrs)
    .map(([k, v]) => ` ${k}="${escapeAttr(String(v))}"`)
    .join('')
  return `<${name}${attrText}>${escapeContent(content)}</${name}>`
}

/** A wrapper element with one child per line. With no children it is an open and a close tag. */
export function dataBlock(name: string, children: string[]): string {
  return [`<${name}>`, ...children, `</${name}>`].join('\n')
}
