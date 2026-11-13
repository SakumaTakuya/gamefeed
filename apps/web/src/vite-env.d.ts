/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 配信オリジン（配信 Worker の URL。末尾スラッシュなし）。se#A.1 の <games-origin> */
  readonly VITE_GAMES_ORIGIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
