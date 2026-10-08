import { useCallback, useEffect, useRef, useState } from 'react';
import type { PublicExamSettings } from '../types';

export type GuardEventKind =
  | 'tab_hidden'
  | 'window_blur'
  | 'focus_return'
  | 'fullscreen_exit'
  | 'copy_attempt'
  | 'cut_attempt'
  | 'paste_attempt'
  | 'drop_attempt'
  | 'context_menu'
  | 'print_attempt'
  | 'devtools_attempt'
  | 'multiple_screens'
  | 'system_key_attempt';

interface KeyboardLockApi {
  lock?: (keyCodes?: string[]) => Promise<void>;
  unlock?: () => void;
}

/** Chrome/Edge expose navigator.keyboard.lock(); other browsers do not. */
export function keyboardLockSupported(): boolean {
  const kb = (navigator as Navigator & { keyboard?: KeyboardLockApi }).keyboard;
  return typeof kb?.lock === 'function';
}

interface GuardOptions {
  /** Watch only while the attempt is live — not while paused, locked or finished. */
  active: boolean;
  settings: PublicExamSettings | null;
  report: (kind: GuardEventKind, detail: string) => void;
}

const SAME_KIND_THROTTLE_MS = 2000;
/** A blur that is followed by the tab becoming hidden is a tab switch, not a window switch. */
const CLASSIFY_DELAY_MS = 300;

/**
 * Browser-side enforcement of the quiz's exam rules.
 *
 * Detects (cannot prevent): switching tabs, switching windows/apps, leaving
 * full screen, extra displays. Blocks (and logs): copy, cut, paste, drag-in,
 * right-click, print and devtools shortcuts. Each real-world departure is
 * reported once; returning reports how long the student was away.
 */
export function useExamGuard({ active, settings, report }: GuardOptions) {
  const [fullscreen, setFullscreen] = useState<boolean>(() =>
    typeof document !== 'undefined' ? Boolean(document.fullscreenElement) : false,
  );
  const reportRef = useRef(report);
  reportRef.current = report;
  const lastSent = useRef<Record<string, number>>({});

  const send = useCallback((kind: GuardEventKind, detail: string) => {
    const now = Date.now();
    if (now - (lastSent.current[kind] ?? 0) < SAME_KIND_THROTTLE_MS) return;
    lastSent.current[kind] = now;
    reportRef.current(kind, detail);
  }, []);

  const requireFullscreen = Boolean(settings?.require_fullscreen);
  const watchTabs = Boolean(settings && !settings.allow_tab_switch);
  const watchWindows = Boolean(settings && !settings.allow_window_switch);
  const blockClipboard = Boolean(settings && !settings.allow_copy_paste);
  const blockContextMenu = Boolean(settings && !settings.allow_right_click);
  const lockKeyboard = Boolean(settings?.lock_keyboard);

  // Full screen: track state always (the gate needs it), report exits only while live.
  useEffect(() => {
    const onChange = () => {
      const isFull = Boolean(document.fullscreenElement);
      setFullscreen(isFull);
      if (!isFull && active && requireFullscreen) send('fullscreen_exit', 'Esc held down or full screen closed.');
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, [active, requireFullscreen, send]);

  // Keyboard Lock (Chrome/Edge, full screen only): the Windows key, Alt+Tab, Esc
  // and other OS/browser shortcuts are delivered to the page instead of acting.
  // Leaving full screen then takes Esc held down. The browser drops the lock
  // whenever full screen ends, so it is re-applied on every return.
  useEffect(() => {
    if (!active || !lockKeyboard || !fullscreen) return;
    const kb = (navigator as Navigator & { keyboard?: KeyboardLockApi }).keyboard;
    if (typeof kb?.lock !== 'function') return;
    void kb.lock().catch(() => {});
    return () => kb.unlock?.();
  }, [active, lockKeyboard, fullscreen]);

  // System keys reaching the page (they cannot act while locked): swallow and log.
  useEffect(() => {
    if (!active || !lockKeyboard) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const isWindowsKey = e.key === 'Meta' || e.key === 'OS' || e.code === 'MetaLeft' || e.code === 'MetaRight';
      const isAltTab = e.altKey && e.key === 'Tab';
      if (!isWindowsKey && !isAltTab) return;
      e.preventDefault();
      send('system_key_attempt', isWindowsKey ? 'Pressed the Windows key (blocked).' : 'Pressed Alt+Tab (blocked).');
    };
    document.addEventListener('keydown', onKeyDown, { capture: true });
    return () => document.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [active, lockKeyboard, send]);

  // Tab and window switches.
  useEffect(() => {
    if (!active || (!watchTabs && !watchWindows)) return;
    let awaySince: number | null = null;
    let awayReported = false;
    let classify: ReturnType<typeof setTimeout> | null = null;

    const leave = (kind: 'tab_hidden' | 'window_blur', detail: string) => {
      if (awaySince !== null) return; // one departure = one incident
      awaySince = Date.now();
      awayReported = (kind === 'tab_hidden' && watchTabs) || (kind === 'window_blur' && watchWindows);
      if (awayReported) send(kind, detail);
    };
    const back = () => {
      if (awaySince === null || document.visibilityState !== 'visible' || !document.hasFocus()) return;
      const seconds = Math.max(1, Math.round((Date.now() - awaySince) / 1000));
      if (awayReported) reportRef.current('focus_return', `Back on the quiz after ${seconds} s.`);
      awaySince = null;
      awayReported = false;
    };
    const cancelClassify = () => {
      if (classify) clearTimeout(classify);
      classify = null;
    };
    const onBlur = () => {
      cancelClassify();
      classify = setTimeout(() => {
        classify = null;
        if (document.visibilityState === 'hidden') leave('tab_hidden', 'Switched tab or minimised the browser.');
        else if (!document.hasFocus()) leave('window_blur', 'Switched to another window or app.');
      }, CLASSIFY_DELAY_MS);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        cancelClassify();
        leave('tab_hidden', 'Switched tab or minimised the browser.');
      } else {
        back();
      }
    };
    const onFocus = () => {
      cancelClassify();
      back();
    };
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelClassify();
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [active, watchTabs, watchWindows, send]);

  // Clipboard, drag-in, right-click, print, devtools.
  useEffect(() => {
    if (!active || (!blockClipboard && !blockContextMenu)) return;
    const onClipboard = (e: ClipboardEvent) => {
      if (!blockClipboard) return;
      e.preventDefault();
      send(`${e.type}_attempt` as GuardEventKind, `Blocked ${e.type}.`);
    };
    const onDrop = (e: DragEvent) => {
      if (!blockClipboard) return;
      e.preventDefault();
      send('drop_attempt', 'Blocked dragging content into the quiz.');
    };
    const onDragStart = (e: DragEvent) => {
      if (blockClipboard) e.preventDefault();
    };
    const onContextMenu = (e: MouseEvent) => {
      if (!blockContextMenu) return;
      e.preventDefault();
      send('context_menu', 'Blocked the right-click menu.');
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (!blockClipboard) return;
      const key = e.key.toLowerCase();
      const mod = e.ctrlKey || e.metaKey;
      if (key === 'f12' || (mod && e.shiftKey && ['i', 'j', 'c'].includes(key)) || (mod && key === 'u')) {
        e.preventDefault();
        send('devtools_attempt', `Blocked ${e.key === 'F12' ? 'F12' : 'a developer-tools shortcut'}.`);
      } else if (mod && key === 'p') {
        e.preventDefault();
        send('print_attempt', 'Blocked printing.');
      } else if (mod && key === 's') {
        e.preventDefault();
      }
    };
    const onBeforePrint = () => {
      if (blockClipboard) send('print_attempt', 'Opened the print dialog (content is hidden in print).');
    };
    const opts = { capture: true } as const;
    document.addEventListener('copy', onClipboard, opts);
    document.addEventListener('cut', onClipboard, opts);
    document.addEventListener('paste', onClipboard, opts);
    document.addEventListener('drop', onDrop, opts);
    document.addEventListener('dragstart', onDragStart, opts);
    document.addEventListener('contextmenu', onContextMenu, opts);
    document.addEventListener('keydown', onKeyDown, opts);
    window.addEventListener('beforeprint', onBeforePrint);
    return () => {
      document.removeEventListener('copy', onClipboard, opts);
      document.removeEventListener('cut', onClipboard, opts);
      document.removeEventListener('paste', onClipboard, opts);
      document.removeEventListener('drop', onDrop, opts);
      document.removeEventListener('dragstart', onDragStart, opts);
      document.removeEventListener('contextmenu', onContextMenu, opts);
      document.removeEventListener('keydown', onKeyDown, opts);
      window.removeEventListener('beforeprint', onBeforePrint);
    };
  }, [active, blockClipboard, blockContextMenu, send]);

  // Extra displays (Chromium exposes screen.isExtended). Informational only.
  useEffect(() => {
    if (!active || !requireFullscreen) return;
    const scr = window.screen as Screen & {
      isExtended?: boolean;
      addEventListener?: (type: 'change', fn: () => void) => void;
      removeEventListener?: (type: 'change', fn: () => void) => void;
    };
    const check = () => {
      if (scr.isExtended) send('multiple_screens', 'More than one display is connected.');
    };
    check();
    scr.addEventListener?.('change', check);
    return () => scr.removeEventListener?.('change', check);
  }, [active, requireFullscreen, send]);

  const enterFullscreen = useCallback(async () => {
    try {
      await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    } catch {
      /* denied or unsupported: the gate stays up with an explanation */
    }
  }, []);

  return {
    fullscreen,
    fullscreenSupported: typeof document !== 'undefined' && Boolean(document.fullscreenEnabled),
    enterFullscreen,
  };
}

/** Leave full screen after the attempt ends so the student is not stranded. */
export function exitFullscreen(): void {
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
}
