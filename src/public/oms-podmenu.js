// Odczyt w nagłówku przed malowaniem. Bez JS listy pozostają rozwinięte.
(() => {
  const stany = {};
  const kluczZapisu = klucz => `oms-podmenu-${klucz}`;
  const nazwaStanu = klucz => `podmenu${klucz[0].toUpperCase()}${klucz.slice(1)}`;
  for (const klucz of ['zamowienia', 'magazyn', 'faktury', 'analityka']) {
    let zapis;
    try { zapis = localStorage.getItem(kluczZapisu(klucz)); } catch { /* stan domyślny */ }
    stany[klucz] = zapis === 'true' || zapis === 'false' ? zapis : 'domyslny';
    document.documentElement.dataset[nazwaStanu(klucz)] = stany[klucz];
  }
  document.addEventListener('DOMContentLoaded', () => {
    const przyciski = [...document.querySelectorAll('button[data-podmenu]')];
    function ustaw(klucz, otwarte) {
      for (const przycisk of przyciski.filter(p => p.dataset.podmenu === klucz)) {
        przycisk.setAttribute('aria-expanded', String(otwarte));
        document.getElementById(przycisk.getAttribute('aria-controls')).hidden = !otwarte;
      }
      document.documentElement.dataset[nazwaStanu(klucz)] = String(otwarte);
    }
    for (const przycisk of przyciski) {
      const klucz = przycisk.dataset.podmenu;
      ustaw(klucz, stany[klucz] === 'domyslny' ? przycisk.getAttribute('aria-expanded') === 'true' : stany[klucz] === 'true');
      przycisk.hidden = false;
      przycisk.addEventListener('click', () => {
        const otwarte = przycisk.getAttribute('aria-expanded') !== 'true';
        ustaw(klucz, otwarte);
        try { localStorage.setItem(kluczZapisu(klucz), String(otwarte)); } catch { /* działa bez zapisu */ }
      });
    }
  });
})();
