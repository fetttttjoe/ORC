import { describe, expect, it } from 'bun:test'
import { assertPublicUrl, isPrivateIp } from './net-guard'

describe('isPrivateIp', () => {
  it('refuses every range a research fetch must never reach', () => {
    for (const ip of [
      '127.0.0.1', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1',
      '169.254.169.254', // cloud metadata
      '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '192.0.0.170', '198.18.0.1',
      '::1', '::', 'fe80::1', 'fd00::1', '::ffff:10.0.0.1',
    ]) expect({ ip, private: isPrivateIp(ip) }).toEqual({ ip, private: true })
  })

  it('allows public addresses, including the ranges adjacent to private ones', () => {
    for (const ip of [
      '8.8.8.8', '1.1.1.1',
      '172.15.0.1', '172.32.0.1', // just outside 172.16/12
      '169.253.1.1', '100.63.0.1', '198.20.0.1',
      '2607:f8b0::1', '::ffff:8.8.8.8',
    ]) expect({ ip, private: isPrivateIp(ip) }).toEqual({ ip, private: false })
  })

  it('treats an unparseable address as private', () => {
    for (const ip of ['not-an-ip', '', '1.2.3', '1.2.3.4.5', '999.1.1.1'])
      expect({ ip, private: isPrivateIp(ip) }).toEqual({ ip, private: true })
  })
})

describe('assertPublicUrl', () => {
  it('refuses non-http(s) schemes and embedded credentials before any DNS lookup', async () => {
    await expect(assertPublicUrl(new URL('file:///etc/passwd'))).rejects.toThrow(/non-http/)
    await expect(assertPublicUrl(new URL('ftp://example.test/x'))).rejects.toThrow(/non-http/)
    await expect(assertPublicUrl(new URL('https://user:pw@example.test/'))).rejects.toThrow(/credentials/)
  })

  it('refuses an IP literal in a private range without resolving anything', async () => {
    await expect(assertPublicUrl(new URL('http://127.0.0.1:8080/x'))).rejects.toThrow(/private\/reserved/)
    await expect(assertPublicUrl(new URL('http://169.254.169.254/latest/meta-data/'))).rejects.toThrow(/private\/reserved/)
    await expect(assertPublicUrl(new URL('http://[::1]/x'))).rejects.toThrow(/private\/reserved/)
  })
})
