import { bladOperatora } from './bledy.js';
import { odczytajNadpisania } from './dane-reczne.js';
import { stanFaktury } from './faktura-stan.js';
import {
  parsujHurtPozycji, parsujNowaPozycje, parsujEdycjePozycji, roznicePozycji,
  ustawWMapie, oznaczUsunieta, cenaBruttoZPol, wybierzZrodloCeny,
} from './pozycje-reczne.js';
import { nettoWiersza } from './tabela-pozycji.js';
import { STAWKA_VAT, stawkaPozycji, czyStawkaVat } from './vat.js';
import { KLUCZ_WYSYLKI, wysylkaZeSklepu, parsujEdycjeWysylki, rozniceWysylki } from './wysylka-kwota.js';
import { grosze } from './kwoty.js';

/** Porównujemy z pozycją efektywną, także gdy cofamy poprawki ze sklepu. */
export function sprawdzZmianePozycjiPoFakturze(z, przed, po, { przywrocenie = false } = {}) {
  if (stanFaktury(z.faktura) !== 'brak') {
    const zmianaKwoty = przywrocenie || Number(przed.ilosc) !== Number(po.ilosc)
      || grosze(przed.cena_brutto) !== grosze(po.cena_brutto);
    if (zmianaKwoty) {
      throw bladOperatora('Nie można zmienić pozycji po rozpoczęciu wystawiania faktury — zmianę kwoty obsługuje korekta.',
        { kod: 'POZYCJA_PO_FAKTURZE' });
    }
  }
}

/** Reguły U1–U6 dotyczą nowej czynności: usunięcia pozycji sklepowej. */
export function sprawdzUsunieciePozycji(z, klucz, { zwroty = [] } = {}) {
  if (klucz === KLUCZ_WYSYLKI) throw bladOperatora('Nie można usunąć wysyłki — można zmienić jej kwotę.');
  const p = z.pozycje.find((x) => x.klucz === klucz);
  if (!p) throw bladOperatora('Nie ma takiej pozycji w zamówieniu — odśwież kartę.');
  if (p.reczna) return p;
  if (/^p/u.test(klucz)) throw bladOperatora('Nie można usunąć pozycji bez identyfikatora sklepu — poczekaj na synchronizację.');
  if (z.pozycje.some((x) => /^p/u.test(x.klucz))) {
    throw bladOperatora('Zamówienie zawiera pozycję bez identyfikatora sklepu — poczekaj na synchronizację.');
  }
  if (stanFaktury(z.faktura) !== 'brak') {
    throw bladOperatora('Nie można usunąć pozycji po rozpoczęciu wystawiania faktury — zmianę kwoty obsługuje korekta.');
  }
  if (zwroty.some((w) => (w.pozycje ?? []).some((x) => x.klucz_pozycji === klucz))) {
    throw bladOperatora('Nie można usunąć pozycji, która ma zarejestrowany zwrot.');
  }
  if (z.pozycje.filter((x) => x.klucz !== KLUCZ_WYSYLKI).length <= 1) {
    throw bladOperatora('Nie można usunąć ostatniej pozycji zamówienia — dla rezygnacji wybierz „Anuluj”.');
  }
  if (z.scalone_do) throw bladOperatora('Nie można usunąć pozycji zamówienia dołączonego do grupy — otwórz zamówienie główne.');
  return p;
}

// Ta sama reguła co w parsujPozycjeFormularza: ilość i domyślna stawka nie zaczynają wiersza.
const pusteWiersz = (w) => ['nazwa', 'sku', 'cena_netto', 'cena_brutto']
  .every((k) => String(w[k] ?? '').trim() === '');

/** Całe parsowanie przed bazą. Nie zmienia zamówienia ani jego mapy poprawek. */
export function planZapisuPozycji(z, body, {
  stawkaDomyslna = STAWKA_VAT, wdt = false, zw = false, zwolniona = false, zwroty = [],
} = {}) {
  // Firma zwolniona z VAT nie realizuje WDT, tak samo jak dzisiejsza trasa.
  wdt = wdt && !zwolniona;
  const opcje = { stawkaDomyslna, wdt, zw };
  const wynik = { nowe: [], reczneZmiany: [], reczneUsuniete: [],
    mapa: odczytajNadpisania(z.pozycje_reczne_json), zmienione: [], usunieteNazwy: [] };
  const wiersze = parsujHurtPozycji(body);
  const usun = String(body?.usun ?? '');
  if (usun) {
    const p = sprawdzUsunieciePozycji(z, usun, { zwroty });
    if (p.reczna) wynik.reczneUsuniete.push(p.id);
    else wynik.mapa = oznaczUsunieta(wynik.mapa, usun);
    wynik.usunieteNazwy.push(p.nazwa);
  }
  let indeksNowego = 0;
  for (const w of wiersze) {
    if (usun && w.klucz === usun) continue;
    if (w.klucz === '') {
      const indeks = indeksNowego++;
      if (String(body?.usun_nowy ?? '') === String(indeks)) continue;
      if (pusteWiersz(w)) continue;
      const p = parsujNowaPozycje(w, opcje);
      wynik.nowe.push(p);
      wynik.zmienione.push(p.nazwa);
      continue;
    }
    if (w.klucz === KLUCZ_WYSYLKI) {
      const sklep = wysylkaZeSklepu(z);
      const n = rozniceWysylki(sklep, parsujEdycjeWysylki(w, sklep));
      wynik.mapa = ustawWMapie(wynik.mapa, KLUCZ_WYSYLKI, n);
      if (Object.keys(n).length) wynik.zmienione.push('Wysyłka');
      continue;
    }
    const p = z.pozycje.find((x) => x.klucz === w.klucz);
    if (!p) continue; // Formularz sprzed synchronizacji: zachowanie dzisiejszej pętli.
    const stawka = wdt ? '0' : stawkaPozycji(p, stawkaDomyslna, { zw });
    const polaCeny = wybierzZrodloCeny(w, {
      bruttoTeraz: p.cena_brutto, nettoTeraz: nettoWiersza(p, stawka, { zw }),
    });
    if (p.reczna) {
      const bezZmianyStawki = w.vat === undefined || String(w.vat).trim() === '';
      if (bezZmianyStawki && p.vat !== null && p.vat !== undefined && !czyStawkaVat(p.vat, { zw })) {
        throw bladOperatora(`Pozycja „${p.nazwa}” ma stawkę „${p.vat}”, której obecny program fakturowy nie obsługuje`
          + ' — wybierz stawkę w jej wierszu.');
      }
      const { vat, ...bezStawki } = parsujNowaPozycje({ ...w, ...polaCeny, sku: p.sku }, {
        ...opcje, stawkaDomyslna: bezZmianyStawki ? stawkaPozycji(p, stawkaDomyslna, { zw }) : stawkaDomyslna,
      });
      sprawdzZmianePozycjiPoFakturze(z, p, bezStawki);
      wynik.reczneZmiany.push({ id: p.id, pozycja: bezZmianyStawki ? bezStawki : { ...bezStawki, vat } });
      wynik.zmienione.push(p.nazwa);
      continue;
    }
    // Stare formularze i gratisy przechodzą dotychczasową walidację wobec ceny sklepu.
    const cena = String(polaCeny.cena_brutto ?? '').trim() === ''
      ? cenaBruttoZPol(polaCeny, stawka, { wdt, zw }) : polaCeny.cena_brutto;
    const po = parsujEdycjePozycji({ ...w, cena_brutto: cena }, p.sklep);
    sprawdzZmianePozycjiPoFakturze(z, p, po);
    const n = roznicePozycji(p.sklep, po);
    wynik.mapa = ustawWMapie(wynik.mapa, p.klucz, n);
    if (Object.keys(n).length) wynik.zmienione.push(p.sklep.nazwa);
  }
  return wynik;
}
