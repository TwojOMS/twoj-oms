import { bladOperatora, komunikatDlaOperatora } from './bledy.js';

// Wyszukiwanie firmy po NIP-ie w bazie REGON (GUS BIR1.1). CZYSTA warstwa: normalizacja
// NIP-u, składanie koperty SOAP i czytanie odpowiedzi. Sieć siedzi w gus/client.js.
//
// ⚠️ PO CO GUS, SKORO JEST BIALA LISTA MF. Biała Lista dla jednoosobowej działalności
// oddaje IMIĘ I NAZWISKO zamiast nazwy handlowej, a na fakturze ma stać nazwa firmy.
// GUS oddaje jedno i drugie (`nazwa` to nazwa z rejestru REGON).

// NIP w REGON-ie to DZIESIĘĆ CYFR bez separatorów. Człowiek wpisuje go z myślnikami,
// spacjami albo z prefiksem „PL" (tak stoi na fakturach unijnych) — i to jest normalne,
// więc czyścimy, zamiast odmawiać.
export function znormalizujNip(surowy) {
  const t = String(surowy ?? '').trim().replace(/^PL/i, '');
  return t.replace(/\D+/g, '');
}

// Suma kontrolna NIP-u. Sprawdzamy ją PRZED wyjściem do sieci, bo literówka w dziesięciu
// cyfrach jest częstsza niż firma, której nie ma w REGON-ie — a odpowiedź GUS-u na oba
// przypadki wygląda tak samo („nie znaleziono"), więc bez tej kontroli operator dostawałby
// mylący komunikat i szukał firmy, zamiast poprawić cyfrę.
const WAGI = [6, 5, 7, 2, 3, 4, 5, 6, 7];

export function nipPoprawny(nip) {
  if (!/^\d{10}$/.test(nip)) return false;
  const suma = WAGI.reduce((acc, waga, i) => acc + waga * Number(nip[i]), 0);
  const kontrolna = suma % 11;
  // Reszta 10 nie ma cyfry kontrolnej — takiego NIP-u po prostu nie ma.
  return kontrolna !== 10 && kontrolna === Number(nip[9]);
}

/** NIP gotowy do zapytania albo odmowa Z WYJASNIENIEM, co poprawić. */
export function nipDoZapytania(surowy) {
  // ⚠️ NUMER ZAGRANICZNY ODPRAWIAMY PRZED SUMĄ KONTROLNĄ. Bez tego „SK1234567890" gubiło
  // litery, trafiało na polski algorytm i wracało jako „błędna suma kontrolna — sprawdź,
  // czy nie ma literówki". Numer był poprawny, tylko słowacki, a człowiek szukał literówki,
  // której nie ma. REGON zna wyłącznie podmioty zarejestrowane w Polsce.
  const zKrajem = String(surowy ?? '').replace(/[\s.\-/]/g, '').toUpperCase();
  const obcy = zKrajem.match(/^([A-Z]{2})[0-9A-Z]{2,14}$/);
  if (obcy && obcy[1] !== 'PL') {
    throw bladOperatora(
      `„${surowy}" to numer zagraniczny (${obcy[1]}), a GUS zna wyłącznie polskie podmioty. `
      + 'Dane firmy wpisz ręcznie.',
    );
  }

  const nip = znormalizujNip(surowy);
  if (!nip) throw bladOperatora('Podaj NIP — bez niego nie ma czego szukać w GUS.');
  if (nip.length !== 10) {
    throw bladOperatora(`NIP musi mieć dziesięć cyfr, a ma ${nip.length}: „${surowy}".`);
  }
  if (!nipPoprawny(nip)) {
    throw bladOperatora(`NIP „${surowy}" ma błędną sumę kontrolną — sprawdź, czy nie ma literówki.`);
  }
  return nip;
}

// Odpowiedź BIR-a przychodzi jako XML ZAGNIEŻDŻONY w polu tekstowym odpowiedzi SOAP,
// więc parsuje się dwa razy. Czytamy po nazwach pól — dwa wywołania nie uzasadniają nowej
// zależności npm, a odpowiedź i tak trafia przed oczy człowieka, zanim cokolwiek zapisze.
export function pole(xml, nazwa) {
  const m = String(xml ?? '').match(new RegExp(`<${nazwa}>([\\s\\S]*?)</${nazwa}>`, 'i'));
  const t = m ? m[1].trim() : '';
  return t === '' ? null : t;
}

// Wnętrze <ZalogujResult> / <DaneSzukajPodmiotyResult> bywa opakowane w CDATA albo
// zaescapowane (&lt;root&gt;) — zależnie od tego, jak usługa akurat odpowie. Obie postaci
// muszą dać ten sam wynik, bo inaczej klient działa „raz na jakiś czas".
export function rozpakuj(tresc) {
  const bezCdata = String(tresc ?? '').replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '');
  return bezCdata
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

/**
 * Dane firmy z odpowiedzi `DaneSzukajPodmioty`, w kształcie pól karty (firma/ulica/kod/miasto).
 *
 * Zwraca `null`, gdy GUS nic nie znalazł — to NIE jest błąd, tylko odpowiedź „nie ma takiej
 * firmy", i karta musi ją odróżnić od awarii usługi.
 *
 * ⚠️ Adres składamy TĄ SAMĄ zasadą, co adres ze sklepu (ulica + numer w jednym polu):
 * REGON trzyma ulicę, numer nieruchomości i numer lokalu OSOBNO, a panel ma jedno pole
 * „Ulica" i musi w nim pokazać komplet — inaczej faktura pojechałaby bez numeru domu.
 */
export function firmaZOdpowiedzi(xml) {
  const wnetrze = rozpakuj(xml);
  const blok = wnetrze.match(/<dane>([\s\S]*?)<\/dane>/i);
  if (!blok) return null;
  const d = blok[1];
  // Komunikat „nie znaleziono" przychodzi jako <ErrorCode> W ŚRODKU <dane> — obecność
  // samego bloku nie znaczy jeszcze, że firma istnieje.
  if (pole(d, 'ErrorCode')) return null;

  const ulica = pole(d, 'Ulica');
  const nrNieruchomosci = pole(d, 'NrNieruchomosci');
  const nrLokalu = pole(d, 'NrLokalu');
  const numer = [nrNieruchomosci, nrLokalu].filter(Boolean).join('/');
  return {
    firma: pole(d, 'Nazwa'),
    nip: pole(d, 'Nip'),
    regon: pole(d, 'Regon'),
    ulica: [ulica, numer].filter(Boolean).join(' ') || null,
    kod: sformatujKod(pole(d, 'KodPocztowy')),
    miasto: pole(d, 'Miejscowosc'),
    // Typ podmiotu: 'P' = osoba prawna, 'F' = fizyczna (JDG). Karta go nie pokazuje, ale
    // to on odpowiada na pytanie, czemu w ogóle sięgamy do GUS-u zamiast do Białej Listy.
    typ: pole(d, 'Typ'),
  };
}

// REGON oddaje kod BEZ myślnika ('00001'), a panel, Woo i DPD używają postaci z myślnikiem.
// Bez tego pole „Kod pocztowy" po pobraniu z GUS-u wyglądałoby inaczej niż to samo pole
// wypełnione ze sklepu — i każde pobranie oznaczałoby je jako „zmienione ręcznie".
export function sformatujKod(kod) {
  const cyfry = String(kod ?? '').replace(/\D+/g, '');
  if (cyfry.length !== 5) return kod || null;
  return `${cyfry.slice(0, 2)}-${cyfry.slice(2)}`;
}

/** Koperta SOAP logowania. Klucz NIGDY nie trafia nigdzie indziej niż tutaj. */
export function kopertaZaloguj(klucz, adresUslugi) {
  return koperta('Zaloguj', `<ns:pKluczUzytkownika>${esc(klucz)}</ns:pKluczUzytkownika>`, adresUslugi);
}

/** Koperta SOAP wyszukania po NIP-ie. */
export function kopertaSzukajPoNip(nip, adresUslugi) {
  return koperta(
    'DaneSzukajPodmioty',
    `<ns:pParametryWyszukiwania><dat:Nip>${esc(nip)}</dat:Nip></ns:pParametryWyszukiwania>`,
    adresUslugi,
  );
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// BIR wymaga WS-Addressing (`<wsa:To>` musi zgadzać się z adresem usługi) — bez tego
// odpowiada 500 zamiast czymkolwiek sensownym.
function koperta(akcja, cialo, adresUslugi) {
  return '<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"'
    + ' xmlns:ns="http://CIS/BIR/PUBL/2014/07" xmlns:dat="http://CIS/BIR/PUBL/2014/07/DataContract"'
    + ' xmlns:wsa="http://www.w3.org/2005/08/addressing">'
    + '<soap:Header>'
    + `<wsa:Action>http://CIS/BIR/PUBL/2014/07/IUslugaBIRzewnPubl/${akcja}</wsa:Action>`
    + `<wsa:To>${esc(adresUslugi)}</wsa:To>`
    + '</soap:Header>'
    + `<soap:Body><ns:${akcja}>${cialo}</ns:${akcja}></soap:Body>`
    + '</soap:Envelope>';
}

// Komunikat po nieudanym zapytaniu — wspólny dla trzech przycisków „Pobierz z GUS” (karta, nowe zamówienie,
// Stali klienci). PRZ-083: atrapa GUS w demo (deploy/proba/atrapy/gus.mjs) rzuca błąd z `wylaczoneWDemo` —
// jego treść idzie wprost, bo „spróbuj za chwilę” obiecywałoby, że kiedyś zadziała.
export function komunikatAwariiGus(e) {
  if (e?.wylaczoneWDemo) return e.message;
  return `Nie udało się zapytać GUS: ${komunikatDlaOperatora(e)} Wpisz dane ręcznie albo spróbuj za chwilę.`;
}
