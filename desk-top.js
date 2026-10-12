const button = document.createElement('button');
button.type = 'button';
button.className = 'totop';
button.textContent = '↑ Top';
button.hidden = true;
button.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
(document.querySelector('main') || document.body).append(button);

const SHOWN_PAST = 600;
const place = () => { button.hidden = window.scrollY < SHOWN_PAST; };
window.addEventListener('scroll', place, { passive: true });
place();
