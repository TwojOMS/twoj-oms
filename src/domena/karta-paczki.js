// KARTA PACZKI (PRZ-152.G8) — co pokazuje jedna paczka w sekcji „Przesyłka” karty zamówienia.
// Układ zatwierdzony przez właściciela 04.11 („Tak, układ OK”):
//   wiersz 1: „Paczka N” · plakietka przewoźnika · JEDEN status etapu · akcje;
//   wiersz 2: numer listu (link do śledzenia) + „kopiuj numer”;
//   wiersz 3: ostatnie zdarzenie kuriera — `opis · dziś 17:18`, bez nawiasu z sekundami;
//   wiersz 4: „Do: …” — adres FAKTYCZNIE użyty przy nadaniu (kod paczkomatu przy paczkomacie),
//             kraj tylko, gdy inny niż PL;
//   stopka:   „Nadana dziś 14:00 · etykieta wydrukowana 14:00 · status sprawdzony 21:14”.
// Widok niczego tu nie liczy — dostaje gotowe napisy. Dane i reguły (stan, etap, przewoźnik)
// biorą się z tych samych funkcji domeny, co reszta panelu; ten moduł tylko je składa.

import { etapPrzesylki, etykietaEtapu, dniKalendarzowe } from './etap-przesylki.js';
import { fmtKiedy, dzienWarszawa, fmtDataCzasKrotko } from './format-daty.js';
import { przewoznikPaczki } from './przewoznik-przesylki.js';
import { adresOdbiorcy } from './adres-odbiorcy.js';
import { metodaKuriera } from './moduly-kurierow.ts';

// „Paczkomat X” tylko przy metodzie paczkomatowej z rejestru kurierów (formularz `paczkomat`) i przy
// paczkomacie zamówionym na Allegro; inny punkt (ORLEN, DHL BOX, One Box) to „Punkt odbioru X”.
// Bez literału kuriera — nazwy kurierów żyją w rejestrze (strażnik kurierów).
const czyPaczkomat = (metoda) => metoda === 'allegro_paczkomat' || metodaKuriera(metoda)?.formularz === 'paczkomat';

// Stany sprzed numeru listu (przesylka-stan.js) — jeden status zamiast surowego kodu.
const NAZWY_STANOW = {
  w_trakcie: 'Nadanie trwa',
  tworzona_u_kuriera: 'Tworzona u kuriera',
  zawieszona: 'Nadanie zawieszone',
  do_wyjasnienia: 'Do wyjaśnienia',
  blad: 'Błąd nadania',
};
const STANY_ZLE = new Set(['zawieszona', 'do_wyjasnienia', 'blad']);

/**
 * Jeden status paczki: przy nadanej — etap z opisu kuriera („W drodze (dziś)”, „Doręczona”…),
 * bez zdarzeń — „Nadana”; przed numerem listu — nazwa stanu.
 * @returns {{ tekst: string, klasa: string }}
 */
export function statusPaczki(p, stan, teraz = new Date()) {
  if (stan === 'nadana') {
    const etap = etapPrzesylki(p?.status_kuriera);
    const tekst = etap ? etykietaEtapu(etap, dniKalendarzowe(p?.utworzona_at, teraz.toISOString())) : null;
    if (tekst) return { tekst, klasa: `pastylka pastylka--etap-${etap}` };
    return { tekst: 'Nadana', klasa: 'znacznik znacznik--wyslane' };
  }
  return {
    tekst: NAZWY_STANOW[stan] ?? String(stan ?? ''),
    klasa: STANY_ZLE.has(stan) ? 'znacznik znacznik--w-realizacji' : 'znacznik',
  };
}

/** Plakietka przewoźnika jak w Szczegółach; przy drodze przez Allegro dopisek „· Allegro”. */
export function plakietkaPaczki(p, z) {
  const przewoznik = przewoznikPaczki(p, z);
  if (!przewoznik) return null;
  const przezAllegro = String(p?.kurier ?? '').startsWith('allegro');
  return { klucz: przewoznik.klucz, napis: przezAllegro ? `${przewoznik.nazwa} · Allegro` : przewoznik.nazwa };
}

const tekst = (v) => (v == null ? '' : String(v).trim());
const krajPL = (k) => tekst(k).toUpperCase() || 'PL';

function odczytajAdresUzyty(json) {
  if (!json) return null;
  try {
    const a = JSON.parse(json);
    return a && typeof a === 'object' ? a : null;
  } catch {
    return null;
  }
}

// Te same pola, co dawna linia „Adres użyty przy nadaniu”, plus punkt odbioru.
const POLA_POROWNANIA = ['nazwa', 'ulica', 'kod', 'miasto', 'kraj', 'punkt_odbioru'];
const doPorownania = (a) => Object.fromEntries(POLA_POROWNANIA.map((k) => [k, k === 'kraj' ? krajPL(a?.[k]) : tekst(a?.[k])]));

/**
 * Wiersz „Do:” — adres użyty przy TYM nadaniu (operator mógł go poprawić na ekranie nadania),
 * a dla paczek sprzed kolumny `adres_uzyty` — adres z zamówienia. `inny` = różni się od adresu
 * zamówienia (zastępuje dawną osobną linię „Adres użyty przy nadaniu”).
 * @returns {{ tekst: string, inny: boolean }}
 */
export function adresPaczki(p, z) {
  const zamowienia = { ...adresOdbiorcy(z), punkt_odbioru: z?.punkt_odbioru ?? null };
  const uzyty = odczytajAdresUzyty(p?.adres_uzyty);
  const a = uzyty ?? zamowienia;
  const nazwa = tekst(a.nazwa);
  const firma = tekst(a.company);
  const kraj = krajPL(a.kraj);
  const punkt = tekst(a.punkt_odbioru);
  let czesci;
  if (punkt) {
    czesci = [`${czyPaczkomat(z?.metoda_wysylki) ? 'Paczkomat' : 'Punkt odbioru'} ${punkt}`, nazwa];
  } else {
    const miejscowosc = [tekst(a.kod), tekst(a.miasto)].filter(Boolean).join(' ');
    czesci = [firma && firma !== nazwa ? firma : '', nazwa, tekst(a.ulica), miejscowosc];
  }
  if (kraj !== 'PL') czesci.push(kraj);
  const inny = Boolean(uzyty)
    && JSON.stringify(doPorownania(uzyty)) !== JSON.stringify(doPorownania(zamowienia));
  return { tekst: czesci.filter(Boolean).join(', '), inny };
}

/** Ostatnie zdarzenie kuriera: `opis · dziś 17:18`; „brak zdarzeń”, gdy sprawdzone bez wyniku. */
export function zdarzeniePaczki(p, teraz = new Date()) {
  if (p?.status_kuriera || p?.status_kuriera_at) {
    const kiedy = fmtKiedy(p.status_kuriera_at, teraz);
    return [p.status_kuriera || 'zdarzenie bez opisu', kiedy].filter(Boolean).join(' · ');
  }
  return p?.status_kuriera_pobrany_at ? 'brak zdarzeń' : null;
}

/**
 * Stopka: kiedy nadana, wydruk etykiety, ostatnie sprawdzenie statusu. Czas tego samego dnia,
 * co nadanie, bez powtarzania dnia („Nadana dziś 14:00 · etykieta wydrukowana 14:00”).
 * @returns {{ tekst: string, zle: boolean }[]}
 */
export function stopkaPaczki(p, kol, teraz = new Date()) {
  const dzienNadania = dzienWarszawa(p?.utworzona_at);
  const kiedy = (w) => {
    if (!w) return '';
    return dzienNadania && dzienWarszawa(w) === dzienNadania ? fmtDataCzasKrotko(w).slice(11, 16) : fmtKiedy(w, teraz);
  };
  const czesci = [];
  const nadana = fmtKiedy(p?.utworzona_at, teraz);
  if (nadana) czesci.push({ tekst: `Nadana ${nadana}`, zle: false });
  if (kol?.status === 'oczekuje') czesci.push({ tekst: 'czeka na wydruk', zle: false });
  else if (kol?.status === 'wydrukowano') czesci.push({ tekst: `etykieta wydrukowana ${kiedy(kol.wydrukowane_at)}`.trim(), zle: false });
  else if (kol?.status === 'porzucone') czesci.push({ tekst: 'wydruk porzucony', zle: true });
  if (p?.status_kuriera_blad) {
    czesci.push({ tekst: `status niedostępny (ostatnia próba ${kiedy(p.status_kuriera_pobrany_at)})`, zle: true });
  } else if (p?.status_kuriera_pobrany_at) {
    czesci.push({ tekst: `status sprawdzony ${kiedy(p.status_kuriera_pobrany_at)}`, zle: false });
  }
  return czesci;
}

/** Wszystko, co karta paczki pokazuje (poza akcjami i ostrzeżeniami, które zostają w widoku). */
export function kartaPaczki({ p, z, stan, kol, teraz = new Date() }) {
  const plakietka = plakietkaPaczki(p, z);
  return {
    plakietka,
    status: statusPaczki(p, stan, teraz),
    zdarzenie: p?.numer_listu ? zdarzeniePaczki(p, teraz) : null,
    adres: adresPaczki(p, z),
    stopka: p?.numer_listu ? stopkaPaczki(p, kol, teraz) : [],
  };
}
