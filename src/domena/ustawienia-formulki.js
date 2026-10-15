// src/oms/domain/ustawienia-formulki.js
//
// Znaczenie kluczy autorespondera. Tabela `ustawienia` jest glupia (klucz -> tekst); regula
// i wartosci domyslne siedza TUTAJ, zeby dalo sie je przetestowac bez bazy — ten sam podzial,
// co w domain/ustawienia-panelu.js.

// ⚠️ LIMIT ALLEGRO, nie nasz wybor. Odmowa przy ZAPISIE, a nie przy wysylce: przekroczenie
// wychodzi wtedy przy formularzu, gdzie czlowiek moze skrocic tekst, a nie w nocy z czuwacza,
// gdzie skonczyloby sie 400 od Allegro i cisza u kupujacego.
export const MAKS_ZNAKOW_WIADOMOSCI = 2000;

export const KLUCZE = {
  wlaczony: 'formulka.wlaczona',
  tresc: 'formulka.tresc',
  od: 'formulka.od',
  do: 'formulka.do',
  dni: 'formulka.dni',
  karencja: 'formulka.karencja',
};

const DOMYSLNA_KARENCJA_MIN = 10;

function liczba(wartosc, gdyBrak) {
  const n = Number(wartosc);
  return Number.isFinite(n) ? n : gdyBrak;
}

/** Ustawienia w postaci uzywanej przez czuwacz. Pusta baza = autoresponder wylaczony. */
export function ustawieniaFormulki(zapis = {}) {
  return {
    // ⚠️ DOMYSLNIE WYLACZONY. Panel wdrozony bez decyzji czlowieka NIE MOZE zaczac pisac
    // do kupujacych — to jedyna wartosc domyslna w tym module, ktora cos wysyla.
    wlaczona: zapis[KLUCZE.wlaczony] === '1',
    tresc: zapis[KLUCZE.tresc] ?? '',
    odGodziny: liczba(zapis[KLUCZE.od], 18),
    doGodziny: liczba(zapis[KLUCZE.do], 8),
    dni: String(zapis[KLUCZE.dni] ?? '')
      .split(',').map((d) => Number(d)).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6),
    karencjaMin: liczba(zapis[KLUCZE.karencja], DOMYSLNA_KARENCJA_MIN),
  };
}

/**
 * Walidacja formularza z /ustawienia. Oddaje gotowe pary klucz->tekst do `zapiszUstawienia`.
 * ⚠️ Twarde reguly obowiazuja TYLKO przy wlaczaniu: wylaczenie ma przejsc zawsze, zeby
 * dalo sie zgasic autoresponder, ktorego tresc wlasnie okazala sie zla.
 */
export function sprawdzFormularz(pola = {}) {
  const wlaczona = pola.wlaczona === 'on' || pola.wlaczona === '1' || pola.wlaczona === true;
  const tresc = String(pola.tresc ?? '');
  const od = liczba(pola.od, NaN);
  const doG = liczba(pola.do, NaN);
  const dni = (Array.isArray(pola.dni) ? pola.dni : [pola.dni])
    .filter((d) => d !== undefined && d !== null && d !== '')
    .map((d) => Number(d))
    .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
  const karencja = liczba(pola.karencja, NaN);

  if (tresc.length > MAKS_ZNAKOW_WIADOMOSCI) {
    return { ok: false, blad: `Formułka ma ${tresc.length} znaków, a Allegro przyjmuje najwyżej ${MAKS_ZNAKOW_WIADOMOSCI}.` };
  }
  if (!Number.isInteger(od) || od < 0 || od > 23 || !Number.isInteger(doG) || doG < 0 || doG > 23) {
    return { ok: false, blad: 'Godziny muszą być liczbami od 0 do 23.' };
  }
  if (!Number.isInteger(karencja) || karencja < 0) {
    return { ok: false, blad: 'Karencja musi być liczbą minut, nie mniejszą od zera.' };
  }
  if (wlaczona && tresc.trim() === '') {
    return { ok: false, blad: 'Włączony autoresponder musi mieć treść formułki.' };
  }
  if (wlaczona && dni.length === 0) {
    return { ok: false, blad: 'Zaznacz przynajmniej jeden dzień, w którym formułka ma wychodzić.' };
  }

  return {
    ok: true,
    wartosci: {
      [KLUCZE.wlaczony]: wlaczona ? '1' : '0',
      [KLUCZE.tresc]: tresc,
      [KLUCZE.od]: String(od),
      [KLUCZE.do]: String(doG),
      [KLUCZE.dni]: dni.join(','),
      [KLUCZE.karencja]: String(karencja),
    },
  };
}
