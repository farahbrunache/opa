export function alwaysUpperCase(field) {
  if (!field) return;

  const raise = () => {
    const was = field.value;
    const now = was.toUpperCase();
    if (now === was) return;

    const start = field.selectionStart;
    const end = field.selectionEnd;
    field.value = now;
    if (now.length === was.length && start !== null) {
      try {
        field.setSelectionRange(start, end);
      } catch {
      }
    }
  };

  field.addEventListener('input', raise);
  raise();
}

export function codeFields(ids) {
  for (const id of ids) alwaysUpperCase(document.getElementById(id));
}
