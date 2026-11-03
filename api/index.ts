import { app } from "@gamefeed/api";
import { handle } from "hono/vercel";

export default handle(app);
