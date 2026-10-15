import { daneSpecyfikacji } from './specyfikacja.js';
import { adresOdbiorcy } from './adres-odbiorcy.js';
import { punktOdbioru } from './wysylka.js';
import { fmtDataCzasKrotko } from './format-daty.js';

// „Zestawienie zamówień" (PRZ-084) — wydruk WEWNETRZNY na wzor „order-shipping" z Apilo:
// zamowienia jedno pod drugim, kazde z danymi wysylki, pozycjami z cenami, kwota i uwagami
// klienta. Decyzja właściciela 15.10: dane osobowe w pelni, jak w Apilo (imie, adres/paczkomat,
// telefon, e-mail) — to kartka dla pakujacego, nie dla klienta.
//
// ⚠️ TEN MODUL NIE LICZY ZADNEJ KWOTY. Pozycje, wysylka, razem, platnosc i uwagi ida
// z `daneSpecyfikacji` — tej samej funkcji, ktora sklada kartke wkladana do paczki, a ta
// liczy wszystko funkcjami karty i faktury. Zestawienie i specyfikacja tego samego zamowienia
// nie maja prawa pokazac dwoch roznych kwot.
//
// ⚠️ Adres WYLACZNIE przez `adresOdbiorcy` (reczna poprawka na karcie wygrywa), a paczkomat
// przez `punktOdbioru` (nadpisanie wygrywa) — to ten sam adres, na ktory panel nadaje paczke.
// Wydruk z adresem sprzed poprawki wyslalby pakujacego z paczka pod zly adres.

/** Linie bloku „Dane wysyłki" — tylko niepuste, w kolejnosci z wydruku Apilo. */
function linieWysylki(z) {
  const a = adresOdbiorcy(z);
  const punkt = punktOdbioru(z);
  return [
    a.nazwa,
    a.company && a.company !== a.nazwa ? a.company : null,
    punkt ? `Paczkomat ${punkt}` : null,
    a.ulica,
    [a.kod, a.miasto].filter(Boolean).join(' '),
    a.kraj,
    a.phone,
    a.email,
  ].map((l) => String(l ?? '').trim()).filter(Boolean);
}

/**
 * @param {object} z - zamowienie (wiersz `zLinii`, z nalozonymi nadpisaniami)
 * @param {{ kanal?: string, klienciWdt?: Set<string> }} opts - `kanal` to etykieta kanalu
 *   dla czlowieka (sklada wolajacy z definicji kanalow — nazwy kanalow nie mieszkaja w kodzie)
 */
export function daneZestawienia(z, { kanal = '', klienciWdt = new Set() } = {}) {
  const s = daneSpecyfikacji(z, { sprzedawca: null, klienciWdt });
  const pozycje = s.pozycje.map((p) => ({
    nazwa: p.nazwa, sku: p.symbol, ilosc: p.ilosc, cenaZl: p.cenaZl, wartoscZl: p.wartoscZl,
  }));
  // Wysylka jako OSTATNI WIERSZ tabeli (jak w Apilo), z kwota liczona przez specyfikacje.
  // Wiersz stoi takze przy 0,00 („Kurier DPD (darmowa wysyłka)") — pakujacy ma widziec,
  // czym jedzie paczka; nie ma go tylko wtedy, gdy zamowienie nie zna ani metody, ani kosztu.
  if (s.dostawa || Number(s.dostawaZl)) {
    pozycje.push({
      nazwa: s.dostawa || 'Wysyłka', sku: '', ilosc: 1, cenaZl: s.dostawaZl, wartoscZl: s.dostawaZl,
    });
  }
  return {
    numer: String(z?.numer ?? ''),
    kanal: String(kanal ?? ''),
    numerWKanale: z?.zrodlo_id != null ? String(z.zrodlo_id) : '',
    platnosc: s.platnosc ?? '',
    dataZamowienia: fmtDataCzasKrotko(z?.utworzone_at ?? ''),
    fakturaWybrana: s.fakturaWybrana,
    wysylka: linieWysylki(z),
    pozycje,
    razemZl: s.razemZl,
    uwagiKlienta: s.uwagiKlienta,
  };
}
