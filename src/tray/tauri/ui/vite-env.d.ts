/// <reference types="vite/client" />

declare module '*.css' {
  const css: string;
  export default css;
}

declare module '*.svg' {
  const src: string;
  export default src;
}
