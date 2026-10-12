import { linkParts } from '/sheet.js';

export const FARAH = 'Farah';

export function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

export function day(value) {
  if (!value) return null;
  return new Date(value).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

export function dayTime(value) {
  if (!value) return null;
  const at = new Date(value);
  return `${day(value)} · ${at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
}

export function linkedText(node, text) {
  for (const part of linkParts(text)) {
    if (!part.href) {
      node.append(document.createTextNode(part.text));
      continue;
    }
    const a = el('a', part.text, null);
    a.href = part.href;
    a.rel = 'noopener noreferrer';
    node.append(a);
  }
  return node;
}

export function dollars(amount) {
  const n = Number(amount);
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}
