import { describe, expect, it, vi } from 'vitest'

const notificationMock = vi.hoisted(() => {
  /** Spy constructor: records options, exposes on()/show(), spyable via .mock. */
  const FakeNotification = vi.fn(function (this: {
      options: unknown
      callbacks: Record<string, () => void>
      on: ReturnType<typeof vi.fn>
      show: ReturnType<typeof vi.fn>
    }, options: unknown) {
    this.options = options
    this.show = vi.fn()
    this.callbacks = {}
    // Registration-time capture: the click handler is stored per instance so
    // tests can drive it, mirroring how Electron invokes the listener later.
    this.on = vi.fn((name: string, cb: () => void) => {
      this.callbacks[name] = cb
      return this
    })
  })
  return { FakeNotification: Object.assign(FakeNotification, { isSupported: vi.fn(() => true) }) }
})

vi.mock('electron', () => ({
  Notification: notificationMock.FakeNotification,
}))

import { completionNotificationText, shouldNotifyCompletion, showCompletionNotification } from '../../src/main/notifications'

describe('completionNotificationText', () => {
  it('returns fixed bilingual copy for done and error statuses', () => {
    expect(completionNotificationText('zh', 'done')).toEqual({ title: '任务完成', body: 'Pi 已处理完你的消息。' })
    expect(completionNotificationText('en', 'done')).toEqual({ title: 'Task complete', body: 'Pi finished your message.' })
    expect(completionNotificationText('zh', 'error')).toEqual({ title: '任务出错', body: 'Pi 处理你的消息时出错了，请查看对话。' })
    expect(completionNotificationText('en', 'error')).toEqual({ title: 'Task failed', body: 'Pi hit an error processing your message. See the chat.' })
  })
})

describe('shouldNotifyCompletion', () => {
  it('notifies only when enabled and the window is not focused', () => {
    expect(shouldNotifyCompletion(true, false)).toBe(true)
    expect(shouldNotifyCompletion(true, true)).toBe(false)
    expect(shouldNotifyCompletion(false, false)).toBe(false)
    expect(shouldNotifyCompletion(false, true)).toBe(false)
  })
})

describe('showCompletionNotification', () => {
  it('shows a notification and wires the click to focus', () => {
    const focus = vi.fn()
    expect(showCompletionNotification('t', 'b', focus)).toBe(true)
    expect(notificationMock.FakeNotification.isSupported).toHaveBeenCalled()
    const instance = notificationMock.FakeNotification.mock.instances.at(-1) as unknown as {
      options: { title: string; body: string }
      callbacks: Record<string, () => void>
      show: ReturnType<typeof vi.fn>
    }
    expect(instance).toBeDefined()
    expect(instance.options).toEqual({ title: 't', body: 'b' })
    expect(instance.show).toHaveBeenCalledTimes(1)
    // Clicking the toast focuses the window (listener captured at registration).
    instance.callbacks['click']?.()
    expect(focus).toHaveBeenCalledTimes(1)
  })

  it('fails closed when unsupported and never throws', () => {
    vi.mocked(notificationMock.FakeNotification.isSupported).mockReturnValue(false)
    expect(showCompletionNotification('t', 'b', () => {})).toBe(false)

    vi.mocked(notificationMock.FakeNotification.isSupported).mockReturnValue(true)
    notificationMock.FakeNotification.mockImplementation(() => { throw new Error('no toast service') })
    try {
      expect(showCompletionNotification('t', 'b', () => {})).toBe(false)
    } finally {
      notificationMock.FakeNotification.mockReset()
      vi.mocked(notificationMock.FakeNotification.isSupported).mockReturnValue(true)
    }
  })
})