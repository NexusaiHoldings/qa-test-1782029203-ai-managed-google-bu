/**
 * active-theme — the resolved ThemeContract this company wears.
 * Written by provisioning (_step_substrate_install): an approved mood
 * board's derived theme wins, else the CMO's authored ThemeContract
 * (company-theme-authoring-001 / visual phase 3b). Do NOT hand-edit.
 */
import type { ThemeContract } from "./contract";

export const activeTheme: ThemeContract = {
  "type": {
    "fontBody": "inter",
    "fontHeading": "inter"
  },
  "color": {
    "bg": "#ffffff",
    "text": "#1a2332",
    "accent": "#1a4f8a",
    "border": "#d6dce6",
    "danger": "#b02a2a",
    "success": "#1a6b3c",
    "surface": "#f4f6f9",
    "textMuted": "#4f5f74",
    "accentText": "#ffffff",
    "surfaceAlt": "#e8ecf2",
    "borderStrong": "#b0bbc9"
  },
  "shape": {
    "radius": 6
  }
};
