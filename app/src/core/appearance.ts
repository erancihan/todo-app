/**
 * Theme and density (docs/04-ux-and-interaction.md §7.7, ThemeToggle/DensityToggle).
 *
 * Both are per-viewer conveniences, so they live in `localStorage` rather than in
 * the engine: they describe this browser, not the account, and syncing them in
 * Phase 2 would mean a phone's density preference reaching a desktop.
 *
 * Applied to `<html>` rather than to a component, because the values they switch
 * are CSS custom properties on `:root` — the whole point is that no rule below
 * has to know a toggle exists.
 */

export type Theme = "dark" | "light" | "system";
export type Density = "dense" | "comfortable";

const THEME_KEY = "daybook.theme";
const DENSITY_KEY = "daybook.density";

/** Read a stored preference, tolerating storage being unavailable. */
function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    // Private windows and blocked site data throw on *access*, not on read.
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Not being able to remember a preference is not a reason to refuse it.
  }
}

export function storedTheme(): Theme {
  const value = read(THEME_KEY);
  return value === "light" || value === "dark" || value === "system" ? value : "dark";
}

export function storedDensity(): Density {
  return read(DENSITY_KEY) === "comfortable" ? "comfortable" : "dense";
}

function prefersDark(): boolean {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true;
}

/**
 * Put the theme on `<html>`.
 *
 * `dark` is the shipped default and `index.html` ships with the class already
 * applied, so the app never flashes light before this runs.
 */
export function applyTheme(theme: Theme): void {
  const dark = theme === "dark" || (theme === "system" && prefersDark());
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.dataset.theme = theme;
  // Keeps form controls, scrollbars and the like in step with the page.
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
}

export function applyDensity(density: Density): void {
  document.documentElement.dataset.density = density;
}

export function setTheme(theme: Theme): void {
  write(THEME_KEY, theme);
  applyTheme(theme);
}

export function setDensity(density: Density): void {
  write(DENSITY_KEY, density);
  applyDensity(density);
}

/**
 * Apply the stored preferences and keep `system` in step with the OS.
 *
 * Returns the values applied so the view can show which one is active without
 * reading storage a second time.
 */
export function initAppearance(): { theme: Theme; density: Density } {
  const theme = storedTheme();
  const density = storedDensity();
  applyTheme(theme);
  applyDensity(density);

  // Only matters while the choice is `system`; re-reading the stored value each
  // time means switching to an explicit theme silently stops this listener
  // mattering, without needing to remove it.
  window
    .matchMedia?.("(prefers-color-scheme: dark)")
    .addEventListener?.("change", () => {
      if (storedTheme() === "system") applyTheme("system");
    });

  return { theme, density };
}
