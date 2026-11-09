import type { DeerApi } from "./ipc.js";

declare global {
  interface Window {
    deer: DeerApi;
  }
}

export {};
