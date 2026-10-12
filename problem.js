export class Problem extends Error {
  constructor(said, report, status) {
    super(said);
    this.report = report;
    this.status = status;
  }
}

function stamp(at) {
  const when = at ? new Date(at) : new Date();
  return `${when.toISOString().replace('T', ' ').slice(0, 19)} UTC`;
}

function reportLine(parts) {
  return `For a report: ${parts.filter(Boolean).join(' · ')}`;
}

export async function call(url, options = {}, doing = 'Loading this page') {
  const action = new URL(url, window.location.href).searchParams.get('action');
  let response;
  try {
    response = await fetch(url, options);
  } catch (error) {
    throw new Problem(
      `${doing} didn't work. This device couldn't reach app.farahbrunache.com. It may be offline `
        + 'or on a weak signal, or the site may be restarting. Check the connection and try again '
        + 'in a minute.',
      reportLine(['no response', action, `the browser said "${error.message}"`, stamp()]),
      0,
    );
  }

  const text = await response.text().catch(() => '');
  let data = null;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = null;
  }
  const ref = data?.ref || response.headers.get('x-request-ref');

  if (!response.ok) {
    const why = data?.error
      || (response.status >= 500
        ? 'The server hit a problem and sent back no explanation.'
        : 'The server refused it and sent back no explanation.');
    throw new Problem(
      `${doing} didn't work. ${why}`,
      reportLine([ref && `ref ${ref}`, `HTTP ${response.status}`, data?.action || action, stamp(data?.at)]),
      response.status,
    );
  }
  if (data === null) {
    throw new Problem(
      `${doing} didn't work. The server answered, but not in a form this page can read. Reload `
        + 'the page and try again.',
      reportLine([ref && `ref ${ref}`, `HTTP ${response.status}`, action,
        `it sent ${response.headers.get('content-type') || 'no content type'}`, stamp()]),
      response.status,
    );
  }
  return data;
}

export function asProblem(error, doing = 'This page') {
  if (error instanceof Problem) return error;
  return new Problem(
    `${doing} didn't work. The page itself broke: ${error?.message || error}. Reload the page and `
      + 'try again.',
    reportLine(['page error', error?.name, stamp()]),
    0,
  );
}

export function localProblem(said, action, detail) {
  return new Problem(said, reportLine(['ref —', 'HTTP —', action, detail, stamp()]), 0);
}

export function showProblem(box, error, doing) {
  const problem = asProblem(error, doing);
  box.hidden = false;
  box.className = 'msg bad';
  box.textContent = '';
  const said = document.createElement('p');
  said.textContent = problem.message;
  const report = document.createElement('p');
  report.className = 'report';
  report.textContent = problem.report;
  box.append(said, report);
  console.error('[one-percent]', problem.message, problem.report, error);
}
