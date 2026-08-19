import { Notification } from 'electron'
import type { CompletionStatus } from '../shared/contracts'

/**
 * Completion notifications live in main (the runtime coordinates run state;
 * index.ts wires the platform-specific bits). Notification text is fixed —
 * never message content — so secrets never surface on lock screens or
 * notification centers.
 */

/** Fixed bilingual notification copy for a finished agent run. */
export function completionNotificationText(
  lang: 'zh' | 'en',
  status: CompletionStatus,
): { title: string; body: string } {
  if (status === 'error') {
    return lang === 'zh'
      ? { title: '任务出错', body: 'Pi 处理你的消息时出错了，请查看对话。' }
      : { title: 'Task failed', body: 'Pi hit an error processing your message. See the chat.' }
  }
  return lang === 'zh'
    ? { title: '任务完成', body: 'Pi 已处理完你的消息。' }
    : { title: 'Task complete', body: 'Pi finished your message.' }
}

/**
 * Pure policy: notify only when the preference is enabled AND the app window
 * is not focused (the user is elsewhere; a focused window needs no toast).
 */
export function shouldNotifyCompletion(enabled: boolean, focused: boolean): boolean {
  return enabled && !focused
}

/**
 * Shows the native notification and returns true when one was actually
 * displayed. Failures are swallowed: a missing notification service (some
 * Linux/WSL setups, Windows without toast support) must never crash the app.
 * `focus` is invoked when the toast is clicked (platform-specific window
 * restore/focus logic lives in index.ts, which owns the window).
 */
export function showCompletionNotification(
  title: string,
  body: string,
  focus: () => void,
): boolean {
  try {
    if (!Notification.isSupported()) return false
    const notification = new Notification({ title, body })
    notification.on('click', () => {
      try {
        focus()
      } catch { /* focus is best effort */ }
    })
    notification.show()
    return true
  } catch {
    // Windows without AppUserModelID, unsupported desktops, sandboxed macOS
    // processes, ...
    return false
  }
}