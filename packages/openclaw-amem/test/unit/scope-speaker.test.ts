import { describe, it, expect } from 'vitest'
import { resolveSpeakerKey, isGroupSession, readIdentityLinks, visibleToSpeaker } from '../../src/scope.js'

describe('resolveSpeakerKey', () => {
  it('joins the lowercased channel and the sender id', () => {
    expect(resolveSpeakerKey({ channel: 'Discord', senderId: 'AbC123' })).toBe('discord:AbC123')
  })

  it('falls back to messageProvider when there is no channel', () => {
    expect(resolveSpeakerKey({ messageProvider: 'telegram', senderId: '42' })).toBe('telegram:42')
  })

  it('reads the tool ctx fields messageChannel and requesterSenderId', () => {
    expect(resolveSpeakerKey({ messageChannel: 'Telegram', requesterSenderId: ' 42 ' })).toBe('telegram:42')
  })

  it('prefers channel over messageProvider', () => {
    expect(resolveSpeakerKey({ channel: 'slack', messageProvider: 'other', senderId: 'U1' })).toBe('slack:U1')
  })

  it('prefers channelContext.sender.id over senderId', () => {
    expect(resolveSpeakerKey({ channel: 'discord', senderId: 'old', channelContext: { sender: { id: 'new' } } })).toBe(
      'discord:new'
    )
  })

  it('trims whitespace and keeps the id case', () => {
    expect(resolveSpeakerKey({ channel: ' Discord ', senderId: '  Sam_X \n' })).toBe('discord:Sam_X')
  })

  it('returns undefined without a channel, an id, or a ctx', () => {
    expect(resolveSpeakerKey({ senderId: '1' })).toBeUndefined()
    expect(resolveSpeakerKey({ channel: 'discord' })).toBeUndefined()
    expect(resolveSpeakerKey({ channel: 'discord', senderId: '   ' })).toBeUndefined()
    expect(resolveSpeakerKey({ channel: '  ', senderId: '1' })).toBeUndefined()
    expect(resolveSpeakerKey(undefined)).toBeUndefined()
  })

  it('returns undefined in a group or room session', () => {
    const base = { channel: 'discord', senderId: '1' }
    expect(resolveSpeakerKey({ ...base, sessionKey: 'agent:main:discord:group:99' })).toBeUndefined()
    expect(resolveSpeakerKey({ ...base, sessionKey: 'agent:main:discord:channel:99' })).toBeUndefined()
    expect(resolveSpeakerKey({ ...base, sessionKey: 'agent:main:main' })).toBe('discord:1')
    expect(resolveSpeakerKey({ ...base, sessionKey: 'agent:main:discord:direct:1' })).toBe('discord:1')
  })
})

describe('isGroupSession', () => {
  it('matches group and channel segments after the channel name', () => {
    expect(isGroupSession('agent:main:telegram:group:-100')).toBe(true)
    expect(isGroupSession('agent:main:slack:channel:C1:thread:2')).toBe(true)
  })

  it('does not match a channel called "channel" or a missing key', () => {
    expect(isGroupSession('agent:main:channel')).toBe(false)
    expect(isGroupSession(undefined)).toBe(false)
  })
})

describe('identity links', () => {
  const links = { Alice: ['telegram:123', 'Discord:U1'], bob: ['555'] }

  it('maps a linked account to the canonical identity, lowercased', () => {
    expect(resolveSpeakerKey({ channel: 'telegram', senderId: '123' }, links)).toBe('identity:alice')
  })

  it('gives one key to one person on two channels', () => {
    const a = resolveSpeakerKey({ channel: 'telegram', senderId: '123' }, links)
    const b = resolveSpeakerKey({ channel: 'discord', senderId: 'u1' }, links)
    expect(a).toBe(b)
  })

  it('accepts a bare peer id entry, as OpenClaw does', () => {
    expect(resolveSpeakerKey({ channel: 'slack', senderId: '555' }, links)).toBe('identity:bob')
  })

  it('trims whitespace around an entry, as OpenClaw does', () => {
    const padded = { alice: [' telegram:123', 'discord:u1 '] }
    expect(resolveSpeakerKey({ channel: 'telegram', senderId: '123' }, padded)).toBe('identity:alice')
    expect(resolveSpeakerKey({ channel: 'discord', senderId: 'u1' }, padded)).toBe('identity:alice')
  })

  it('keeps the channel key for an unlinked account or without links', () => {
    expect(resolveSpeakerKey({ channel: 'telegram', senderId: '999' }, links)).toBe('telegram:999')
    expect(resolveSpeakerKey({ channel: 'telegram', senderId: '123' })).toBe('telegram:123')
    expect(resolveSpeakerKey({ channel: 'telegram', senderId: '123' }, {})).toBe('telegram:123')
  })

  it('ignores malformed entries and keeps the first match in config order', () => {
    const odd = { '': ['telegram:1'], x: 'telegram:1', first: ['telegram:1'], second: ['telegram:1'] } as never
    expect(resolveSpeakerKey({ channel: 'telegram', senderId: '1' }, odd)).toBe('identity:first')
  })

  it('does not link a group turn', () => {
    expect(
      resolveSpeakerKey({ channel: 'telegram', senderId: '123', sessionKey: 'agent:main:telegram:group:1' }, links)
    ).toBe(undefined)
  })

  it('reads session.identityLinks from the config, and ignores anything else', () => {
    expect(readIdentityLinks({ session: { identityLinks: links } })).toBe(links)
    expect(readIdentityLinks({ session: {} })).toBeUndefined()
    expect(readIdentityLinks({ session: { identityLinks: 'x' } })).toBeUndefined()
    expect(readIdentityLinks(undefined)).toBeUndefined()
  })
})

describe('visibleToSpeaker', () => {
  it('shows untagged notes to everyone', () => {
    expect(visibleToSpeaker([], 's')).toBe(true)
    expect(visibleToSpeaker(undefined, undefined)).toBe(true)
  })

  it('shows a note tagged for exactly the speaker', () => {
    expect(visibleToSpeaker(['s'], 's')).toBe(true)
    expect(visibleToSpeaker(['s'], 'other')).toBe(false)
  })

  it('hides a multi-subject note, even one that names the speaker', () => {
    expect(visibleToSpeaker(['s', 'other'], 's')).toBe(false)
  })

  it('hides every tagged note when there is no speaker', () => {
    expect(visibleToSpeaker(['s'], undefined)).toBe(false)
  })
})
