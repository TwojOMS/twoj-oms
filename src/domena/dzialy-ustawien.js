// PRZ-127: prezentacja działów nie zmienia praw do obsługujących je tras.
const z = (klucz, etykieta, href, tylkoAdmin = false) => ({ klucz, etykieta, href, tylkoAdmin });
export const DZIALY_USTAWIEN = [
  { klucz: 'firma', etykieta: 'Firma', zakladki: [z('dane', 'Dane i logo', '/ustawienia/firma'), z('rejestrowe', 'Dane rejestrowe', '/ustawienia/firma/rejestrowe'), z('rachunek', 'Rachunek bankowy', '/ustawienia/firma/rachunek')] },
  { klucz: 'integracje', etykieta: 'Integracje', zakladki: [z('polaczenia', 'Moje połączenia', '/ustawienia/integracje'), z('katalog', 'Dodaj integrację', '/ustawienia/integracje/katalog')] },
  { klucz: 'zamowienia', etykieta: 'Zamówienia i magazyn', zakladki: [z('statusy', 'Statusy zamówień', '/ustawienia/statusy'), z('magazyn', 'Stany magazynowe', '/ustawienia/magazyn')] },
  { klucz: 'wysylka', etykieta: 'Wysyłka i druk', zakladki: [z('paczki', 'Szablony paczek', '/ustawienia/zamowienia-i-wysylka'), z('dostawa', 'Koszty dostawy', '/ustawienia/wysylka/dostawa'), z('druk', 'Etykiety i druk', '/ustawienia/druk')] },
  { klucz: 'faktury', etykieta: 'Faktury i podatki', zakladki: [z('program', 'Program do faktur', '/ustawienia/integracje/program-fakturowy'), z('zasady', 'Zasady wystawiania', '/ustawienia/faktury/zasady'), z('vat', 'VAT i zwolnienie', '/ustawienia/faktury/vat'), z('numeracja', 'Numeracja', '/ustawienia/faktury/numeracja'), z('ksef', 'KSeF', '/ustawienia/faktury/ksef')] },
  { klucz: 'komunikacja', etykieta: 'Komunikacja', zakladki: [z('szablony', 'Szablony wiadomości', '/ustawienia/szablony-wiadomosci'), z('podpis', 'Podpis i stopka', '/ustawienia/komunikacja/podpis'), z('allegro', 'Autoodpowiedź Allegro', '/ustawienia/wiadomosci-i-automatyzacje')] },
  { klucz: 'automatyzacje', etykieta: 'Automatyzacje', zakladki: [z('reguly', 'Reguły', '/ustawienia/automatyzacje', true), z('systemowe', 'Automaty systemowe', '/ustawienia/automatyzacje/systemowe', true)] },
  { klucz: 'zespol', etykieta: 'Zespół i dostęp', zakladki: [z('konta', 'Użytkownicy', '/ustawienia/konta', true), z('role', 'Role i uprawnienia', '/ustawienia/role', true), z('klucze-api', 'Klucze API', '/ustawienia/klucze-api', true), z('logowania', 'Historia logowań', '/ustawienia/zespol/logowania', true)] },
  { klucz: 'kopie', etykieta: 'Kopie zapasowe', zakladki: [z('stan', 'Stan i zakres', '/ustawienia/kopie'), z('historia', 'Historia', '/ustawienia/kopie/historia')] },
  { klucz: 'system', etykieta: 'System', zakladki: [z('funkcje', 'Włączone funkcje', '/ustawienia/moduly', true), z('stan', 'Stan systemu', '/ustawienia/lacznosc'), z('aktualizacje', 'Aktualizacje', '/ustawienia/aktualizacje', true)] },
];
const ALIASY = [
  ['/ustawienia/automatyzacje/ksef', 'automatyzacje', 'systemowe'],
  ['/ustawienia/integracje/infakt/ksef-automat', 'automatyzacje', 'systemowe'],
  ['/ustawienia/integracje/program-fakturowy/dla-kazdego', 'faktury', 'zasady'],
  ['/ustawienia/integracje/program-fakturowy/serie', 'faktury', 'numeracja'],
  ['/ustawienia/integracje/program-fakturowy/ksef', 'faktury', 'ksef'],
  ['/ustawienia/integracje/program-fakturowy', 'faktury', 'program'],
  ['/ustawienia/firma/stawka-vat', 'faktury', 'vat'], ['/ustawienia/firma/zwolnienie-vat', 'faktury', 'vat'],
  ['/ustawienia/integracje/poczta/podpis', 'komunikacja', 'podpis'],
  ['/ustawienia/firma/nip', 'firma', 'rejestrowe'], ['/ustawienia/firma/bdo', 'firma', 'rejestrowe'],
  ['/ustawienia/paczka', 'wysylka', 'paczki'], ['/ustawienia/dostawa', 'wysylka', 'dostawa'],
  ['/ustawienia/formulka', 'komunikacja', 'allegro'], ['/ustawienia/kanaly', 'integracje', 'polaczenia'],
];
export function modelNawigacjiUstawien(url = '/ustawienia', { admin = false, podgladDemo = false, daneDemo = false, zdolnosci = {} } = {}) {
  const adres = new URL(String(url), 'http://oms.invalid');
  const sciezka = adres.pathname;
  const maAdmina = admin || podgladDemo;
  const dzialy = DZIALY_USTAWIEN.map(d => ({ ...d, zakladki: d.zakladki.filter(p =>
    p.klucz === 'klucze-api' ? admin : !p.tylkoAdmin || maAdmina) })).filter(d => d.zakladki.length);
  if (daneDemo && maAdmina) dzialy.find(d => d.klucz === 'system').zakladki.push(z('demo', 'Dane demo', '/ustawienia/dane-demo', true));
  const dokladne = dzialy.flatMap(d => d.zakladki.map(p => [p.href, d.klucz, p.klucz]));
  const pasuje = [...ALIASY, ...dokladne].filter(([href]) => sciezka === href || sciezka.startsWith(`${href}/`)).sort((a,b) => b[0].length - a[0].length)[0];
  let [aktywnyDzial, aktywnaZakladka] = pasuje ? pasuje.slice(1) : [null, null];
  if (sciezka === '/ustawienia') [aktywnyDzial, aktywnaZakladka] = ['firma', 'dane'];
  if (sciezka === '/ustawienia/integracje/poczta' && adres.searchParams.has('podglad')) [aktywnyDzial, aktywnaZakladka] = ['komunikacja', 'podpis'];
  const aktywny = dzialy.find(d => d.klucz === aktywnyDzial);
  const zakladki = (aktywny?.zakladki ?? []).map(p => ({ ...p, aktywna: p.klucz === aktywnaZakladka, dostepna: true }));
  return { dzialy: dzialy.map(d => ({ klucz: d.klucz, etykieta: d.etykieta, href: d.zakladki[0].href, aktywna: d.klucz === aktywnyDzial, dostepna: true })),
    zakladki, aktywnyDzial: aktywny ? aktywnyDzial : null, aktywnaZakladka: aktywny ? aktywnaZakladka : null };
}
