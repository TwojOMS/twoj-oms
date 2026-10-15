export function podlaczMenu(root = document) {
  const menu = [...root.querySelectorAll('details[data-menu]')];

  const zamknijPozostale = (otwarte) => {
    if (!otwarte.open) return;
    for (const element of menu) if (element !== otwarte) element.open = false;
  };
  const zamknijPoza = (event) => {
    if (menu.some((element) => element.contains(event.target))) return;
    for (const element of menu) element.open = false;
  };
  const zamknijEscape = (event) => {
    if (event.key !== 'Escape') return;
    const otwarte = menu.find((element) => element.open);
    if (!otwarte) return;
    otwarte.open = false;
    otwarte.querySelector('summary')?.focus();
    event.preventDefault();
  };

  const obslugaOtwarcia = new Map(menu.map((element) => [
    element, () => zamknijPozostale(element),
  ]));
  for (const element of menu) element.addEventListener('toggle', obslugaOtwarcia.get(element));
  root.addEventListener('click', zamknijPoza);
  root.addEventListener('keydown', zamknijEscape);

  return () => {
    root.removeEventListener('click', zamknijPoza);
    root.removeEventListener('keydown', zamknijEscape);
    for (const element of menu) element.removeEventListener('toggle', obslugaOtwarcia.get(element));
  };
}

if (typeof document !== 'undefined') podlaczMenu(document);
