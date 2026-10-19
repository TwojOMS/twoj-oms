import { describe, it, expect } from 'vitest';
import {
  sprawdzSzablon, zlozTresc, zlozTemat, polaZamowienia, polaSzablonu, odczytajSzablony, zapiszSzablon, usunSzablon,
  szablonDoEdycji, rodzajSzablonu, DOMYSLNE, MAKS, KLUCZ_USTAWIEN,
} from '../../src/domena/szablony-wiadomosci.js';

// PRZ-101.03: szablony wiadomości — reguły zapisu i składanie treści (czysta domena).

const PUSTY = { wbudowane: {}, wlasne: [], licznik: 0 };
const zam = (nad = {}) => ({
  numer: '1024', utworzone_at: '2026-10-14T09:15:00Z', sklep: 'reczne', kwota_brutto: '476.00',
  koszt_dostawy_brutto: '19.00', metoda_wysylki: 'dpd',
  klient: { email: 'anna.nowak@example.com' },
  dostawa: { first_name: 'Anna Maria', last_name: 'Nowak', address_1: 'Lipowa 7', postcode: '00-950', city: 'Warszawa' },
  pozycje: [{ nazwa: 'Lampa Grzybek', ilosc: 2, cena_brutto: '189.00', brutto_linii: '378.00' },
    { nazwa: 'Klosz lniany', ilosc: 1, cena_brutto: '79.00', brutto_linii: '79.00' }],
  przesylki: [{ numer_listu: '000111' }, { numer_listu: '000222' }],
  ...nad,
});

describe('odmowy zapisu', () => {
  it('nieznane pole — odmowa z nazwą pola', () => {
    const w = sprawdzSzablon('potwierdzenie', { temat: 'Zamówienie {numer_zamowienia}', tresc: 'Dzień dobry {Imię},\n{podpis}' });
    expect(w.ok).toBe(false);
    expect(w.blad).toContain('{Imię}');
  });

  it('nieznane pole w temacie — odmowa z nazwą pola', () => {
    const w = sprawdzSzablon('wlasny', { nazwa: 'X', temat: 'Paczka {nr_paczki}', tresc: 'Dzień dobry' });
    expect(w).toMatchObject({ ok: false });
    expect(w.blad).toContain('{nr_paczki}');
  });

  it.each(['proforma', 'faktura', 'przypomnienie'])('%s bez {dane_platnosci} — odmowa (pieniądze)', (rodzaj) => {
    const w = sprawdzSzablon(rodzaj, { temat: 'Płatność {numer_zamowienia}', tresc: 'Prosimy o wpłatę {kwota}.\n\n{podpis}' });
    expect(w.ok).toBe(false);
    expect(w.blad).toContain('{dane_platnosci}');
  });

  // Kierownik pętli 18.10: przy pobraniu {zamkniecie} mówi „Należność pobierze kurier" — bez niego klient może
  // zapłacić dwa razy (przelewem i kurierowi). Obowiązkowe jak {dane_platnosci}.
  it.each(['proforma', 'faktura', 'przypomnienie'])('%s bez {zamkniecie} — odmowa z nazwą pola', (rodzaj) => {
    const w = sprawdzSzablon(rodzaj, { temat: 'P {numer_zamowienia}', tresc: 'Dzień dobry,\n\n{dane_platnosci}\n\nDziękujemy.\n\n{podpis}' });
    expect(w.ok).toBe(false);
    expect(w.blad).toContain('{zamkniecie}');
    expect(w.blad).toMatch(/kurier/);
  });

  it('{zamkniecie} w zdaniu własnym przechodzi; w szablonie własnym nadal nie działa', () => {
    expect(sprawdzSzablon('faktura', { temat: 'F', tresc: '{dane_platnosci}\n\nDziękujemy. {zamkniecie}\n\n{podpis}' }).ok).toBe(true);
    expect(sprawdzSzablon('wlasny', { nazwa: 'A', temat: 'T', tresc: 'x {zamkniecie}' }).ok).toBe(false);
  });

  // Recenzja 18.10: klamra, która nie tworzy znanego pola, trafiłaby do klienta dosłownie — każda ma dać odmowę.
  it('długa klamra (ponad 40 znaków) — odmowa z fragmentem tekstu', () => {
    const w = sprawdzSzablon('wlasny', { nazwa: 'A', temat: 'T', tresc: 'Numer: {tu wpisz numer zamówienia, który podał klient}.\n\n{podpis}' });
    expect(w.ok).toBe(false);
    expect(w.blad).toContain('{tu wpisz numer');
  });

  it('klamra przez dwie linie — odmowa', () => {
    const w = sprawdzSzablon('wlasny', { nazwa: 'A', temat: 'T', tresc: 'Dzień dobry {imie\n},\n\n{podpis}' });
    expect(w.ok).toBe(false);
    expect(w.blad).toMatch(/klamr/i);
  });

  it.each(['Cena {od 10 zł', 'Uśmiech :}', 'a { b', '{{imie}}'])('samotna albo podwójna klamra „%s" — odmowa', (tekst) => {
    expect(sprawdzSzablon('wlasny', { nazwa: 'A', temat: 'T', tresc: tekst }).ok).toBe(false);
  });

  it('klamra w temacie — odmowa', () => {
    expect(sprawdzSzablon('wlasny', { nazwa: 'A', temat: 'Nr {numer_zamowienia', tresc: 'x' }).ok).toBe(false);
  });

  it('{do_zaplaty} działa tylko w mailach o płatności', () => {
    expect(sprawdzSzablon('przypomnienie', { temat: 'P', tresc: 'Prosimy o {do_zaplaty}.\n\n{dane_platnosci}\n\n{zamkniecie}' }).ok).toBe(true);
    expect(sprawdzSzablon('wlasny', { nazwa: 'A', temat: 'T', tresc: 'Dopłata {do_zaplaty}' }).ok).toBe(false);
    expect(polaSzablonu('wlasny').find((p) => p.nazwa === 'kwota').opis).toMatch(/nie kwota do zapłaty/);
  });

  // PRZ-101.06: maile do zespołu (zaproszenie, reset hasła) — bez linku pracownik nie ustawi hasła.
  it.each(['zaproszenie', 'reset'])('%s bez {link} — odmowa z nazwą pola', (id) => {
    const w = sprawdzSzablon(rodzajSzablonu(id), { temat: 'Witaj {imie}', tresc: 'Cześć {imie}, link jest ważny {waznosc}.' });
    expect(w.ok).toBe(false);
    expect(w.blad).toContain('{link}');
  });

  it('mail do zespołu nie zna pól zamówienia ani podpisu; domyślne przechodzą', () => {
    expect(sprawdzSzablon('konto', { temat: 'T', tresc: '{link} {kwota}' }).ok).toBe(false);
    expect(sprawdzSzablon('konto', { temat: 'T', tresc: '{link}\n\n{podpis}' }).ok).toBe(false);
    expect(sprawdzSzablon('konto', DOMYSLNE.zaproszenie).ok).toBe(true);
    expect(sprawdzSzablon('konto', DOMYSLNE.reset).ok).toBe(true);
    expect(polaSzablonu('konto').map((p) => p.nazwa)).toEqual(['imie', 'link', 'waznosc']);
    expect(polaSzablonu('konto').find((p) => p.nazwa === 'imie').opis).toMatch(/pracownika/);
  });

  it('{link} i {waznosc} nie działają w mailach do klienta', () => {
    expect(sprawdzSzablon('wlasny', { nazwa: 'A', temat: 'T', tresc: '{link}' }).ok).toBe(false);
    expect(sprawdzSzablon('potwierdzenie', { temat: 'T', tresc: '{waznosc}' }).ok).toBe(false);
  });

  it('zapis i „Przywróć domyślny" szablonu konta', () => {
    const z = zapiszSzablon(PUSTY, 'reset', { temat: 'Nowe hasło', tresc: 'Tu: {link}' }, 't');
    expect(z.ok).toBe(true);
    expect(odczytajSzablony({ [KLUCZ_USTAWIEN]: JSON.stringify(z.stan) }).wbudowane.reset).toMatchObject({ temat: 'Nowe hasło' });
    expect(szablonDoEdycji(z.stan, 'reset')).toMatchObject({ rodzaj: 'konto', zmieniony: true });
    expect(szablonDoEdycji(usunSzablon(z.stan, 'reset').stan, 'reset')).toMatchObject({ zmieniony: false, ...DOMYSLNE.reset });
  });

  it('{dane_platnosci} w środku zdania nie liczy się jako obecne', () => {
    const w = sprawdzSzablon('proforma', { temat: 'P', tresc: 'Dane: {dane_platnosci}\n{podpis}' });
    expect(w.ok).toBe(false);
  });

  it('domyślne szablony płatnicze przechodzą (mają {dane_platnosci})', () => {
    for (const r of ['proforma', 'faktura', 'przypomnienie']) expect(sprawdzSzablon(r, DOMYSLNE[r]).ok).toBe(true);
    expect(sprawdzSzablon('potwierdzenie', DOMYSLNE.potwierdzenie).ok).toBe(true);
  });

  it('pole płatnicze w szablonie własnym — odmowa', () => {
    const w = sprawdzSzablon('wlasny', { nazwa: 'X', temat: 'T', tresc: 'Dzień dobry\n\n{dane_platnosci}' });
    expect(w.ok).toBe(false);
    expect(w.blad).toContain('{dane_platnosci}');
  });

  it('pusta nazwa szablonu własnego — odmowa', () => {
    expect(sprawdzSzablon('wlasny', { nazwa: '   ', temat: 'T', tresc: 'Treść' })).toMatchObject({ ok: false, blad: expect.stringMatching(/nazwę/) });
  });

  it('pusty temat albo treść — odmowa', () => {
    expect(sprawdzSzablon('wlasny', { nazwa: 'A', temat: ' ', tresc: 'x' }).ok).toBe(false);
    expect(sprawdzSzablon('wlasny', { nazwa: 'A', temat: 'T', tresc: '\n \n' }).ok).toBe(false);
  });

  it('blok w środku linii — odmowa', () => {
    const w = sprawdzSzablon('wlasny', { nazwa: 'A', temat: 'T', tresc: 'Oto pozycje: {pozycje}' });
    expect(w).toMatchObject({ ok: false, blad: expect.stringContaining('osobnej linii') });
  });

  it('za długa treść — odmowa', () => {
    expect(sprawdzSzablon('wlasny', { nazwa: 'A', temat: 'T', tresc: 'x'.repeat(MAKS.tresc + 1) }).ok).toBe(false);
  });

  it('31. szablon własny — odmowa, stan bez zmian', () => {
    let stan = PUSTY;
    for (let i = 1; i <= 30; i += 1) {
      const w = zapiszSzablon(stan, 'nowy', { nazwa: `S${i}`, temat: 'T', tresc: 'x' }, 't');
      expect(w.ok).toBe(true);
      stan = w.stan;
    }
    expect(stan.wlasne).toHaveLength(30);
    const w31 = zapiszSzablon(stan, 'nowy', { nazwa: 'S31', temat: 'T', tresc: 'x' }, 't');
    expect(w31.ok).toBe(false);
    expect(w31.blad).toContain('30');
  });
});

describe('składanie treści', () => {
  it('podstawia pola i nie zostawia {…} dla pól bez wartości', () => {
    const { tekst } = zlozTresc('Dzień dobry {imie},\nzamówienie {numer_zamowienia} ({numer_przesylki}).', {
      pola: { imie: 'Anna', numer_zamowienia: '1024' },
    });
    expect(tekst).toBe('Dzień dobry Anna,\nzamówienie 1024 ().');
    expect(tekst).not.toMatch(/[{}]/);
  });

  it('puste pole przed przecinkiem zabiera odstęp: „Dzień dobry," zamiast „Dzień dobry ,"', () => {
    expect(zlozTresc('Dzień dobry {imie},\nnr {numer_zamowienia} jutro', { pola: {} }).tekst).toBe('Dzień dobry,\nnr  jutro');
    expect(zlozTresc('Dzień dobry {imie},', { pola: { imie: 'Anna' } }).tekst).toBe('Dzień dobry Anna,');
    expect(zlozTemat('Dla {imie}: zamówienie {numer_zamowienia}', { numer_zamowienia: '7' })).toBe('Dla: zamówienie 7');
  });

  it('kupujący firma bez osoby w adresie — nazwa firmy', () => {
    const p = polaZamowienia(zam({ dostawa: { company: 'Półcień sp. z o.o.', address_1: 'Lipowa 7', city: 'Warszawa' } }));
    expect(p).toMatchObject({ kupujacy: 'Półcień sp. z o.o.', imie: '' });
  });

  it('wartość pola z klamrami nie jest podstawiana drugi raz', () => {
    expect(zlozTresc('{kupujacy}', { pola: { kupujacy: '{kwota}', kwota: '9 zł' } }).tekst).toBe('{kwota}');
  });

  it('blok rozwija się w linie, pusty blok znika razem ze swoją pustą linią', () => {
    const { tekst, czesci } = zlozTresc('A\n\n{pozycje}\n\n{wysylka}\n\nB', {
      bloki: { pozycje: ['ZAMÓWIENIE', '  x'], wysylka: [] },
    });
    expect(tekst).toBe('A\n\nZAMÓWIENIE\n  x\n\nB');
    expect(czesci.map((c) => c.typ)).toEqual(['akapit', 'blok', 'akapit']);
  });

  it('wiele pustych linii zwija się do jednej, linie akapitu zostają razem', () => {
    expect(zlozTresc('\n\nA\nB\n\n\n\nC\n\n').tekst).toBe('A\nB\n\nC');
  });

  it('temat: pola podstawione, jeden odstęp, bez nowej linii', () => {
    expect(zlozTemat('Proforma {numer_dokumentu} — nr {numer_zamowienia} ', { numer_zamowienia: '7' })).toBe('Proforma — nr 7');
  });
});

describe('pola z zamówienia', () => {
  it('imię, kupujący, kwota, przesyłki i data', () => {
    const p = polaZamowienia(zam(), { podpis: 'Pracownia Półcień' });
    expect(p).toMatchObject({
      numer_zamowienia: '1024', data_zamowienia: '2026-10-14', imie: 'Anna Maria', kupujacy: 'Anna Maria Nowak',
      kwota: '476,00 zł', numer_przesylki: '000111, 000222', nazwa_firmy: 'Pracownia Półcień',
    });
    expect(p.metoda_wysylki).toMatch(/DPD/);
  });

  it('bez zamówienia — wszystkie pola puste poza marką', () => {
    const p = polaZamowienia(null, { podpis: 'Marka' });
    expect(Object.entries(p).filter(([k, v]) => k !== 'nazwa_firmy' && v !== '')).toEqual([]);
  });

  it('lista pól pod edytorem: blok płatniczy obowiązkowy tylko w mailach o płatności', () => {
    expect(polaSzablonu('faktura').find((p) => p.nazwa === 'dane_platnosci')).toMatchObject({ blok: true, wymagane: true });
    expect(polaSzablonu('wlasny').map((p) => p.nazwa)).not.toContain('dane_platnosci');
  });
});

describe('stan zapisany', () => {
  it('edycja wbudowanego, potem „Przywróć domyślny"', () => {
    const z = zapiszSzablon(PUSTY, 'potwierdzenie', { temat: 'Mamy to: {numer_zamowienia}', tresc: 'Dziękujemy!\n\n{podpis}' }, '2026-10-18T10:00:00Z');
    expect(z.ok).toBe(true);
    expect(szablonDoEdycji(z.stan, 'potwierdzenie')).toMatchObject({ zmieniony: true, temat: 'Mamy to: {numer_zamowienia}' });
    const p = usunSzablon(z.stan, 'potwierdzenie');
    expect(szablonDoEdycji(p.stan, 'potwierdzenie')).toMatchObject({ zmieniony: false, ...DOMYSLNE.potwierdzenie });
  });

  it('id usuniętego szablonu własnego nie wraca do nowego', () => {
    let s = zapiszSzablon(PUSTY, 'nowy', { nazwa: 'A', temat: 'T', tresc: 'x' }, 't').stan;
    s = usunSzablon(s, 'wlasny-1').stan;
    const nowy = zapiszSzablon(s, 'nowy', { nazwa: 'B', temat: 'T', tresc: 'x' }, 't');
    expect(nowy.id).toBe('wlasny-2');
  });

  it('uszkodzony wiersz w bazie = brak szablonów, nie wyjątek', () => {
    expect(odczytajSzablony({ [KLUCZ_USTAWIEN]: '{zepsute' })).toEqual(PUSTY);
    expect(odczytajSzablony({})).toEqual(PUSTY);
  });
});
