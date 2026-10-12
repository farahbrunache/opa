const OWNER_PAGES = ['desk.html', 'money.html', 'funnel.html', 'questions.html'];

export function noExplainers({ ROOT, read, fail }) {
  for (const page of OWNER_PAGES) {
    const html = read(`${ROOT}/${page}`);
    if (/class="hint"/.test(html)) {
      fail('explainer', `${page} class="hint"`);
    }
    if (/class="lede"/.test(html)) {
      fail('explainer', `${page} class="lede"`);
    }
    for (const [, text] of html.matchAll(/<p class="(?:meta|note|empty)">([^<]*\S[^<]*)<\/p>/g)) {
      fail('explainer', `${page} "${text.trim().slice(0, 60)}"`);
    }
  }
}
