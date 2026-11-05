/**
 * `createDb` の接続タイムアウト（#40、R-12.1-6）。
 *
 * DB に届かないとき postgres-js の既定（30 秒）まで待つと、Vercel の関数制限（10 秒）に先に当たって
 * 原因が見えない 504 になる。既定を 5 秒にし、失敗を早く・`CONNECT_TIMEOUT` として返すことを確かめる。
 * 本物の DB は要らない: 接続は受け付けるが一切応答しない TCP サーバで「届くが返事がない」状況を作る。
 */

import net from "node:net";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { createDb } from "../src/db/client.ts";

/** 接続を受け付けて黙り続けるサーバ。postgres-js のスタートアップに応答しないので接続は完了しない。 */
async function silentServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    url: `postgresql://user:pass@127.0.0.1:${port}/db`,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("createDb の接続タイムアウト（#40）", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const fn of cleanups.splice(0)) await fn();
  });

  it("既定の connect_timeout は 5 秒（postgres-js の既定 30 秒ではない）", () => {
    const h = createDb("postgresql://user:pass@127.0.0.1:1/db");
    cleanups.push(() => h.close());
    expect(h.options.connect_timeout).toBe(5);
    expect(h.options.max).toBe(5);
  });

  it("connectTimeout で上書きできる", () => {
    const h = createDb("postgresql://user:pass@127.0.0.1:1/db", { connectTimeout: 2 });
    cleanups.push(() => h.close());
    expect(h.options.connect_timeout).toBe(2);
  });

  it("応答しない DB には connectTimeout 秒で CONNECT_TIMEOUT を返し、30 秒待たない", async () => {
    const srv = await silentServer();
    cleanups.push(srv.close);
    const h = createDb(srv.url, { max: 1, connectTimeout: 1 });
    cleanups.push(() => h.close());

    const started = Date.now();
    const err = await h.db.execute(sql`select 1`).then(
      () => {
        throw new Error("応答しないサーバに対してクエリが成功した");
      },
      (e: unknown) => (e instanceof Error && e.cause instanceof Error ? e.cause : e),
    );
    const elapsed = Date.now() - started;

    expect((err as { code?: string }).code).toBe("CONNECT_TIMEOUT");
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(5_000);
  }, 10_000);
});
