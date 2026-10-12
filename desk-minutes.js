import { el, get } from '/desk-ui.js';

function minutes(seconds) {
  if (seconds < 60) return `${seconds} sec`;
  const m = Math.round(seconds / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} hr ${m % 60} min`;
}

export async function renderMinutes() {
  const box = document.getElementById('minutes');
  const said = document.getElementById('minutessaid');
  box.textContent = '';
  box.hidden = true;
  try {
    const data = await get('time');
    document.getElementById('minutesdays').textContent = `Last ${data.days} days`;
    if (!data.steps.length) {
      said.textContent = 'Nothing timed yet.';
      return;
    }
    said.textContent = `${data.people} ${data.people === 1 ? 'person' : 'people'}, `
      + `${minutes(data.total)} in all, about `
      + `${minutes(Math.round(data.total / Math.max(1, data.people)))} each.`;
    const steps = [...data.steps].sort((a, b) => b.total - a.total);
    const most = Math.max(1, steps[0].total);
    for (const step of steps) {
      const bar = el('div', null, 'bar');
      const head = el('div', null, 'bl');
      const what = el('span', step.label);
      if (step.demo) what.append(' ', el('span', 'Demo', 'tag t-demo'));
      head.append(what, el('b', minutes(step.total)));
      const track = el('div', null, 'track');
      const fill = el('i');
      fill.style.width = `${(step.total / most) * 100}%`;
      track.append(fill);
      bar.append(head, track,
        el('small', `${step.times} ${step.times === 1 ? 'time' : 'times'} · typically ${minutes(step.typical)}`));
      box.append(bar);
    }
    box.hidden = false;
  } catch (error) {
    said.textContent = error.message;
  }
}
