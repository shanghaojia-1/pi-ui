import { describe, expect, it } from 'vitest'
import {
  IPC, isCustomProviderConfig, isImageAttachments, isSettingsPatch, isThinkingLevel, isToolApprovalMode, sanitizeErrorText,
  type AppSnapshot, type SettingsSnapshot, type ToolApprovalMode,
} from '../../src/shared/contracts'

const VALID_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

describe('isThinkingLevel', () => {
  it('accepts every documented level', () => {
    for (const level of VALID_LEVELS) expect(isThinkingLevel(level)).toBe(true)
  })

  it('rejects case-mutated or whitespace-padded strings', () => {
    for (const bad of ['OFF', 'Max', 'Medium', 'off ', ' high', 'max\n', 'xhigh\t']) {
      expect(isThinkingLevel(bad)).toBe(false)
    }
  })

  it('rejects unknown level names', () => {
    for (const bad of ['', 'super', 'ultra', 'on', 'true', '1', 'level', 'lowest']) {
      expect(isThinkingLevel(bad)).toBe(false)
    }
  })

  it('rejects non-string values', () => {
    for (const bad of [undefined, null, 0, 1, 42, true, false, {}, [], ['off'], { level: 'max' }]) {
      expect(isThinkingLevel(bad)).toBe(false)
    }
  })

  it('returns a type guard usable on unknown input', () => {
    const value: unknown = 'high'
    if (isThinkingLevel(value)) {
      // Narrowed to ThinkingLevel: must be assignable to the union
      const level: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' = value
      expect(level).toBe('high')
    } else {
      expect.unreachable('should have narrowed')
    }
  })
})

describe('isSettingsPatch', () => {
  it('rejects null provider/model values: clearing is never persisted as an empty string', () => {
    expect(isSettingsPatch({ defaultProvider: null })).toBe(false)
    expect(isSettingsPatch({ defaultModel: null })).toBe(false)
    expect(isSettingsPatch({ defaultProvider: null, defaultModel: null })).toBe(false)
    expect(isSettingsPatch({ defaultProvider: 'openai', defaultModel: null })).toBe(false)
    expect(isSettingsPatch({ defaultProvider: null, defaultModel: 'gpt-4o' })).toBe(false)
  })

  it('accepts non-null provider/model values and non-model-only patches', () => {
    expect(isSettingsPatch({ defaultProvider: 'openai', defaultModel: 'gpt-4o' })).toBe(true)
    expect(isSettingsPatch({ defaultProvider: 'openai' })).toBe(true)
    expect(isSettingsPatch({ defaultModel: 'gpt-4o' })).toBe(true)
    expect(isSettingsPatch({ defaultThinkingLevel: 'high' })).toBe(true)
    expect(isSettingsPatch({ compactionEnabled: true, retryEnabled: false, httpIdleTimeoutMs: 90000 })).toBe(true)
    expect(isSettingsPatch({})).toBe(true)
  })
})

describe('sanitizeErrorText', () => {
  const SECRET = 'sk-live-secret-1234567890'

  it('redacts exact known secrets, Bearer tokens, Authorization headers and key assignments', () => {
    const known = new Set([SECRET])
    const out = sanitizeErrorText(
      `fatal ${SECRET} Authorization: Bearer abc.def-ghi api-key=myKey token="quotedKey"`,
      'fallback', known,
    )
    expect(out).not.toContain(SECRET)
    expect(out).not.toContain('abc.def-ghi')
    expect(out).not.toContain('myKey')
    expect(out).not.toContain('quotedKey')
    expect(out).toContain('[REDACTED]')
  })

  it('redacts JWTs, URL userinfo and URL query secrets', () => {
    const out = sanitizeErrorText(
      'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c '
        + 'at https://u:pw@example.com/path?api_key=deadbeef&token=live&sig=abcdef',
      'fallback',
    )
    expect(out).not.toContain('eyJhbGci')
    expect(out).not.toContain('deadbeef')
    expect(out).not.toContain('live')
    expect(out).not.toContain('abcdef')
    expect(out).not.toContain('u:pw@')
  })

  it('keeps the useful non-secret context and never passes a secret-laden error through in full', () => {
    const known = new Set([SECRET])
    const out = sanitizeErrorText(`HTTP 401 from api.openai.com: invalid key ${SECRET}`, 'fixed', known)
    expect(out).toContain('HTTP 401 from api.openai.com: invalid key')
    expect(out).not.toContain(SECRET)
    expect(out).not.toBe('fixed') // usable context remains: no fallback
    // Long secret-laden errors are truncated, never leaked wholesale.
    const long = sanitizeErrorText(`${'x'.repeat(2000)} ${SECRET}`, 'fixed', known)
    expect(long).not.toContain(SECRET)
    expect(long.length).toBeLessThan(1500)
    expect(long).not.toBe('fixed')
  })

  it('redacts JSON-style quoted key assignments, keeping the field name', () => {
    const out = sanitizeErrorText(
      '{"error":{"details":{"apiKey":"secret-1","api_key": "secret-2","token":"secret-3","password":"secret-4"}}}',
      'fallback',
    )
    for (const secret of ['secret-1', 'secret-2', 'secret-3', 'secret-4']) expect(out).not.toContain(secret)
    for (const name of ['apiKey', 'api_key', 'token', 'password']) expect(out).toContain(name)
    expect(out).toContain('"apiKey": [REDACTED]')
    expect(out).toContain('[REDACTED]')
  })

  it('redacts single-quoted, case-mutated and equals-form assignments without touching plain words', () => {
    const out = sanitizeErrorText(
      `{'APIKEY': 'v1'} api_key = v2 ApiKey : v3 "token":"v4" token: v5 invalid token provided tokens: 5`,
      'fallback',
    )
    for (const v of ['v1', 'v2', 'v3', 'v4', 'v5']) expect(out).not.toContain(v)
    expect(out).toContain('APIKEY') // the field name is kept, only the value is replaced
    expect(out).toContain('invalid token provided') // the bare word is never redacted
    expect(out).toContain('tokens: 5')
    expect(out).toContain('[REDACTED]')
  })

  it('redacts known secrets first, then mixed Bearer/JWT/query and JSON forms', () => {
    const known = new Set([SECRET])
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQifQ.sig-abcdef'
    const out = sanitizeErrorText(
      `Authorization: Bearer ${SECRET} at https://u:pw@example.com/path?api_key=${SECRET}&token=jwt-tok&sig=xyz789 body {"apiKey":"${SECRET}"} jwt ${jwt}`,
      'fallback', known,
    )
    for (const fragment of [SECRET, 'jwt-tok', 'xyz789', jwt, 'u:pw@']) {
      expect(out).not.toContain(fragment)
    }
    expect(out).toContain('api_key')
    expect(out).toContain('apiKey')
    expect(out).toContain('[REDACTED]')
  })

  it('handles Error and object values, falls back when nothing remains and truncates long text', () => {
    expect(sanitizeErrorText(new Error('boom'), 'fallback')).toBe('boom')
    expect(sanitizeErrorText({ message: 'obj boom' }, 'fallback')).toContain('obj boom')
    expect(sanitizeErrorText('   ', 'fixed')).toBe('fixed')
    expect(sanitizeErrorText('', 'fixed')).toBe('fixed')
    const long = `start ${'x'.repeat(5000)}`
    const out = sanitizeErrorText(long, 'fixed')
    expect(out).toContain('start')
    expect(out.length).toBeLessThan(2000)
  })

  it('redacts known secrets in raw, JSON-escaped and URL-encoded forms at once', () => {
    const secret = 'p@ss"w0rd-12345'
    const escaped = 'p@ss\\"w0rd-12345' // JSON.stringify(secret).slice(1, -1)
    const encoded = encodeURIComponent(secret)
    const out = sanitizeErrorText(
      `raw=${secret} json={"apiKey":"${escaped}"} url=${encoded}`,
      'fallback', new Set([secret]),
    )
    expect(out).not.toContain(secret)
    expect(out).not.toContain(escaped)
    expect(out).not.toContain(encoded)
    expect(out).not.toContain('w0rd-12345') // recognizable later half of every form
    expect(out).toContain('apiKey')
  })

  it('replaces longer known secrets before shorter ones so short secrets cannot shred long ones', () => {
    const out = sanitizeErrorText(
      'here abcdefghijk-12345 and abc and abcdefghijk-12345',
      'fallback', new Set(['abc', 'abcdefghijk-12345']),
    )
    expect(out).not.toContain('abcdefghijk-12345')
    expect(out).not.toContain('hijk-12345') // later half of the long secret
    expect(out).not.toContain('abc')
    expect(out).toContain('here')
  })

  it('skips empty and too-short known secrets instead of shredding text', () => {
    const input = 'keep abc and x alone'
    expect(sanitizeErrorText(input, 'fallback', new Set(['', 'a', 'ab', 'x']))).toBe(input)
  })

  it('redacts a known secret containing quotes and backslashes in both raw and escaped form', () => {
    const secret = 'q"uote\\back-777'
    const escaped = 'q\\"uote\\\\back-777'
    const out = sanitizeErrorText(
      `log ${secret} json={"apiKey":"${escaped}"}`,
      'fallback', new Set([secret]),
    )
    expect(out).not.toContain(secret)
    expect(out).not.toContain(escaped)
    expect(out).not.toContain('back-777') // recognizable tail of both forms
    expect(out).toContain('apiKey')
  })

  it('redacts URL-encoded known secrets in plain text', () => {
    const secret = 'sk value/xyz-42'
    const encoded = encodeURIComponent(secret) // sk%20value%2Fxyz-42
    const out = sanitizeErrorText(`payload says ${encoded} now`, 'fallback', new Set([secret]))
    expect(out).not.toContain(encoded)
    expect(out).not.toContain(secret)
    expect(out).not.toContain('xyz-42')
    expect(out).toContain('payload says')
  })

  it('redacts escaped JSON embedded in an outer string (escaped key and value quotes)', () => {
    const out = sanitizeErrorText(
      'body=\\"apiKey\\":\\"s3cr3t-escaped-8899\\" trailing',
      'fallback',
    )
    expect(out).not.toContain('s3cr3t-escaped-8899')
    expect(out).not.toContain('escaped-8899')
    expect(out).toContain('apiKey')
    expect(out).toContain('trailing')
  })

  it('redacts a known secret that survives double JSON escaping (stringify of stringify)', () => {
    const secret = 'dbl"esc-999'
    const doubleEscaped = JSON.stringify({ body: JSON.stringify({ apiKey: secret }) })
    const out = sanitizeErrorText(`raw ${secret} ${doubleEscaped}`, 'fallback', new Set([secret]))
    expect(out).not.toContain(secret)
    expect(out).not.toContain('esc-999')
    expect(out).toContain('apiKey')
  })

  it('redacts bare, quoted, equals- and colon-separated keys across nested objects', () => {
    const out = sanitizeErrorText(
      `{a:{apiKey:bare-111},b:{ api_key = "spaced-222" },c:{'refreshToken' : 'ref-333'},d:{ access-token=444 },e:{token:'tok-555'}}`,
      'fallback',
    )
    for (const v of ['bare-111', 'spaced-222', 'ref-333', '444', 'tok-555']) expect(out).not.toContain(v)
    for (const k of ['apiKey', 'api_key', 'refreshToken', 'access-token', 'token']) expect(out).toContain(k)
  })

  it('redacts every listed field name case-insensitively and keeps the keys', () => {
    const input = '{"APIKEY":"m1","API_KEY":"m2","API-KEY":"m3","AccessToken":"m4","access_token":"m5","Access-Token":"m6","RefreshToken":"m7","refresh_token":"m8","Refresh-Token":"m9","Authorization":"m10","TOKEN":"m11","Password":"m12","SeCrEt":"m13"}'
    const out = sanitizeErrorText(input, 'fallback')
    for (let i = 1; i <= 13; i += 1) expect(out).not.toContain(`m${i}`)
    for (const k of ['APIKEY', 'API_KEY', 'API-KEY', 'AccessToken', 'access_token', 'Access-Token', 'RefreshToken', 'refresh_token', 'Refresh-Token', 'Authorization', 'TOKEN', 'Password', 'SeCrEt']) {
      expect(out).toContain(k)
    }
  })

  it('replaces quoted values containing escaped quotes and backslashes entirely, leaving no suffix', () => {
    const out = sanitizeErrorText(
      '{"apiKey":"va\\"lue\\\\with-999","password":\'it\\\'s-pw-888\'}',
      'fallback',
    )
    expect(out).not.toContain('with-999')
    expect(out).not.toContain('va\\"lue')
    expect(out).not.toContain('s-pw-888')
    expect(out).not.toContain("it\\'s")
    expect(out).toContain('apiKey')
    expect(out).toContain('password')
  })

  it('never matches lookalike field names or plain prose', () => {
    const input = 'token budget monkey=banana notkey: visible secretary hockey=2 tokenizer: 5 x-api-key: v key: k'
    expect(sanitizeErrorText(input, 'fallback')).toBe(input)
  })

  it('removes a unique long secret completely from raw JSON (whole and later half)', () => {
    const secret = 'UNIQUE-LONG-SECRET-abcdef123456'
    const input = `{"apiKey":"${secret}","refresh_token":"${secret}"}`
    const out = sanitizeErrorText(input, 'fallback', new Set([secret]))
    expect(out).not.toContain(secret)
    expect(out).not.toContain(secret.slice(Math.floor(secret.length / 2)))
    expect(out).toContain('apiKey')
    expect(out).toContain('refresh_token')
    // Without knownSecrets the generic scan alone must remove it too.
    const out2 = sanitizeErrorText(input, 'fallback')
    expect(out2).not.toContain(secret)
    expect(out2).not.toContain(secret.slice(Math.floor(secret.length / 2)))
  })
})

describe('isToolApprovalMode', () => {
  it('accepts exactly the two documented modes', () => {
    expect(isToolApprovalMode('ask')).toBe(true)
    expect(isToolApprovalMode('managed')).toBe(true)
  })

  it('rejects case-mutated, padded, unknown and non-string values', () => {
    for (const bad of ['ASK', 'Managed', 'auto', 'off', 'on', 'true', '', ' ', 'ask ', ' managed', '1', 1, 0, true, false, null, undefined, {}, [], ['managed'], { mode: 'managed' }]) {
      expect(isToolApprovalMode(bad)).toBe(false)
    }
  })

  it('returns a type guard usable on unknown input', () => {
    const value: unknown = 'managed'
    if (isToolApprovalMode(value)) {
      // Narrowed to ToolApprovalMode: must be assignable to the union
      const mode: 'ask' | 'managed' = value
      expect(mode).toBe('managed')
    } else {
      expect.unreachable('should have narrowed')
    }
  })
})

describe('tool approval mode contract', () => {
  it('keeps toolApprovalMode out of SettingsPatch: the switch is a dedicated IPC, never a patch', () => {
    expect(isSettingsPatch({ toolApprovalMode: 'managed' })).toBe(false)
    expect(isSettingsPatch({ toolApprovalMode: 'ask' })).toBe(false)
    expect(isSettingsPatch({ defaultModel: 'gpt-4o', toolApprovalMode: 'managed' })).toBe(false)
  })

  it('types toolApprovalMode onto both snapshots (the top bar reads it from AppSnapshot)', () => {
    // Compile-time: these assignments fail to typecheck if the field is missing.
    const readSettings = (s: SettingsSnapshot): ToolApprovalMode => s.toolApprovalMode
    const readApp = (a: AppSnapshot): ToolApprovalMode => a.toolApprovalMode
    expect(typeof readSettings).toBe('function')
    expect(typeof readApp).toBe('function')
  })

  it('exposes a dedicated setToolApprovalMode IPC channel', () => {
    expect(IPC.setToolApprovalMode).toBe('pi:set-tool-approval-mode')
  })
})

describe('IPC channel contract', () => {
  it('exposes every expected channel as a non-empty string', () => {
    const expected = [
      'snapshot', 'chooseWorkspace', 'openWorkspace', 'newSession', 'openSession',
      'prompt', 'abort', 'cancelSubagent', 'model', 'thinking', 'settings', 'updateSettings',
      'runtimeApiKey', 'logoutProvider', 'refreshModels', 'setToolApprovalMode', 'changed',
    ] as const
    for (const key of expected) {
      expect(typeof IPC[key]).toBe('string')
      expect(IPC[key].length).toBeGreaterThan(0)
    }
  })

  it('uses unique channel names', () => {
    const values = Object.values(IPC)
    expect(new Set(values).size).toBe(values.length)
  })

  it('uses the pi: namespace for all channels', () => {
    for (const value of Object.values(IPC)) expect(value.startsWith('pi:')).toBe(true)
  })
})

describe('isImageAttachments', () => {
  const png = { data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', mimeType: 'image/png' }

  it('accepts a valid single attachment', () => {
    expect(isImageAttachments([png])).toBe(true)
  })

  it('accepts multiple attachments up to the limit', () => {
    const many = Array.from({ length: 5 }, () => ({ ...png }))
    expect(isImageAttachments(many)).toBe(true)
  })

  it('rejects more than the limit', () => {
    const tooMany = Array.from({ length: 6 }, () => ({ ...png }))
    expect(isImageAttachments(tooMany)).toBe(false)
  })

  it('accepts an empty array (equivalent to no attachments)', () => {
    expect(isImageAttachments([])).toBe(true)
  })

  it('rejects undefined, null and non-arrays', () => {
    expect(isImageAttachments(undefined)).toBe(false)
    expect(isImageAttachments(null)).toBe(false)
    expect(isImageAttachments('image')).toBe(false)
    expect(isImageAttachments({ data: 'x', mimeType: 'image/png' })).toBe(false)
  })

  it('rejects non-image mime types', () => {
    expect(isImageAttachments([{ ...png, mimeType: 'text/plain' }])).toBe(false)
    expect(isImageAttachments([{ ...png, mimeType: 'image' }])).toBe(false)
  })

  it('rejects malformed base64 data', () => {
    expect(isImageAttachments([{ ...png, data: 'not base64!!' }])).toBe(false)
    expect(isImageAttachments([{ ...png, data: '' }])).toBe(false)
  })

  it('rejects images over the byte budget', () => {
    const big = 'A'.repeat((10 * 1024 * 1024 / 3) * 4 + 64)
    expect(isImageAttachments([{ ...png, data: big }])).toBe(false)
  })

  it('accepts an image right at the byte budget', () => {
    // base64 length must encode to <= 10MB decoded bytes: floor(len/4)*3
    const over = 'A'.repeat(Math.ceil((10 * 1024 * 1024) / 3) * 4)
    expect(isImageAttachments([{ ...png, data: over }])).toBe(false)
    const under = 'A'.repeat(Math.ceil((10 * 1024 * 1024) / 3) * 4 - 4)
    expect(isImageAttachments([{ ...png, data: under }])).toBe(true)
  })
})

describe('isCustomProviderConfig', () => {
  const valid = {
    id: 'my-ollama',
    name: '本地 Ollama',
    baseUrl: 'http://localhost:11434/v1',
    api: 'openai-completions',
    models: [{ id: 'llama3.1:8b' }],
  }

  it('accepts a minimal valid config', () => {
    expect(isCustomProviderConfig(valid)).toBe(true)
  })

  it('accepts full config with key, names, image input and context window', () => {
    expect(
      isCustomProviderConfig({
        ...valid,
        api: 'anthropic-messages',
        apiKey: 'sk-test-123',
        models: [
          { id: 'm1', name: 'M1', input: ['text', 'image'], contextWindow: 128000 },
          { id: 'm2' },
        ],
      }),
    ).toBe(true)
  })

  it('rejects non-objects and missing fields', () => {
    expect(isCustomProviderConfig(null)).toBe(false)
    expect(isCustomProviderConfig(undefined)).toBe(false)
    expect(isCustomProviderConfig('x')).toBe(false)
    expect(isCustomProviderConfig({ ...valid, id: undefined })).toBe(false)
    expect(isCustomProviderConfig({ ...valid, baseUrl: undefined })).toBe(false)
    expect(isCustomProviderConfig({ ...valid, models: undefined })).toBe(false)
  })

  it('rejects malformed provider ids', () => {
    for (const id of ['', 'a b', '中文', '-leading', 'a'.repeat(65), 'a/b', 'a.b']) {
      expect(isCustomProviderConfig({ ...valid, id })).toBe(false)
    }
  })

  it('rejects non-http(s) or oversized base URLs', () => {
    expect(isCustomProviderConfig({ ...valid, baseUrl: 'ftp://x' })).toBe(false)
    expect(isCustomProviderConfig({ ...valid, baseUrl: 'localhost:11434' })).toBe(false)
    expect(isCustomProviderConfig({ ...valid, baseUrl: 'x'.repeat(513) })).toBe(false)
  })

  it('rejects unsupported api values', () => {
    expect(isCustomProviderConfig({ ...valid, api: 'magic-api' })).toBe(false)
  })

  it('rejects empty or oversized model lists and bad models', () => {
    expect(isCustomProviderConfig({ ...valid, models: [] })).toBe(false)
    expect(isCustomProviderConfig({ ...valid, models: Array.from({ length: 21 }, (_, i) => ({ id: `m${i}` })) })).toBe(false)
    expect(isCustomProviderConfig({ ...valid, models: [{ id: '' }] })).toBe(false)
    expect(isCustomProviderConfig({ ...valid, models: [{ id: 'm', input: ['video'] }] })).toBe(false)
    expect(isCustomProviderConfig({ ...valid, models: [{ id: 'm', contextWindow: 0 }] })).toBe(false)
  })
})
