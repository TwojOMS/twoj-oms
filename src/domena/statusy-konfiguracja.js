import { ETYKIETY } from './status.js';

// Historyczne rodziny barw. Szary po zapisie dostaje czytelniejszy tekst (WCAG 4,5:1).
export const PALETA_STATUSOW = {
  niebieski: { etykieta: 'Niebieski', klasa: 'nowe' },
  morski: { etykieta: 'Morski', klasa: 'indywidualne' },
  zolty: { etykieta: 'Żółty', klasa: 'w-realizacji' },
  zielony: { etykieta: 'Zielony', klasa: 'wyslane' },
  fioletowy: { etykieta: 'Fioletowy', klasa: 'zwrot' },
  szary: { etykieta: 'Szary', klasa: 'szary' },
  granatowy: { etykieta: 'Granatowy', klasa: 'granatowy' },
  oliwkowy: { etykieta: 'Oliwkowy', klasa: 'oliwkowy' },
  pomaranczowy: { etykieta: 'Pomarańczowy', klasa: 'pomaranczowy' },
  czerwony: { etykieta: 'Czerwony', klasa: 'czerwony' },
  rozowy: { etykieta: 'Różowy', klasa: 'rozowy' },
};
export function domyslneStatusy() {
  return Object.entries(ETYKIETY).map(([klucz, etykieta], kolejnosc) => ({
    klucz, etykieta, kolor: Object.keys(PALETA_STATUSOW)[kolejnosc], kolejnosc,
  }));
}

export function sprawdzStatusy(statusy) {
  if (!Array.isArray(statusy)) throw new Error('Nieprawidłowa konfiguracja statusów.');
  const klucze = new Set();
  const nazwy = new Set();
  for (const s of statusy) {
    if (!s || typeof s.etykieta !== 'string' || !s.etykieta.trim() || [...s.etykieta.trim()].length > 40) throw new Error('Nazwa musi mieć od 1 do 40 znaków.');
    const nazwa = s.etykieta.trim().toLocaleLowerCase('pl');
    if (nazwy.has(nazwa)) throw new Error('Status o tej nazwie już istnieje.');
    nazwy.add(nazwa);
    if (klucze.has(s.klucz)) throw new Error('Powtórzony klucz statusu.');
    klucze.add(s.klucz);
    if (!Object.hasOwn(PALETA_STATUSOW, s.kolor)) throw new Error('Wybierz kolor z palety.');
    if (!Object.hasOwn(ETYKIETY, s.klucz) && (!/^w_[a-z0-9_]+$/.test(s.klucz) || !['nowe', 'w_realizacji'].includes(s.jak))) throw new Error('Wybierz zachowanie: Nowe albo W realizacji.');
    if (Object.hasOwn(ETYKIETY, s.klucz) && s.jak !== undefined) throw new Error('Nie można zmienić zachowania statusu systemowego.');
  }
  if (Object.keys(ETYKIETY).some(k => !klucze.has(k))) throw new Error('Nie można usunąć statusu systemowego ani zmienić jego klucza.');
  if (statusy.length > 26) throw new Error('Możesz dodać najwyżej 20 własnych statusów.');
  return statusy.map((s, kolejnosc) => ({ ...s, etykieta: s.etykieta.trim(), kolejnosc }));
}

export function kluczNowegoStatusu(nazwa, statusy) {
  const slug = String(nazwa).toLowerCase().replaceAll('ł', 'l').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'status';
  const baza = `w_${slug}`;
  let klucz = baza;
  for (let n = 2; statusy.some(s => s.klucz === klucz); n++) klucz = `${baza}_${n}`;
  return klucz;
}
