// 配信時に注入されるバンドルの入口（scripts/bundle.ts が IIFE にする）。
import { installGuest } from "./browser.ts";

installGuest(window);
