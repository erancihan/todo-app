/**
 * The discoverability layer (docs/04-ux-and-interaction.md §4.4).
 *
 * Vim-ish single-key verbs surprise non-power users, so every verb is also
 * reachable by name through the `Ctrl/Cmd+K` palette and listed in the `?` cheat
 * sheet. Both read from this one table, so a binding can never appear in the
 * palette but be missing from the cheat sheet.
 */

import type { Action } from "./keymap";

export interface Command {
  /** The controller action this dispatches — the id *is* the action. */
  id: Action;
  label: string;
  keys: string[];
}

export const PALETTE_COMMANDS: Command[] = [
  { id: "quick-add", label: "New todo", keys: ["n"] },
  { id: "new-sibling-below", label: "New sibling below", keys: ["o"] },
  { id: "new-sibling-above", label: "New sibling above", keys: ["O"] },
  { id: "new-subitem", label: "Add sub-item", keys: ["a"] },
  { id: "edit", label: "Edit body", keys: ["e", "Enter"] },
  { id: "toggle-done", label: "Toggle done", keys: ["x", "Space"] },
  { id: "promote", label: "Promote to full todo", keys: ["p"] },
  { id: "indent", label: "Indent", keys: ["Tab"] },
  { id: "outdent", label: "Outdent", keys: ["Shift+Tab"] },
  { id: "delete", label: "Delete", keys: ["d d"] },
  { id: "focus-next", label: "Move focus down", keys: ["j", "↓"] },
  { id: "focus-prev", label: "Move focus up", keys: ["k", "↑"] },
  { id: "cheat-sheet", label: "Keyboard cheat sheet", keys: ["?"] },
];

export interface CheatSheetSection {
  title: string;
  rows: { keys: string; action: string }[];
}

export const CHEAT_SHEET: CheatSheetSection[] = [
  {
    title: "List mode",
    rows: [
      { keys: "j / ↓", action: "Next row" },
      { keys: "k / ↑", action: "Previous row" },
      { keys: "h / ←", action: "Collapse, or jump to parent" },
      { keys: "l / →", action: "Expand, or enter first child" },
      { keys: "e / Enter", action: "Edit body" },
      { keys: "o / O", action: "New sibling below / above" },
      { keys: "a", action: "Add sub-item" },
      { keys: "Tab / Shift+Tab", action: "Indent / outdent" },
      { keys: "x / Space", action: "Toggle done" },
      { keys: "p", action: "Promote to full todo" },
      { keys: "n", action: "Quick-add" },
    ],
  },
  {
    title: "Edit mode",
    rows: [
      { keys: "Enter", action: "New line" },
      { keys: "Shift+Enter", action: "New line" },
      { keys: "Ctrl/Cmd+Enter", action: "Submit and open the next line" },
      { keys: "Esc", action: "Back to list (text is kept)" },
    ],
  },
  {
    title: "Anywhere",
    rows: [
      { keys: "Ctrl/Cmd+K", action: "Command palette" },
      { keys: "?", action: "This cheat sheet" },
    ],
  },
];
