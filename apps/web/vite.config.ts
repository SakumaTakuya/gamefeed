import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    // ローカルでは apps/api（:3000）に /api を流す
    proxy: { "/api": "http://localhost:3000" },
  },
});
