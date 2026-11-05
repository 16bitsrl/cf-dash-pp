import { useSyncExternalStore } from "react";

// Installing Dash++ as an app. Chrome and Android offer it through an event we keep for the menu;
// Safari on iPhone and iPad has no such event, there it is "Share → Add to Home Screen".

type InstallEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };

let deferred: InstallEvent | null = null;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((l) => l());

const standalone = () => window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
// iPadOS presents itself as a Mac: a Mac with a touch screen is an iPad.
const ios = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferred = e as InstallEvent;
  changed();
});
window.addEventListener("appinstalled", () => {
  deferred = null;
  changed();
});

/** Keeps the app's own files on the device, only in the published app (not while developing). */
export function registerServiceWorker() {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => void navigator.serviceWorker.register("/sw.js").catch(() => {}));
}

type InstallState = { mode: "prompt" | "ios" | null };

let snapshot: InstallState = { mode: null };
function read(): InstallState {
  const mode = standalone() ? null : deferred ? "prompt" : ios() ? "ios" : null;
  if (mode !== snapshot.mode) snapshot = { mode };
  return snapshot;
}

/** How this browser can install Dash++: its own prompt, the iPhone steps, or not at all (already installed or not supported). */
export function useInstall() {
  const state = useSyncExternalStore((l) => (listeners.add(l), () => listeners.delete(l)), read);
  async function prompt() {
    if (!deferred) return;
    await deferred.prompt();
    await deferred.userChoice.catch(() => null);
    deferred = null;
    changed();
  }
  return { ...state, prompt };
}
