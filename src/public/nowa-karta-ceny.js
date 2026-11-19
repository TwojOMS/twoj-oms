// Ceny w formularzu „Nowy produkt”: netto ↔ brutto po stawce VAT i podgląd marży na żywo.
//
// Skrypt NIE liczy sam. Arytmetykę bierze z modułu domeny, którym serwer zapisuje cenę
// (adres w `data-ceny` formularza, serwowany pod /public/domena/), więc podgląd i zapis nie mają
// jak się rozjechać. Bez JavaScriptu formularz działa dalej: serwer liczy brutto z netto sam.

const ID = {
  zakup: 'nowa-zakup',
  netto: 'nowa-netto',
  brutto: 'nowa-cena',
  vat: 'nowa-vat',
  pomoc: 'nowa-netto-pomoc',
  marza: 'nowa-marza',
};

/**
 * @param {Document} dokument
 * @param {{ polaCenyPoZmianie: Function, podgladMarzy: Function }} ceny — moduł domeny.
 */
export function podepnij(dokument, ceny) {
  const el = Object.fromEntries(Object.entries(ID).map(([klucz, id]) => [klucz, dokument.getElementById(id)]));
  if (!el.netto || !el.brutto || !el.vat) return;
  // Pole wpisane ostatnio — od niego liczy zmiana stawki.
  let zrodlo = '';

  const odswiez = (cel) => {
    const bezStawki = el.vat.value === '';
    // Bez stawki netto nie ma z czego liczyć; nieaktywne pole nie jedzie też do serwera,
    // więc zostaje brutto, a serwer nie odmówi „netto bez VAT”.
    el.netto.disabled = bezStawki;
    if (el.pomoc) el.pomoc.hidden = !bezStawki;
    if (!bezStawki) {
      const pola = ceny.polaCenyPoZmianie({
        netto: el.netto.value,
        brutto: el.brutto.value,
        stawka: el.vat.value,
        zrodlo,
      });
      // Pola, w którym człowiek właśnie pisze, nie nadpisujemy.
      if (cel !== el.netto && el.netto.value !== pola.netto) el.netto.value = pola.netto;
      if (cel !== el.brutto && el.brutto.value !== pola.brutto) el.brutto.value = pola.brutto;
    }
    if (el.marza)
      el.marza.textContent =
        ceny.podgladMarzy({ netto: bezStawki ? '' : el.netto.value, zakup: el.zakup?.value ?? '' }) ?? '';
  };

  el.netto.addEventListener('input', (e) => {
    zrodlo = 'netto';
    odswiez(e.target);
  });
  el.brutto.addEventListener('input', (e) => {
    zrodlo = 'brutto';
    odswiez(e.target);
  });
  el.vat.addEventListener('change', () => odswiez(null));
  el.zakup?.addEventListener('input', () => odswiez(null));
  odswiez(null);
}

if (typeof document !== 'undefined') {
  const adres = document.querySelector('form[data-ceny]')?.dataset.ceny;
  if (adres) import(adres).then((ceny) => podepnij(document, ceny));
}
