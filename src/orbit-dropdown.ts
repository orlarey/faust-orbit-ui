/**
 * Generic custom dropdown — replaces the native `<select>` popup so we
 * have full theming control. The underlying `<select>` is kept in the
 * DOM as the state holder: setting `select.value` and dispatching a
 * synthetic `change` event lets existing event handlers (FaustOrbitUI's
 * own zoom/random change listeners, OrbitUI's preset change handler)
 * continue to work unchanged.
 *
 * Use `enableCustomDropdown(select)` to swap a native popup for a
 * theme-styled one. Use `openDropdownMenu(opts)` for ad-hoc menus that
 * don't have a matching `<select>`.
 */

export type DropdownItem =
  | { kind: 'option'; value: string; label: string; disabled?: boolean; active?: boolean }
  | { kind: 'separator' };

export type DropdownOptions = {
  /** Anchor under which the menu opens (its bottom-left corner).
   *  Mutually exclusive with `position`. */
  anchor?: HTMLElement;
  /** Open the menu directly at viewport coords — useful for context
   *  menus triggered by `contextmenu` events. Mutually exclusive with
   *  `anchor`. */
  position?: { left: number; top: number };
  items: ReadonlyArray<DropdownItem>;
  onPick: (value: string) => void;
  /** Where to attach the menu element. Defaults to `document.body`.
   *  Components that render inside a shadow root pass their shadow
   *  here so the menu inherits the shadow's stylesheet. */
  mountRoot?: ParentNode;
};

const MENU_CLASS = 'orbit-dropdown-menu';

/** Open a theme-styled popup anchored under `opts.anchor`. Returns a
 *  function that closes the popup. The popup also closes on outside
 *  pointerdown, Esc, scroll, and window resize. */
export function openDropdownMenu(opts: DropdownOptions): () => void {
  closeAllDropdownMenus();

  const menu = document.createElement('div');
  menu.className = MENU_CLASS;
  positionMenu(menu, opts);

  for (const item of opts.items) {
    if (item.kind === 'separator') {
      const sep = document.createElement('div');
      sep.className = 'orbit-dropdown-menu-separator';
      menu.appendChild(sep);
      continue;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'orbit-dropdown-menu-item';
    if (item.active) btn.classList.add('orbit-dropdown-menu-item--active');
    btn.disabled = !!item.disabled;
    btn.textContent = item.label;
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (item.disabled) return;
      close();
      opts.onPick(item.value);
    });
    menu.appendChild(btn);
  }

  (opts.mountRoot ?? document.body).appendChild(menu);

  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    document.removeEventListener('pointerdown', onDocPointerDown, { capture: true });
    document.removeEventListener('keydown', onKeyDown, { capture: true });
    window.removeEventListener('scroll', onScrollOrResize, { capture: true });
    window.removeEventListener('resize', onScrollOrResize);
    menu.remove();
  };
  // composedPath walks through shadow boundaries, so the "click outside"
  // detection works whether the menu lives in document.body or inside a
  // shadow root mounted on the host page.
  const onDocPointerDown = (e: PointerEvent): void => {
    const path = e.composedPath();
    if (path.includes(menu)) return;
    if (opts.anchor && path.includes(opts.anchor)) return;
    close();
  };
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  };
  const onScrollOrResize = (): void => close();
  document.addEventListener('pointerdown', onDocPointerDown, { capture: true });
  document.addEventListener('keydown', onKeyDown, { capture: true });
  window.addEventListener('scroll', onScrollOrResize, { capture: true });
  window.addEventListener('resize', onScrollOrResize);

  return close;
}

/** Bind a native `<select>` to a custom dropdown. Mousedown / Enter /
 *  ArrowDown on the select open the themed popup; picking sets
 *  `select.value` and dispatches a `change` event so existing listeners
 *  fire. */
export function enableCustomDropdown(
  select: HTMLSelectElement,
  itemsBuilder?: () => ReadonlyArray<DropdownItem>,
  mountRoot?: ParentNode,
): () => void {
  const open = (): void => {
    const items = itemsBuilder ? itemsBuilder() : optionsToItems(select);
    openDropdownMenu({
      anchor: select,
      items,
      onPick: (value) => {
        select.value = value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      },
      ...(mountRoot ? { mountRoot } : {}),
    });
  };
  const onMouseDown = (e: MouseEvent): void => {
    e.preventDefault();
    open();
  };
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      open();
    }
  };
  select.addEventListener('mousedown', onMouseDown);
  select.addEventListener('keydown', onKeyDown);
  return () => {
    select.removeEventListener('mousedown', onMouseDown);
    select.removeEventListener('keydown', onKeyDown);
  };
}

/** Default conversion from a `<select>`'s `<option>`s to dropdown items. */
function optionsToItems(select: HTMLSelectElement): DropdownItem[] {
  const out: DropdownItem[] = [];
  for (const opt of Array.from(select.options)) {
    if (opt.hidden) continue;
    out.push({
      kind: 'option',
      value: opt.value,
      label: opt.textContent ?? '',
      disabled: opt.disabled,
      active: opt.selected,
    });
  }
  return out;
}

function closeAllDropdownMenus(): void {
  document.querySelectorAll(`.${MENU_CLASS}`).forEach((el) => el.remove());
}

function positionMenu(menu: HTMLElement, opts: DropdownOptions): void {
  if (opts.anchor) {
    const r = opts.anchor.getBoundingClientRect();
    menu.style.left = `${Math.round(r.left)}px`;
    menu.style.top = `${Math.round(r.bottom + 4)}px`;
    menu.style.minWidth = `${Math.round(r.width)}px`;
    return;
  }
  if (opts.position) {
    menu.style.left = `${Math.round(opts.position.left)}px`;
    menu.style.top = `${Math.round(opts.position.top)}px`;
  }
}
