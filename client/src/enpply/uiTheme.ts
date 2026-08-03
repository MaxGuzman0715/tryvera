import type { AppUiTheme } from "./types";

/** Applies UI theme on `<html>` for CSS `[data-app-theme]`. */
export function applyAppUiTheme(theme: AppUiTheme): void {
  document.documentElement.dataset.appTheme = theme;
}
