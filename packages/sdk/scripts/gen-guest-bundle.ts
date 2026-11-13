import { writeFileSync } from "node:fs";
import { buildGuestBundle, GEN_PATH, genSource } from "./bundle.ts";

/**
 * Guest SDK のバンドルを `src/guest-bundle.gen.ts` に書く。配信 Worker がこれを <head> に注入する（gc#A.4）。
 * `packages/sdk/src` か `packages/domain/src` を直したら `pnpm --filter @gamefeed/sdk gen:bundle` を実行してコミットする。
 * 忘れると `test/bundle.spec.ts` が落ちる。
 */
const js = await buildGuestBundle();
writeFileSync(GEN_PATH, genSource(js));
console.log(`wrote ${GEN_PATH} (${js.length} bytes)`);
