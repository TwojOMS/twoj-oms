import { potwierdzOdmoweHistorycznegoSchema } from '../pomoc/baseline-historyczne.js';
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// ⚠️ Projekt NIE uzywa better-sqlite3 — baza stoi na wbudowanym node:sqlite, a testy
// otwieraja ja przez openOmsDb(':memory:'), ktore zaklada komplet tabel i migracje.
import { openOmsDb } from '../../src/oms/db/db.ts';
import { createTokeny, DNI_OSTRZEZENIA } from '../../src/oms/allegro/tokeny.js';
import { zapiszTokeny, wczytajTokeny, zapiszBladTokenu } from '../../src/oms/db/tokeny.js';

// ⚠️ WARTOSC JAWNIE FIKCYJNA — prawdziwy naglowek dopiero powstanie i wejdzie KONFIGURACJA
// (`ALLEGRO_USER_AGENT`), a Allegro trzyma go na bialej liscie. `.invalid` to TLD
// zarezerwowane przez RFC 2606.
const UA = 'PrzykladowyPanel/0.0.0 (+https://przyklad.invalid/panel)';
const ustawienia = {
  clientId: 'id', clientSecret: 'sekret', auth: 'https://przyklad/auth/oauth', userAgent: UA,
};
const baza = () => { return openOmsDb(':memory:'); };
const zaDni = (n) => new Date(Date.now() + n * 86400000).toISOString();

// ⚠️ Do testow GRANICY ostrzezenia `zaDni` nie wystarcza: `zostaloDni` liczy sie przez
// Math.floor, a miedzy zapisem daty a jej odczytem mija kilka milisekund — wiec „dokladnie
// 7 dni" zamienia sie w 6 i granica przesuwa sie o cala dobe, ZALEZNIE OD ZEGARA. Minuta
// zapasu usuwa te zaleznosc i pozwala orzekac o granicy, a nie o szybkosci maszyny.
const zaDniZZapasem = (n) => new Date(Date.now() + n * 86400000 + 60000).toISOString();

const odpowiedz = (dane, { ok = true, status = 200 } = {}) => ({ ok, status, json: async () => dane });

// Cialo, ktore NIE JEST JSON-em (HTML-owa strona bledu, pusta odpowiedz z proxy). `.json()`
// rzuca wtedy SyntaxError — i wlasnie ten wyjatek potrafil wyprzec cala obsluge ponizej.
const cialoNieJson = ({ ok = true, status = 200 } = {}) => ({
  ok,
  status,
  json: async () => { throw new SyntaxError('Unexpected token < in JSON at position 0'); },
});

describe('tokeny kanału Allegro', () => {
  it('token ważny jest oddawany bez ani jednego wyjścia do sieci', async () => {
    const db = baza();
    zapiszTokeny(db, 'allegro_szkicownia', {
      accessToken: 'ZYWY', refreshToken: 'r', wygasaAt: zaDni(1), refreshWygasaAt: zaDni(80),
    });
    const fetchImpl = () => { throw new Error('siec nie miala byc wolana'); };
    const t = createTokeny({ db, kanal: 'allegro_szkicownia', ustawienia, fetchImpl });

    expect(await t.waznyToken()).toBe('ZYWY');
  });

  it('token wygasły jest odświeżany, a NOWA para NADPISUJE starą', async () => {
    const db = baza();
    zapiszTokeny(db, 'allegro_szkicownia', {
      accessToken: 'STARY', refreshToken: 'STARY_R', wygasaAt: zaDni(-1), refreshWygasaAt: zaDni(80),
    });
    const fetchImpl = async () => ({
      ok: true,
      json: async () => ({ access_token: 'NOWY', refresh_token: 'NOWY_R', expires_in: 43199 }),
    });
    const t = createTokeny({ db, kanal: 'allegro_szkicownia', ustawienia, fetchImpl });

    expect(await t.waznyToken()).toBe('NOWY');
    // ⚠️ Stary refresh token jest juz SPALONY po stronie Allegro. Zostawienie go w bazie
    // znaczy, ze kolejne odswiezenie poleci wartoscia, ktora na pewno nie zadziala.
    expect(t.stan().refresh_token).toBe('NOWY_R');
    // ⚠️ ASERCJA NA BAZIE, NIE NA WARTOSCI ZWROCONEJ. `waznyToken()` oddaje `d.access_token`
    // PROSTO Z ODPOWIEDZI, z pominieciem bazy — wiec podmiana zapisywanego access tokena na
    // smiec przechodzila cala suite. Zapisany access token to ten, ktorym poller bedzie
    // sie posluzyc przy nastepnym przebiegu; jesli w bazie lezy smiec, kanal zamilknie,
    // a `stan()` bedzie do konca twierdzil, ze wszystko jest w porzadku.
    expect(t.stan().access_token).toBe('NOWY');
  });

  it('bliskie wygaśnięcie refresh tokena jest SPRAWĄ, zanim stanie się awarią', () => {
    const db = baza();
    zapiszTokeny(db, 'allegro_szkicownia', {
      accessToken: 'a', refreshToken: 'r', wygasaAt: zaDni(1), refreshWygasaAt: zaDni(DNI_OSTRZEZENIA - 1),
    });
    const t = createTokeny({ db, kanal: 'allegro_szkicownia', ustawienia, fetchImpl: () => {} });

    expect(t.stan().wymagaPowiazania).toBe(true);
  });

  it('brak tokenów NIE RZUCA — kanał ma powiedzieć „połącz mnie", a nie wywalić panel', () => {
    const db = baza();
    const t = createTokeny({ db, kanal: 'allegro_szkicownia', ustawienia, fetchImpl: () => {} });
    expect(t.stan().wymagaPowiazania).toBe(true);
  });

  // ⚠️ BEZ TEGO TESTU `wymagaPowiazania: true` NA SZTYWNO PRZECHODZI CALA CZWORKE WYZEJ.
  // Kanal zdrowy musi umiec powiedziec, ze jest zdrowy — inaczej ostrzezenie „polacz mnie"
  // wisi na ekranie zawsze i po tygodniu nikt go nie czyta (a wtedy prawdziwe wygasniecie
  // przechodzi niezauwazone).
  it('kanał ze świeżą parą NIE prosi o ponowne połączenie', () => {
    const db = baza();
    zapiszTokeny(db, 'allegro_szkicownia', {
      accessToken: 'a', refreshToken: 'r', wygasaAt: zaDni(1), refreshWygasaAt: zaDniZZapasem(80),
    });
    const t = createTokeny({ db, kanal: 'allegro_szkicownia', ustawienia, fetchImpl: () => {} });

    expect(t.stan().wymagaPowiazania).toBe(false);
    expect(t.stan().zostaloDni).toBe(80);
  });

  it('granica ostrzeżenia: DOKŁADNIE DNI_OSTRZEZENIA dni to już sprawa, dzień więcej — jeszcze nie', () => {
    const db = baza();
    const t = createTokeny({ db, kanal: 'allegro_szkicownia', ustawienia, fetchImpl: () => {} });

    zapiszTokeny(db, 'allegro_szkicownia', {
      accessToken: 'a', refreshToken: 'r', wygasaAt: zaDni(1), refreshWygasaAt: zaDniZZapasem(DNI_OSTRZEZENIA),
    });
    expect(t.stan().zostaloDni).toBe(DNI_OSTRZEZENIA);
    expect(t.stan().wymagaPowiazania).toBe(true);

    zapiszTokeny(db, 'allegro_szkicownia', {
      accessToken: 'a', refreshToken: 'r', wygasaAt: zaDni(1), refreshWygasaAt: zaDniZZapasem(DNI_OSTRZEZENIA + 1),
    });
    expect(t.stan().zostaloDni).toBe(DNI_OSTRZEZENIA + 1);
    expect(t.stan().wymagaPowiazania).toBe(false);
  });

  // Token wazny „jeszcze przez dwie minuty" jest w praktyce martwy: zdazy wygasnac w trakcie
  // przebiegu pollera, ktory chodzi po wielu stronach zamowien. Odswiezamy Z WYPRZEDZENIEM.
  it('token wygasający za dwie minuty jest odświeżany PRZED użyciem (margines)', async () => {
    const db = baza();
    zapiszTokeny(db, 'allegro_szkicownia', {
      accessToken: 'PRAWIE_MARTWY',
      refreshToken: 'STARY_R',
      wygasaAt: new Date(Date.now() + 2 * 60 * 1000).toISOString(),
      refreshWygasaAt: zaDni(80),
    });
    const fetchImpl = async () => odpowiedz({ access_token: 'NOWY', refresh_token: 'NOWY_R', expires_in: 43199 });
    const t = createTokeny({ db, kanal: 'allegro_szkicownia', ustawienia, fetchImpl });

    expect(await t.waznyToken()).toBe('NOWY');
  });

  it('odświeżenie idzie na /token, z Basic z poświadczeń kanału i grant_type=refresh_token', async () => {
    const db = baza();
    zapiszTokeny(db, 'allegro_szkicownia', {
      accessToken: 'STARY', refreshToken: 'STARY_R', wygasaAt: zaDni(-1), refreshWygasaAt: zaDni(80),
    });
    const wywolania = [];
    const fetchImpl = async (url, opcje) => {
      wywolania.push({ url, opcje });
      return odpowiedz({ access_token: 'NOWY', refresh_token: 'NOWY_R', expires_in: 43199 });
    };
    const t = createTokeny({ db, kanal: 'allegro_szkicownia', ustawienia, fetchImpl });

    await t.waznyToken();

    expect(wywolania).toHaveLength(1);
    expect(wywolania[0].url).toBe('https://przyklad/auth/oauth/token');
    expect(wywolania[0].opcje.method).toBe('POST');
    expect(wywolania[0].opcje.headers.Authorization)
      .toBe(`Basic ${Buffer.from('id:sekret').toString('base64')}`);
    const pola = new URLSearchParams(String(wywolania[0].opcje.body));
    expect(pola.get('grant_type')).toBe('refresh_token');
    expect(pola.get('refresh_token')).toBe('STARY_R');
  });

  it('nowa para dostaje ważność z expires_in, a refresh tokena — z udokumentowanych 3 miesięcy', async () => {
    const db = baza();
    zapiszTokeny(db, 'allegro_szkicownia', {
      accessToken: 'STARY', refreshToken: 'STARY_R', wygasaAt: zaDni(-1), refreshWygasaAt: zaDni(10),
    });
    const fetchImpl = async () => odpowiedz({ access_token: 'NOWY', refresh_token: 'NOWY_R', expires_in: 43199 });
    const t = createTokeny({ db, kanal: 'allegro_szkicownia', ustawienia, fetchImpl });

    await t.waznyToken();

    const zostaloSekund = (Date.parse(t.stan().wygasa_at) - Date.now()) / 1000;
    expect(zostaloSekund).toBeGreaterThan(43000);
    expect(zostaloSekund).toBeLessThanOrEqual(43199);
    // Odswiezenie odsuwa tez horyzont refresh tokena — inaczej ostrzezenie „polacz mnie"
    // zostaloby zapalone na zawsze mimo swiezo zrotowanej pary.
    //
    // ⚠️ NIE `expect(zostaloDni).toBe(89)`: `zostaloDni` liczy sie przez Math.floor, wiec gdy
    // zapis i odczyt trafia w TE SAMA milisekunde, wychodzi rowne 90, a milisekunde pozniej —
    // 89. Taki test przechodzi albo nie w zaleznosci od obciazenia maszyny (zlapane przy
    // weryfikacji mutacyjnej). Orzekamy wiec o ODLEGLOSCI, ktora jest jednoznaczna.
    const refreshZaMs = Date.parse(t.stan().refresh_wygasa_at) - Date.now();
    expect(refreshZaMs).toBeGreaterThan(89.9 * 86400000);
    expect(refreshZaMs).toBeLessThanOrEqual(90 * 86400000);
    expect(t.stan().wymagaPowiazania).toBe(false);
  });

  // ⚠️ NIE PONAWIAMY. Kazda kolejna proba leci tokenem, ktory Allegro mogl juz zrotowac —
  // petla ponowien spalilaby swiezo wydana pare. Jedno wyjscie do sieci, slad w bazie, koniec.
  it('odrzucone odświeżenie NIE PONAWIA, nie kasuje starej pary i zostawia ślad dla człowieka', async () => {
    const db = baza();
    zapiszTokeny(db, 'allegro_szkicownia', {
      accessToken: 'STARY', refreshToken: 'STARY_R', wygasaAt: zaDni(-1), refreshWygasaAt: zaDni(80),
    });
    let prob = 0;
    const fetchImpl = async () => { prob += 1; return odpowiedz({ error: 'invalid_grant' }, { ok: false, status: 400 }); };
    const t = createTokeny({ db, kanal: 'allegro_szkicownia', ustawienia, fetchImpl });

    await expect(t.waznyToken()).rejects.toThrow(/odświeżenie tokenu odrzucone/i);
    expect(prob).toBe(1);

    const s = t.stan();
    expect(s.access_token).toBe('STARY');
    expect(s.refresh_token).toBe('STARY_R');
    expect(s.ostatni_blad).toMatch(/400/);
  });

  // Niezmiennik 4.10: poswiadczenia i tokeny nie maja prawa trafic do bazy jako tekst bledu
  // ani do komunikatu, ktory ktos wypisze do logu.
  it('ani wyjątek, ani ślad w bazie nie niosą poświadczeń kanału ani tokenów', async () => {
    const db = baza();
    const tajne = { clientId: 'KLIENT_X', clientSecret: 'SEKRET_X', auth: 'https://przyklad/auth/oauth' };
    zapiszTokeny(db, 'allegro_szkicownia', {
      accessToken: 'ACCESS_X', refreshToken: 'REFRESH_X', wygasaAt: zaDni(-1), refreshWygasaAt: zaDni(80),
    });
    const fetchImpl = async () => odpowiedz(
      { error: 'invalid_client', error_description: 'SEKRET_X jest zly' },
      { ok: false, status: 401 },
    );
    const t = createTokeny({ db, kanal: 'allegro_szkicownia', ustawienia: tajne, fetchImpl });

    const blad = await t.waznyToken().then(() => null, (e) => e);
    const basic = Buffer.from('KLIENT_X:SEKRET_X').toString('base64');
    for (const tekst of [blad.message, t.stan().ostatni_blad]) {
      expect(tekst).not.toContain('SEKRET_X');
      expect(tekst).not.toContain('REFRESH_X');
      expect(tekst).not.toContain('ACCESS_X');
      expect(tekst).not.toContain(basic);
    }
  });

  it('stan dla ekranu nie niesie ani access, ani refresh tokena', () => {
    const db = baza();
    zapiszTokeny(db, 'allegro_szkicownia', {
      accessToken: 'ACCESS_X', refreshToken: 'REFRESH_X', wygasaAt: zaDni(1), refreshWygasaAt: zaDniZZapasem(80),
    });
    const t = createTokeny({ db, kanal: 'allegro_szkicownia', ustawienia, fetchImpl: () => {} });

    const dlaEkranu = t.stanDlaEkranu();
    expect(JSON.stringify(dlaEkranu)).not.toContain('ACCESS_X');
    expect(JSON.stringify(dlaEkranu)).not.toContain('REFRESH_X');
    expect(dlaEkranu.wymagaPowiazania).toBe(false);
    expect(dlaEkranu.zostaloDni).toBe(80);
  });

  it('kanał niepołączony odmawia tokenu komunikatem dla człowieka, a nie awarią techniczną', async () => {
    const db = baza();
    let prob = 0;
    const fetchImpl = async () => { prob += 1; return odpowiedz({}); };
    const t = createTokeny({ db, kanal: 'allegro_szkicownia', ustawienia, fetchImpl });

    await expect(t.waznyToken()).rejects.toThrow(/nie jest połączony/i);
    expect(prob).toBe(0);
  });
});

describe('device flow kanału Allegro', () => {
  it('rozpoczęcie wiązania woła /device z client_id i oddaje kod dla człowieka', async () => {
    const db = baza();
    const wywolania = [];
    const fetchImpl = async (url, opcje) => {
      wywolania.push({ url, opcje });
      return odpowiedz({
        device_code: 'DC', user_code: 'ABCD', interval: 5, expires_in: 600,
        verification_uri_complete: 'https://allegro.pl/device?user_code=ABCD',
      });
    };
    const t = createTokeny({ db, kanal: 'allegro_szkicownia', ustawienia, fetchImpl });

    const dane = await t.rozpocznijPowiazanie();

    expect(dane.user_code).toBe('ABCD');
    expect(dane.device_code).toBe('DC');
    expect(wywolania[0].url).toBe('https://przyklad/auth/oauth/device');
    expect(wywolania[0].opcje.method).toBe('POST');
    expect(new URLSearchParams(String(wywolania[0].opcje.body)).get('client_id')).toBe('id');
  });

  // Czlowiek jeszcze nie klilknal w przegladarce — to NORMALNY etap wiazania, a nie awaria.
  // Rzucenie tutaj kazaloby ekranowi pokazac blad przy kazdym odpytaniu, co drugie sekunde.
  it('kod jeszcze niepotwierdzony nie jest awarią i NICZEGO nie zapisuje do bazy', async () => {
    const db = baza();
    const fetchImpl = async () => odpowiedz({ error: 'authorization_pending' }, { ok: false, status: 400 });
    const t = createTokeny({ db, kanal: 'allegro_szkicownia', ustawienia, fetchImpl });

    expect(await t.dokonczPowiazanie('DC')).toEqual({ gotowe: false, powod: 'authorization_pending' });
    expect(wczytajTokeny(db, 'allegro_szkicownia')).toBe(null);
    expect(t.stan().wymagaPowiazania).toBe(true);
  });

  // ⚠️ WYJSCIE ZE STANU, Z KTOREGO PANEL SAM NIE WYCHODZI (niezmiennik 4.9): wygasly refresh
  // token naprawia WYLACZNIE czlowiek przy przegladarce. Udane wiazanie musi wiec nie tylko
  // zapisac pare, ale i ZGASIC slad po poprzedniej awarii — inaczej kanal swiezo polaczony
  // dalej wygladalby na zepsuty.
  it('potwierdzone wiązanie zapisuje parę, gasi ostrzeżenie i czyści poprzedni błąd', async () => {
    const db = baza();
    zapiszTokeny(db, 'allegro_szkicownia', {
      accessToken: 'STARY', refreshToken: 'STARY_R', wygasaAt: zaDni(-1), refreshWygasaAt: zaDni(1),
    });
    zapiszBladTokenu(db, 'allegro_szkicownia', 'Odświeżenie tokenu odrzucone (HTTP 400).');
    expect(wczytajTokeny(db, 'allegro_szkicownia').ostatni_blad).toMatch(/400/);

    const fetchImpl = async () => odpowiedz({ access_token: 'A', refresh_token: 'R', expires_in: 43199 });
    const t = createTokeny({ db, kanal: 'allegro_szkicownia', ustawienia, fetchImpl });

    expect(await t.dokonczPowiazanie('DC')).toEqual({ gotowe: true });

    const s = t.stan();
    expect(s.access_token).toBe('A');
    expect(s.refresh_token).toBe('R');
    expect(s.ostatni_blad).toBe(null);
    expect(s.wymagaPowiazania).toBe(false);
  });

  it('dokończenie wiązania leci grant_type device_code z podanym kodem', async () => {
    const db = baza();
    const wywolania = [];
    const fetchImpl = async (url, opcje) => {
      wywolania.push({ url, opcje });
      return odpowiedz({ access_token: 'A', refresh_token: 'R', expires_in: 43199 });
    };
    const t = createTokeny({ db, kanal: 'allegro_szkicownia', ustawienia, fetchImpl });

    await t.dokonczPowiazanie('DC-123');

    expect(wywolania[0].url).toBe('https://przyklad/auth/oauth/token');
    const pola = new URLSearchParams(String(wywolania[0].opcje.body));
    expect(pola.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:device_code');
    expect(pola.get('device_code')).toBe('DC-123');
  });
});

// ⚠️⚠️ NAGLOWEK ZGODNOSCI NA SCIEZCE OAUTH. Kusi, zeby liczyc `User-Agent` wylacznie przy
// API zamowien — ale `/auth/oauth/device` i `/auth/oauth/token` ida na TE SAMA aplikacje
// i na TEN SAM klucz, ktory Allegro grozi zablokowac („wywolania API bez prawidlowego
// naglowka User-Agent spowoduja zablokowanie klucza API"; po 30.06.2026 sa odrzucane).
//
// Gorzej: to wlasnie te trzy zadania ida PIERWSZE. Kanal, ktoremu Allegro odbije
// odswiezenie tokenu albo wiazanie, staje w miejscu, z ktorego panel SAM NIE WYJDZIE —
// wymaga czlowieka przy przegladarce (niezmiennik 4.9).
//
// KAZDA Z TRZECH SCIEZEK MA WLASNY TEST. Wspolne zrodlo naglowkow (`naglowki()`) jest
// decyzja implementacji, a nie kontraktem: gdyby ktos rozbil je na trzy kopie albo pominal
// naglowek przy jednym wywolaniu, dwa pozostale testy dalej byly by zielone.
describe('nagłówek User-Agent — WSZYSTKIE trzy żądania OAuth do Allegro', () => {
  const naglowkiZ = (wywolania) => wywolania[0].opcje.headers;

  it('ODŚWIEŻENIE tokenu niesie User-Agent z konfiguracji', async () => {
    const db = baza();
    zapiszTokeny(db, 'allegro_szkicownia', {
      accessToken: 'STARY', refreshToken: 'STARY_R', wygasaAt: zaDni(-1), refreshWygasaAt: zaDni(80),
    });
    const wywolania = [];
    const fetchImpl = async (url, opcje) => {
      wywolania.push({ url, opcje });
      return odpowiedz({ access_token: 'NOWY', refresh_token: 'NOWY_R', expires_in: 43199 });
    };
    const t = createTokeny({ db, kanal: 'allegro_szkicownia', ustawienia, fetchImpl });

    expect(await t.waznyToken()).toBe('NOWY');

    // Adres w asercji, bo bez niego test nie odroznilby odswiezenia od device flow — oba
    // ida na `/token`, a to jest ta sciezka, ktora chodzi SAMA, co dwie minuty.
    expect(wywolania[0].url).toBe('https://przyklad/auth/oauth/token');
    expect(new URLSearchParams(String(wywolania[0].opcje.body)).get('grant_type')).toBe('refresh_token');
    expect(naglowkiZ(wywolania)['User-Agent']).toBe(UA);
  });

  it('DEVICE FLOW (/device) niesie User-Agent z konfiguracji', async () => {
    const db = baza();
    const wywolania = [];
    const fetchImpl = async (url, opcje) => {
      wywolania.push({ url, opcje });
      return odpowiedz({ device_code: 'DC', user_code: 'ABCD', interval: 5, expires_in: 600 });
    };
    const t = createTokeny({ db, kanal: 'allegro_szkicownia', ustawienia, fetchImpl });

    await t.rozpocznijPowiazanie();

    expect(wywolania[0].url).toBe('https://przyklad/auth/oauth/device');
    expect(naglowkiZ(wywolania)['User-Agent']).toBe(UA);
  });

  it('DOKOŃCZENIE WIĄZANIA (/token, grant_type device_code) niesie User-Agent z konfiguracji', async () => {
    const db = baza();
    const wywolania = [];
    const fetchImpl = async (url, opcje) => {
      wywolania.push({ url, opcje });
      return odpowiedz({ access_token: 'A', refresh_token: 'R', expires_in: 43199 });
    };
    const t = createTokeny({ db, kanal: 'allegro_szkicownia', ustawienia, fetchImpl });

    expect(await t.dokonczPowiazanie('DC-123')).toEqual({ gotowe: true });

    expect(wywolania[0].url).toBe('https://przyklad/auth/oauth/token');
    expect(new URLSearchParams(String(wywolania[0].opcje.body)).get('grant_type'))
      .toBe('urn:ietf:params:oauth:grant-type:device_code');
    expect(naglowkiZ(wywolania)['User-Agent']).toBe(UA);
  });

  // ⚠️ TO JEST TEST NA „STALA W KODZIE". Testy wyzej przeszlyby tak samo, gdyby ktos wpisal
  // naglowek na sztywno w tokeny.js — a wtedy podniesienie numeru wersji (jedyna zmiana,
  // na ktora Allegro pozwala) wymagaloby wydania panelu zamiast linii w `.env.oms`.
  it('wartość pochodzi z ustawień kanału, a nie ze stałej w module', async () => {
    const db = baza();
    const inny = { ...ustawienia, userAgent: 'InnaNazwa/9.9.9 (+https://inny.invalid/dok)' };
    const wywolania = [];
    const fetchImpl = async (url, opcje) => {
      wywolania.push({ url, opcje });
      return odpowiedz({ device_code: 'DC', user_code: 'ABCD', interval: 5, expires_in: 600 });
    };
    const t = createTokeny({ db, kanal: 'allegro_szkicownia', ustawienia: inny, fetchImpl });

    await t.rozpocznijPowiazanie();

    expect(naglowkiZ(wywolania)['User-Agent']).toBe('InnaNazwa/9.9.9 (+https://inny.invalid/dok)');
    expect(naglowkiZ(wywolania)['User-Agent']).not.toBe(UA);
  });

  // Naglowek zgodnosci ma sie DOLOZYC, a nie wyprzec tego, co juz dziala. `Authorization:
  // Basic` i `Content-Type` sa warunkiem przyjecia zadania OAuth przez Allegro.
  it('dokłada się do nagłówków, których żądanie OAuth już wymagało', async () => {
    const db = baza();
    const wywolania = [];
    const fetchImpl = async (url, opcje) => {
      wywolania.push({ url, opcje });
      return odpowiedz({ device_code: 'DC', user_code: 'ABCD', interval: 5, expires_in: 600 });
    };
    const t = createTokeny({ db, kanal: 'allegro_szkicownia', ustawienia, fetchImpl });

    await t.rozpocznijPowiazanie();

    const h = naglowkiZ(wywolania);
    expect(h.Authorization).toMatch(/^Basic /);
    expect(h['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(h['User-Agent']).toBe(UA);
  });
});

// ⚠️ Odpowiedz o NIEOCZEKIWANYM KSZTALCIE jest najgorszym momentem, jaki moze spotkac ten
// modul: Allegro ODDALO 200, wiec rotacja pary PO ICH STRONIE JUZ SIE STALA, a stary refresh
// token jest spalony. Kazde wysypanie sie PRZED zapisem znaczy, ze nowej pary nie ma nigdzie
// — kanal umiera do czasu, az czlowiek przejdzie device flow w przegladarce.
describe('odpowiedź o nieoczekiwanym kształcie nie ma prawa spalić pary bez śladu', () => {
  it('200 BEZ expires_in: para jest ZAPISANA (z zapasową ważnością), a nie zgubiona', async () => {
    const db = baza();
    zapiszTokeny(db, 'allegro_szkicownia', {
      accessToken: 'STARY', refreshToken: 'STARY_R', wygasaAt: zaDni(-1), refreshWygasaAt: zaDni(80),
    });
    // Odpowiedz z para tokenow, ale bez `expires_in` — kiedys `new Date(NaN).toISOString()`
    // rzucalo tu RangeError i zapis nigdy sie nie wykonywal.
    const fetchImpl = async () => odpowiedz({ access_token: 'NOWY', refresh_token: 'NOWY_R' });
    const t = createTokeny({ db, kanal: 'allegro_szkicownia', ustawienia, fetchImpl });

    expect(await t.waznyToken()).toBe('NOWY');

    const s = t.stan();
    expect(s.access_token).toBe('NOWY');
    // To jest cala stawka: NOWY refresh token lezy w bazie, wiec kanal ma czym zyc dalej.
    expect(s.refresh_token).toBe('NOWY_R');
    expect(s.ostatni_blad).toBe(null);
    // Zapasowa waznosc jest KROTKA celowo — nie udajemy, ze znamy termin. Ma sie zmiescic
    // grubo ponizej prawdziwych ~12 h access tokena Allegro.
    const zostaloMs = Date.parse(s.wygasa_at) - Date.now();
    expect(zostaloMs).toBeGreaterThan(0);
    expect(zostaloMs).toBeLessThanOrEqual(10 * 60 * 1000);
    // Horyzont refresh tokena tez sie odsunal — kanal nie ma wygladac na wymagajacy uwagi.
    expect(s.wymagaPowiazania).toBe(false);
  });

  it('200 BEZ pary tokenów: ślad w bazie ZANIM poleci wyjątek, stara para nietknięta', async () => {
    const db = baza();
    zapiszTokeny(db, 'allegro_szkicownia', {
      accessToken: 'STARY', refreshToken: 'STARY_R', wygasaAt: zaDni(-1), refreshWygasaAt: zaDni(80),
    });
    // 200 z pustym ciałem: Allegro zrotowalo pare, ale nam jej nie oddalo.
    const fetchImpl = async () => odpowiedz({});
    const t = createTokeny({ db, kanal: 'allegro_szkicownia', ustawienia, fetchImpl });

    await expect(t.waznyToken()).rejects.toThrow(/bez pary tokenów/i);

    const s = t.stan();
    // ⚠️ `ostatni_blad = null` po takiej odpowiedzi byloby najgorszym mozliwym stanem:
    // kanal martwy, a ekran spokojny. Czlowiek dowiedzialby sie z braku zamowien.
    expect(s.ostatni_blad).toMatch(/połącz/i);
    expect(s.access_token).toBe('STARY');
    expect(s.refresh_token).toBe('STARY_R');
  });

  it('200 z ciałem, które NIE JEST JSON-em: ślad i komunikat, a nie SyntaxError', async () => {
    const db = baza();
    zapiszTokeny(db, 'allegro_szkicownia', {
      accessToken: 'STARY', refreshToken: 'STARY_R', wygasaAt: zaDni(-1), refreshWygasaAt: zaDni(80),
    });
    const fetchImpl = async () => cialoNieJson();
    const t = createTokeny({ db, kanal: 'allegro_szkicownia', ustawienia, fetchImpl });

    const blad = await t.waznyToken().then(() => null, (e) => e);
    expect(blad).toBeInstanceOf(Error);
    expect(blad).not.toBeInstanceOf(SyntaxError);
    expect(blad.message).toMatch(/bez pary tokenów/i);
    expect(t.stan().ostatni_blad).toMatch(/połącz/i);
    expect(t.stan().refresh_token).toBe('STARY_R');
  });

  it('ODMOWA z ciałem, które NIE JEST JSON-em, też zostawia ślad (5xx z HTML-em)', async () => {
    const db = baza();
    zapiszTokeny(db, 'allegro_szkicownia', {
      accessToken: 'STARY', refreshToken: 'STARY_R', wygasaAt: zaDni(-1), refreshWygasaAt: zaDni(80),
    });
    const fetchImpl = async () => cialoNieJson({ ok: false, status: 502 });
    const t = createTokeny({ db, kanal: 'allegro_szkicownia', ustawienia, fetchImpl });

    const blad = await t.waznyToken().then(() => null, (e) => e);
    expect(blad).not.toBeInstanceOf(SyntaxError);
    expect(blad.message).toMatch(/odrzucone/i);
    expect(t.stan().ostatni_blad).toMatch(/502/);
  });

  it('device flow: 200 bez expires_in zapisuje parę, 200 bez refresh tokena NICZEGO nie zapisuje', async () => {
    const db = baza();
    const t = createTokeny({
      db, kanal: 'allegro_szkicownia', ustawienia,
      fetchImpl: async () => odpowiedz({ access_token: 'A', refresh_token: 'R' }),
    });
    expect(await t.dokonczPowiazanie('DC')).toEqual({ gotowe: true });
    expect(t.stan().refresh_token).toBe('R');
    expect(Date.parse(t.stan().wygasa_at) - Date.now()).toBeGreaterThan(0);

    const db2 = baza();
    const t2 = createTokeny({
      db: db2, kanal: 'allegro_szkicownia', ustawienia,
      fetchImpl: async () => odpowiedz({ access_token: 'A' }),
    });
    // Sam access token bez refresh tokena to kanal, ktory umrze za 12 godzin i nikt nie
    // bedzie wiedzial dlaczego. Lepiej powiedziec „jeszcze nie gotowe".
    expect(await t2.dokonczPowiazanie('DC')).toEqual({ gotowe: false, powod: 'odpowiedź bez pary tokenów' });
    expect(wczytajTokeny(db2, 'allegro_szkicownia')).toBe(null);
  });

  // Ta sciezka jest ODPYTYWANA CO KILKA SEKUND, dopoki czlowiek nie kliknie w przegladarce —
  // wiec akurat tutaj proxy albo strona bledu Allegro trafi sie predzej czy pozniej.
  // SyntaxError z `.json()` wywalilby ekran wiazania zamiast powiedziec „jeszcze nie".
  it('device flow: ciało, które NIE JEST JSON-em, to „jeszcze nie gotowe", a nie awaria', async () => {
    const db = baza();
    const t = createTokeny({
      db, kanal: 'allegro_szkicownia', ustawienia,
      fetchImpl: async () => cialoNieJson({ ok: false, status: 502 }),
    });

    expect(await t.dokonczPowiazanie('DC')).toEqual({ gotowe: false, powod: 'HTTP 502' });
    expect(wczytajTokeny(db, 'allegro_szkicownia')).toBe(null);
  });
});

// ⚠️ REFRESH TOKEN JEST JEDNORAZOWY. Dwa rownolegle `waznyToken()` na wygaslym tokenie
// wyslalyby TEN SAM refresh token dwoma zadaniami: drugie dostanie `invalid_grant`, a Allegro
// przy wykryciu reuzycia potrafi uniewaznic CALA rodzine tokenow — czyli zabic kanal.
describe('dwa równoległe odświeżenia nie wysyłają tego samego refresh tokena dwa razy', () => {
  it('DWIE OSOBNE instancje createTokeny nad tą samą bazą robią DOKŁADNIE JEDNO wyjście do sieci', async () => {
    const db = baza();
    zapiszTokeny(db, 'allegro_szkicownia', {
      accessToken: 'STARY', refreshToken: 'STARY_R', wygasaAt: zaDni(-1), refreshWygasaAt: zaDni(80),
    });

    const wyslaneTokeny = [];
    let zwolnij;
    const wstrzymanie = new Promise((res) => { zwolnij = res; });
    const fetchImpl = async (url, opcje) => {
      wyslaneTokeny.push(new URLSearchParams(String(opcje.body)).get('refresh_token'));
      // Trzymamy odpowiedz, zeby oba wywolania na pewno nachodzily na siebie w czasie —
      // bez tego test moglby przechodzic tylko dlatego, ze pierwsze zdazylo sie skonczyc.
      await wstrzymanie;
      return odpowiedz({ access_token: 'NOWY', refresh_token: 'NOWY_R', expires_in: 43199 });
    };

    // ⚠️ DWIE OSOBNE INSTANCJE, tak jak w panelu: `createTokeny` bywa wolane per zadanie
    // HTTP. Deduplikacja trzymana w polu instancji przepuscilaby ten wyscig.
    const a = createTokeny({ db, kanal: 'allegro_szkicownia', ustawienia, fetchImpl });
    const b = createTokeny({ db, kanal: 'allegro_szkicownia', ustawienia, fetchImpl });

    const oba = Promise.all([a.waznyToken(), b.waznyToken()]);
    zwolnij();
    const [pierwszy, drugi] = await oba;

    expect(wyslaneTokeny).toEqual(['STARY_R']);
    expect(pierwszy).toBe('NOWY');
    expect(drugi).toBe('NOWY');
    expect(a.stan().refresh_token).toBe('NOWY_R');
  });

  it('inny kanał w tej samej bazie NIE jest blokowany przez trwające odświeżenie', async () => {
    const db = baza();
    for (const kanal of ['allegro_szkicownia', 'allegro_pro']) {
      zapiszTokeny(db, kanal, {
        accessToken: 'STARY', refreshToken: `STARY_R_${kanal}`, wygasaAt: zaDni(-1), refreshWygasaAt: zaDni(80),
      });
    }
    let zwolnij;
    const wstrzymanie = new Promise((res) => { zwolnij = res; });
    const fetchImpl = async (url, opcje) => {
      const stary = new URLSearchParams(String(opcje.body)).get('refresh_token');
      await wstrzymanie;
      return odpowiedz({ access_token: `NOWY_${stary}`, refresh_token: 'NOWY_R', expires_in: 43199 });
    };
    const a = createTokeny({ db, kanal: 'allegro_szkicownia', ustawienia, fetchImpl });
    const b = createTokeny({ db, kanal: 'allegro_pro', ustawienia, fetchImpl });

    const oba = Promise.all([a.waznyToken(), b.waznyToken()]);
    zwolnij();
    expect(await oba).toEqual(['NOWY_STARY_R_allegro_szkicownia', 'NOWY_STARY_R_allegro_pro']);
  });

  // ⚠️ TA SAMA LEKCJA CO BLOKADA POLLERA (`wTrakcie` w services/poller.js): blokada
  // niezwolniona po BLEDZIE wycisza kanal na zawsze, i to cicho — panel dalej dziala.
  it('nieudane odświeżenie ZWALNIA blokadę: następna próba znów wychodzi do sieci', async () => {
    const db = baza();
    zapiszTokeny(db, 'allegro_szkicownia', {
      accessToken: 'STARY', refreshToken: 'STARY_R', wygasaAt: zaDni(-1), refreshWygasaAt: zaDni(80),
    });
    let prob = 0;
    const fetchImpl = async () => {
      prob += 1;
      if (prob === 1) return odpowiedz({ error: 'server_error' }, { ok: false, status: 503 });
      return odpowiedz({ access_token: 'NOWY', refresh_token: 'NOWY_R', expires_in: 43199 });
    };
    const t = createTokeny({ db, kanal: 'allegro_szkicownia', ustawienia, fetchImpl });

    await expect(t.waznyToken()).rejects.toThrow(/odrzucone/i);
    // Druga instancja — blokada nie ma prawa przezyc ani bledu, ani zmiany instancji.
    const t2 = createTokeny({ db, kanal: 'allegro_szkicownia', ustawienia, fetchImpl });
    expect(await t2.waznyToken()).toBe('NOWY');
    expect(prob).toBe(2);
  });

  // Wywolanie, ktore weszlo do kolejki, gdy inne wlasnie konczylo odswiezanie, ma dostac
  // token ZAPISANY w bazie, a nie poleciec spalonym refresh tokenem ze swojego odczytu.
  it('drugie wywołanie, które przyszło tuż po zakończonym odświeżeniu, NIE wychodzi do sieci', async () => {
    const db = baza();
    zapiszTokeny(db, 'allegro_szkicownia', {
      accessToken: 'STARY', refreshToken: 'STARY_R', wygasaAt: zaDni(-1), refreshWygasaAt: zaDni(80),
    });
    let prob = 0;
    const fetchImpl = async () => {
      prob += 1;
      return odpowiedz({ access_token: 'NOWY', refresh_token: 'NOWY_R', expires_in: 43199 });
    };
    const t = createTokeny({ db, kanal: 'allegro_szkicownia', ustawienia, fetchImpl });

    expect(await t.waznyToken()).toBe('NOWY');
    expect(await t.waznyToken()).toBe('NOWY');
    expect(prob).toBe(1);
  });
});

// ⚠️ „Trzeba polaczyc kanal ponownie" znaczy: WSTAN OD BIURKA i przejdz device flow
// w przegladarce. To zdanie ma byc prawdziwe, bo inaczej albo wysyla czlowieka na darmo
// (503), albo kaze mu klikac zamiast poprawic plik z poswiadczeniami (invalid_client).
describe('komunikat odmowy mówi PRAWDĘ o tym, co człowiek ma zrobić', () => {
  const zOdmowa = (dane, status) => {
    const db = baza();
    zapiszTokeny(db, 'allegro_szkicownia', {
      accessToken: 'STARY', refreshToken: 'STARY_R', wygasaAt: zaDni(-1), refreshWygasaAt: zaDni(80),
    });
    const t = createTokeny({
      db, kanal: 'allegro_szkicownia', ustawienia,
      fetchImpl: async () => odpowiedz(dane, { ok: false, status }),
    });
    return t;
  };

  it('5xx to usterka PRZEJŚCIOWA — nie każe niczego łączyć ponownie', async () => {
    const t = zOdmowa({ error: 'server_error' }, 503);
    await expect(t.waznyToken()).rejects.toThrow();

    const opis = t.stan().ostatni_blad;
    expect(opis).toMatch(/503/);
    // ⚠️ To jest sedno poprawki: przy 503 zadne „polacz kanal ponownie" nie jest prawda —
    // panel wyjdzie z tego SAM. Asercje sa na zdaniach, ktore ma WYLACZNIE galaz 5xx:
    // ogolny komunikat („nie wiadomo, czy przejsciowa") tez zawiera slowo „przejsciowa",
    // wiec sprawdzanie samego slowa przepuszczaloby usunieta galaz.
    expect(opis).toMatch(/panel spróbuje ponownie/i);
    expect(opis).toMatch(/NIE łącz kanału ponownie/);
    expect(opis).not.toMatch(/nie wiadomo/i);
  });

  it('invalid_client to ZŁE POŚWIADCZENIA W KONFIGURACJI — device flow tego nie naprawi', async () => {
    const t = zOdmowa({ error: 'invalid_client' }, 401);
    await expect(t.waznyToken()).rejects.toThrow();

    const opis = t.stan().ostatni_blad;
    expect(opis).toMatch(/invalid_client/);
    expect(opis).toMatch(/konfiguracj/i);
    expect(opis).toMatch(/NIC tu nie da/);
    expect(opis).not.toMatch(/nie wiadomo/i);
  });

  it('invalid_grant to JEDYNY przypadek, w którym naprawdę trzeba połączyć kanał ponownie', async () => {
    const t = zOdmowa({ error: 'invalid_grant' }, 400);
    await expect(t.waznyToken()).rejects.toThrow();

    const opis = t.stan().ostatni_blad;
    expect(opis).toMatch(/invalid_grant/);
    expect(opis).toMatch(/Kanał sam z tego nie wyjdzie/i);
    expect(opis).toMatch(/Połącz z Allegro/);
    expect(opis).not.toMatch(/nie wiadomo/i);
  });

  it('odmowa bez kodu OAuth nie zgaduje: mówi, że nie wiadomo, i nie wysyła nikogo na darmo', async () => {
    const t = zOdmowa({}, 400);
    await expect(t.waznyToken()).rejects.toThrow();

    const opis = t.stan().ostatni_blad;
    expect(opis).toMatch(/400/);
    expect(opis).toMatch(/nie wiadomo/i);
  });

  // ⚠️ NIEZMIENNIK 4.10. Kod bledu OAuth wolno przeczytac, ale tylko wtedy, gdy WYGLADA jak
  // kod OAuth. Serwer, ktory wsadzi w to pole cokolwiek innego, nie ma jak przemycic
  // sekretu do bazy ani na ekran — a `error_description` nie jest czytane nigdzie.
  it('pole `error` o dziwnym kształcie NIE trafia do bazy (mogłoby nieść cokolwiek)', async () => {
    const t = zOdmowa({ error: 'Basic aWQ6c2VrcmV0 odrzucony', error_description: 'sekret=SEKRET_X' }, 400);
    await expect(t.waznyToken()).rejects.toThrow();

    const opis = t.stan().ostatni_blad;
    expect(opis).not.toContain('aWQ6c2VrcmV0');
    expect(opis).not.toContain('SEKRET_X');
    expect(opis).toMatch(/nie wiadomo/i);
  });
});

// Slad bez daty jest gorszy niz brak sladu: operator zobaczy swiezy blad obok
// `zaktualizowane_at` z ostatniego SUKCESU i uzna go za stara sprawe, ktora ktos juz zamknal.
describe('ślad po błędzie niesie WŁASNY znacznik czasu', () => {
  it('zapiszBladTokenu odświeża zaktualizowane_at, a nie zostawia daty ostatniego sukcesu', () => {
    const db = baza();
    zapiszTokeny(db, 'allegro_szkicownia', {
      accessToken: 'a', refreshToken: 'r', wygasaAt: zaDni(1), refreshWygasaAt: zaDni(80),
    });
    // Udany zapis sprzed trzech dni — dokladnie ta sytuacja, ktora myli operatora.
    const trzyDniTemu = new Date(Date.now() - 3 * 86400000).toISOString();
    db.prepare('UPDATE tokeny_kanalu SET zaktualizowane_at = ? WHERE kanal = ?').run(trzyDniTemu, 'allegro_szkicownia');

    zapiszBladTokenu(db, 'allegro_szkicownia', 'Odświeżenie tokenu odrzucone (HTTP 400).');

    const w = wczytajTokeny(db, 'allegro_szkicownia');
    expect(w.ostatni_blad).toMatch(/400/);
    expect(w.zaktualizowane_at).not.toBe(trzyDniTemu);
    expect(Date.now() - Date.parse(w.zaktualizowane_at)).toBeLessThan(5000);
  });
});

// ⚠️ BLAD POLACZENIOWY: DWIE SCIEZKI, DWIE DECYZJE — i to jest decyzja, nie przeoczenie.
//
// W device flow (`dokonczPowiazanie`) wyjatek z `fetch` zamieniamy w powod PONAWIALNY, bo
// `device_code` jest wielokrotnego uzytku, a po drugiej stronie stoi czlowiek z waznym
// kodem. Przy odswiezaniu jest odwrotnie: REFRESH TOKEN ALLEGRO JEST JEDNORAZOWY, a wyjatek
// z `fetch` jest nierozstrzygalny — zadanie moglo dojsc i zrotowac pare, urywajac sie
// dopiero na odpowiedzi. Ponowienie byloby wtedy REUZYCIEM, po ktorym Allegro potrafi
// uniewaznic cala rodzine tokenow, czyli zabic kanal az do wizyty czlowieka. Poller tyka
// co 2 minuty i sam sprobuje ponownie, czytajac wiersz z bazy NA NOWO.
describe('odświeżanie tokenu po błędzie sieci NIE PONAWIA — refresh token jest jednorazowy', () => {
  it('wyjątek z fetch leci w górę po JEDNYM żądaniu i NIE RUSZA pary w bazie', async () => {
    const db = baza();
    zapiszTokeny(db, 'allegro_szkicownia', {
      accessToken: 'STARY', refreshToken: 'STARY_R', wygasaAt: zaDni(-1), refreshWygasaAt: zaDni(80),
    });
    let wywolan = 0;
    const t = createTokeny({
      db,
      kanal: 'allegro_szkicownia',
      ustawienia,
      fetchImpl: async () => {
        wywolan += 1;
        throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
      },
    });

    await expect(t.waznyToken()).rejects.toThrow();
    // ⚠️ DOKLADNIE JEDNO. Kazde kolejne poleciałoby tokenem, ktory Allegro mogl juz zrotowac.
    expect(wywolan).toBe(1);
    // Para zostaje NIETKNIETA — najblizszy przebieg pollera sprobuje nia jeszcze raz.
    const w = wczytajTokeny(db, 'allegro_szkicownia');
    expect(w.refresh_token).toBe('STARY_R');
    expect(w.access_token).toBe('STARY');
  });

  it('kolejne wywołanie po błędzie sieci znów PRÓBUJE — blokada odświeżania została zwolniona', async () => {
    const db = baza();
    zapiszTokeny(db, 'allegro_szkicownia', {
      accessToken: 'STARY', refreshToken: 'STARY_R', wygasaAt: zaDni(-1), refreshWygasaAt: zaDni(80),
    });
    let wywolan = 0;
    const t = createTokeny({
      db,
      kanal: 'allegro_szkicownia',
      ustawienia,
      fetchImpl: async () => {
        wywolan += 1;
        if (wywolan === 1) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
        return odpowiedz({ access_token: 'NOWY', refresh_token: 'NOWY_R', expires_in: 43199 });
      },
    });

    await expect(t.waznyToken()).rejects.toThrow();
    // ⚠️ Niezwolniona blokada wyciszylaby kanal DO RESTARTU PROCESU — cicho, bo panel dalej
    // dziala. Ponowienie robi tu POLLER przy nastepnym tyknieciu, a nie petla w kodzie.
    expect(await t.waznyToken()).toBe('NOWY');
    expect(wczytajTokeny(db, 'allegro_szkicownia').refresh_token).toBe('NOWY_R');
    expect(wywolan).toBe(2);
  });
});

// ⚠️ SQLite, inaczej niz reszta swiata, DOPUSZCZA NULL w kolumnie TEXT PRIMARY KEY —
// a `ON CONFLICT(kanal)` NULL-i ze soba nie sklei. Bez `NOT NULL` kazdy zapis z pustym
// kanalem dokladalby NOWY wiersz z para tokenow zamiast nadpisac poprzedni.
describe('klucz tabeli tokenów nie przyjmuje NULL-a', () => {
  it('zapis z pustym kanałem jest ODRZUCANY, a nie dokłada kolejnego wiersza', () => {
    const db = baza();
    const zapisz = () => zapiszTokeny(db, null, {
      accessToken: 'a', refreshToken: 'r', wygasaAt: zaDni(1), refreshWygasaAt: zaDni(80),
    });

    expect(zapisz).toThrow(/NOT NULL/i);
    expect(zapisz).toThrow(/NOT NULL/i);
    expect(db.prepare('SELECT COUNT(*) AS ile FROM tokeny_kanalu').get().ile).toBe(0);
  });
});

// ⚠️ Tabela ma powstac takze w bazie JUZ ISTNIEJACEJ na produkcji — tej z prawdziwymi
// numerami listow przewozowych. Tabele (inaczej niz KOLUMNY, ktore dokladamy lista DOLOZ
// w db/db.js) zaklada `CREATE TABLE IF NOT EXISTS` w schema.sql, wykonywany przy KAZDYM
// otwarciu bazy — ten test pilnuje, ze tak faktycznie jest i ze zalozenie tabeli niczego
// w tej bazie nie rusza.
describe('tabela tokenow w bazie JUZ ISTNIEJACEJ', () => {
  it('powstaje przy otwarciu starej bazy i nie tyka danych, ktore juz w niej leza', () => {
    // Wyjątek zatwierdzony przez właściciela 2026-09-30: odmowa niezgodnego baseline + prawidłowe reopen.
    potwierdzOdmoweHistorycznegoSchema(["DROP TABLE tokeny_kanalu"], ['tokeny_kanalu']);
    const plik = join(mkdtempSync(join(tmpdir(), 'oms-tokeny-')), 'oms.sqlite');
    const pierwsza = openOmsDb(plik);
    pierwsza.prepare(
      "INSERT INTO zamowienia (sklep, zrodlo_id, numer, kwota_brutto, utworzone_at)"
      + " VALUES ('szkicownia', 1267, '1267', '123.45', '2026-07-29')",
    ).run();
    pierwsza.prepare(
      'INSERT INTO przesylki (zamowienie_id, kurier, status, numer_listu, utworzona_at)'
      + " VALUES (1, 'dpd', 'nadana', '0000123456789A', '2026-07-29T13:00:00')",
    ).run();
    // Poprawny baseline już zawiera tabelę; normalne reopen ma zachować dane.
    pierwsza.close();

    const druga = openOmsDb(plik);
    expect(
      druga.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tokeny_kanalu'").get(),
    ).toBeTruthy();
    // Numer listu przewozowego i kwota zamowienia maja byc DOKLADNIE takie, jak byly.
    const przesylka = druga.prepare('SELECT numer_listu FROM przesylki WHERE zamowienie_id = 1').get();
    expect(przesylka.numer_listu).toBe('0000123456789A');
    expect(druga.prepare('SELECT kwota_brutto FROM zamowienia WHERE id = 1').get().kwota_brutto).toBe('123.45');

    zapiszTokeny(druga, 'allegro_szkicownia', {
      accessToken: 'a', refreshToken: 'r', wygasaAt: zaDni(1), refreshWygasaAt: zaDni(80),
    });
    expect(wczytajTokeny(druga, 'allegro_szkicownia').access_token).toBe('a');
    druga.close();

    // Kolejne otwarcie oznaczonego baseline nie ma prawa skasować zapisanej pary.
    const trzecia = openOmsDb(plik);
    expect(wczytajTokeny(trzecia, 'allegro_szkicownia').refresh_token).toBe('r');
    trzecia.close();
  });
});
