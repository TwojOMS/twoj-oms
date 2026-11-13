// PRZ-119.11a — piaskownica na koncie próbnym Fakturowni. Profil z prywatnego pliku (domyślnie
// /konfiguracja/fakturownia-proba.json), transport przypięty do jednej domeny konta, odmowa KSeF w dwóch warstwach
// (adapter i transport), automat KSeF wyłączony, `oid` ze znacznikiem bazy, odmowa w demo publicznym, porównanie IP
// zapory z DNS dla `stan`. Zero sieci: fetch podmieniony (szpieg), domeny i tokeny zmyślone („Pracownia Półcień”).
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { openOmsDb } from '../../src/oms/db/db.ts';
import { zapiszKonfiguracjeIntegracji } from '../../src/oms/db/konfiguracja-integracji.js';
import { modulyPiaskownicy } from '../../deploy/proba/atrapy/index.mjs';
import { ENV_DEMO } from '../../scripts/demo-dane.mjs';
import {
  wczytajProfilFakturowni, transportFakturowniProby, SCIEZKA_PROFILU_FAKTUROWNI,
} from '../../deploy/proba/atrapy/fakturownia-proba.ts';
import { ODMOWA_KSEF_PIASKOWNICY } from '../../src/integracje/programy/fakturownia.ts';
import { porownajIpFakturowni } from '../../deploy/proba/fakturownia-ip.mjs';

const DOMENA = 'pracownia-polcien';
const TOKEN = 'zmyslony-token-polcien-proba-0001';
const ZDANIE_KSEF = 'Piaskownica: wysyłka do KSeF przez prawdziwą Fakturownię jest wyłączona — sprawdzisz ją na atrapie.';
const katalogi = [];
const katalog = () => { const k = fs.mkdtempSync(path.join(os.tmpdir(), 'prz-119-11a-')); katalogi.push(k); return k; };
afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of katalogi.splice(0)) fs.rmSync(k, { recursive: true, force: true });
});
const ENV = () => ({ ...ENV_DEMO, OMS_TRYB: 'proba', OMS_PROFORMY_KATALOG: katalog() });
function profil(tresc = { srodowisko: 'proba', domena: DOMENA }) {
  const plik = path.join(katalog(), 'fakturownia-proba.json');
  fs.writeFileSync(plik, typeof tresc === 'string' ? tresc : JSON.stringify(tresc));
  return plik;
}
const json = (cialo, status = 200) => new Response(JSON.stringify(cialo), { status, headers: { 'content-type': 'application/json' } });
const FIX = new URL('../fixtures/fakturownia/F04-faktura-minimalna.json', import.meta.url);
const odpowiedzF04 = () => JSON.parse(fs.readFileSync(FIX, 'utf8')).wymiany[1].odpowiedz.cialo;

/** Udawana Fakturownia za globalnym fetch: zapisuje każde żądanie. */
function udawanaSiec() {
  const zadania = [];
  const siec = vi.fn(async (url, opcje = {}) => {
    const u = new URL(String(url));
    zadania.push({ url: String(url), metoda: opcje.method ?? 'GET', cialo: opcje.body ?? null, redirect: opcje.redirect });
    if (opcje.method === 'POST' && u.pathname === '/invoices.json') return json(odpowiedzF04(), 201);
    if (u.pathname === '/clients.json') return json([]);
    if (u.pathname === '/invoices.json') return json([]);
    if (u.pathname === '/account.json') return json({ prefix: DOMENA });
    return json({ status: 404 }, 404);
  });
  vi.stubGlobal('fetch', siec);
  return { siec, zadania };
}

function zbuduj({ env = ENV(), sciezka, db = openOmsDb() } = {}) {
  zapiszKonfiguracjeIntegracji(db, 'program_fakturowy', { ustawienia: { program: 'fakturownia' }, sekrety: {} });
  zapiszKonfiguracjeIntegracji(db, 'fakturownia', { ustawienia: { domena: DOMENA }, sekrety: { token: TOKEN } });
  const faktury = modulyPiaskownicy(env, { baza: () => db, profilFakturowni: sciezka }).find((m) => m.nazwa === 'faktury');
  const obce = { 'kanaly.klienciKanalow': { lampy: {} }, 'kanaly.config': { definicje: [], sklepy: {} } };
  const usluga = (m, n) => { const k = `${m}.${n}`; if (!Object.hasOwn(obce, k)) throw new Error(k); return obce[k]; };
  const z = faktury.zbuduj({ db, konfiguracja: faktury.konfiguracja(env), teraz: () => new Date('2026-11-12T10:00:00Z'), log: () => {}, usluga });
  return { db, uslugi: z.uslugi };
}

describe('PRZ-119.11a profil próby Fakturowni — plik', () => {
  it('domyślna ścieżka to prywatny katalog konfiguracji kontenera', () => {
    expect(SCIEZKA_PROFILU_FAKTUROWNI).toBe('/konfiguracja/fakturownia-proba.json');
  });

  it('brak pliku = null (atrapa); poprawny plik = { srodowisko, domena }', () => {
    expect(wczytajProfilFakturowni({ OMS_TRYB: 'proba' }, { sciezka: path.join(katalog(), 'brak.json') })).toBeNull();
    expect(wczytajProfilFakturowni({ OMS_TRYB: 'proba' }, { sciezka: profil() })).toEqual({ srodowisko: 'proba', domena: DOMENA });
  });

  it('plik z domeną spoza wzoru, z tokenem, z innym środowiskiem albo nie-JSON = odmowa bez wypisywania pliku', () => {
    const zle = [
      { srodowisko: 'proba', domena: `${DOMENA}.fakturownia.pl` },
      { srodowisko: 'proba', domena: 'Pracownia-Polcien' },
      { srodowisko: 'produkcja', domena: DOMENA },
      { srodowisko: 'proba', domena: DOMENA, token: TOKEN },
      `{"srodowisko":"proba","domena":"${DOMENA}"`,
    ];
    for (const t of zle) {
      const f = () => wczytajProfilFakturowni({ OMS_TRYB: 'proba' }, { sciezka: profil(t) });
      expect(f, JSON.stringify(t)).toThrow(/profil/i);
      try { f(); } catch (e) { expect(String(e.message)).not.toContain(TOKEN); }
    }
  });

  it('demo publiczne z plikiem profilu = odmowa startu (login i hasło demo osobno), także przez moduły piaskownicy', () => {
    const plik = profil();
    const ZDANIE = /Prawdziwa Fakturownia jest dostępna tylko w prywatnej piaskownicy/;
    expect(() => wczytajProfilFakturowni({ OMS_TRYB: 'proba', OMS_DEMO_LOGIN: 'gosc' }, { sciezka: plik })).toThrow(ZDANIE);
    expect(() => wczytajProfilFakturowni({ OMS_TRYB: 'proba', OMS_DEMO_HASLO: 'gosc' }, { sciezka: plik })).toThrow(ZDANIE);
    expect(() => wczytajProfilFakturowni({ OMS_TRYB: 'produkcja' }, { sciezka: plik })).toThrow(ZDANIE);
    expect(() => modulyPiaskownicy({ ...ENV(), OMS_DEMO_LOGIN: 'gosc', OMS_DEMO_HASLO: 'gosc' }, { profilFakturowni: plik })).toThrow(ZDANIE);
    // Bez pliku demo startuje jak dotąd.
    expect(() => modulyPiaskownicy({ ...ENV(), OMS_DEMO_LOGIN: 'gosc', OMS_DEMO_HASLO: 'gosc' },
      { profilFakturowni: path.join(katalog(), 'brak.json') })).not.toThrow();
  });
});

describe('PRZ-119.11a transport próby — tylko https://<domena>.fakturownia.pl', () => {
  const ZLE = [
    'https://app.fakturownia.pl/invoices.json',
    'https://inna.fakturownia.pl/invoices.json',
    `https://${DOMENA}.fakturownia.pl.evil.pl/invoices.json`,
    `https://u:p@${DOMENA}.fakturownia.pl/invoices.json`,
    `https://${DOMENA}.fakturownia.pl:8443/invoices.json`,
    `http://${DOMENA}.fakturownia.pl/invoices.json`,
    'https://fakturownia.pl/invoices.json',
    `https://${DOMENA}.fakturownia.pl/invoices.json#x`,
  ];
  it.each(ZLE)('%s → wyjątek przed siecią', async (adres) => {
    const szpieg = vi.fn(async () => json({}));
    const t = transportFakturowniProby({ domena: DOMENA, fetchImpl: szpieg });
    await expect(t(adres, { method: 'GET' })).rejects.toThrow();
    expect(szpieg).not.toHaveBeenCalled();
  });

  it('send_to_ksef dopisane ręcznie i gov_save_and_send w treści → wyjątek przed siecią', async () => {
    const szpieg = vi.fn(async () => json({}));
    const t = transportFakturowniProby({ domena: DOMENA, fetchImpl: szpieg });
    const baza = `https://${DOMENA}.fakturownia.pl`;
    await expect(t(`${baza}/invoices/1.json?send_to_ksef=yes`)).rejects.toThrow(/KSeF/);
    await expect(t(`${baza}/invoices/1.json?send%5Fto%5Fksef=yes`)).rejects.toThrow(/KSeF/);
    await expect(t(`${baza}/invoices.json`, { method: 'POST', body: JSON.stringify({ invoice: { gov_save_and_send: true } }) }))
      .rejects.toThrow(/KSeF/);
    const ksef = JSON.stringify({ invoice: { gov_save_and_send: true } });
    for (const body of [new TextEncoder().encode(ksef), new Blob([ksef]), new URLSearchParams({ gov_save_and_send: '1' })]) {
      await expect(t(`${baza}/invoices.json`, { method: 'POST', body })).rejects.toThrow();
    }
    expect(szpieg).not.toHaveBeenCalled();
  });

  it('dozwolony adres: jedno żądanie, redirect „error”, bez ponowień po błędzie sieci', async () => {
    const ok = vi.fn(async () => json({ ok: 1 }));
    const r = await transportFakturowniProby({ domena: DOMENA, fetchImpl: ok })(`https://${DOMENA}.fakturownia.pl/invoices.json?page=1`, { method: 'GET' });
    expect(r.status).toBe(200);
    expect(ok).toHaveBeenCalledTimes(1);
    expect(ok.mock.calls[0][1].redirect).toBe('error');
    const pada = vi.fn(async () => { throw new TypeError('fetch failed'); });
    await expect(transportFakturowniProby({ domena: DOMENA, fetchImpl: pada })(`https://${DOMENA}.fakturownia.pl/invoices.json`)).rejects.toThrow();
    expect(pada).toHaveBeenCalledTimes(1);
  });
});

describe('PRZ-119.11a moduł faktur piaskownicy z profilem i bez', () => {
  it('bez pliku profilu, z tokenem w bazie → atrapa, zero żądań sieciowych', async () => {
    const { siec } = udawanaSiec();
    const { db, uslugi } = zbuduj({ sciezka: path.join(katalog(), 'brak.json') });
    expect(uslugi.konfiguracjaProgramu.atrapa).toBe(true);
    await uslugi.programFakturowy.sprawdzPolaczenie().catch(() => {});
    await uslugi.programFakturowy.listaFaktur({}).catch(() => {});
    expect(siec).not.toHaveBeenCalled();
    db.close();
  });

  it('z profilem: prawdziwy klient wyłącznie na domenę z pliku, redirect „error”', async () => {
    const { zadania } = udawanaSiec();
    const { db, uslugi } = zbuduj({ sciezka: profil() });
    expect(uslugi.konfiguracjaProgramu.atrapa).toBe(false);
    await uslugi.programFakturowy.sprawdzPolaczenie().catch(() => {});
    expect(zadania.length).toBeGreaterThan(0);
    for (const z of zadania) {
      expect(new URL(z.url).origin).toBe(`https://${DOMENA}.fakturownia.pl`);
      expect(z.redirect).toBe('error');
    }
    db.close();
  });

  it('z profilem i inną domeną w zapisie ekranu → 400, zero żądań', async () => {
    const { siec } = udawanaSiec();
    const db = openOmsDb();
    const { uslugi } = zbuduj({ sciezka: profil(), db });
    zapiszKonfiguracjeIntegracji(db, 'fakturownia', { ustawienia: { domena: 'inna-firma' }, sekrety: { token: TOKEN } });
    await expect(uslugi.programFakturowy.sprawdzPolaczenie()).rejects.toMatchObject({ status: 400 });
    expect(siec).not.toHaveBeenCalled();
    db.close();
  });

  it('wyslijDokumentDoKsef w profilu → 4xx ze zdaniem planu, zero żądań', async () => {
    expect(ODMOWA_KSEF_PIASKOWNICY).toBe(ZDANIE_KSEF);
    const { siec } = udawanaSiec();
    const { db, uslugi } = zbuduj({ sciezka: profil() });
    const blad = await uslugi.programFakturowy.wyslijDokumentDoKsef('595670707').then(() => null, (e) => e);
    expect(blad?.message).toBe(ZDANIE_KSEF);
    expect(blad.status).toBeGreaterThanOrEqual(400);
    expect(blad.status).toBeLessThan(500);
    expect(siec).not.toHaveBeenCalled();
    db.close();
  });

  it('automat KSeF w profilu: włączony w Ustawieniach, pora minęła — przebieg nic nie woła, stan „wyłączony — piaskownica”', async () => {
    const { siec } = udawanaSiec();
    const { db, uslugi } = zbuduj({ sciezka: profil() });
    const wpis = db.prepare("INSERT INTO ustawienia (klucz, wartosc, zmienione_at) VALUES (?, ?, '2026-11-12')");
    wpis.run('ksef.automat.wlaczony', '1');
    wpis.run('ksef.automat.godzina', '00:00');
    const wysylka = vi.spyOn(uslugi.wysylkaKsef, 'wyslij');
    for (let i = 0; i < 2; i++) {
      expect(await uslugi.automatKsef.przebieg()).toEqual({ pominiety: true, powod: 'wyłączony — piaskownica' });
    }
    expect(uslugi.automatKsef.stan()).toMatchObject({ wlaczony: false, wylaczony: 'wyłączony — piaskownica' });
    expect(wysylka).not.toHaveBeenCalled();
    expect(siec).not.toHaveBeenCalled();
    // Żadnego zapisu wyniku ani dnia przebiegu co przebieg.
    expect(db.prepare("SELECT klucz FROM ustawienia WHERE klucz IN ('ksef.automat.wynik', 'ksef.automat.ostatni_przebieg')").all()).toEqual([]);
    db.close();
  });

  it('oid w profilu = proba-<znacznik bazy>-<numer>; dwie bazy (reset) → dwa różne oid; bez profilu oid bez zmian', async () => {
    const { zadania } = udawanaSiec();
    const NABYWCA = { firma: 'Pracownia Półcień sp. z o.o.', nip: '1234563218', ulica: 'Zmyślona 1', kod: '00-001', miasto: 'Warszawa', kraj: 'PL', email: 'biuro@polcien.example' };
    const ladunek = { invoice_date: '2026-11-12', sale_date: '2026-11-12', payment_date: '2026-11-19',
      services: [{ name: 'Lampa (zmyślona)', quantity: 1, gross_price: 12300, tax_symbol: '23' }] };
    const wystaw = async (uslugi) => {
      const { client_id } = await uslugi.programFakturowy.przygotujNabywce(NABYWCA, { zalozGdyBrak: true });
      await uslugi.programFakturowy.wystaw({ client_id, ...ladunek }, { oid: 'ZAM-41' });
      const post = zadania.filter((z) => z.metoda === 'POST' && new URL(z.url).pathname === '/invoices.json').at(-1);
      return JSON.parse(post.cialo).invoice;
    };
    const plik = profil();
    const a = zbuduj({ sciezka: plik });
    const b = zbuduj({ sciezka: plik });
    const oidA = (await wystaw(a.uslugi)).oid;
    const oidA2 = (await wystaw(a.uslugi)).oid;
    const oidB = (await wystaw(b.uslugi)).oid;
    expect(oidA).toMatch(/^proba-[a-z0-9]{8}-ZAM-41$/);
    expect(oidA2).toBe(oidA);
    expect(oidB).toMatch(/^proba-[a-z0-9]{8}-ZAM-41$/);
    expect(oidB).not.toBe(oidA);
    a.db.close(); b.db.close();
  });
});

describe('PRZ-119.11a porównanie IP zapory z DNS (stan)', () => {
  const zPliku = (tresc) => () => { if (tresc === null) { const e = new Error('brak'); e.code = 'ENOENT'; throw e; } return tresc; };
  it('brak pliku → zdanie o T7', async () => {
    const z = await porownajIpFakturowni({ domena: DOMENA, czytaj: zPliku(null), resolve4: async () => ['203.0.113.10'] });
    expect(z).toMatch(/brak pliku/i);
    expect(z.split('\n')).toHaveLength(1);
  });
  it('DNS w pliku → zgodne; DNS spoza pliku → odśwież poleceniem z T7', async () => {
    const zgodne = await porownajIpFakturowni({ domena: DOMENA, czytaj: zPliku('203.0.113.10\n203.0.113.11\n'), resolve4: async () => ['203.0.113.11', '203.0.113.10'] });
    expect(zgodne).toMatch(/zgodne/);
    const rozne = await porownajIpFakturowni({ domena: DOMENA, czytaj: zPliku('203.0.113.10\n'), resolve4: async () => ['198.51.100.7'] });
    expect(rozne).toMatch(/198\.51\.100\.7/);
    expect(rozne).toMatch(/T7/);
    expect(rozne.split('\n')).toHaveLength(1);
  });
  it('błąd DNS → jedno zdanie, bez wyjątku; pyta o <domena>.fakturownia.pl', async () => {
    const resolve4 = vi.fn(async () => { throw Object.assign(new Error('x'), { code: 'ENOTFOUND' }); });
    const z = await porownajIpFakturowni({ domena: DOMENA, czytaj: zPliku('203.0.113.10\n'), resolve4 });
    expect(resolve4).toHaveBeenCalledWith(`${DOMENA}.fakturownia.pl`);
    expect(z).toMatch(/DNS/);
  });
});

describe('PRZ-161 profil „dowolna domena” ("domena":"*") — próba jak inny sklep', () => {
  const GWIAZDKA = { srodowisko: 'proba', domena: '*' };
  it('plik z "*" jest poprawny; inne znaki spoza wzoru nadal odmowa', () => {
    expect(wczytajProfilFakturowni({ OMS_TRYB: 'proba' }, { sciezka: profil(GWIAZDKA) })).toEqual(GWIAZDKA);
    expect(() => wczytajProfilFakturowni({ OMS_TRYB: 'proba' }, { sciezka: profil({ srodowisko: 'proba', domena: '**' }) })).toThrow(/profil/i);
    expect(() => wczytajProfilFakturowni({ OMS_TRYB: 'proba', OMS_DEMO_LOGIN: 'gosc' }, { sciezka: profil(GWIAZDKA) }))
      .toThrow(/Prawdziwa Fakturownia jest dostępna tylko w prywatnej piaskownicy/);
  });
  it.each([
    'https://evil.pl/invoices.json',
    // Jedna kropka i prefiks zgodny ze wzorem po ucięciu 15 znaków — zatrzymuje go tylko sprawdzenie końcówki hosta.
    'https://zlodziej-abcdefghij.com/invoices.json',
    `https://${DOMENA}.fakturownia.pl.evil.pl/invoices.json`,
    'https://a.b.fakturownia.pl/invoices.json',
    'https://fakturownia.pl/invoices.json',
    `http://${DOMENA}.fakturownia.pl/invoices.json`,
    `https://${DOMENA}.fakturownia.pl:8443/invoices.json`,
    `https://u:p@${DOMENA}.fakturownia.pl/invoices.json`,
  ])('transport „*”: %s → wyjątek przed siecią', async (adres) => {
    const szpieg = vi.fn(async () => json({}));
    await expect(transportFakturowniProby({ domena: '*', fetchImpl: szpieg })(adres, { method: 'GET' })).rejects.toThrow();
    expect(szpieg).not.toHaveBeenCalled();
  });
  it('transport „*”: każde konto <wzór>.fakturownia.pl przechodzi, KSeF nadal zablokowany', async () => {
    const szpieg = vi.fn(async () => json({}));
    const t = transportFakturowniProby({ domena: '*', fetchImpl: szpieg });
    await t('https://inna-firma.fakturownia.pl/invoices.json?page=1', { method: 'GET' });
    await t(`https://${DOMENA}.fakturownia.pl/invoices.json`, { method: 'GET' });
    expect(szpieg).toHaveBeenCalledTimes(2);
    await expect(t('https://inna-firma.fakturownia.pl/invoices/1.json?send_to_ksef=yes')).rejects.toThrow(/KSeF/);
    await expect(t('https://inna-firma.fakturownia.pl/invoices.json', { method: 'POST', body: JSON.stringify({ invoice: { gov_save_and_send: true } }) }))
      .rejects.toThrow(/KSeF/);
    expect(szpieg).toHaveBeenCalledTimes(2);
  });
  it('moduł: domena z ekranu (nie z pliku), ekran bez blokady domeny', async () => {
    const { zadania } = udawanaSiec();
    const db = openOmsDb();
    const { uslugi } = zbuduj({ sciezka: profil(GWIAZDKA), db });
    zapiszKonfiguracjeIntegracji(db, 'fakturownia', { ustawienia: { domena: 'inna-firma' }, sekrety: { token: TOKEN } });
    expect(uslugi.konfiguracjaFakturowni.domenaProby).toBeNull();
    await uslugi.programFakturowy.sprawdzPolaczenie().catch(() => {});
    await uslugi.konfiguracjaFakturowni.sprawdzPolaczenie().catch(() => {});
    expect(zadania.length).toBeGreaterThan(1);
    for (const z of zadania) {
      expect(new URL(z.url).origin).toBe('https://inna-firma.fakturownia.pl');
      expect(z.redirect).toBe('error');
    }
    db.close();
  });
});
