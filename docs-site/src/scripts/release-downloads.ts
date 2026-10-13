// Version picker wiring for the download page (ReleaseDownloads.astro).
//
// One bundled copy serves every picker instance on the page. Astro
// re-executes this module after each client-side navigation, so wireAll runs
// both on first load and on every `astro:page-load`; the data-wired guard
// keeps re-wiring idempotent. This lives in its own module (rather than an
// inline script) because `astro check` does not honor JSDoc casts inside
// inline scripts, while real annotations here are fully checked.

function ensureDismissListener(): void {
  if (document.documentElement.hasAttribute('data-release-downloads-dismiss')) return;
  document.documentElement.setAttribute('data-release-downloads-dismiss', '');
  // A click outside an open list collapses it. Document-level and installed
  // once (see the flag above): a per-picker listener would pile up stale
  // closures over swapped-out roots on every navigation.
  document.addEventListener('click', event => {
    const target = event.target instanceof Node ? event.target : null;
    document.querySelectorAll('[data-release-downloads]').forEach(picker => {
      if (!(picker instanceof HTMLElement)) return;
      if (target && picker.contains(target)) return;
      const box = picker.querySelector('.combo-box');
      const list = picker.querySelector('.combo-list');
      if (box) box.setAttribute('aria-expanded', 'false');
      if (list instanceof HTMLElement) list.hidden = true;
    });
  });
}

function wire(root: HTMLElement): void {
  if (root.dataset.wired) return;
  root.dataset.wired = '1';
  const box = root.querySelector('.combo-box');
  const list = root.querySelector('.combo-list');
  const reset = root.querySelector('.reset-button');
  const current = root.querySelector('[data-current]');
  const badge = root.querySelector('[data-badge]');
  if (!box || !list || !reset || !current) return;
  // Exact element types, declared rather than narrowed: the guard above
  // proves these at runtime, but its narrowing does not reach the nested
  // closures below, so each element gets a type of its own.
  const boxEl = box as HTMLElement;
  const listEl = list as HTMLElement;
  const resetEl = reset as HTMLButtonElement;
  const currentEl = current as HTMLElement;
  const options = [...root.querySelectorAll('.option')];
  const newestOption = options.find(
    (option): option is HTMLElement =>
      option instanceof HTMLElement && option.dataset.newest !== undefined
  );

  function setExpanded(open: boolean): void {
    boxEl.setAttribute('aria-expanded', String(open));
    listEl.hidden = !open;
  }

  function select(option: HTMLElement): void {
    options.forEach(candidate => {
      if (candidate instanceof HTMLElement) {
        candidate.setAttribute('aria-selected', String(candidate === option));
      }
    });
    currentEl.textContent = option.dataset.tag ?? '';
    root.querySelectorAll('[data-version-files]').forEach(node => {
      if (!(node instanceof HTMLElement)) return;
      node.hidden = node.dataset.tag !== option.dataset.tag;
    });
    const isNewest = option === newestOption;
    root.setAttribute('data-showing', isNewest ? 'latest' : 'older');
    if (badge instanceof HTMLElement) {
      badge.hidden = false;
      badge.textContent = isNewest ? 'Latest' : 'Older version';
      badge.classList.toggle('latest-badge', isNewest);
      badge.classList.toggle('older-badge', !isNewest);
    }
    resetEl.disabled = !!isNewest;
    resetEl.title = isNewest ? '' : 'Back to the latest version';
    setExpanded(false);
    boxEl.focus();
  }

  // `.hidden` reads as `string | boolean` in this toolchain (TS 6 DOM
  // types), so negate to the boolean toggle `setExpanded` takes.
  boxEl.addEventListener('click', () => setExpanded(!listEl.hidden));
  boxEl.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setExpanded(!listEl.hidden);
    }
  });
  resetEl.addEventListener('click', e => {
    e.stopPropagation();
    if (newestOption) select(newestOption);
  });
  listEl.addEventListener('click', e => {
    const {target} = e;
    if (!(target instanceof HTMLElement)) return;
    const option = target.closest('.option');
    if (option instanceof HTMLElement) select(option);
  });
  root.addEventListener('keydown', e => {
    if (e.key === 'Escape') setExpanded(false);
  });
}

function wireAll(): void {
  ensureDismissListener();
  document.querySelectorAll('[data-release-downloads]').forEach(node => {
    if (node instanceof HTMLElement) wire(node);
  });
}

wireAll();
// Client-side navigation swaps the picker DOM without a full page load:
// re-wire the fresh nodes.
document.addEventListener('astro:page-load', wireAll);
