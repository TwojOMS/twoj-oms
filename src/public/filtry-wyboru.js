// Listy wielokrotnego wyboru nad tabelą zamówień (lista.ejs). Bez tego skryptu wszystko działa —
// to zwykłe pola wyboru w formularzu GET. Skrypt dokłada tylko wygodę: podsumowanie
// („3 wybrane”) zmienia się przy klikaniu, a nie dopiero po „Filtruj”, lista zamyka się
// kliknięciem obok albo klawiszem Escape.
const pola = [...document.querySelectorAll('details.wybor-filtra')];

// Ta sama odmiana, co w podsumowaniu składanym przez serwer (domena/filtry-listy.js).
export function ileWybranych(n) {
  const d = n % 10; const s = n % 100;
  return `${n} ${d >= 2 && d <= 4 && !(s >= 12 && s <= 14) ? 'wybrane' : 'wybranych'}`;
}

function podsumuj(pole) {
  const zaznaczone = [...pole.querySelectorAll('input[type="checkbox"]:checked')];
  const tekst = pole.querySelector('.wybor-filtra-tekst');
  if (!tekst) return;
  tekst.textContent = !zaznaczone.length ? (pole.dataset.wszystkie || 'Wszystkie')
    : zaznaczone.length === 1 ? zaznaczone[0].dataset.etykieta : ileWybranych(zaznaczone.length);
  tekst.classList.toggle('wybor-filtra-tekst--wybrane', zaznaczone.length > 0);
}

if (pola.length) {
  document.addEventListener('change', (e) => {
    const pole = e.target instanceof Element ? e.target.closest('details.wybor-filtra') : null;
    if (pole) podsumuj(pole);
  });
  document.addEventListener('click', (e) => {
    for (const pole of pola) if (pole.open && !pole.contains(/** @type {Node} */ (e.target))) pole.open = false;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const otwarte = pola.find((p) => p.open);
    if (!otwarte) return;
    otwarte.open = false;
    otwarte.querySelector('summary')?.focus();
  });
}
