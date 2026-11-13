// PRZ-119.02 — klient HTTP Fakturowni na ZAPISANYCH odpowiedziach z pomiarów F1–F17
// (tests/fixtures/fakturownia/, konto próbne „firma-testowa”, dane zmyślone). Żadne żądanie nie wychodzi
// z procesu: fetch jest wstrzyknięty i odpowiada wyłącznie tym, co zapisano w pomiarze.
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createFakturowniaClient, METODY_FAKTUROWNI, LIMIT_ZADANIA_MS, STRONA_FAKTUROWNI, SUFIT_STRON,
} from '../../src/oms/fakturownia/client.js';
import { PROG_ZAWIESZONEJ_FAKTURY_MS } from '../../src/domena/faktura-stan.js';
import { utworzHttp } from '../../src/core/http.ts';

const FIX = fileURLToPath(new URL('../fixtures/fakturownia/', import.meta.url));
const pomiar = (nr) => JSON.parse(fs.readFileSync(path.join(FIX, fs.readdirSync(FIX).find((n) => n.startsWith(`${nr}-`))), 'utf8'));
const wymiana = (nr, i) => pomiar(nr).wymiany[i];

// Zmyślony token w kształcie tokenu Fakturowni (część po ukośniku = domena) — ukośnik daje inną postać
// zakodowaną (`%2F`), więc maskowanie samej surowej postaci nie wystarczy.
const DOMENA = 'firma-testowa';
const TOKEN = 'ZmyslonyTokenPolcien123/firma-testowa';
const ADRES = `https://${DOMENA}.fakturownia.pl`;
const ZAKAZANE = /send_to_ksef|gov_save_and_send|api_token/i;

/** Ten sam adres niezależnie od kolejności parametrów (pomiar F07 #35 ma `page` przed `kinds[]`). */
function klucz(url) {
  const u = new URL(url);
  const p = [...u.searchParams].map(([k, v]) => `${k}=${v}`).sort();
  return `${u.origin}${u.pathname}?${p.join('&')}`;
}

const json = (cialo, status = 200, naglowki = {}) => new Response(cialo === undefined ? null : JSON.stringify(cialo), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', ...naglowki },
});

/**
 * fetch, który zapisuje każde żądanie i odpowiada według `odpowiedz(zadanie)`.
 * `zadanie` = { url, metoda, naglowki, cialo, signal }.
 */
function nagrywacz(odpowiedz) {
  const zadania = [];
  const fetchImpl = async (url, opcje = {}) => {
    const zadanie = {
      url: String(url), metoda: opcje.method ?? 'GET', naglowki: { ...(opcje.headers ?? {}) },
      cialo: opcje.body ?? null, signal: opcje.signal,
    };
    zadania.push(zadanie);
    return odpowiedz(zadanie);
  };
  return { fetchImpl, zadania };
}

/** fetch odtwarzający wymiany z pomiaru: tylko adresy (i metody), które naprawdę padły na koncie próbnym. */
function zPomiaru(wymiany) {
  return nagrywacz((z) => {
    const w = wymiany.find((x) => x.zadanie.metoda === z.metoda && klucz(x.zadanie.url) === klucz(z.url));
    if (!w) throw new Error(`żądanie spoza pomiaru: ${z.metoda} ${z.url}`);
    return json(w.odpowiedz.cialo, w.odpowiedz.status);
  });
}

const klient = (fetchImpl, dodatki = {}) => createFakturowniaClient({ token: TOKEN, domena: DOMENA, fetchImpl, ...dodatki });
const cialoZadania = (w) => (typeof w.zadanie.cialo === 'string' ? JSON.parse(w.zadanie.cialo) : w.zadanie.cialo);
const blad = async (obietnica) => { try { await obietnica; } catch (e) { return e; } throw new Error('oczekiwano odmowy'); };

// Postacie tokenu, które serwer albo pośrednik mógłby odbić w treści błędu.
const POSTACIE_TOKENU = [
  TOKEN,
  encodeURIComponent(TOKEN),
  encodeURIComponent(TOKEN).replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()),
];
const bezTokenu = (tekst) => {
  for (const p of POSTACIE_TOKENU) expect(String(tekst)).not.toContain(p);
};

describe('PRZ-119.02 klient Fakturowni — stałe i budowa', () => {
  it('limit jednego żądania jest krótszy od progu zawieszonej faktury; strona 100, sufit 6 stron', () => {
    expect(LIMIT_ZADANIA_MS).toBe(60_000);
    expect(LIMIT_ZADANIA_MS).toBeLessThan(PROG_ZAWIESZONEJ_FAKTURY_MS);
    expect(STRONA_FAKTUROWNI).toBe(100);
    expect(SUFIT_STRON).toBe(6);
  });

  it('domena konta tylko z małych liter, cyfr i myślnika; bez tokenu klienta nie ma', () => {
    for (const zla of ['', 'Firma', '-firma', 'firma.zla', 'firma/x', 'a@b', 'x'.repeat(64), 'firma testowa']) {
      expect(() => createFakturowniaClient({ token: TOKEN, domena: zla, fetchImpl: async () => json([]) }), zla).toThrow(/domen/i);
    }
    expect(() => createFakturowniaClient({ token: '', domena: DOMENA, fetchImpl: async () => json([]) })).toThrow(/token/i);
    expect(() => klient(async () => json([]))).not.toThrow();
  });

  it('wstrzyknięty `http` → odmowa przy budowie (transport z ponowieniami powtórzyłby wysyłkę do KSeF)', () => {
    const http = utworzHttp({ fetchImpl: async () => json([]), czekaj: async () => {}, log: () => {} });
    expect(() => createFakturowniaClient({ token: TOKEN, domena: DOMENA, http })).toThrow(/http/);
    expect(() => createFakturowniaClient({ token: TOKEN, domena: DOMENA, fetchImpl: async () => json([]), http })).toThrow(/http/);
  });

  it('każde żądanie: Bearer w nagłówku, token nigdy w adresie, narzucony limit czasu (F01, F03)', async () => {
    const { fetchImpl, zadania } = zPomiaru([...pomiar('F01').wymiany, ...pomiar('F03').wymiany]);
    await expect(klient(fetchImpl).sprawdzPolaczenie()).resolves.toEqual({ ok: true });
    expect(zadania).toHaveLength(1);
    const [z] = zadania;
    expect(z.url).toBe(`${ADRES}/invoices.json?page=1&per_page=1`);
    expect(z.naglowki).toMatchObject({ Accept: 'application/json', Authorization: `Bearer ${TOKEN}` });
    expect(z.signal).toBeInstanceOf(AbortSignal);
    for (const p of POSTACIE_TOKENU) expect(z.url).not.toContain(p);
  });

  it('sprawdzPolaczenie: HTTP 200 bez tablicy to nie API Fakturowni', async () => {
    const e = await blad(klient(async () => json({ strona: 'pośrednik' })).sprawdzPolaczenie());
    expect(e.message).toMatch(/nie wygląda na API Fakturowni/);
  });
});

describe('PRZ-119.02 błędy na odpowiedziach z pomiaru', () => {
  it('401 przy złym tokenie i bez tokenu (F02): rozpoznanie po kodzie, bez adresu konta i treści serwera', async () => {
    for (const w of pomiar('F02').wymiany) {
      const e = await blad(klient(async () => json(w.odpowiedz.cialo, w.odpowiedz.status)).sprawdzPolaczenie());
      expect(e.status).toBe(401);
      expect(e.dlaOperatora).toBe(true);
      expect(e.message).toMatch(/Fakturownia nie przyjęła tokenu \(HTTP 401\)/);
      expect(e.message).not.toMatch(/firma-testowa|fakturownia\.pl|Musisz|zalogowany/);
      expect(JSON.stringify(e.tresc ?? null)).not.toMatch(/firma-testowa/);
      bezTokenu(e.message);
    }
  });

  it('401 przy zwykłej operacji też nie niesie adresu konta (F02 na liście faktur)', async () => {
    const w = wymiana('F02', 0);
    const e = await blad(klient(async () => json(w.odpowiedz.cialo, 401)).pobierzFakture(595670707));
    expect(e.status).toBe(401);
    expect(`${e.message} ${JSON.stringify(e.tresc ?? null)}`).not.toMatch(/firma-testowa|Musisz/);
  });

  it('404 (F10 #3): status 404 i „Not Found”', async () => {
    const { fetchImpl } = zPomiaru(pomiar('F10').wymiany);
    const e = await blad(klient(fetchImpl).pobierzFakture(987654321));
    expect(e.status).toBe(404);
    expect(e.message).toMatch(/Not Found/);
    expect(e.tresc).toEqual({ status: 404, error: 'Not Found' });
  });

  it('422 duplikat oid (F11 #11): status i treść pola oddane, decyzja należy do adaptera', async () => {
    const w = wymiana('F11', 11);
    const { fetchImpl, zadania } = zPomiaru([w]);
    const e = await blad(klient(fetchImpl).wystaw(cialoZadania(w).invoice));
    expect(zadania).toHaveLength(1);
    expect(e.status).toBe(422);
    expect(e.tresc).toEqual({ code: 'error', message: { oid: ['- zostało już zajęte'] } });
    expect(e.message).toMatch(/oid - zostało już zajęte/);
    expect(e.message).not.toMatch(/firma-testowa/);
  });

  it('429: status i sekundy z Retry-After (Fakturownia nie dławiła w F08, ale klient to rozumie)', async () => {
    const e = await blad(klient(async () => json({ code: 'error', message: 'Too many requests' }, 429, { 'Retry-After': '30' })).pobierzFakture(1));
    expect(e.status).toBe(429);
    expect(e.ponowZaS).toBe(30);
    expect(e.message).toMatch(/30 s/);
    const bez = await blad(klient(async () => json(null, 429)).pobierzFakture(1));
    expect(bez.status).toBe(429);
    expect(bez.ponowZaS).toBeUndefined();
  });

  it('token odbity w treści błędu nie trafia do komunikatu ani do treści — także zakodowany', async () => {
    const odbicie = POSTACIE_TOKENU.map((p) => `token=${p}`).join(' | ');
    const tresci = [
      { code: 'error', message: `Nieznany token ${odbicie}` },
      { code: 'error', message: { buyer_name: [`zły ${odbicie}`] } },
      { status: 500, error: odbicie },
    ];
    for (const cialo of tresci) {
      const e = await blad(klient(async () => json(cialo, 422)).wystaw({ kind: 'vat' }));
      bezTokenu(e.message);
      bezTokenu(JSON.stringify(e.tresc));
      bezTokenu(e.stack);
      expect(e.message).toMatch(/\[token\]/);
    }
    // Błąd sieci z adresem i tokenem w opisie (np. pośrednik) — ta sama zasada.
    const siec = await blad(klient(async () => { throw new TypeError(`fetch failed ${ADRES}/?x=${encodeURIComponent(TOKEN)} ${TOKEN}`); }).pobierzFakture(1));
    bezTokenu(siec.message);
    bezTokenu(siec.stack);
    expect(siec.message).not.toMatch(/firma-testowa\.fakturownia\.pl/);
    expect(siec.status).toBeUndefined();
  });
});

describe('PRZ-119.02 stronicowanie: goła tablica, koniec = strona krótsza niż per_page', () => {
  const zakres = { period: 'more', date_from: '2026-10-10', date_to: '2026-10-11' };

  it('101 dokumentów = 2 strony (F07 #28–#29)', async () => {
    const { fetchImpl, zadania } = zPomiaru(pomiar('F07').wymiany);
    const wiersze = await klient(fetchImpl).listaFaktur(zakres);
    expect(wiersze).toHaveLength(101);
    expect(zadania.map((z) => new URL(z.url).searchParams.get('page'))).toEqual(['1', '2']);
    expect(zadania.every((z) => new URL(z.url).searchParams.get('per_page') === '100')).toBe(true);
    expect(wiersze[100]).toEqual(wymiana('F07', 29).odpowiedz.cialo[0]);
  });

  it('dokładnie 100 = pełna strona i pusta następna (F07 #26–#27)', async () => {
    const { fetchImpl, zadania } = zPomiaru(pomiar('F07').wymiany);
    const wiersze = await klient(fetchImpl).listaFaktur({ ...zakres, date_to: '2026-10-10' });
    expect(wiersze).toHaveLength(100);
    expect(zadania).toHaveLength(2);
  });

  it('kinds[] jako tablica (F07 #35)', async () => {
    const { fetchImpl } = zPomiaru(pomiar('F07').wymiany);
    // Strona 2 tego zapytania nie padła w pomiarze — wystarczy, że pierwsza ma adres z pomiaru.
    const e = await blad(klient(fetchImpl).listaFaktur({ ...zakres, 'kinds[]': ['vat', 'wdt'] }));
    expect(e.message).toMatch(/żądanie spoza pomiaru: GET .*page=2/);
  });

  const pelna = wymiana('F07', 28).odpowiedz.cialo;
  const strony = (ile) => nagrywacz((z) => {
    const nr = Number(new URL(z.url).searchParams.get('page'));
    const zostalo = ile - (nr - 1) * STRONA_FAKTUROWNI;
    return json(pelna.slice(0, Math.max(0, Math.min(STRONA_FAKTUROWNI, zostalo))));
  });

  it('600 = komplet po sprawdzeniu strony 7; 601 = odmowa (sufit), bez cichej części', async () => {
    const r600 = strony(600);
    await expect(klient(r600.fetchImpl).listaFaktur(zakres)).resolves.toHaveLength(600);
    expect(r600.zadania).toHaveLength(7);
    const r601 = strony(601);
    const e = await blad(klient(r601.fetchImpl).listaFaktur(zakres));
    expect(e.message).toMatch(/najwyżej 600/);
    expect(e.dlaOperatora).toBe(true);
    expect(r601.zadania).toHaveLength(7);
  });

  it('sufit per wywołanie może tylko zawęzić', async () => {
    const e = await blad(klient(strony(201).fetchImpl).listaFaktur(zakres, { sufitStron: 2 }));
    expect(e.message).toMatch(/najwyżej 200/);
    const e2 = await blad(klient(strony(601).fetchImpl).listaFaktur(zakres, { sufitStron: 50 }));
    expect(e2.message).toMatch(/najwyżej 600/);
  });

  it('zły sufitStron (0, ujemny, ułamek, napis, null, NaN) → odmowa bez żądania, nie cichy sufit 6', async () => {
    const { fetchImpl, zadania } = nagrywacz(() => json([]));
    for (const zly of [0, -1, 1.5, '2', null, Number.NaN]) {
      const e = await blad(klient(fetchImpl).listaFaktur(zakres, { sufitStron: zly }));
      expect(e.status, String(zly)).toBe(400);
    }
    expect(zadania).toHaveLength(0);
  });

  it('strona bez tablicy (obiekt, null, HTML) albo dłuższa niż per_page → odmowa, nie „cichy komplet”', async () => {
    for (const druga of [{}, null, { invoices: [] }, 'html']) {
      const { fetchImpl } = nagrywacz((z) => {
        if (new URL(z.url).searchParams.get('page') === '1') return json(pelna);
        return druga === 'html' ? new Response('<html>przerwa</html>', { status: 200 }) : json(druga);
      });
      const e = await blad(klient(fetchImpl).listaFaktur(zakres));
      expect(e.message, JSON.stringify(druga)).toMatch(/nie rozpoznaję strony listy/);
    }
    const e = await blad(klient(async () => json([...pelna, ...pelna.slice(0, 1)])).listaFaktur(zakres));
    expect(e.message).toMatch(/nie rozpoznaję strony listy/);
  });

  it('parametry spoza listy dozwolonych → odmowa bez żądania (nieznany filtr Fakturownia przemilcza, F16 #5)', async () => {
    const { fetchImpl, zadania } = nagrywacz(() => json([]));
    for (const zle of [{ send_to_ksef: 'yes' }, { api_token: 'x' }, { page: '3' }, { per_page: '1000' }, { numer_nieistniejacy_filtr: 'x' }]) {
      const e = await blad(klient(fetchImpl).listaFaktur(zle));
      expect(e.status, JSON.stringify(zle)).toBe(400);
    }
    const e = await blad(klient(fetchImpl).pobierzFakture(1, { send_to_ksef: 'yes' }));
    expect(e.status).toBe(400);
    expect(zadania).toHaveLength(0);
  });

  it('send_to_ksef albo api_token w WARTOŚCI dozwolonego parametru → strażnik adresów odmawia bez żądania', async () => {
    const { fetchImpl, zadania } = nagrywacz(() => json([]));
    const k = klient(fetchImpl);
    const proby = [
      () => k.listaFaktur({ number: 'FV/1&send_to_ksef=yes' }),
      () => k.listaFaktur({ 'fields[invoice]': 'id,api_token' }),
      () => k.pobierzFakture(1, { correction_positions: 'full&send_to_ksef=yes' }),
      () => k.iluMaNumer('FV/1?send_to_ksef=yes'),
      () => k.znajdzKlientowPoNip('1234567890&api_token=x'),
    ];
    for (const [i, proba] of proby.entries()) expect((await blad(proba())).status, `próba ${i}`).toBe(400);
    expect(zadania).toHaveLength(0);
  });
});

describe('PRZ-119.02 operacje na pomiarze', () => {
  it('pobierzFakture z polami (F12) i z pozycjami korekty (F15 #3) — surowy obiekt', async () => {
    const { fetchImpl } = zPomiaru([...pomiar('F12').wymiany, ...pomiar('F15').wymiany]);
    const k = klient(fetchImpl);
    await expect(k.pobierzFakture(595670707, { 'fields[invoice]': 'id,number,gov_status' })).resolves.toEqual(wymiana('F12', 0).odpowiedz.cialo);
    await expect(k.pobierzFakture('595671213', { correction_positions: 'full' })).resolves.toEqual(wymiana('F15', 3).odpowiedz.cialo);
  });

  it('identyfikator dokumentu tylko z cyfr — inaczej odmowa 400 bez żądania', async () => {
    const { fetchImpl, zadania } = nagrywacz(() => json({}));
    for (const zly of ['', '  ', '12/../x', '1?send_to_ksef=yes', null, -5, 1.5]) {
      expect((await blad(klient(fetchImpl).pobierzFakture(zly))).status, String(zly)).toBe(400);
      expect((await blad(klient(fetchImpl).wyslijDokumentDoKsef(zly))).status, String(zly)).toBe(400);
    }
    expect(zadania).toHaveLength(0);
  });

  it('wystaw (F04 #1) i wystawKorekte (F15 #2): POST {invoice}, odpowiedź surowa', async () => {
    const f04 = wymiana('F04', 1);
    const f15 = wymiana('F15', 2);
    // Ten sam adres i metoda — każda wymiana dostaje własne nagranie.
    const a = zPomiaru([f04]);
    const b = zPomiaru([f15]);
    await expect(klient(a.fetchImpl).wystaw(cialoZadania(f04).invoice)).resolves.toEqual(f04.odpowiedz.cialo);
    await expect(klient(b.fetchImpl).wystawKorekte(cialoZadania(f15).invoice)).resolves.toEqual(f15.odpowiedz.cialo);
    expect(JSON.parse(a.zadania[0].cialo)).toEqual(cialoZadania(f04));
    expect(a.zadania[0].naglowki['Content-Type']).toBe('application/json');
    expect(JSON.parse(b.zadania[0].cialo)).toEqual(cialoZadania(f15));
  });

  it('wystawKorekte bez kind: correction → odmowa bez żądania', async () => {
    const { fetchImpl, zadania } = nagrywacz(() => json({}));
    expect((await blad(klient(fetchImpl).wystawKorekte({ kind: 'vat' }))).status).toBe(400);
    expect(zadania).toHaveLength(0);
  });

  it('oznaczZaplacona (F09 #2)', async () => {
    const { fetchImpl } = zPomiaru(pomiar('F09').wymiany);
    await expect(klient(fetchImpl).oznaczZaplacona(595670707)).resolves.toMatchObject({ id: 595670707, status: 'paid' });
  });

  // PRZ-119.05 (recenzja 03 a): F09 — `change_status` ustawia `paid_date` na DZIŚ, więc data zapłaty
  // z zamówienia idzie osobnym `PUT /invoices/{id}.json` (NIEZMIERZONE — pomiar przed profilem próby).
  it('oznaczZaplacona z paidDate: change_status, potem PUT {invoice:{paid_date}}', async () => {
    const { fetchImpl, zadania } = nagrywacz((z) => json(z.metoda === 'PUT'
      ? { id: 595670707, status: 'paid', paid_date: '2026-11-10' }
      : { id: 595670707, status: 'paid' }));
    await expect(klient(fetchImpl).oznaczZaplacona(595670707, { paidDate: '2026-11-10' }))
      .resolves.toMatchObject({ id: 595670707, status: 'paid', paid_date: '2026-11-10' });
    expect(zadania.map((z) => `${z.metoda} ${z.url}`)).toEqual([
      `POST ${ADRES}/invoices/595670707/change_status.json?status=paid`,
      `PUT ${ADRES}/invoices/595670707.json`,
    ]);
    expect(JSON.parse(zadania[1].cialo)).toEqual({ invoice: { paid_date: '2026-11-10' } });
  });

  it('oznaczZaplacona: zła data zapłaty → odmowa 400 bez żądania', async () => {
    for (const paidDate of ['10.11.2026', '2026-13-01', 'jutro', 20261110]) {
      const { fetchImpl, zadania } = nagrywacz(() => json({}));
      expect((await blad(klient(fetchImpl).oznaczZaplacona(595670707, { paidDate }))).status).toBe(400);
      expect(zadania).toHaveLength(0);
    }
  });

  it('oznaczZaplacona: data nieprzyjęta → błąd mówi, że faktura JUŻ jest opłacona', async () => {
    const { fetchImpl, zadania } = nagrywacz((z) => (z.metoda === 'PUT'
      ? json({ code: 'error', message: 'zmyślony błąd' }, 422) : json({ id: 595670707, status: 'paid' })));
    const e = await blad(klient(fetchImpl).oznaczZaplacona(595670707, { paidDate: '2026-11-10' }));
    expect(zadania).toHaveLength(2);
    expect(e.zaplataOznaczona).toBe(true);
    expect(e.message).toMatch(/oznaczona jako opłacona.*2026-11-10/);
  });

  it('iluMaNumer (F16 #3, #4): per_page=100, liczy tylko RÓWNE numery; pełna strona → odmowa', async () => {
    const trafienie = wymiana('F16', 3).odpowiedz.cialo;
    expect(trafienie).toHaveLength(1);
    const podobny = { ...trafienie[0], id: 595679999, number: 'WDT/1/10/2026-A' };
    const r = nagrywacz(() => json([...trafienie, podobny]));
    await expect(klient(r.fetchImpl).iluMaNumer('WDT/1/10/2026')).resolves.toBe(1);
    expect(r.zadania[0].url).toBe(`${ADRES}/invoices.json?period=all&number=WDT%2F1%2F10%2F2026&per_page=100`);
    const pusto = nagrywacz(() => json(wymiana('F16', 4).odpowiedz.cialo));
    await expect(klient(pusto.fetchImpl).iluMaNumer('ZMYSLONY/999/2099')).resolves.toBe(0);
    const pelna = nagrywacz(() => json(Array.from({ length: 100 }, (_, i) => ({ ...trafienie[0], id: i + 1 }))));
    const e = await blad(klient(pelna.fetchImpl).iluMaNumer('WDT/1/10/2026'));
    expect(e.message).toMatch(/nie wiadomo, ile/);
    expect(pelna.zadania).toHaveLength(1);
  });

  it('pobierzPdf: Accept application/pdf, oddaje bajty; nie-PDF → odmowa', async () => {
    const bajty = Buffer.from('%PDF-1.4\n% Pracownia Półcień — zmyślona faktura\n');
    const { fetchImpl, zadania } = nagrywacz(() => new Response(bajty, { status: 200, headers: { 'content-type': 'application/pdf' } }));
    const pdf = await klient(fetchImpl).pobierzPdf(595670959);
    expect(Buffer.isBuffer(pdf)).toBe(true);
    expect(pdf.equals(bajty)).toBe(true);
    expect(zadania[0].url).toBe(`${ADRES}/invoices/595670959.pdf`);
    expect(zadania[0].naglowki.Accept).toBe('application/pdf');
    const e = await blad(klient(async () => new Response('<html>logowanie</html>', { status: 200 })).pobierzPdf(1));
    expect(e.message).toMatch(/nie jest PDF/);
  });

  it('znajdzKlientowPoNip: GET /clients.json?tax_no= — surowa tablica w kształcie z F03 #2', async () => {
    const klienci = wymiana('F03', 2).odpowiedz.cialo;
    expect(Array.isArray(klienci) && klienci.length).toBe(1);
    const nip = klienci[0].tax_no;
    const { fetchImpl, zadania } = nagrywacz(() => json(klienci));
    await expect(klient(fetchImpl).znajdzKlientowPoNip(nip)).resolves.toEqual(klienci);
    expect(zadania[0].url).toBe(`${ADRES}/clients.json?tax_no=${nip}`);
  });
});

describe('PRZ-119.02 strażnik adresów: send_to_ksef tylko w wyslijDokumentDoKsef', () => {
  it('żadne żądanie poza wysyłką nie niesie send_to_ksef, gov_save_and_send ani api_token — w adresie ani treści', async () => {
    const { fetchImpl, zadania } = nagrywacz((z) => (z.url.includes('.pdf')
      ? new Response(Buffer.from('%PDF-1.4'), { status: 200 })
      : json(z.url.includes('invoices.json?') || z.url.includes('clients.json') ? [] : { id: 1 })));
    const k = klient(fetchImpl);
    const wolane = new Set();
    const wywolaj = async (nazwa, ...args) => { wolane.add(nazwa); await k[nazwa](...args); };
    await wywolaj('sprawdzPolaczenie');
    await wywolaj('listaFaktur', { period: 'more', date_from: '2026-10-10', date_to: '2026-10-11', 'kinds[]': ['vat', 'wdt'], include_positions: 'true' });
    await wywolaj('pobierzFakture', 595670707);
    await wywolaj('pobierzFakture', 595670707, { 'fields[invoice]': 'id,number,gov_status' });
    await wywolaj('pobierzPdf', 595670707);
    await wywolaj('iluMaNumer', 'WDT/1/10/2026');
    await wywolaj('znajdzKlientowPoNip', '1234567890');
    await wywolaj('wystaw', cialoZadania(wymiana('F04', 1)).invoice);
    await wywolaj('wystawKorekte', cialoZadania(wymiana('F15', 2)).invoice);
    await wywolaj('oznaczZaplacona', 595670707);
    expect([...wolane].sort()).toEqual(METODY_FAKTUROWNI.filter((m) => m !== 'wyslijDokumentDoKsef').sort());
    expect(zadania.length).toBeGreaterThanOrEqual(10);
    for (const z of zadania) {
      expect(z.url, z.url).not.toMatch(ZAKAZANE);
      expect(String(z.cialo ?? ''), z.url).not.toMatch(ZAKAZANE);
      expect(z.url.startsWith(`${ADRES}/`)).toBe(true);
    }
  });

  it('treść z zakazanym kluczem → odmowa bez żądania (adapter nie przemyci wysyłki w wystawieniu)', async () => {
    const { fetchImpl, zadania } = nagrywacz(() => json({ id: 1 }));
    const k = klient(fetchImpl);
    for (const zle of [{ kind: 'vat', send_to_ksef: 'yes' }, { kind: 'vat', api_token: 'x' }, { kind: 'vat', ['gov_save_and_send']: true },
      { kind: 'vat', positions: [{ name: 'x', gov_cokolwiek: 1 }] }]) {
      expect((await blad(k.wystaw(zle))).status, JSON.stringify(zle)).toBe(400);
    }
    expect(zadania).toHaveLength(0);
  });

  it('wyslijDokumentDoKsef: dokładnie jedno GET …/invoices/{id}.json?send_to_ksef=yes, odpowiedź surowa', async () => {
    const cialo = wymiana('F12', 0).odpowiedz.cialo;
    const { fetchImpl, zadania } = nagrywacz(() => json(cialo));
    await expect(klient(fetchImpl).wyslijDokumentDoKsef(595670707)).resolves.toEqual({ odpowiedzFakturowni: cialo });
    expect(zadania).toHaveLength(1);
    expect(zadania[0].metoda).toBe('GET');
    expect(zadania[0].url).toBe(`${ADRES}/invoices/595670707.json?send_to_ksef=yes`);
    expect(zadania[0].cialo).toBeNull();
    expect(zadania[0].naglowki.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('wyslijDokumentDoKsef: timeout = „nie wiadomo”, bez ponowienia i bez statusu', async () => {
    const { fetchImpl, zadania } = nagrywacz(() => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); });
    const e = await blad(klient(fetchImpl).wyslijDokumentDoKsef(595670707));
    expect(zadania).toHaveLength(1);
    expect(e.status).toBeUndefined();
    expect(e.message).toMatch(/nie wiadomo/);
  });

  it('wyslijDokumentDoKsef: 500, 502, 503 i 429 też bez ponowienia — dokładnie jedno wywołanie fetchImpl', async () => {
    for (const status of [500, 502, 503, 429]) {
      const { fetchImpl, zadania } = nagrywacz(() => json({ status, error: 'x' }, status, { 'Retry-After': '1' }));
      const e = await blad(klient(fetchImpl).wyslijDokumentDoKsef(595670707));
      expect(e.status).toBe(status);
      expect(zadania).toHaveLength(1);
    }
  });

  // PRZ-119.05 (recenzja 03 c): 503 przy zapisie → dokładnie jedno żądanie, także na transporcie
  // DOMYŚLNYM (klient bez `fetchImpl` składa `utworzHttp` — tu nad podstawionym globalnym fetch).
  it('503 przy wystawieniu, korekcie, zapłacie i KSeF: dokładnie jedno żądanie (transport domyślny)', async () => {
    const r = nagrywacz(() => json({ code: 'error', message: 'chwilowo niedostępne' }, 503));
    vi.stubGlobal('fetch', r.fetchImpl);
    try {
      const k = createFakturowniaClient({ token: TOKEN, domena: DOMENA });
      const proby = [
        () => k.wystaw({ kind: 'vat' }),
        () => k.wystawKorekte({ kind: 'correction' }),
        () => k.oznaczZaplacona(595670707, { paidDate: '2026-11-10' }),
        () => k.wyslijDokumentDoKsef(595670707),
      ];
      for (const proba of proby) {
        const przed = r.zadania.length;
        const e = await blad(proba());
        expect(e.status).toBe(503);
        expect(r.zadania.length - przed).toBe(1);
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
