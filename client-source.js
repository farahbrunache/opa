const here = new URL(window.location.href);
const id = here.searchParams.get('id') || '';

export const PREVIEW = here.pathname === '/preview';
export const RECORD = `/desk?id=${encodeURIComponent(id)}`;

export function readFrom(part, extra = '') {
  return PREVIEW
    ? `/api/desk?action=client-preview&id=${encodeURIComponent(id)}&part=${part}${extra}`
    : `/api/client?action=${part}${extra}`;
}

function still(root) {
  for (const node of root.querySelectorAll('button, input, textarea, select')) {
    if (!node.closest('[data-read]')) node.disabled = true;
  }
  for (const node of root.querySelectorAll('form, .cstep')) node.inert = true;
  for (const node of root.querySelectorAll('a[href]')) {
    if (node.closest('[data-read]') || node.getAttribute('href').startsWith('#')) continue;
    node.removeAttribute('href');
    node.setAttribute('aria-disabled', 'true');
  }
}

export function freeze(root) {
  still(root);
  new MutationObserver(() => still(root)).observe(root, { childList: true, subtree: true });
}
