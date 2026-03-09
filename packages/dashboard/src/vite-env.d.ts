/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DIRECTORY_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
