// Vercel の Node 関数エントリ。
// apps/api を依存ごと束ねた dist/app.js（vercel.json の buildCommand で生成）を読む。
// default export が fetch を持つオブジェクト（Hono の app）なら @vercel/node は Web ハンドラとして呼ぶ。
// 関数（hono/vercel の handle など）を default export すると Node の (req, res) で呼ばれて壊れる（#17）。
import { app } from "../apps/api/dist/app.js";

export default app;
