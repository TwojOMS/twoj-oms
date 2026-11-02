// PRZ-122.TFe: przypadki wspólne przeniesione z tests/moduly/faktury/zwolnienie-vat-prz122.test.js; asercje bez zmian.
// PRZ-122.B07b — zwolnienie z VAT w Ustawieniach → Firma (tylko TwojeFaktury): zapis adminem, odmowy 403/409/400,
// podstawa składana na serwerze; adapter: firma zwolniona → wszystkie stawki „zw” i adnotacja; pozycja „zw” bez
// podstawy → odmowa PRZED rezerwacją numeru. Proforma: etykieta „zw” bez „%” (uwaga (3) z odbioru B07a).
// Prawdziwy skład (zbudujOms), sieć zabroniona. Dane zmyślone („Pracownia Półcień”, „Lampy Kowalczyk sp. z o.o.”).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Wybór programu dla tras Ustawień → Firma podaje test sam (opakowanie rejestracji), żeby w jednym składzie
// produkcyjnym przełączać TwojeFaktury / inFakt. Prawdziwe wpięcie z modul.ts: zwolnienie-vat-sklad-prz122.test.js.
const stan = vi.hoisted(() => ({ program: 'twojefaktury' }));
vi.mock('../../../src/moduly/faktury/trasy/ustawienia-firma.js', async (oryginal) => {
  const m = await oryginal();
  return { ...m, registerUstawieniaFirmyRoutes: (app, o) => m.registerUstawieniaFirmyRoutes(app, { ...o, wyborProgramu: { get program() { return stan.program; } } }) };
});

const { zbudujOms } = await import('../../../src/oms/bootstrap.ts');
const { modulyDla } = await import('../../../src/moduly/lista.ts');
const { zalozKonto, kontoPoLoginie, ustawUprawnienia } = await import('../../../src/core/bezpieczenstwo/konta.js');
const { jako, get, post } = await import('../../pomoc/konta-prz068.js');
const { czytajStawkeDomyslna, zapiszStawkeDomyslna } = await import('../../../src/moduly/faktury/db/stawka-vat.js');
const {
  sprawdzFormularzZwolnienia, czytajZwolnienie, zapiszZwolnienie, zwolnienieDlaProgramu,
} = await import('../../../src/moduly/faktury/db/zwolnienie-vat.js');
const { openOmsDb } = await import('../../../src/oms/db/db.ts');
const { modulRdzen } = await import('../../../src/moduly/rdzen/modul.ts');
const { zbudujProformePdf } = await import('../../../src/moduly/faktury/pdf/proforma-pdf.js');
const { podsumowanieVat } = await import('../../../src/domena/podsumowanie-vat.js');

const EKRAN = '/ustawienia/faktury/vat';
const ZAPIS = '/ustawienia/firma/zwolnienie-vat';
const ART_113 = 'art. 113 ust. 1 i 9 ustawy o VAT';

let katalog;
beforeEach(() => {
  stan.program = 'twojefaktury';
  katalog = mkdtempSync(join(tmpdir(), 'prz122-b07b-'));
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw Error('Sieć zabroniona'); });
});
afterEach(() => { vi.restoreAllMocks(); rmSync(katalog, { recursive: true, force: true }); });

async function panel() {
  const env = { OMS_TRYB: 'produkcja', OMS_SPRZEDAWCA_NIP: '1234563218', OMS_USER: 'operator', OMS_PASS: 'fixture',
    OMS_PROFORMY_KATALOG: katalog, OMS_ETYKIETY_KATALOG: katalog };
  const a = await zbudujOms({ env, moduly: modulyDla(env) });
  zalozKonto(a.db, { login: 'polcien', imie: 'Pracownia Półcień', haslo: 'h', rola: 'administrator', admin: true });
  zalozKonto(a.db, { login: 'ewa', imie: 'Ewa', haslo: 'h', rola: 'sprzedaz' });
  ustawUprawnienia(a.db, kontoPoLoginie(a.db, 'ewa').id, ['ustawienia', 'zamowienia']);
  return { ...a, admin: jako(a.db, 'polcien'), ewa: jako(a.db, 'ewa'), zamknij: async () => { await a.app.close(); a.db.close(); } };
}
const sekcja = (html) => /<section class="ust-sekcja" id="zwolnienie-vat">[\s\S]*?<\/section>/u.exec(html)?.[0] ?? '';
const sekcjaStawki = (html) => /<section class="ust-sekcja" id="stawka-vat">[\s\S]*?<\/section>/u.exec(html)?.[0] ?? '';

describe('sprawdzFormularzZwolnienia — podstawa składana na serwerze', () => {
  it('art. 113 → stała podstawa, rodzaj „ustawa”', () => {
    expect(sprawdzFormularzZwolnienia({ zwolniona: 'tak', podstawa: 'art113' }))
      .toMatchObject({ bledy: [], ustawienia: { zwolniona: true, podstawa: ART_113, rodzaj: 'ustawa' } });
  });

  it('art. 43: numer punktu i litera wpisane przez admina', () => {
    expect(sprawdzFormularzZwolnienia({ podstawa: 'art43', punkt: ' 29 ', litera: 'a' }).ustawienia)
      .toEqual({ zwolniona: false, podstawa: 'art. 43 ust. 1 pkt 29 lit. a ustawy o VAT', rodzaj: 'ustawa' });
    expect(sprawdzFormularzZwolnienia({ zwolniona: 'tak', podstawa: 'art43', punkt: '18', litera: '' }).ustawienia)
      .toEqual({ zwolniona: true, podstawa: 'art. 43 ust. 1 pkt 18 ustawy o VAT', rodzaj: 'ustawa' });
  });

  it('art. 43: punkt spoza 1–41 albo nie liczba, litera spoza a–z → zdanie, nic do zapisu', () => {
    for (const [punkt, litera] of [['0', ''], ['42', ''], ['', ''], ['2a', ''], ['1.5', ''], ['29', 'ab'], ['29', '1'], ['29', 'ą']]) {
      const w = sprawdzFormularzZwolnienia({ zwolniona: 'tak', podstawa: 'art43', punkt, litera });
      expect(w.bledy.length, `${punkt}/${litera}`).toBeGreaterThan(0);
      expect(w.ustawienia).toBeNull();
    }
  });

  it('„inna podstawa”: tekst i rodzaj; bez tekstu albo z rodzajem spoza listy → zdanie', () => {
    expect(sprawdzFormularzZwolnienia({ zwolniona: 'tak', podstawa: 'inna', podstawa_tekst: ' art. 132 ust. 1 lit. i dyrektywy 2006/112/WE ', rodzaj: 'dyrektywa' }).ustawienia)
      .toEqual({ zwolniona: true, podstawa: 'art. 132 ust. 1 lit. i dyrektywy 2006/112/WE', rodzaj: 'dyrektywa' });
    expect(sprawdzFormularzZwolnienia({ podstawa: 'inna', podstawa_tekst: '  ', rodzaj: 'inna' }).bledy[0]).toMatch(/Wpisz podstawę/u);
    expect(sprawdzFormularzZwolnienia({ podstawa: 'inna', podstawa_tekst: 'art. 132\n\n ust. 1\tlit. i', rodzaj: 'dyrektywa' }).ustawienia.podstawa)
      .toBe('art. 132 ust. 1 lit. i');
    expect(sprawdzFormularzZwolnienia({ podstawa: 'inna', podstawa_tekst: 'x', rodzaj: 'rozporządzenie' }).bledy.length).toBe(1);
  });

  it('firma zwolniona bez podstawy → zdanie; niezwolniona bez podstawy → zapis „bez podstawy”', () => {
    expect(sprawdzFormularzZwolnienia({ zwolniona: 'tak', podstawa: '' }).bledy[0]).toMatch(/Firma zwolniona z VAT musi mieć podstawę/u);
    expect(sprawdzFormularzZwolnienia({ podstawa: '' })).toMatchObject({ bledy: [], ustawienia: { zwolniona: false, podstawa: null, rodzaj: null } });
  });
});

describe('PRZ-122.B07b Ustawienia → Firma → Zwolnienie z VAT', () => {
  it('sekcja tylko przy TwojeFaktury; przy inFakcie ekran bez niej, a stawki bez „zw”', async () => {
    const p = await panel();
    try {
      const tf = await get(p.app, EKRAN, p.admin);
      expect(tf.statusCode, tf.body).toBe(200);
      const s = sekcja(tf.body);
      expect(s).toContain('Firma zwolniona z VAT');
      expect(s).toContain(ART_113);
      expect(s).toContain(`action="${ZAPIS}"`);
      expect(sekcjaStawki(tf.body)).toMatch(/<option value="zw">zw<\/option>/u);
      stan.program = 'infakt';
      const inf = await get(p.app, EKRAN, p.admin);
      expect(inf.statusCode).toBe(200);
      expect(sekcja(inf.body)).toBe('');
      expect(sekcjaStawki(inf.body)).not.toContain('zw');
    } finally { await p.zamknij(); }
  });

  it('administrator zapisuje firmę zwolnioną (art. 113) → 303; zapis w `ustawienia`, domyślna „zw” tylko z flagą', async () => {
    const p = await panel();
    try {
      const r = await post(p.app, ZAPIS, p.admin, { zwolniona: 'tak', podstawa: 'art113' });
      expect(r.statusCode, r.body).toBe(303);
      expect(czytajZwolnienie(p.db)).toEqual({ zwolniona: true, podstawa: ART_113, rodzaj: 'ustawa' });
      expect(zwolnienieDlaProgramu(p.db)).toEqual({ zwolniona: true, podstawa: ART_113, rodzaj: 'ustawa' });
      expect(czytajStawkeDomyslna(p.db, { zw: true })).toBe('zw');
      // Zapis z rodzajem spoza listy (ręczna zmiana bazy) → dla programu brak podstawy, pozycja „zw” dostanie odmowę.
      p.db.prepare("UPDATE ustawienia SET wartosc = ? WHERE klucz = 'vat.zwolnienie'")
        .run(JSON.stringify({ zwolniona: true, podstawa: ART_113, rodzaj: 'zmyslony' }));
      expect(zwolnienieDlaProgramu(p.db)).toBeNull();
      zapiszZwolnienie(p.db, { zwolniona: true, podstawa: ART_113, rodzaj: 'ustawa' });
      expect(czytajStawkeDomyslna(p.db)).toBe('23');
      const e = await get(p.app, r.headers.location, p.admin);
      expect(e.body).toContain('Zapisano zwolnienie z VAT');
      expect(sekcja(e.body)).toMatch(/name="zwolniona" value="tak" checked/u);
      // Wycofanie zwolnienia przywraca domyślną 23 (zostaje podstawa dla pojedynczych pozycji „zw”).
      expect((await post(p.app, ZAPIS, p.admin, { podstawa: 'art43', punkt: '29', litera: 'a' })).statusCode).toBe(303);
      expect(czytajZwolnienie(p.db)).toEqual({ zwolniona: false, podstawa: 'art. 43 ust. 1 pkt 29 lit. a ustawy o VAT', rodzaj: 'ustawa' });
      expect(czytajStawkeDomyslna(p.db, { zw: true })).toBe('23');
      expect(sekcja((await get(p.app, EKRAN, p.admin)).body)).toMatch(/name="punkt"[^>]*value="29"/u);
      // Stawka domyślna inna niż „zw” (8) — zapis podstawy bez zwolnienia jej nie rusza (recenzja B07b, uwaga 2).
      zapiszStawkeDomyslna(p.db, '8', { zw: true });
      expect((await post(p.app, ZAPIS, p.admin, { podstawa: 'art43', punkt: '29', litera: 'a' })).statusCode).toBe(303);
      expect(czytajStawkeDomyslna(p.db, { zw: true })).toBe('8');
    } finally { await p.zamknij(); }
  });

  it('konto z dostępem do Ustawień, ale nie administrator → 403, nic nie zapisane; ekran bez formularza', async () => {
    const p = await panel();
    try {
      const r = await post(p.app, ZAPIS, p.ewa, { zwolniona: 'tak', podstawa: 'art113' });
      expect(r.statusCode).toBe(403);
      expect(r.body).toMatch(/tylko administrator/u);
      expect(czytajZwolnienie(p.db)).toBeNull();
      expect(sekcja((await get(p.app, EKRAN, p.ewa)).body)).not.toContain(`action="${ZAPIS}"`);
    } finally { await p.zamknij(); }
  });

  it('pusta podstawa przy zwolnionej firmie albo „inna” bez tekstu → 400 ze zdaniem, nic nie zapisane', async () => {
    const p = await panel();
    try {
      const r = await post(p.app, ZAPIS, p.admin, { zwolniona: 'tak', podstawa: '' });
      expect(r.statusCode).toBe(400);
      expect(sekcja(r.body)).toContain('Firma zwolniona z VAT musi mieć podstawę');
      const r2 = await post(p.app, ZAPIS, p.admin, { podstawa: 'inna', podstawa_tekst: '', rodzaj: 'inna' });
      expect(r2.statusCode).toBe(400);
      expect(sekcja(r2.body)).toContain('Wpisz podstawę');
      expect(czytajZwolnienie(p.db)).toBeNull();
      expect(czytajStawkeDomyslna(p.db, { zw: true })).toBe('23');
    } finally { await p.zamknij(); }
  });

  it('przy programie innym niż TwojeFaktury zapis → 409, nic nie zapisane', async () => {
    stan.program = 'infakt';
    const p = await panel();
    try {
      const r = await post(p.app, ZAPIS, p.admin, { zwolniona: 'tak', podstawa: 'art113' });
      expect(r.statusCode).toBe(409);
      expect(czytajZwolnienie(p.db)).toBeNull();
    } finally { await p.zamknij(); }
  });

  it('domyślna stawka „zw” zapisuje się z ekranu tylko przy TwojeFaktury', async () => {
    const p = await panel();
    try {
      expect((await post(p.app, '/ustawienia/firma/stawka-vat', p.admin, { stawka: 'zw' })).statusCode).toBe(303);
      expect(czytajStawkeDomyslna(p.db, { zw: true })).toBe('zw');
      stan.program = 'infakt';
      const p2 = await panel();
      try {
        expect((await post(p2.app, '/ustawienia/firma/stawka-vat', p2.admin, { stawka: 'zw' })).statusCode).toBe(400);
      } finally { await p2.zamknij(); }
    } finally { await p.zamknij(); }
  });
});

describe('PRZ-122.B07b uwaga (3) z B07a — proforma: etykieta „zw” bez „%”', () => {
  it('PDF proformy z pozycją „zw”: „zw” w pozycji i w tabeli VAT, nigdzie „zw%”', () => {
    const pozycje = [
      { name: 'Kurs lutowania', quantity: '1', gross_price: 5700, tax_symbol: 'zw' },
      { name: 'Lampa stołowa', quantity: '1', gross_price: 12300, tax_symbol: '23' },
    ];
    const buf = zbudujProformePdf({
      numer: 'PF/1/11/2026', dataWystawienia: '2026-11-03', sprzedawca: { nazwa: 'Pracownia Półcień', nip: '1234563218' },
      nabywca: { nazwa: 'Lampy Kowalczyk sp. z o.o.', nip: '1234500011' }, pozycje,
      podsumowanieVat: podsumowanieVat(pozycje, { zw: true }), doZaplatyGr: 18000, slownie: 'sto osiemdziesiąt złotych',
    });
    const plik = join(katalog, 'p.pdf');
    writeFileSync(plik, buf);
    const tekst = execFileSync('pdftotext', ['-layout', '-enc', 'UTF-8', plik, '-'], { encoding: 'utf8' });
    expect(tekst).toMatch(/\bzw\b/u);
    expect(tekst).not.toContain('zw%');
    expect(tekst).toContain('23%');
  });
});
