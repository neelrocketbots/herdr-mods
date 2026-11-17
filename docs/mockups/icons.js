// Replaces <i data-i="name"></i> with the mods' stroke icons.
const PATHS = {
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  changes: '<circle cx="6" cy="6" r="2.5"/><path d="M6 8.5v4a4 4 0 0 0 4 4h5"/><circle cx="17.5" cy="16.5" r="2.5"/>',
  pr: '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><path d="M6 9v12"/>',
  github: '<path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.4 5.4 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/><path d="M9 18c-4.51 2-5-2-8-2"/>',
  linear: '<path d="M3.5 13.5l7 7"/><path d="M3 10l11 11"/><path d="M4.5 6.5l13 13"/><path d="M8 4l12 12"/><circle cx="12" cy="12" r="9"/>',
  worktree: '<circle cx="6" cy="5" r="2.2"/><circle cx="6" cy="19" r="2.2"/><circle cx="17" cy="9" r="2.2"/><path d="M6 7.2v9.6"/><path d="M17 11.2c0 3-3 3.8-6 4.3"/><path d="M19.5 17v5M17 19.5h5"/>',
  editor: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M9.5 10l-2.5 2.5 2.5 2.5M14.5 10l2.5 2.5-2.5 2.5"/>',
  claude: '<path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6L5.6 18.4"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
};
for (const el of document.querySelectorAll("i[data-i]")) {
  el.outerHTML = `<svg class="ico" viewBox="0 0 24 24" style="${el.getAttribute("style") ?? ""}">${PATHS[el.dataset.i] ?? ""}</svg>`;
}
