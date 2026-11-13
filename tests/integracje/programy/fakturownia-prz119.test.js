// PRZ-119.03 — adapter Fakturowni za kontraktem ProgramFakturowy (src/integracje/programy/fakturownia.ts).
// Prawdziwy klient (src/oms/fakturownia/client.js) na wstrzykniętym fetch, który odpowiada ZAPISANYMI odpowiedziami
// z pomiarów F1–F17 (tests/fixtures/fakturownia/, konto próbne, dane zmyślone). Żadne żądanie nie wychodzi z procesu.
// Ciała żądań porównujemy POLE PO POLU z tym, co w pomiarze przyjęła Fakturownia (bez pól sprzedawcy — decyzja (a)).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakturowniaClient } from '../../../src/oms/fakturownia/client.js';
import { programFakturownia, groszeZNapisu, napisZGroszy } from '../../../src/integracje/programy/fakturownia.ts';
import { sprawdzProgramFakturowy } from '../../../src/integracje/program-fakturowy.ts';
import { podsumowanieWierszami } from '../../../src/domena/podsumowanie-wierszami.js';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { utworzAlarmAutoKsef, KLUCZ_ALARMU_AUTO_KSEF } from '../../../src/moduly/faktury/db/alarm-auto-ksef.js';
import { filtrujDokumenty, doZestawienia, sumaListy } from '../../../src/domena/lista-faktur.js';

const FIX = fileURLToPath(new URL('../../fixtures/fakturownia/', import.meta.url));
const pomiar = (nr) => JSON.parse(fs.readFileSync(path.join(FIX, fs.readdirSync(FIX).find((n) => n.startsWith(`${nr}-`))), 'utf8'));
const wymiana = (nr, i) => pomiar(nr).wymiany[i];
/** Ciało `invoice` żądania z pomiaru, bez pól sprzedawcy (zwykła faktura ich nie wysyła — decyzja (a)). */
const zadanieZPomiaru = (nr, i) => Object.fromEntries(Object.entries(wymiana(nr, i).zadanie.cialo.invoice)
  .filter(([k]) => !k.startsWith('seller_')));
const odpowiedzZPomiaru = (nr, i) => wymiana(nr, i).odpowiedz.cialo;

const DOMENA = 'firma-testowa';
const TOKEN = 'ZmyslonyTokenPolcien123/firma-testowa';
const STRATEGIA = { position: 'default', sum: 'sum', invoice_form_price_kind: 'gross' };
const OID = 'pro-R/2026/041';

const json = (cialo, status = 200) => new Response(cialo === undefined ? null : JSON.stringify(cialo), {
  status, headers: { 'content-type': 'application/json; charset=utf-8' },
});

/** Udawana Fakturownia: POST /invoices.json → `post(invoice)`, GET /invoices/{id}.json → `dokumenty[id]`, listy → `lista(url)`. */
function fakturownia({ post = () => [201, odpowiedzZPomiaru('F04', 1)], dokumenty = {}, klienci = [], lista = () => [] } = {}) {
  const zadania = [];
  const fetchImpl = async (url, opcje = {}) => {
    const z = { url: String(url), metoda: opcje.method ?? 'GET', cialo: opcje.body ?? null };
    zadania.push(z);
    const u = new URL(z.url);
    if (z.metoda === 'POST' && u.pathname === '/invoices.json') {
      const [status, cialo] = post(JSON.parse(z.cialo).invoice);
      return json(cialo, status);
    }
    if (z.metoda === 'POST' && /\/change_status\.json$/.test(u.pathname)) return json({ status: 'ok' });
    const m = /^\/invoices\/(\d+)\.json$/.exec(u.pathname);
    if (z.metoda === 'GET' && m) return dokumenty[m[1]] ? json(dokumenty[m[1]]) : json({ status: 404, error: 'Not Found' }, 404);
    if (z.metoda === 'PUT' && m) return json({ id: Number(m[1]), status: 'paid', ...JSON.parse(z.cialo).invoice });
    if (u.pathname === '/clients.json') return json(klienci);
    if (u.pathname === '/invoices.json') return json(lista(u));
    throw new Error(`żądanie spoza testu: ${z.metoda} ${z.url}`);
  };
  const klient = createFakturowniaClient({ token: TOKEN, domena: DOMENA, fetchImpl });
  const posty = () => zadania.filter((z) => z.metoda === 'POST').map((z) => JSON.parse(z.cialo).invoice);
  return { klient, zadania, posty };
}

function alarmWPamieci() {
  const wpisy = [];
  return { wpisy, dopisz: (w) => { wpisy.push(w); }, wczytaj: () => [...wpisy], zgas: () => { wpisy.length = 0; } };
}

function zestaw(opcje = {}, { alarm = alarmWPamieci(), pomin = [] } = {}) {
  const f = fakturownia(opcje);
  const klient = { ...f.klient };
  for (const m of pomin) delete klient[m];
  const program = programFakturownia(klient, { alarmAutoKsef: alarm, teraz: () => new Date('2026-11-12T10:00:00Z') });
  return { ...f, program, alarm };
}

/** Nabywca z pomiaru F04 #1 (ten sam, którego Fakturownia przyjęła). */
const zF04 = zadanieZPomiaru('F04', 1);
const NABYWCA_PL = Object.freeze({
  firma: zF04.buyer_name, nip: zF04.buyer_tax_no, ulica: zF04.buyer_street, kod: zF04.buyer_post_code,
  miasto: zF04.buyer_city, kraj: zF04.buyer_country, email: zF04.buyer_email,
});
const zF14 = zadanieZPomiaru('F14', 2);
const NABYWCA_UE = Object.freeze({
  firma: zF14.buyer_name, nip: zF14.buyer_tax_no, ulica: zF14.buyer_street, kod: zF14.buyer_post_code,
  miasto: zF14.buyer_city, kraj: 'PL', email: zF14.buyer_email,
});
const DATY = { invoice_date: '2026-11-12', sale_date: '2026-11-12', payment_date: '2026-11-19' };

async function wystawZ(program, nabywca, ladunek, { oid = OID } = {}) {
  const { client_id } = await program.przygotujNabywce(nabywca, { zalozGdyBrak: true });
  return program.wystaw({ client_id, ...DATY, ...ladunek }, { oid });
}

describe('PRZ-119.03 kwoty: grosze ↔ napis Fakturowni', () => {
  it('napisZGroszy: całe grosze → „123.00”, ujemne i duże bez utraty grosza', () => {
    expect(napisZGroszy(12300)).toBe('123.00');
    expect(napisZGroszy(99)).toBe('0.99');
    expect(napisZGroszy(1230)).toBe('12.30');
    expect(napisZGroszy(123456789)).toBe('1234567.89');
    expect(napisZGroszy(-12300)).toBe('-123.00');
    expect(napisZGroszy(0)).toBe('0.00');
    expect(() => napisZGroszy(12.5)).toThrow();
  });

  it('groszeZNapisu: odpowiedzi Fakturowni („123.0”, „-123.0”, „1234567.89”) bez parseFloat×100', () => {
    expect(groszeZNapisu('123.0')).toBe(12300);
    expect(groszeZNapisu('-123.0')).toBe(-12300);
    expect(groszeZNapisu('0.99')).toBe(99);
    expect(groszeZNapisu('2.97')).toBe(297);
    expect(groszeZNapisu('1234567.89')).toBe(123456789);
    // 4.35 × 100 = 434.99999999999994 w liczbach zmiennoprzecinkowych
    expect(groszeZNapisu('4.35')).toBe(435);
    expect(groszeZNapisu('1.15')).toBe(115);
    expect(() => groszeZNapisu('12,30')).toThrow();
    expect(() => groszeZNapisu('1.234')).toThrow();
    expect(() => groszeZNapisu('')).toThrow();
  });
});

describe('PRZ-119.03 opis i zdolności', () => {
  it('opis: Fakturownia, VAT wierszami, wystawienie NIE wysyła do KSeF; komplet przechodzi sprawdzProgramFakturowy', () => {
    const { program } = zestaw();
    expect(program.opis).toMatchObject({
      id: 'fakturownia', regulaVat: 'wierszami', wystawienieWysylaDoKsef: false,
      nazwa: { mianownik: 'Fakturownia', dopelniacz: 'Fakturowni', miejscownik: 'Fakturowni', narzednik: 'Fakturownią' },
      limity: { stronaListy: 100, sufitStron: 6 },
    });
    expect([...program.opis.zdolnosci].sort()).toEqual(['numeracjaWlasna', 'oznaczZaplacona', 'wyslijDoKsef']);
    expect(() => sprawdzProgramFakturowy(program)).not.toThrow();
  });

  it('klient bez metody → brak zdolności i brak metody w programie (i dalej przechodzi kontrakt)', () => {
    const { program } = zestaw({}, { pomin: ['oznaczZaplacona', 'wyslijDokumentDoKsef', 'iluMaNumer'] });
    expect(program.opis.zdolnosci).toEqual([]);
    for (const m of ['oznaczZaplacona', 'wyslijDokumentDoKsef', 'iluMaNumer', 'listaNieoplaconych', 'statusKorekty', 'pobierzKorekte']) {
      expect(m in program, m).toBe(false);
    }
    expect(() => sprawdzProgramFakturowy(program)).not.toThrow();
  });

  it('jedna brakująca metoda → tylko jej zdolność znika', () => {
    const { program } = zestaw({}, { pomin: ['wyslijDokumentDoKsef'] });
    expect([...program.opis.zdolnosci].sort()).toEqual(['numeracjaWlasna', 'oznaczZaplacona']);
    expect('wyslijDokumentDoKsef' in program).toBe(false);
  });

  it('bez magazynu alarmu auto-KSeF adapter nie powstaje', () => {
    const { klient } = fakturownia();
    expect(() => programFakturownia(klient, {})).toThrow(/alarm/i);
  });

  it('źródło adaptera nie zna adresu wysyłki do KSeF przy wystawieniu', () => {
    const zrodlo = fs.readFileSync(fileURLToPath(new URL('../../../src/integracje/programy/fakturownia.ts', import.meta.url)), 'utf8');
    expect(zrodlo).not.toMatch(/gov_save_and_send|send_to_ksef/);
  });
});

describe('PRZ-119.03 wystaw — ciało żądania pole po polu jak w pomiarze', () => {
  it('krajowa (F04 #1): to samo ciało + strategia + oid; przygotujNabywce bez sieci', async () => {
    const { program, zadania, posty } = zestaw();
    const { client_id } = await program.przygotujNabywce(NABYWCA_PL, { zalozGdyBrak: true });
    expect(zadania).toHaveLength(0);
    const w = await program.wystaw({
      client_id, ...DATY,
      services: [{ name: zF04.positions[0].name, quantity: 1, gross_price: 12300, tax_symbol: '23' }],
    }, { oid: OID });
    expect(posty()).toEqual([{ ...zF04, calculating_strategy: STRATEGIA, oid: OID, oid_unique: 'yes' }]);
    expect(w).toEqual({ uuid: '595670707', numer: '1/11/2026', ksefStatus: null });
  });

  it('za pobraniem: payment_type cash_on_delivery, reszta bez zmian', async () => {
    const { program, posty } = zestaw();
    await wystawZ(program, NABYWCA_PL, {
      payment_method: 'delivery',
      services: [{ name: zF04.positions[0].name, quantity: 1, gross_price: 12300, tax_symbol: '23' }],
    });
    expect(posty()).toEqual([{ ...zF04, payment_type: 'cash_on_delivery', calculating_strategy: STRATEGIA, oid: OID, oid_unique: 'yes' }]);
  });

  it('zapłacona (F09 #6): status paid + paid „123.00” + data zapłaty', async () => {
    const zF09 = zadanieZPomiaru('F09', 6);
    const { program, posty } = zestaw({ post: () => [201, odpowiedzZPomiaru('F09', 6)] });
    await wystawZ(program, NABYWCA_PL, {
      paid_price: 12300, paid_date: '2026-11-12',
      services: [{ name: zF09.positions[0].name, quantity: 1, gross_price: 12300, tax_symbol: '23' }],
    });
    expect(posty()).toEqual([{ ...zF09, paid_date: '2026-11-12', calculating_strategy: STRATEGIA, oid: OID, oid_unique: 'yes' }]);
  });

  it('WDT z własną serią (F14 #2 + F16): kind wdt, kraj z prefiksu, tax "0", adnotacja, jawny buyer_tax_no_kind, numer', async () => {
    const { program, posty } = zestaw({ post: () => [201, odpowiedzZPomiaru('F14', 2)] });
    const w = await wystawZ(program, NABYWCA_UE, {
      sale_type: 'merchandise', sales_kind: 'sprzedaz_podstawowa', notes: zF14.description, number: 'WDT/1/11/2026',
      services: [{ name: zF14.positions[0].name, quantity: 1, gross_price: 10000, tax_symbol: '0' }],
    });
    expect(posty()).toEqual([{
      ...zF14, buyer_tax_no_kind: 'nip_ue', number: 'WDT/1/11/2026',
      calculating_strategy: STRATEGIA, oid: OID, oid_unique: 'yes',
    }]);
    expect(w.numer).toBe('WDT/1');
  });

  it('kwoty 0,99×3 (F06 #8) i 12,30 + 2×0,30@8 (F06 #11): ciało jak w pomiarze, suma Fakturowni = podsumowanieWierszami', async () => {
    for (const [nr, linie] of [
      [8, [{ name: 'Żarówka 1 (zmyślona)', quantity: 1, gross_price: 99, tax_symbol: '23' },
        { name: 'Żarówka 2 (zmyślona)', quantity: 1, gross_price: 99, tax_symbol: '23' },
        { name: 'Żarówka 3 (zmyślona)', quantity: 1, gross_price: 99, tax_symbol: '23' }]],
      [11, [{ name: 'Abażur (zmyślony)', quantity: 1, gross_price: 1230, tax_symbol: '23' },
        { name: 'Broszura (zmyślona)', quantity: 2, gross_price: 30, tax_symbol: '8' }]],
    ]) {
      const odp = odpowiedzZPomiaru('F06', nr);
      const { program, posty } = zestaw({ post: () => [201, odp] });
      await wystawZ(program, NABYWCA_PL, { services: linie });
      expect(posty()).toEqual([{ ...zadanieZPomiaru('F06', nr), oid: OID, oid_unique: 'yes' }]);
      const oms = podsumowanieWierszami(linie.map((l) => ({ bruttoGr: l.gross_price, stawka: l.tax_symbol })));
      expect({ nettoGr: groszeZNapisu(odp.price_net), vatGr: groszeZNapisu(odp.price_tax), bruttoGr: groszeZNapisu(odp.price_gross) }).toEqual(oms);
    }
  });

  it('1 234 567,89 zł: wysyłane jako „1234567.89” i odczytane z powrotem co do grosza', async () => {
    const odp = { ...odpowiedzZPomiaru('F04', 1), price_gross: '1234567.89', paid: '0.0' };
    const { program, posty } = zestaw({ post: () => [201, odp], dokumenty: { 595670707: odp } });
    await wystawZ(program, NABYWCA_PL, { services: [{ name: 'Żyrandol (zmyślony)', quantity: 1, gross_price: 123456789, tax_symbol: '23' }] });
    expect(posty()[0].positions).toEqual([{ name: 'Żyrandol (zmyślony)', quantity: 1, tax: 23, total_price_gross: '1234567.89' }]);
    const wiersz = await program.pobierzFakture('595670707');
    expect(wiersz).toMatchObject({ gross_price: 123456789, paid_price: 0, left_to_pay: 123456789 });
  });

  it('nabywca z kartoteki (zalozGdyBrak false, jeden wpis po NIP-ie) → client_id + dane wpisu', async () => {
    const wpis = odpowiedzZPomiaru('F03', 2)[0];
    const { program, posty } = zestaw({ klienci: [wpis] });
    const { client_id } = await program.przygotujNabywce(NABYWCA_PL, { zalozGdyBrak: false });
    await program.wystaw({ client_id, ...DATY, services: [{ name: 'Lampa (zmyślona)', quantity: 1, gross_price: 12300, tax_symbol: '23' }] }, { oid: OID });
    expect(posty()[0]).toMatchObject({ client_id: wpis.id, buyer_name: wpis.name, buyer_tax_no: wpis.tax_no, buyer_city: wpis.city });
  });

  it('kartoteka: brak wpisu → null; dwa wpisy z tym NIP-em → odmowa', async () => {
    expect(await zestaw({ klienci: [] }).program.przygotujNabywce(NABYWCA_PL)).toBeNull();
    const wpis = odpowiedzZPomiaru('F03', 2)[0];
    await expect(zestaw({ klienci: [wpis, { ...wpis, id: 1 }] }).program.przygotujNabywce(NABYWCA_PL))
      .rejects.toMatchObject({ status: 400 });
  });
});

describe('PRZ-119.03 wystaw — odmowy przed siecią (F10: Fakturownia przyjmuje bez nazwy, tax 22 i zły kind)', () => {
  const linia = { name: 'Lampa (zmyślona)', quantity: 1, gross_price: 12300, tax_symbol: '23' };
  for (const [opis, nabywca, ladunek, opcje] of [
    ['nabywca bez nazwy', { ...NABYWCA_PL, firma: '  ' }, { services: [linia] }, {}],
    ['stawka spoza listy (22)', NABYWCA_PL, { services: [{ ...linia, tax_symbol: '22' }] }, {}],
    ['stawka „zw”', NABYWCA_PL, { services: [{ ...linia, tax_symbol: 'zw' }] }, {}],
    ['kwota nie w całych groszach', NABYWCA_PL, { services: [{ ...linia, gross_price: 123.5 }] }, {}],
    ['ilość nie liczbą', NABYWCA_PL, { services: [{ ...linia, quantity: 'dwa' }] }, {}],
    ['brak pozycji', NABYWCA_PL, { services: [] }, {}],
    ['nieznany sposób płatności', NABYWCA_PL, { payment_method: 'card', services: [linia] }, {}],
    ['brak oid', NABYWCA_PL, { services: [linia] }, { oid: '' }],
    ['WDT z pozycją 23%', NABYWCA_UE, { sale_type: 'merchandise', services: [linia] }, {}],
  ]) {
    it(`${opis} → 400, zero żądań`, async () => {
      const { program, zadania } = zestaw();
      const blad = await (async () => {
        const n = nabywca.firma.trim() ? await program.przygotujNabywce(nabywca, { zalozGdyBrak: true }) : { client_id: { rodzaj: 'dane', ...nabywca } };
        return program.wystaw({ client_id: n.client_id, ...DATY, ...ladunek }, { oid: OID, ...opcje });
      })().catch((e) => e);
      expect(blad).toBeInstanceOf(Error);
      expect(blad.status).toBe(400);
      expect(blad.dlaOperatora).toBe(true);
      expect(zadania).toHaveLength(0);
    });
  }
});

describe('PRZ-119.03 duplikat oid (F11)', () => {
  it('422 na oid → „już jest faktura dla zamówienia …”, duplikat: true', async () => {
    const { program } = zestaw({ post: () => [422, odpowiedzZPomiaru('F11', 11)] });
    const blad = await wystawZ(program, NABYWCA_PL, { services: [{ name: 'Lampa', quantity: 1, gross_price: 4500, tax_symbol: '23' }] }).catch((e) => e);
    expect(blad).toMatchObject({ status: 422, duplikat: true, dlaOperatora: true });
    expect(blad.message).toMatch(/już jest faktura dla zamówienia/i);
    expect(blad.message).toContain(OID);
  });

  it('inna odmowa 422 → zwykła 4xx, bez znacznika duplikatu', async () => {
    const { program } = zestaw({ post: () => [422, { code: 'error', message: { buyer_tax_no: ['jest nieprawidłowy'] } }] });
    const blad = await wystawZ(program, NABYWCA_PL, { services: [{ name: 'Lampa', quantity: 1, gross_price: 4500, tax_symbol: '23' }] }).catch((e) => e);
    expect(blad.status).toBe(422);
    expect(blad.duplikat).toBeUndefined();
  });

  it('422 na seller_name → „Uzupełnij dane firmy w Fakturowni (Ustawienia konta)”', async () => {
    const { program } = zestaw({ post: () => [422, { code: 'error', message: { seller_name: ['nie może być puste'] } }] });
    const blad = await wystawZ(program, NABYWCA_PL, { services: [{ name: 'Lampa', quantity: 1, gross_price: 4500, tax_symbol: '23' }] }).catch((e) => e);
    expect(blad).toMatchObject({ status: 422, dlaOperatora: true });
    expect(blad.message).toMatch(/Uzupełnij dane firmy w Fakturowni \(Ustawienia konta\)/);
  });
});

describe('PRZ-119.03 gov_status po wystawieniu → trwały alarm auto-KSeF', () => {
  const linia = { name: 'Lampa', quantity: 1, gross_price: 12300, tax_symbol: '23' };
  const zGov = (gov, id = 595670707, number = '1/11/2026') => ({ ...odpowiedzZPomiaru('F04', 1), id, number, gov_status: gov });

  it('null / not_connected / not_applicable → bez alarmu', async () => {
    for (const gov of [null, 'not_connected', 'not_applicable']) {
      const { program, alarm } = zestaw({ post: () => [201, zGov(gov)] });
      await wystawZ(program, NABYWCA_PL, { services: [linia] });
      expect(alarm.wpisy, String(gov)).toEqual([]);
    }
  });

  it('gov_status „processing” → alarm; kolejne wystaw przechodzą i dopisują; czyste NIE gaszą; gasi tylko „Sprawdziłem”', async () => {
    const db = openOmsDb(':memory:');
    const alarm = utworzAlarmAutoKsef(db, { teraz: () => new Date('2026-11-12T10:00:00Z') });
    const odpowiedzi = [zGov('processing', 1, 'A/1'), zGov('sent', 2, 'A/2'), zGov(null, 3, 'A/3')];
    const { program } = zestaw({ post: () => [201, odpowiedzi.shift()] }, { alarm });

    expect(await wystawZ(program, NABYWCA_PL, { services: [linia] })).toMatchObject({ uuid: '1', numer: 'A/1' });
    expect(alarm.wczytaj()).toMatchObject([{ dokument: '1', numer: 'A/1', gov_status: 'processing', oid: OID }]);

    expect(await wystawZ(program, NABYWCA_PL, { services: [linia] }, { oid: 'pro-R/2026/042' })).toMatchObject({ numer: 'A/2' });
    expect(alarm.wczytaj().map((w) => w.numer)).toEqual(['A/1', 'A/2']);

    expect(await wystawZ(program, NABYWCA_PL, { services: [linia] }, { oid: 'pro-R/2026/043' })).toMatchObject({ numer: 'A/3' });
    expect(alarm.wczytaj().map((w) => w.numer)).toEqual(['A/1', 'A/2']);
    expect(db.prepare('SELECT wartosc FROM ustawienia WHERE klucz = ?').get(KLUCZ_ALARMU_AUTO_KSEF)).toBeTruthy();

    alarm.zgas();
    expect(alarm.wczytaj()).toEqual([]);
  });

  it('awaria zapisu alarmu nie psuje wystawienia (dokument już jest)', async () => {
    const alarm = { dopisz: () => { throw new Error('dysk pełny'); }, wczytaj: () => [], zgas: () => {} };
    const { program } = zestaw({ post: () => [201, zGov('processing')] }, { alarm });
    const blad = console.error;
    console.error = () => {};
    try {
      await expect(wystawZ(program, NABYWCA_PL, { services: [linia] })).resolves.toMatchObject({ numer: '1/11/2026' });
    } finally { console.error = blad; }
  });

  it('korekta z gov_status ≠ null też zapala alarm', async () => {
    const alarm = alarmWPamieci();
    const { program } = zestaw({
      post: () => [201, { ...odpowiedzZPomiaru('F15', 2), gov_status: 'processing' }],
      dokumenty: { 595670707: odpowiedzZPomiaru('F04', 1) },
    }, { alarm });
    await program.wystawKorekte(LADUNEK_KOREKTY);
    expect(alarm.wpisy).toMatchObject([{ dokument: '595671213', numer: 'K1', gov_status: 'processing' }]);
  });
});

describe('PRZ-119.03 alarm auto-KSeF w tabeli ustawienia', () => {
  it('nieczytelny zapis → alarm świeci (wpis „nieczytelny”), nie znika po cichu', () => {
    const db = openOmsDb(':memory:');
    db.prepare('INSERT INTO ustawienia (klucz, wartosc, zmienione_at) VALUES (?, ?, ?)').run(KLUCZ_ALARMU_AUTO_KSEF, '{zepsute', '2026-11-12T10:00:00Z');
    const alarm = utworzAlarmAutoKsef(db);
    expect(alarm.wczytaj()).toHaveLength(1);
    alarm.dopisz({ dokument: '9', numer: 'B/9', gov_status: 'sent' });
    expect(alarm.wczytaj().length).toBeGreaterThanOrEqual(1);
    expect(alarm.wczytaj().some((w) => w.numer === 'B/9')).toBe(true);
  });

  it('ten sam dokument dopisany dwa razy → jeden wpis', () => {
    const alarm = utworzAlarmAutoKsef(openOmsDb(':memory:'));
    alarm.dopisz({ dokument: '9', numer: 'B/9', gov_status: 'sent' });
    alarm.dopisz({ dokument: '9', numer: 'B/9', gov_status: 'ok' });
    expect(alarm.wczytaj()).toHaveLength(1);
  });
});

const zF15 = Object.fromEntries(Object.entries(wymiana('F15', 2).zadanie.cialo.invoice));
const NAZWA_F04 = zF04.positions[0].name;
const LADUNEK_KOREKTY = Object.freeze({
  client_id: 288946221,
  corrected_invoice_number: '1/11/2026', corrected_invoice_date: '2026-11-12', corrected_invoice_uuid: '595670707',
  correction_reason: zF15.correction_reason,
  services: [
    { name: NAZWA_F04, quantity: 1, gross_price: 12300, tax_symbol: '23', group: '0', correction: false },
    { name: NAZWA_F04, quantity: 0, gross_price: 0, tax_symbol: '23', group: '0', correction: true },
  ],
});

describe('PRZ-119.03 wystawKorekte (F15)', () => {
  it('ciało pole po polu jak w pomiarze: dane sprzedawcy i nabywcy z korygowanego dokumentu + strategia', async () => {
    const { program, posty, zadania } = zestaw({
      post: () => [201, odpowiedzZPomiaru('F15', 2)],
      dokumenty: { 595670707: odpowiedzZPomiaru('F04', 1) },
    });
    const w = await program.wystawKorekte(LADUNEK_KOREKTY);
    expect(zadania[0]).toMatchObject({ metoda: 'GET' });
    expect(new URL(zadania[0].url).pathname).toBe('/invoices/595670707.json');
    expect(posty()).toEqual([{ ...zF15, calculating_strategy: STRATEGIA }]);
    expect(w).toEqual({ referencja: null, uuid: '595671213', numer: 'K1' });
  });

  it('uwagi korekty → description; strategia w korekcie także przy WDT (tax "0")', async () => {
    const wdt = { ...odpowiedzZPomiaru('F14', 2) };
    const { program, posty } = zestaw({ post: () => [201, odpowiedzZPomiaru('F15', 2)], dokumenty: { 595670959: wdt } });
    await program.wystawKorekte({
      ...LADUNEK_KOREKTY, corrected_invoice_uuid: '595670959', notes: 'Adnotacja WDT (zmyślona).',
      sale_type: 'merchandise', sales_kind: 'sprzedaz_podstawowa',
      services: [
        { name: 'Lampa', quantity: 1, gross_price: 10000, tax_symbol: '0', group: '0', correction: false },
        { name: 'Lampa', quantity: 0, gross_price: 0, tax_symbol: '0', group: '0', correction: true },
      ],
    });
    const c = posty()[0];
    expect(c.calculating_strategy).toEqual(STRATEGIA);
    expect(c.description).toBe('Adnotacja WDT (zmyślona).');
    expect(c.positions[0]).toMatchObject({ tax: '0', quantity: -1, total_price_gross: '-100.00' });
    expect(c.buyer_tax_no).toBe('SK2021234567');
  });

  it('brak korygowanego dokumentu → odmowa bez POST', async () => {
    const { program, posty } = zestaw();
    await expect(program.wystawKorekte(LADUNEK_KOREKTY)).rejects.toMatchObject({ status: 404 });
    expect(posty()).toEqual([]);
  });
});

describe('PRZ-119.03 odczyt — wiersz w kształcie kontraktu', () => {
  it('niezapłacona (F04 #1): left_to_pay = brutto − zapłacono, w groszach', async () => {
    const { program } = zestaw({ dokumenty: { 595670707: odpowiedzZPomiaru('F04', 1) } });
    expect(await program.pobierzFakture('595670707')).toMatchObject({
      uuid: '595670707', number: '1/11/2026', rodzaj: 'vat', invoice_date: '2026-11-12', sale_date: '2026-11-12',
      payment_date: '2026-11-19', payment_method: 'transfer', gross_price: 12300, net_price: 10000, tax_price: 2300,
      paid_price: 0, left_to_pay: 12300, currency: 'PLN', updated_at: '2026-11-12T09:26:16.000+01:00',
      client_company_name: 'Pracownia Półcień Sp. z o.o.', client_nip: '1234563218', client_tax_code: '1234563218',
      client_first_name: null, client_last_name: null, client_id: 288946221, ksef_number: null,
      services: [{ name: NAZWA_F04, quantity: 1, gross_price: 12300, tax_symbol: '23' }],
    });
  });

  // Decyzja kierownika (recenzja 03): numer KSeF tylko z dokumentu przyjętego przez KSeF — `stanKsef`/`wKsef`
  // w domenie traktują samą obecność `ksef_number` jako „jest w KSeF”.
  it.each([
    ['ok', 'KSEF-ZMYSLONY-1'], ['demo_ok', 'KSEF-ZMYSLONY-1'],
    ['processing', null], ['send_error', null], ['server_error', null], [null, null],
  ])('ksef_number przy gov_status=%s → %s', async (gov_status, oczekiwany) => {
    const d = { ...odpowiedzZPomiaru('F04', 1), gov_status, gov_id: 'KSEF-ZMYSLONY-1' };
    const { program } = zestaw({ dokumenty: { 595670707: d } });
    expect((await program.pobierzFakture('595670707')).ksef_number).toBe(oczekiwany);
  });

  it('osoba prywatna: client_first_name / client_last_name z buyer_first_name / buyer_last_name', async () => {
    const d = { ...odpowiedzZPomiaru('F04', 1), buyer_company: false, buyer_name: 'Anna Zmyślona',
      buyer_first_name: 'Anna', buyer_last_name: 'Zmyślona', buyer_tax_no: null };
    const { program } = zestaw({ dokumenty: { 595670707: d } });
    expect(await program.pobierzFakture('595670707')).toMatchObject({
      client_first_name: 'Anna', client_last_name: 'Zmyślona', client_tax_code: null, client_company_name: null,
    });
  });

  it('osoba prywatna bez imienia i nazwiska: client_company_name = buyer_name (nabywca nie znika z listy)', async () => {
    const d = { ...odpowiedzZPomiaru('F04', 1), buyer_company: false, buyer_name: 'Anna Zmyślona',
      buyer_first_name: null, buyer_last_name: null, buyer_tax_no: null };
    const { program } = zestaw({ dokumenty: { 595670707: d } });
    expect((await program.pobierzFakture('595670707')).client_company_name).toBe('Anna Zmyślona');
  });

  it('zapłacona (F09 #3): status paid, paid_price = brutto, left_to_pay 0, paid_date', async () => {
    const d = odpowiedzZPomiaru('F09', 3);
    const { program } = zestaw({ dokumenty: { [d.id]: d } });
    expect(await program.pobierzFakture(String(d.id))).toMatchObject({
      status: 'paid', paid_price: 12300, left_to_pay: 0, gross_price: 12300, paid_date: '2026-11-12',
    });
  });

  it('korekta (F15 #3): rodzaj korekta, kwoty ujemne, stawka z correction_before, numer korygowanej', async () => {
    const k = odpowiedzZPomiaru('F15', 3);
    const { program } = zestaw({ dokumenty: { [k.id]: k, 595670707: odpowiedzZPomiaru('F04', 1) } });
    const w = await program.pobierzFakture(String(k.id));
    expect(w).toMatchObject({
      rodzaj: 'korekta', gross_price: -12300, parent_id: '595670707', corrected_invoice_number: '1/11/2026',
    });
    expect(w.services[0]).toMatchObject({ quantity: -1, gross_price: -12300, tax_symbol: '23' });
  });

  it('404 (F10 #3) → null', async () => {
    const { program } = zestaw();
    expect(await program.pobierzFakture('987654321')).toBeNull();
  });
});

// Plan PRZ-119, tabela odczytu: test przypina listę pól kanonu, które czyta domena (lista-faktur, paczka-dla-biura,
// eksport CSV, widok listy). Nowe pole czytane przez domenę bez mapowania Fakturowni = dopisz je tu = czerwony test.
const POLA_KANONU_CZYTANE_PRZEZ_DOMENE = Object.freeze([
  'uuid', 'number', 'rodzaj', 'status', 'invoice_date', 'sale_date', 'payment_date', 'payment_method', 'paid_date',
  'ksef_number', 'net_price', 'tax_price', 'gross_price', 'paid_price', 'left_to_pay', 'currency',
  'client_company_name', 'client_first_name', 'client_last_name', 'client_tax_code', 'client_nip', 'services',
]);

describe('PRZ-119.03 kanon — wiersz Fakturowni przez funkcje domeny', () => {
  const wierszF04 = async () => {
    const { program } = zestaw({ dokumenty: { 595670707: odpowiedzZPomiaru('F04', 1) } });
    return program.pobierzFakture('595670707');
  };

  it('wiersz ma każde pole kanonu czytane przez domenę', async () => {
    const w = await wierszF04();
    expect(POLA_KANONU_CZYTANE_PRZEZ_DOMENE.filter((p) => !Object.hasOwn(w, p))).toEqual([]);
  });

  it('filtr typ=vat zostawia fakturę, doZestawienia → true, sumaListy kompletna (netto/brutto w groszach)', async () => {
    const w = await wierszF04();
    expect(filtrujDokumenty([w], { typ: 'vat' })).toHaveLength(1);
    expect(doZestawienia(w)).toBe(true);
    const suma = sumaListy([w]);
    expect(suma.niepelne).toBeFalsy();
    expect(suma.PLN).toMatchObject({ nettoGr: 10000, bruttoGr: 12300 });
  });

  it('korekta (F15 #3): filtr typ=korekta zostawia ją, doZestawienia → true', async () => {
    const k = odpowiedzZPomiaru('F15', 3);
    const { program } = zestaw({ dokumenty: { [k.id]: k, 595670707: odpowiedzZPomiaru('F04', 1) } });
    const w = await program.pobierzFakture(String(k.id));
    expect(filtrujDokumenty([w], { typ: 'korekta' })).toHaveLength(1);
    expect(doZestawienia(w)).toBe(true);
    expect(w).toMatchObject({ net_price: -10000, tax_price: -2300 });
  });
});

describe('PRZ-119.03 listy — period zawsze, sell_date filtrowane po stronie OMS', () => {
  const d = (id, issue, sell) => ({ ...odpowiedzZPomiaru('F04', 1), id, number: `${id}/11/2026`, issue_date: issue, sell_date: sell });

  it('pole invoice_date: period=more, zakres dat, pozycje, kinds vat+wdt', async () => {
    let url;
    const { program } = zestaw({ lista: (u) => { url = u; return [d(1, '2026-11-03', '2026-11-03')]; } });
    const wiersze = await program.listaFaktur({ od: '2026-11-01', do: '2026-11-30', pole: 'invoice_date' });
    expect(url.searchParams.get('period')).toBe('more');
    expect(url.searchParams.get('date_from')).toBe('2026-11-01');
    expect(url.searchParams.get('date_to')).toBe('2026-11-30');
    expect(url.searchParams.get('include_positions')).toBe('true');
    expect(url.searchParams.getAll('kinds[]')).toEqual(['vat', 'wdt']);
    expect(wiersze.map((w) => w.uuid)).toEqual(['1']);
  });

  it('pole sale_date: szersze okno wystawienia, wynik przycięty do sell_date', async () => {
    let url;
    const { program } = zestaw({
      lista: (u) => {
        url = u;
        return [d(1, '2026-11-02', '2026-10-30'), d(2, '2026-11-02', '2026-11-01'), d(3, '2026-12-05', '2026-11-30'), d(4, '2026-12-05', '2026-12-01')];
      },
    });
    const wiersze = await program.listaFaktur({ od: '2026-11-01', do: '2026-11-30', pole: 'sale_date' });
    expect(url.searchParams.get('period')).toBe('more');
    expect(url.searchParams.get('date_from') < '2026-11-01').toBe(true);
    expect(url.searchParams.get('date_to') > '2026-11-30').toBe(true);
    expect(wiersze.map((w) => w.uuid)).toEqual(['2', '3']);
  });

  it('bez zakresu: period=all (nigdy domyślny „ten miesiąc” Fakturowni); korekty kind=correction', async () => {
    const adresy = [];
    const { program } = zestaw({ lista: (u) => { adresy.push(u); return []; } });
    await program.listaFaktur({});
    await program.listaKorekt({});
    expect(adresy.map((u) => u.searchParams.get('period'))).toEqual(['all', 'all']);
    expect(adresy[1].searchParams.get('kind')).toBe('correction');
  });

  // PRZ-119.05 (recenzja 03 b): widok faktur i zwroty czytają `corrected_invoice_number` z LISTY korekt.
  it('listaKorekt: corrected_invoice_number z rodzica, jedno pobranie na rodzica, 404 → null', async () => {
    const korekta = (id, rodzic) => ({ ...d(id, '2026-11-12', '2026-11-12'), kind: 'correction', number: `K${id}`, from_invoice_id: rodzic });
    const { program, zadania } = zestaw({
      lista: () => [korekta(11, 595670707), korekta(12, 595670707), korekta(13, 595679999)],
      dokumenty: { 595670707: odpowiedzZPomiaru('F04', 1) },
    });
    const wiersze = await program.listaKorekt({});
    expect(wiersze.map((w) => [w.uuid, w.corrected_invoice_number])).toEqual([
      ['11', '1/11/2026'], ['12', '1/11/2026'], ['13', null],
    ]);
    const pobrania = zadania.filter((z) => /^\/invoices\/\d+\.json$/.test(new URL(z.url).pathname)).map((z) => new URL(z.url).pathname);
    expect(pobrania).toEqual(['/invoices/595670707.json', '/invoices/595679999.json']);
  });

  it('listaKorekt: błąd pobrania rodzica (inny niż 404) przerywa listę', async () => {
    const korekta = { ...d(11, '2026-11-12', '2026-11-12'), kind: 'correction', number: 'K11', from_invoice_id: 595670707 };
    const { program } = zestaw({ lista: () => [korekta] });
    const f = fakturownia({ lista: () => [korekta] });
    const klient = { ...f.klient, pobierzFakture: async () => { throw Object.assign(new Error('Fakturownia nieosiągalna'), { status: 503 }); } };
    const zBledem = programFakturownia(klient, { alarmAutoKsef: alarmWPamieci(), teraz: () => new Date('2026-11-12T10:00:00Z') });
    await expect(zBledem.listaKorekt({})).rejects.toMatchObject({ status: 503 });
    expect((await program.listaKorekt({}))[0].corrected_invoice_number).toBeNull();
  });

  it('listaFaktur nie pobiera rodziców (faktury nie są korektami)', async () => {
    const { program, zadania } = zestaw({ lista: () => [d(1, '2026-11-03', '2026-11-03')] });
    const [w] = await program.listaFaktur({});
    expect(w.corrected_invoice_number).toBeUndefined();
    expect(zadania).toHaveLength(1);
  });
});

describe('PRZ-119.03 przekazania', () => {
  it('oznaczZaplacona → change_status; wyslijDokumentDoKsef to TA SAMA metoda klienta (jedyne wyjście do KSeF)', async () => {
    const { program, zadania } = zestaw();
    await program.oznaczZaplacona('595670707');
    expect(zadania).toHaveLength(1);
    expect(new URL(zadania[0].url).pathname).toBe('/invoices/595670707/change_status.json');
    expect(zadania[0].metoda).toBe('POST');
  });

  // PRZ-119.05 (recenzja 03 a): data zapłaty z zamówienia nie ginie po drodze do klienta.
  it('oznaczZaplacona z paidDate → change_status, potem PUT paid_date', async () => {
    const { program, zadania } = zestaw();
    await program.oznaczZaplacona('595670707', { paidDate: '2026-11-10' });
    expect(zadania.map((z) => `${z.metoda} ${new URL(z.url).pathname}`)).toEqual([
      'POST /invoices/595670707/change_status.json', 'PUT /invoices/595670707.json',
    ]);
    expect(JSON.parse(zadania[1].cialo)).toEqual({ invoice: { paid_date: '2026-11-10' } });
  });
});
