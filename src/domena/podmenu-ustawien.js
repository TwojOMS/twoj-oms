// PRZ-101.01 (właściciel 18.10): menu Ustawień z lewej strony, w grupach. Plan grup i pozycji:
// Documents/Claude/twojoms-petla/plan-ustawien-18b.md. Jedna lista — „Firma” i „Role i uprawnienia” nie są już
// doklejane w moduly/ustawienia/nawigacja.js.
export const GRUPY_USTAWIEN = Object.freeze([
  { klucz: 'firma', etykieta: 'Firma' },
  { klucz: 'sprzedaz', etykieta: 'Sprzedaż' },
  { klucz: 'komunikacja', etykieta: 'Komunikacja' },
  { klucz: 'integracje', etykieta: 'Integracje' },
  { klucz: 'system', etykieta: 'System' },
]);

// Nowa pozycja: dopisz {klucz, etykieta, href, grupa} na końcu tablicy. Miejsce w grupie bierze z KOLEJNOSC,
// a bez wpisu tam staje na końcu swojej grupy. `wkrotce` = strona-atrapa (domena/ustawienia-wkrotce.js).
export const POZYCJE_USTAWIEN = [
  { klucz: 'firma', etykieta: 'Dane firmy', href: '/ustawienia/firma', grupa: 'firma' },
  { klucz: 'konta', etykieta: 'Użytkownicy', href: '/ustawienia/konta', grupa: 'firma', tylkoAdmin: true },
  { klucz: 'role', etykieta: 'Role i uprawnienia', href: '/ustawienia/role', grupa: 'firma', tylkoAdmin: true },
  // Ekran ma dwie sekcje: „Szablony paczek” i „Koszty dostawy” — stąd etykieta.
  { klucz: 'zamowienia-i-wysylka', etykieta: 'Paczki i koszty dostawy', href: '/ustawienia/zamowienia-i-wysylka', grupa: 'sprzedaz' },
  { klucz: 'magazyn', etykieta: 'Magazyn', href: '/ustawienia/magazyn', grupa: 'sprzedaz' },
  { klucz: 'druk', etykieta: 'Druk i etykiety', href: '/ustawienia/druk', grupa: 'sprzedaz', wkrotce: true },
  // Ekran ma jedną sekcję: „Autoresponder Allegro”.
  { klucz: 'wiadomosci-i-automatyzacje', etykieta: 'Autoodpowiedź Allegro', href: '/ustawienia/wiadomosci-i-automatyzacje', grupa: 'komunikacja' },
  { klucz: 'powiadomienia', etykieta: 'Powiadomienia', href: '/ustawienia/powiadomienia', grupa: 'komunikacja' },
  { klucz: 'integracje', etykieta: 'Sklepy i usługi', href: '/ustawienia/integracje', grupa: 'integracje' },
  { klucz: 'diagnostyka', etykieta: 'Diagnostyka', href: '/ustawienia/lacznosc', grupa: 'system' },
  { klucz: 'moduly', etykieta: 'Moduły', href: '/ustawienia/moduly', grupa: 'system', tylkoAdmin: true },
  { klucz: 'aktualizacje', etykieta: 'Aktualizacje', href: '/ustawienia/aktualizacje', grupa: 'system', tylkoAdmin: true },
  { klucz: 'kopie', etykieta: 'Kopie zapasowe', href: '/ustawienia/kopie', grupa: 'system', wkrotce: true },
  { klucz: 'import-eksport', etykieta: 'Import i eksport', href: '/ustawienia/import-eksport', grupa: 'system', wkrotce: true },
  { klucz: 'api', etykieta: 'API i webhooki', href: '/ustawienia/api', grupa: 'system', wkrotce: true },
  { klucz: 'szablony-wiadomosci', etykieta: 'Szablony wiadomości', href: '/ustawienia/szablony-wiadomosci', grupa: 'komunikacja' },
  { klucz: 'statusy', etykieta: 'Statusy zamówień', href: '/ustawienia/statusy', grupa: 'sprzedaz' },
  // PRZ-108.06 (właściciel 21.10): reguły „gdy … to …” i automaty systemowe (automat KSeF) — tylko admin.
  { klucz: 'automatyzacje', etykieta: 'Automatyzacje', href: '/ustawienia/automatyzacje', grupa: 'sprzedaz', tylkoAdmin: true, beta: true },
];

// Kolejność z planu, także dla pozycji dopisywanych przez innych (statusy, szablony wiadomości).
const KOLEJNOSC = [
  'firma', 'konta', 'role',
  'statusy', 'automatyzacje', 'zamowienia-i-wysylka', 'magazyn', 'druk',
  'szablony-wiadomosci', 'wiadomosci-i-automatyzacje', 'powiadomienia',
  'integracje',
  'moduly', 'diagnostyka', 'aktualizacje', 'kopie', 'import-eksport', 'api',
];

// Formularze, które zapisują pod innym adresem niż ich ekran (odpowiedź 400 renderuje ten ekran).
const ALIASY = [
  ['/ustawienia/paczka', 'zamowienia-i-wysylka'],
  ['/ustawienia/dostawa', 'zamowienia-i-wysylka'],
  ['/ustawienia/formulka', 'wiadomosci-i-automatyzacje'],
  ['/ustawienia/kanaly', 'integracje'],
  // PRZ-108.06: dawny adres zapisu automatu KSeF (ekran inFaktu) — błąd formularza renderuje ekran Automatyzacji.
  ['/ustawienia/integracje/infakt/ksef-automat', 'automatyzacje'],
];

const podAdresem = (sciezka, href) => sciezka === href || sciezka.startsWith(`${href}/`);

function aktywnyKlucz(sciezka, pozycje) {
  const alias = ALIASY.find(([href]) => podAdresem(sciezka, href));
  if (alias) return alias[1];
  // Najdłuższy pasujący adres wygrywa — podstrona integracji (`/ustawienia/integracje/dpd`) to „Sklepy i usługi”.
  return pozycje.filter((p) => podAdresem(sciezka, p.href))
    .sort((a, b) => b.href.length - a.href.length)[0]?.klucz ?? null;
}

const miejsce = (klucz) => { const i = KOLEJNOSC.indexOf(klucz); return i === -1 ? KOLEJNOSC.length : i; };

/** Płaska lista widocznych pozycji w kolejności grup i planu, z `aktywna` i `wkrotce`. */
export function podmenuUstawien(sciezka = '/ustawienia', { admin = false, pozycje = POZYCJE_USTAWIEN } = {}) {
  const czysta = String(sciezka).split('?')[0];
  const grupy = GRUPY_USTAWIEN.map((g) => g.klucz);
  for (const p of pozycje) {
    if (!grupy.includes(p.grupa)) throw new Error(`Pozycja Ustawień „${p.klucz}” ma nieznaną grupę: ${p.grupa}`);
  }
  const widoczne = pozycje.filter((p) => !p.tylkoAdmin || admin);
  const aktywny = aktywnyKlucz(czysta, widoczne);
  return widoczne
    .map((p, i) => ({ p, i }))
    .sort((a, b) => grupy.indexOf(a.p.grupa) - grupy.indexOf(b.p.grupa) || miejsce(a.p.klucz) - miejsce(b.p.klucz) || a.i - b.i)
    .map(({ p: { tylkoAdmin: _tylkoAdmin, wkrotce = false, ...p } }) => ({ ...p, wkrotce, aktywna: aktywny === p.klucz }));
}

/** Te same pozycje w grupach z nagłówkami; grupa bez widocznej pozycji znika. */
export function grupyUstawien(sciezka = '/ustawienia', opcje = {}) {
  const lista = podmenuUstawien(sciezka, opcje);
  return GRUPY_USTAWIEN
    .map((g) => ({ klucz: g.klucz, etykieta: g.etykieta, pozycje: lista.filter((p) => p.grupa === g.klucz) }))
    .filter((g) => g.pozycje.length > 0);
}
