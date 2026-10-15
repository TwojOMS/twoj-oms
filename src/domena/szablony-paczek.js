import { liczbaDodatnia } from './paczka.js';

// Te wartości były dotąd zapisane osobno pod paczka.*. Brak nowego JSON-u musi
// odtworzyć dokładnie tę samą paczkę, także gdy tylko jedno stare pole jest złe.
export const PACZKA_DOMYSLNA = { waga: 1, dlugosc: 110, szerokosc: 75, wysokosc: 1 };
const POLA = Object.keys(PACZKA_DOMYSLNA);
const KLUCZ = 'paczka.szablony';
const LIMIT = 30;

function legacyPaczka(zapis) {
  return Object.fromEntries(POLA.map((pole) => [
    pole, liczbaDodatnia(zapis[`paczka.${pole}`]) ?? PACZKA_DOMYSLNA[pole],
  ]));
}

function stanLegacy(zapis) {
  return {
    domyslnyId: 'domyslna',
    szablony: [{ id: 'domyslna', nazwa: 'Paczka domyślna', ...legacyPaczka(zapis) }],
  };
}

function poprawnyStan(stan) {
  if (stan?.version !== 1 || !Array.isArray(stan.szablony)
    || !stan.szablony.length || stan.szablony.length > LIMIT) return false;
  const ids = new Set();
  const nazwy = new Set();
  for (const s of stan.szablony) {
    if (typeof s?.id !== 'string' || !s.id || ids.has(s.id)
      || typeof s.nazwa !== 'string' || !s.nazwa.trim() || s.nazwa.length > 60) return false;
    const nazwa = s.nazwa.trim().toLocaleLowerCase('pl');
    if (nazwy.has(nazwa) || POLA.some((pole) => typeof s[pole] !== 'number' || !Number.isFinite(s[pole]) || s[pole] <= 0)) return false;
    ids.add(s.id);
    nazwy.add(nazwa);
  }
  return ids.has(stan.domyslnyId);
}

/** Brak/uszkodzenie JSON-u nie może zmienić gabarytu na zero ani ukryć paczki. */
export function odczytajSzablony(zapis = {}) {
  try {
    const stan = JSON.parse(zapis[KLUCZ]);
    if (poprawnyStan(stan)) return { domyslnyId: stan.domyslnyId, szablony: stan.szablony };
  } catch { /* stary zapis albo uszkodzony wiersz — wróć do czterech pól */ }
  return stanLegacy(zapis);
}

/** JSON i stare cztery klucze trafiają do jednej transakcji zapiszUstawienia(). */
export function zapiszSzablony(stan) {
  const domyslny = stan.szablony.find((s) => s.id === stan.domyslnyId);
  if (!domyslny) throw new Error('Brak domyślnego szablonu paczki');
  return {
    [KLUCZ]: JSON.stringify({ version: 1, domyslnyId: stan.domyslnyId, szablony: stan.szablony }),
    ...Object.fromEntries(POLA.map((pole) => [`paczka.${pole}`, String(domyslny[pole])])),
  };
}

function odmowa(tekst) { return { bledy: [tekst] }; }

/** Dodanie (`noweId`) albo edycja (`dane.id`) bez zmiany pozostałych szablonów. */
export function zmienSzablon(stan, dane = {}, noweId = null) {
  const id = String(dane.id ?? noweId ?? '').trim();
  const indeks = stan.szablony.findIndex((s) => s.id === id);
  if (!id) return odmowa('Brak identyfikatora szablonu.');
  if (dane.id != null && indeks < 0) return odmowa('Nie ma takiego szablonu paczki.');
  if (dane.id == null && indeks >= 0) return odmowa('Ten szablon już istnieje.');
  if (indeks < 0 && stan.szablony.length >= LIMIT) return odmowa(`Można zapisać najwyżej ${LIMIT} szablonów paczek.`);

  const nazwa = String(dane.nazwa ?? '').trim();
  const bledy = [];
  if (!nazwa || nazwa.length > 60) bledy.push('Nazwa szablonu musi mieć od 1 do 60 znaków.');
  if (stan.szablony.some((s) => s.id !== id && s.nazwa.trim().toLocaleLowerCase('pl') === nazwa.toLocaleLowerCase('pl'))) {
    bledy.push('Szablon o tej nazwie już istnieje.');
  }
  const paczka = {};
  for (const pole of POLA) {
    const liczba = liczbaDodatnia(dane[pole]);
    if (liczba === null) bledy.push(`${pole} — wpisz liczbę większą od zera.`);
    else paczka[pole] = liczba;
  }
  if (bledy.length) return { bledy };
  const szablony = [...stan.szablony];
  const szablon = { id, nazwa, ...paczka };
  if (indeks >= 0) szablony[indeks] = szablon;
  else szablony.push(szablon);
  return { stan: { ...stan, szablony }, bledy: [] };
}

export function ustawDomyslnySzablon(stan, id) {
  if (!stan.szablony.some((s) => s.id === id)) return odmowa('Nie ma takiego szablonu paczki.');
  return { stan: { ...stan, domyslnyId: id }, bledy: [] };
}

export function usunSzablon(stan, id) {
  if (id === stan.domyslnyId) return odmowa('Nie można usunąć domyślnego szablonu paczki.');
  if (!stan.szablony.some((s) => s.id === id)) return odmowa('Nie ma takiego szablonu paczki.');
  return { stan: { ...stan, szablony: stan.szablony.filter((s) => s.id !== id) }, bledy: [] };
}
