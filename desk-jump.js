let links = [];
let sections = [];

function mark() {
  const line = (document.querySelector('.jump')?.getBoundingClientRect().bottom || 0) + 8;
  let current = 0;
  sections.forEach((section, i) => {
    if (section && section.getBoundingClientRect().top <= line) current = i;
  });
  links.forEach((a, i) => a.classList.toggle('on', i === current));
}

export function watchJumps() {
  const top = [...document.querySelectorAll('.topbar')].find((bar) => bar.offsetParent !== null);
  if (top) document.documentElement.style.setProperty('--topbar-height', `${top.getBoundingClientRect().height}px`);
  links = [...document.querySelectorAll('.jump a[href^="#"]')];
  sections = links.map((a) => document.getElementById(a.getAttribute('href').slice(1)));
  mark();
}

window.addEventListener('scroll', mark, { passive: true });
