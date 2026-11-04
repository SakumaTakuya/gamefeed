import { createDb, migrateDb } from "../src/db/client.ts";

// DATABASE_URL の DB に migrations/ を当てる。デプロイ前に手で、または CI から実行する。
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL を設定してください");
  process.exit(1);
}
const { db, close } = createDb(url, { max: 1 });
try {
  await migrateDb(db);
  console.log("migrations applied");
} finally {
  await close();
}
