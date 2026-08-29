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
  { id: "open-detail", label: "Open detail view", keys: ["v"] },
  { id: "toggle-done", label: "Toggle done", keys: ["x", "Space"] },
  { id: "promote", label: "Promote to full todo", keys: ["p"] },
  { id: "indent", label: "Indent", keys: ["Tab"] },
  { id: "outdent", label: "Outdent", keys: ["Shift+Tab"] },
  { id: "delete", label: "Delete", keys: ["d d"] },
  { id: "open-schedule", label: "Schedule…", keys: ["s"] },
  { id: "open-tags", label: "Edit tags", keys: ["t"] },
  { id: "open-collections", label: "Edit collections", keys: ["c"] },
  { id: "open-status-editor", label: "Edit statuses", keys: [] },
  { id: "yank", label: "Copy todo", keys: ["y"] },
  { id: "paste", label: "Paste a copy", keys: ["P"] },
  { id: "toggle-sidebar", label: "Toggle sidebar", keys: ["Ctrl/Cmd+B"] },
  { id: "focus-search", label: "Search", keys: ["/", "Ctrl/Cmd+F"] },
  { id: "undo", label: "Undo", keys: ["u", "Ctrl/Cmd+Z"] },
  { id: "redo", label: "Redo", keys: ["Ctrl/Cmd+Shift+Z"] },
  { id: "focus-next", label: "Move focus down", keys: ["j", "↓"] },
  { id: "focus-prev", label: "Move focus up", keys: ["k", "↑"] },
  { id: "jump-first", label: "Jump to first", keys: ["g g"] },
  { id: "jump-last", label: "Jump to last", keys: ["G"] },
  { id: "generate-report", label: "EOD report for today", keys: ["Ctrl/Cmd+Shift+E"] },
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
      { keys: "v", action: "Open the detail view (Esc goes back)" },
      { keys: "o / O", action: "New sibling below / above" },
      { keys: "a", action: "Add sub-item" },
      { keys: "Tab / Shift+Tab", action: "Indent / outdent" },
      { keys: "x / Space", action: "Toggle done" },
      { keys: "s", action: "Schedule (then t/m/w/x: today, tomorrow, next week, clear)" },
      { keys: "p", action: "Promote to full todo" },
      { keys: "n", action: "Quick-add" },
      { keys: "t", action: "Edit tags" },
      { keys: "c", action: "Edit collections" },
      { keys: "y / P", action: "Copy a todo / paste a copy" },
      { keys: "d d", action: "Delete" },
      { keys: "g g / G", action: "Jump to first / last" },
      { keys: "u", action: "Undo" },
      { keys: "1 … 9", action: "Select the nth sidebar row (Today, Upcoming, …)" },
      { keys: "Ctrl/Cmd+B", action: "Collapse the sidebar to its rail" },
    ],
  },
  {
    title: "Edit mode",
    rows: [
      { keys: "Enter", action: "New line" },
      { keys: "Shift+Enter", action: "New line" },
      { keys: "Ctrl/Cmd+Enter", action: "Submit and open the next line" },
      { keys: "Ctrl/Cmd+B", action: "Bold" },
      { keys: "Ctrl/Cmd+I", action: "Italic" },
      { keys: "#tag @collection !date", action: "Inline tokens — applied and stripped on accept (!tomorrow, !aug 30, !next week)" },
      { keys: "Esc", action: "Back to list (text is kept)" },
    ],
  },
  {
    title: "Anywhere",
    rows: [
      { keys: "Ctrl/Cmd+K", action: "Command palette" },
      { keys: "Ctrl/Cmd+Shift+E", action: "EOD report for today" },
      { keys: "/ or Ctrl/Cmd+F", action: "Search" },
      { keys: "Ctrl/Cmd+Z", action: "Undo" },
      { keys: "Ctrl/Cmd+Shift+Z", action: "Redo" },
      { keys: "?", action: "This cheat sheet" },
    ],
  },
];
