// installGuest が触る範囲だけを持つ、テスト用の window（DOM なし）。
import type { GuestToHost } from "../src/messages.ts";

type Listener = (ev: Record<string, unknown>) => void;

class Target {
  private listeners = new Map<string, Listener[]>();
  addEventListener(type: string, cb: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), cb]);
  }
  dispatch(type: string, ev: Record<string, unknown> = {}): void {
    for (const cb of this.listeners.get(type) ?? []) cb(ev);
  }
}

interface FakeMeta {
  name: string;
  content: string;
  remove(): void;
}

export interface FakeOptions {
  title?: string;
  metas?: Record<string, string>;
  readyState?: "loading" | "complete";
  /** true なら親がいない（直接開かれた） */
  topLevel?: boolean;
}

export function fakeWindow(opts: FakeOptions = {}) {
  const sent: GuestToHost[] = [];
  const clock = { t: 0 };
  let rafCb: (() => void) | undefined;

  const metas: FakeMeta[] = [];
  const addMeta = (name: string, content: string): FakeMeta => {
    const m: FakeMeta = {
      name,
      content,
      remove: () => {
        metas.splice(metas.indexOf(m), 1);
      },
    };
    metas.push(m);
    return m;
  };
  for (const [name, content] of Object.entries(
    opts.metas ?? {
      "gf:verb": "タップ！",
      "gf:input": "tap",
      "gf:duration": "300",
      "gf:target": "12",
    },
  )) {
    addMeta(name, content);
  }
  const nameOf = (selector: string): string => /name="([^"]+)"/.exec(selector)?.[1] ?? "";
  const asEl = (m: FakeMeta) => ({
    getAttribute: (k: string) => (k === "content" ? m.content : k === "name" ? m.name : null),
    remove: m.remove,
  });

  const doc = Object.assign(new Target(), {
    title: opts.title ?? " まるタップ ",
    readyState: opts.readyState ?? "loading",
    documentElement: {
      style: {} as Record<string, string>,
      captured: [] as number[],
      setPointerCapture(id: number): void {
        if (id < 0) throw new Error("NotFoundError");
        this.captured.push(id);
      },
    },
    querySelector: (sel: string) => {
      const m = metas.find((x) => x.name === nameOf(sel));
      return m ? asEl(m) : null;
    },
    querySelectorAll: (sel: string) => metas.filter((x) => x.name === nameOf(sel)).map(asEl),
    createElement: () => {
      const attrs: Record<string, string> = {};
      return { setAttribute: (k: string, v: string) => (attrs[k] = v), attrs };
    },
    head: {
      appendChild: (el: { attrs: Record<string, string> }) => {
        addMeta(el.attrs.name ?? "", el.attrs.content ?? "");
      },
    },
  });

  const parent = { postMessage: (m: GuestToHost, _target: string) => sent.push(m) };
  const win = Object.assign(new Target(), {
    document: doc,
    performance: { now: () => clock.t },
    requestAnimationFrame: (cb: () => void) => {
      rafCb = cb;
      return 0;
    },
    innerWidth: 400,
    innerHeight: 800,
    parent: parent as unknown,
    postMessage: (m: GuestToHost, _target: string) => sent.push(m),
    GF: undefined as unknown,
  });
  if (opts.topLevel) win.parent = win;

  return {
    win,
    doc,
    sent,
    metas,
    parent,
    clock,
    /** 実時間を進めて、描画タイミングを 1 回起こす */
    step(ms: number): void {
      clock.t += ms;
      const cb = rafCb;
      rafCb = undefined;
      cb?.();
    },
    loaded(): void {
      doc.readyState = "complete";
      doc.dispatch("DOMContentLoaded");
    },
    fromHost(data: unknown): void {
      win.dispatch("message", { source: parent, data });
    },
    pointer(type: string, clientX: number, clientY: number, pointerId = 1): void {
      win.dispatch(type, { pointerId, clientX, clientY });
    },
  };
}
