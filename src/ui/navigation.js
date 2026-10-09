import { icon } from './icons.js';
const MENU_ID = 'st-memory-core-menu-container';
const ITEM_ID = 'st-memory-core-menu-item';

function element(tag, className, text) {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
}

// A single panel is shared by the settings drawer and the menu dialog, so form
// values and subscriptions survive opening and closing either entry point.
export function mountNavigation(panel, { drawer, openButton }) {
  const dialog = element('dialog', 'memory-core-dialog'); dialog.id = 'st-memory-core-dialog';
  dialog.setAttribute('aria-labelledby', 'st-memory-core-dialog-title');
  const header = element('div', 'memory-core-dialog-header');
  const brand = element('div', 'memory-core-dialog-brand');
  const title = element('strong', '', '记忆中枢'); title.id = 'st-memory-core-dialog-title';
  brand.append(icon('memory', 'memory-core-brand-icon'), title, element('span', 'memory-core-brand-note', '故事的私人档案馆'));
  const closeButton = element('button', 'menu_button memory-core-close', '关闭'); closeButton.type = 'button';
  closeButton.prepend(icon('close'));
  closeButton.setAttribute('aria-label', '关闭记忆中枢');
  const content = element('div', 'memory-core-dialog-content');
  header.append(brand, closeButton); dialog.append(header, content); document.body.append(dialog);

  const menuContainer = element('div', 'extension_container'); menuContainer.id = MENU_ID;
  const menuItem = element('button', 'list-group-item flex-container flexGap5 interactable memory-core-menu-entry');
  menuItem.id = ITEM_ID; menuItem.type = 'button'; menuItem.title = '打开记忆中枢';
  menuItem.setAttribute('aria-haspopup', 'dialog'); menuItem.setAttribute('aria-controls', dialog.id);
  const menuIcon = element('i', 'fa-fw fa-solid fa-brain extensionsMenuExtensionButton'); menuIcon.setAttribute('aria-hidden', 'true');
  menuItem.append(menuIcon, element('span', '', '记忆中枢')); menuContainer.append(menuItem);

  let disposed = false; let placeholder; let previousOpen; let wasFloating; let returnFocus;
  function restorePanel() {
    if (!placeholder) return;
    if (placeholder.isConnected) placeholder.replaceWith(panel);
    else if (!disposed) document.body.append(panel);
    panel.classList.remove('memory-core-in-dialog');
    if (wasFloating) panel.classList.add('memory-core-floating');
    drawer.open = previousOpen; placeholder = null;
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    returnFocus = null;
  }
  function closePanel() {
    if (dialog.hasAttribute('open')) {
      if (typeof dialog.close === 'function') dialog.close();
      else dialog.removeAttribute('open');
    }
    restorePanel();
  }
  function openPanel(event) {
    event?.preventDefault(); event?.stopPropagation();
    if (disposed || dialog.hasAttribute('open')) return;
    const menu = document.getElementById('extensionsMenu');
    const menuToggle = document.getElementById('extensionsMenuButton');
    const fromMenu = event?.currentTarget === menuItem;
    returnFocus = fromMenu ? menuToggle : openButton;
    if (fromMenu && menu?.getClientRects().length) {
      if (menuToggle) menuToggle.click(); else menu.style.display = 'none';
    }
    previousOpen = drawer.open; wasFloating = panel.classList.contains('memory-core-floating');
    placeholder = document.createComment('memory-core-panel-home'); panel.replaceWith(placeholder);
    panel.classList.remove('memory-core-floating'); panel.classList.add('memory-core-in-dialog');
    drawer.open = true; content.append(panel);
    try {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else {
        dialog.dataset.fallback = 'true'; dialog.setAttribute('open', '');
        dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true');
      }
      closeButton.focus({ preventScroll: true });
    } catch (error) { restorePanel(); throw error; }
  }
  const onBackdrop = event => {
    if (event.target !== dialog) return;
    const box = dialog.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) closePanel();
  };
  const onKeydown = event => {
    if (dialog.dataset.fallback && event.key === 'Escape') { event.preventDefault(); closePanel(); }
  };
  closeButton.addEventListener('click', closePanel);
  dialog.addEventListener('close', restorePanel);
  dialog.addEventListener('click', onBackdrop); dialog.addEventListener('keydown', onKeydown);
  menuItem.addEventListener('click', openPanel); openButton.addEventListener('click', openPanel);

  function attachMenu() {
    if (disposed) return;
    const menu = document.getElementById('extensionsMenu');
    if (!menu || menuContainer.parentElement === menu) return;
    document.getElementById(MENU_ID)?.remove();
    menu.append(menuContainer);
  }
  attachMenu();
  // Hosts may create or replace their menu after the extension entry has loaded.
  const observer = new MutationObserver(attachMenu);
  observer.observe(document.body, { childList: true, subtree: true });
  return () => {
    if (disposed) return;
    disposed = true; observer.disconnect(); closePanel();
    closeButton.removeEventListener('click', closePanel); dialog.removeEventListener('close', restorePanel);
    dialog.removeEventListener('click', onBackdrop); dialog.removeEventListener('keydown', onKeydown);
    menuItem.removeEventListener('click', openPanel); openButton.removeEventListener('click', openPanel);
    menuContainer.remove(); dialog.remove();
  };
}
