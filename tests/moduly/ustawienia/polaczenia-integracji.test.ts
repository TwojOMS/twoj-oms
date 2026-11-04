import { it, expect } from 'vitest';
import { nowyPanel } from '../../pomoc/konta-prz068.js';
import * as service from '../../../src/moduly/ustawienia/services/polaczenia-integracji.ts';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { KATALOG_INTEGRACJI } from '../../../src/domena/katalog-integracji.ts';
import {openOmsDb} from '../../../src/oms/db/db.ts';
import {migracjaKanalowSprzedazy} from '../../../src/moduly/kanaly/migracje/0001-kanaly-sprzedazy.ts';
import {migracjaTypuKanaluISklepow} from '../../../src/moduly/kanaly/migracje/0003-kanaly-typ-sklepy.ts';
import {createRepozytoriumKanalow} from '../../../src/moduly/kanaly/repozytorium-kanalow.ts';
import { fmtKiedy } from '../../../src/domena/format-daty.js';

const { renderFile } = createRequire(import.meta.url)('ejs') as { renderFile: (path: string, data: object) => Promise<string> };
const TERAZ = new Date('2026-11-03T21:30:00Z');
const renderuj = (polaczenia: any[], katalog = false, kanaly: any[] = []) => renderFile('src/moduly/ustawienia/widoki/ustawienia-polaczenia.ejs', {
  title: 'Integracje', blad: null, zapisano: null, katalog, filtry: { szukaj: '', kategoria: '', planowane: true },
  uslugi: KATALOG_INTEGRACJI, wszystkieUslugi: KATALOG_INTEGRACJI, polaczenia, liczPolaczenia: service.liczPolaczenia, podsumowanie: (service as any).podsumowanie(polaczenia), kanaly,
  fmtDataCzas: (d: string) => d, fmtKiedy: (d: string) => fmtKiedy(d, TERAZ),
});
// Wiersz w kształcie z modelu PRZ-136.06 (polaczeniaIntegracji).
const wiersz = (o: any = {}) => ({ id: 'allegro:allegro_polcien', usluga: 'allegro', nazwa: 'Allegro Półcień', nazwaLudzka: 'Allegro Półcień', kanal: 'allegro_polcien', opis: '',
  stan: 'niesprawdzone', etykietaStanu: 'Niesprawdzone', zrodlo: 'serwer', atrapa: false, ostatniSukcesAt: null, czasOdczytu: null, grupa: 'sprzedaz', konto: null,
  komunikat: null, akcja: { etykieta: 'Zarządzaj', href: '/ustawienia/integracje/allegro/allegro_polcien', glowna: false }, wiecej: [], ...o });
const konto = wiersz();

const hrefZarzadzaj = (html: string, usluga: string) => {
  const karta = html.split('<article').find((a) => a.includes(`data-usluga="${usluga}"`)) ?? '';
  return karta.match(/<a class="ust-link" href="([^"]+)">Zarządzaj<\/a>/)?.[1] ?? null;
};
it('karta Allegro pozwala dodać konto i zarządzać istniejącymi', async () => {
  for (const lista of [[], [konto]]) {
    const html = await renderuj(lista, true);
    expect(html).toMatch(/class="btn btn--drugi btn--maly" href="\/ustawienia\/integracje\/allegro\/nowe">Dodaj konto<\/a>/);
    // PRZ-143.02 N5 (właściciel 04.11): przy jednym koncie „Zarządzaj” w katalogu otwiera ekran tego konta.
    expect(hrefZarzadzaj(html, 'allegro')).toBe(lista.length ? '/ustawienia/integracje/allegro/allegro_polcien' : null);
  }
  const html = await renderuj([konto]);
  // B2: stara kotwica #polaczenia-allegro zniknęła, a cel odnośnika istnieje na liście.
  expect(html).not.toContain('polaczenia-allegro');
  const lista = await renderuj([konto]);
  expect(lista).toMatch(/<section class="pol-grupa" id="grupa-sprzedaz"/);
  expect(lista).not.toContain('id="polaczenia-allegro"');
});
it('karta WooCommerce pozwala dodać sklep i zarządzać istniejącymi (B2: odnośnik do istniejącego elementu)', async () => {
  const sklep = wiersz({ id: 'woocommerce:sklep_polcien', usluga: 'woocommerce', nazwa: 'Sklep Półcień', kanal: 'sklep_polcien', akcja: null });
  const drugi = wiersz({ id: 'woocommerce:sklep_dwa', usluga: 'woocommerce', nazwa: 'Sklep Dwa', kanal: 'sklep_dwa', akcja: null });
  for (const lista of [[], [sklep], [sklep, drugi]]) {
    const html = await renderuj(lista, true);
    expect(html).toMatch(/class="btn btn--drugi btn--maly" href="\/ustawienia\/integracje\/woocommerce\/nowy">Dodaj sklep<\/a>/);
    const href = hrefZarzadzaj(html, 'woocommerce');
    if (!lista.length) { expect(href).toBeNull(); continue; }
    expect(href).not.toMatch(/#polaczenia-allegro$/);
    expect(href).toBe(lista.length === 1 ? '/ustawienia/integracje#pol-woocommerce-sklep_polcien' : '/ustawienia/integracje#grupa-sprzedaz');
    const cel = href!.split('#')[1];
    expect(await renderuj(lista)).toContain(`id="${cel}"`);
  }
});
it('katalog: usługi planowane są wyciszone, z pastylką „Wkrótce” i bez przycisku; obrazki mają wymiary', async () => {
  const html = await renderuj([], true);
  const planowane = KATALOG_INTEGRACJI.filter((u: any) => u.dostepnosc === 'planowana');
  expect(planowane.length).toBeGreaterThan(0);
  for (const u of planowane) {
    const karta = html.split('<article').find((a) => a.includes(`data-usluga="${u.id}"`)) ?? '';
    expect(karta).toContain('ust-karta-integracji--planowana');
    expect(karta).toContain('Wkrótce');
    expect(karta).not.toMatch(/<a /);
  }
  for (const img of html.match(/<img [^>]*>/g) ?? []) expect(img).toMatch(/width="\d+" height="\d+"/);
  // PRZ-136.14 (#11): katalog ma jeden własny <h1> z tytułem zakładki.
  expect(html.match(/<h1[\s>]/g) ?? []).toHaveLength(1);
});
it('wiersz sklepu WooCommerce (env i panel) ma odnośnik do zarządzania', async () => {
  for (const zrodlo of ['serwer', 'panel']) {
    const html = await renderuj([wiersz({ id: 'woocommerce:sklep_polcien', usluga: 'woocommerce', nazwa: 'Sklep Półcień', nazwaLudzka: 'Sklep Półcień', kanal: 'sklep_polcien', zrodlo,
      akcja: { etykieta: 'Zarządzaj', href: '/ustawienia/integracje/woocommerce/sklep_polcien', glowna: false } })]);
    expect(html).toContain('href="/ustawienia/integracje/woocommerce/sklep_polcien">Zarządzaj</a>');
  }
});
it('stopka nie mówi, że sklepy dodaje się w konfiguracji serwera i nie używa nazw plików', async () => {
  const html = await renderuj([konto]);
  expect(html).not.toContain('dodaje się w pliku konfiguracji serwera');
  expect(html).not.toContain('dodaje się w konfiguracji serwera');
  expect(html).not.toContain('oms.env');
  expect(html).toContain('<p class="pol-stopka">');
  expect(html).toContain('href="/ustawienia/integracje/program-fakturowy"');
});
it('nazwa konta nie jest poprzedzana powtórzonym typem', async () => {
  const html = await renderuj([konto]);
  expect(html).not.toMatch(/Allegro\s+(?:<[^>]+>\s*)*Allegro Półcień/);
  expect(html).toContain('Allegro Półcień');
  const bezNazwy = await renderuj([wiersz({ id: 'infakt:glowne', usluga: 'infakt', nazwa: 'infakt', nazwaLudzka: 'inFakt', kanal: undefined, grupa: 'faktury', akcja: null })]);
  expect(bezNazwy).toMatch(/<p class="pol-nazwa">inFakt<\/p>/);
  expect(bezNazwy).not.toMatch(/<p class="pol-konto">inFakt/);
});
it('wiersze kont Allegro z serwera i panelu prowadzą do zarządzania, atrapy nie', async () => {
  for (const zrodlo of ['serwer', 'panel']) {
    const html = await renderuj([{ ...konto, zrodlo }]);
    expect(html).toContain('href="/ustawienia/integracje/allegro/allegro_polcien">Zarządzaj</a>');
  }
  expect(await renderuj([{ ...konto, atrapa: true, akcja: null }])).not.toContain('href="/ustawienia/integracje/allegro/allegro_polcien"');
});

// ── PRZ-136.07: widok listy (U1–U4, U10–U11) ──
const piec = () => [
  wiersz({ id: 'allegro:outlet', kanal: 'outlet', nazwa: 'Allegro Półcień Outlet', nazwaLudzka: 'Allegro Półcień Outlet', stan: 'uwaga', etykietaStanu: 'Wymaga uwagi', konto: 'pracownia_polcien_2',
    wysylkaAllegro: 'wlaczona', komunikat: 'Dostęp do konta wygasa 6 listopada.', czasOdczytu: '2026-11-03T21:18:00Z',
    akcja: { etykieta: 'Odnów dostęp', href: '/ustawienia/integracje/allegro/outlet', glowna: true },
    wiecej: [{ etykieta: 'Pokaż szczegóły', href: '/ustawienia/integracje/allegro/outlet#diagnostyka' }] }),
  wiersz({ id: 'allegro:polcien', kanal: 'polcien', stan: 'dziala', etykietaStanu: 'Działa', konto: 'pracownia_polcien_1', czasOdczytu: '2026-11-03T21:22:00Z' }),
  wiersz({ id: 'inpost:glowne', usluga: 'inpost', nazwa: 'inpost', nazwaLudzka: 'InPost', kanal: undefined, grupa: 'wysylka', stan: 'blad', etykietaStanu: 'Błąd',
    komunikat: 'InPost odrzucił token.', czasOdczytu: '2026-11-02T14:40:00Z', akcja: { etykieta: 'Wklej token', href: '/ustawienia/integracje/inpost', glowna: true } }),
  wiersz({ id: 'smtp:glowne', usluga: 'smtp', nazwa: 'smtp', nazwaLudzka: 'Poczta wychodząca', kanal: undefined, grupa: 'poczta', stan: 'dziala', etykietaStanu: 'Działa',
    akcja: { etykieta: 'Zarządzaj', href: '/ustawienia/integracje/smtp', glowna: false } }),
  wiersz({ id: 'woocommerce:stary', usluga: 'woocommerce', kanal: 'stary', nazwa: 'Stary sklep Półcień', nazwaLudzka: 'Stary sklep Półcień', grupa: 'wstrzymane', stan: 'wylaczone', etykietaStanu: 'Wyłączone',
    akcja: { etykieta: 'Zarządzaj', href: '/ustawienia/integracje/woocommerce/stary', glowna: false } }),
];
const wiersze = (html: string) => html.match(/<li class="pol-wiersz[\s\S]*?<\/li>/g) ?? [];
it('lista: grupy z licznikiem, kotwice, liczniki nad listą, jedna akcja główna przy problemie, wstrzymane zwinięte (U1, U2, U10, U11)', async () => {
  const html = await renderuj(piec());
  expect(html).toContain('class="pol-podsumowanie"');
  expect(html).toMatch(/<strong>5<\/strong> połączeń/);
  expect(html).toMatch(/<strong>1<\/strong> błąd<\/a>/);
  expect(html).toMatch(/<strong>1<\/strong> wymaga uwagi<\/a>/);
  expect(html).toMatch(/<strong>2<\/strong> działa<\/a>/);
  expect(html).toMatch(/<strong>1<\/strong> wstrzymane<\/a>/);
  expect(html).toContain('href="/ustawienia/integracje/katalog">Dodaj integrację</a>');
  for (const [grupa, nazwa, ile] of [['sprzedaz', 'Sprzedaż', 2], ['wysylka', 'Wysyłka', 1], ['poczta', 'Poczta i analityka', 1]] as const) {
    expect(html).toMatch(new RegExp(`<section class="pol-grupa" id="grupa-${grupa}"[\\s\\S]*?<h2[^>]*>${nazwa} <span class="pol-grupa-ile">${ile}</span></h2>`));
  }
  expect(html).not.toContain('id="grupa-faktury"');
  expect(html).toContain('class="pol-wiersz pol-wiersz--blad" id="pol-inpost-glowne"');
  expect(html).toContain('class="pol-wiersz pol-wiersz--uwaga" id="pol-allegro-outlet"');
  const problemy = wiersze(html).filter(w => /pol-wiersz--(blad|uwaga)/.test(w));
  expect(problemy).toHaveLength(2);
  for (const w of problemy) expect(w.match(/btn--glowny/g)).toHaveLength(1);
  expect(wiersze(html).filter(w => !/pol-wiersz--(blad|uwaga)/.test(w)).join('')).not.toContain('btn--glowny');
  expect(html).toContain('<p class="pol-komunikat pol-komunikat--blad">InPost odrzucił token.</p>');
  expect(html).toContain('<span class="pol-stan pol-stan--blad"><span class="pol-kropka" aria-hidden="true"></span>Błąd</span>');
  expect(html).toContain('<time datetime="2026-11-03T21:22:00Z">dziś 22:22</time>');
  expect(html).toContain('<time datetime="2026-11-02T14:40:00Z">wczoraj 15:40</time>');
  expect(html).toContain('Allegro · konto pracownia_polcien_2 · Wysyłam z Allegro: włączone');
  expect(html).toMatch(/<details class="pol-wiecej"><summary class="btn btn--cichy btn--maly" aria-label="Więcej akcji: Allegro Półcień Outlet">Więcej<\/summary>/);
  const wstrzymane = html.match(/<details class="pol-wstrzymane" id="pol-wstrzymane">[\s\S]*?<\/details>\s*$/m)?.[0] ?? html.slice(html.indexOf('<details class="pol-wstrzymane"'));
  expect(html).toContain('<details class="pol-wstrzymane" id="pol-wstrzymane">');
  expect(wstrzymane).toContain('pol-wiersz pol-wiersz--wstrzymane');
  expect(wstrzymane).toContain('Stary sklep Półcień');
  // Wstrzymany nie jest w grupie Sprzedaż.
  const sprzedaz = html.slice(html.indexOf('id="grupa-sprzedaz"'), html.indexOf('id="grupa-wysylka"'));
  expect(sprzedaz).not.toContain('Stary sklep Półcień');
  // Logo 40 px, bez starych kart 116×54.
  expect(html).not.toContain('ust-polaczenie');
  expect(html).toMatch(/<span class="pol-logo"><img src="\/public\/integracje\/[^"]+" alt="" width="40" height="40"><\/span>/);
});
it('lista bez problemów nie ma żadnego przycisku głównego poza „Dodaj integrację”', async () => {
  const html = await renderuj([wiersz({ stan: 'dziala', etykietaStanu: 'Działa' })]);
  expect(html.match(/btn--glowny/g)).toHaveLength(1);
  expect(html).not.toContain('pol-wstrzymane');
  expect(html).not.toMatch(/błąd<\/a>/);
});
it('martwe konto Allegro z serwera: „Połącz z Allegro” jest jedyną akcją główną, wiązanie w toku pokazuje kod', async () => {
  const martwe = wiersz({ stan: 'uwaga', etykietaStanu: 'Wymaga uwagi', komunikat: 'Allegro odrzuciło token.', akcja: { etykieta: 'Zarządzaj', href: '/ustawienia/integracje/allegro/allegro_polcien', glowna: true } });
  const html = await renderuj([martwe], false, [{ stan: { kanal: 'allegro_polcien', wolnoWiazac: true }, wiazanie: null }]);
  expect(html).toContain('action="/ustawienia/kanaly/allegro_polcien/wiazanie"');
  expect(html).toContain('Połącz z Allegro</button>');
  expect(wiersze(html)[0]?.match(/btn--glowny/g)).toHaveLength(1);
  const wToku = await renderuj([martwe], false, [{ stan: { kanal: 'allegro_polcien', wolnoWiazac: true }, wiazanie: { adres: 'https://allegro.example/urzadzenie', userCode: 'ABC-123' } }]);
  expect(wToku).toContain('<strong>ABC-123</strong>');
  expect(wToku).not.toContain('Połącz z Allegro</button>');
});

const odczyt = (o: any) => (service as any).polaczeniaIntegracji?.(o);
it('Woo z panelu ma nazwę z repozytorium i rzeczywisty stan pollera również w trybie próby', () => {
  const db=openOmsDb();
  try {
    migracjaKanalowSprzedazy.wykonaj(db);migracjaTypuKanaluISklepow.wykonaj(db);
    const repo=createRepozytoriumKanalow({db,definicjeEnv:[],konfiguracjaEnv:{}});
    const w=repo.utworzSzkicSklepu({nazwa:'Pracownia Półcień',adres:'https://sklep.polcien.example',odUtc:'2026-11-01T00:00:00Z',aktor:{id:1,login:'polcien'}});
    expect(w.ok).toBe(true);if(!w.ok)throw Error('Nie utworzono szkicu');
    const klucz=w.dane.klucz;
    const czytaj=()=>odczyt({db,proba:true,sklepyWoo:repo.listaTypu('woo'),kanaly:{sklepy:{[klucz]:{ck:'ck_polcien',cs:'cs_polcien'}}}});
    expect(czytaj()[0]).toMatchObject({nazwa:'Pracownia Półcień',zrodlo:'panel',stan:'niesprawdzone',atrapa:false});
    db.prepare('INSERT INTO stan_pollera(sklep,ostatni_przebieg_at) VALUES(?,?)').run(klucz,'2026-11-02T12:00:00Z');
    expect(czytaj()[0]).toMatchObject({stan:'dziala',ostatniSukcesAt:'2026-11-02T12:00:00Z'});
    db.prepare('UPDATE stan_pollera SET ostatni_blad=? WHERE sklep=?').run('ck_polcien cs_polcien',klucz);
    expect(czytaj()[0]).toMatchObject({stan:'uwaga',ostatniSukcesAt:null});
    expect(JSON.stringify(czytaj())).not.toMatch(/ck_polcien|cs_polcien/);
  } finally {db.close();}
});
// PRZ-134.PT7: zgłoszenie właściciela 03.11 — klucze odrzucone przy dodawaniu, szkic został w bazie, a lista go nie
// pokazywała; ponowne dodanie odmawiało („adres już zapisany”), więc sklepu nie dało się ani dokończyć, ani usunąć.
it('szkic Woo z panelu bez udanego połączenia jest na liście z odnośnikiem do dokończenia (PRZ-134.PT7)', async () => {
  const db=openOmsDb();
  try {
    migracjaKanalowSprzedazy.wykonaj(db);migracjaTypuKanaluISklepow.wykonaj(db);
    const repo=createRepozytoriumKanalow({db,definicjeEnv:[],konfiguracjaEnv:{}});
    const w=repo.utworzSzkicSklepu({nazwa:'Pracownia Półcień',adres:'https://sklep.polcien.example',odUtc:'2026-11-01T00:00:00Z',aktor:{id:1,login:'polcien'}});
    if(!w.ok)throw Error('Nie utworzono szkicu');
    const m=odczyt({db,sklepyWoo:repo.listaTypu('woo'),kanaly:{sklepy:{}}});
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({usluga:'woocommerce',kanal:w.dane.klucz,nazwa:'Pracownia Półcień',zrodlo:'panel',stan:'niesprawdzone'});
    expect(m[0].opis).toContain('dokończ');
    expect(await renderuj(m)).toContain(`/ustawienia/integracje/woocommerce/${w.dane.klucz}`);
  } finally {db.close();}
});
it('lista sklepów Woo z panelu przychodzi parametrem, usługa nie czyta repozytorium', () => {
  const db=openOmsDb();
  try {
    const m=odczyt({db,kanaly:{sklepy:{polcien:{}}},sklepyWoo:[{klucz:'polcien',nazwa:'Pracownia Półcień',zrodlo:'panel'}]});
    expect(m[0]).toMatchObject({nazwa:'Pracownia Półcień',zrodlo:'panel'});
    expect(readFileSync('src/moduly/ustawienia/services/polaczenia-integracji.ts','utf8')).not.toContain('createRepozytoriumKanalow');
  } finally {db.close();}
});
it('pusta instalacja nie dostaje pozornych połączeń', async () => {
  const { app, db } = nowyPanel();
  try { expect(odczyt({ db })).toEqual([]); } finally { await app.close(); db.close(); }
});
it('dwa konta Allegro i dwa Woo zachowują osobne stany, WzA jest polem konta', async () => {
  const { app, db } = nowyPanel();
  try {
    db.prepare('INSERT INTO stan_pollera(sklep,ostatni_przebieg_at,ostatni_blad) VALUES(?,?,?)').run('a1','2026-10-31T10:00:00Z',null);
    db.prepare('INSERT INTO stan_pollera(sklep,ostatni_przebieg_at,ostatni_blad) VALUES(?,?,?)').run('a2','2026-10-31T10:01:00Z','Nie wypisuj surowego błędu z kluczem SEKRET');
    const m = odczyt({ db, kanaly: { kanaly: { a1: { clientSecret: 'SEKRET' }, a2: {} }, sklepy: { w1: {}, w2: {} } }, stanyKanalow: [{kanal:'a1',kontoAllegro:'konto A'},{kanal:'a2',kontoAllegro:'konto B'}] });
    expect(m.filter((p: any)=>p.usluga==='allegro')).toHaveLength(2);
    expect(m.filter((p: any)=>p.usluga==='woocommerce')).toHaveLength(2);
    expect(m.find((p: any)=>p.id==='allegro:a1')).toMatchObject({stan:'dziala',ostatniSukcesAt:'2026-10-31T10:00:00Z'});
    expect(m.find((p: any)=>p.id==='allegro:a2')).toMatchObject({stan:'uwaga',ostatniSukcesAt:null});
    // PRZ-136.06 (U6): WzA nie jest osobnym wierszem, tylko polem konta Allegro.
    expect(m.filter((p: any)=>p.usluga==='allegro').map((p: any)=>p.wysylkaAllegro)).toEqual(['wlaczona','wlaczona']);
    expect(m.some((p: any)=>p.usluga==='wza')).toBe(false);
    expect(JSON.stringify(m)).not.toContain('SEKRET');
    expect(new Set(m.map((p: any)=>p.id)).size).toBe(m.length);
  } finally { await app.close(); db.close(); }
});
it('obecność konfiguracji nie dowodzi udanego odczytu; źródło serwer niezależne od stanu', async () => {
  const { app, db } = nowyPanel();
  try {
    const m=odczyt({ db, integracje:[{id:'dpd',skonfigurowana:true,zrodlo:'serwer'}] });
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({usluga:'dpd',stan:'niesprawdzone',ostatniSukcesAt:null,zrodlo:'serwer'});
  } finally { await app.close(); db.close(); }
});
it('atrpa piaskownicy nie jest dowodem rzeczywistego działania', async () => {
  const { app, db } = nowyPanel();
  try {
    db.prepare('INSERT INTO stan_pollera(sklep,ostatni_przebieg_at) VALUES(?,?)').run('woo','2026-10-31T10:00:00Z');
    const m=odczyt({db,proba:true,kanaly:{sklepy:{woo:{}},kanaly:{}}});
    expect(m[0]).toMatchObject({atrapa:true,stan:'niesprawdzone'});
  } finally { await app.close(); db.close(); }
});

// ── PRZ-136.06: model wiersza listy „Moje połączenia” (B1, U5–U9, U13–U14) ──
const allegroPanelu = (klucz: string, nazwa: string, o: any = {}) => ({ klucz, nazwa, srodowisko: 'produkcja', zrodlo: 'panel', kontoId: `k-${klucz}`, login: `login_${klucz}`,
  autoryzacja: 'polaczone', pobieranie: 'wlaczone', odUtc: '2026-11-01T00:00:00Z', raport: '', wersja: 1, generacja: 1, generacjaImportu: 1, ...o });

it('B1: atrapa inFaktu bez zapisanych danych nie jest „skonfigurowana” — wiersz mówi „Niepodłączony” (PRZ-140 N1), nie udaje połączenia', async () => {
  const stanIntegracji = (service as any).stanIntegracji;
  expect(stanIntegracji({ usluga: { atrapa: true, zEnv: false }, zapisany: false })).toEqual({ skonfigurowana: false, atrapa: true, zrodlo: 'panel' });
  expect(stanIntegracji({ usluga: { atrapa: true }, zapisany: true })).toMatchObject({ skonfigurowana: true, atrapa: false });
  expect(stanIntegracji({ usluga: { zEnv: true }, zapisany: false })).toEqual({ skonfigurowana: true, atrapa: false, zrodlo: 'serwer' });
  expect(stanIntegracji({ usluga: null, zapisany: false })).toEqual({ skonfigurowana: false, atrapa: false, zrodlo: 'panel' });
  const { app, db } = nowyPanel();
  try {
    const m = odczyt({ db, proba: true, integracje: [{ id: 'infakt', skonfigurowana: false, atrapa: true, zrodlo: 'panel' }, { id: 'ksef', skonfigurowana: false, atrapa: false, zrodlo: 'panel' }] });
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ usluga: 'infakt', stan: 'niesprawdzone', atrapa: true, etykietaStanu: 'Niepodłączony', nazwaLudzka: 'inFakt', grupa: 'faktury',
      akcja: { etykieta: 'Podłącz', href: '/ustawienia/integracje/infakt', glowna: false } });
    expect(m[0].opis).not.toContain('Konfiguracja jest dostępna');
    const zapisany = odczyt({ db, integracje: [{ id: 'infakt', skonfigurowana: true, atrapa: false, zrodlo: 'panel' }] });
    expect(zapisany[0]).toMatchObject({ etykietaStanu: 'Niesprawdzone', atrapa: false, akcja: { etykieta: 'Zarządzaj', href: '/ustawienia/integracje/infakt' } });
  } finally { await app.close(); db.close(); }
});
it('dwa konta Allegro i dwa WzA dają 2 wiersze; WzA jest polem konta; podsumowanie liczy 2', async () => {
  const { app, db } = nowyPanel();
  try {
    const m = odczyt({ db, kanaly: { kanaly: {} }, polaczeniaAllegro: [allegroPanelu('a1', 'Allegro Półcień'), allegroPanelu('a2', 'Allegro Cień', { autoryzacja: 'odlaczone' })] });
    expect(m).toHaveLength(2);
    expect(m.some((p: any) => p.usluga === 'wza' || String(p.id).startsWith('wza:'))).toBe(false);
    expect(m.find((p: any) => p.kanal === 'a1')).toMatchObject({ wysylkaAllegro: 'wlaczona', grupa: 'sprzedaz', nazwaLudzka: 'Allegro Półcień', konto: 'login_a1' });
    expect(m.find((p: any) => p.kanal === 'a2')).toMatchObject({ wysylkaAllegro: 'wylaczona', grupa: 'wstrzymane', stan: 'wylaczone' });
    expect((service as any).podsumowanie(m)).toEqual({ razem: 2, blad: 0, dziala: 0, uwaga: 0, niesprawdzone: 1, wstrzymane: 1 });
  } finally { await app.close(); db.close(); }
});
it('kolejność w grupie: uwaga, działa, niesprawdzone; grupy w stałej kolejności, wstrzymane na końcu', async () => {
  const { app, db } = nowyPanel();
  try {
    const wstaw = db.prepare('INSERT INTO stan_pollera(sklep,ostatni_przebieg_at,ostatni_blad) VALUES(?,?,?)');
    wstaw.run('dziala', '2026-11-03T21:22:00Z', null);
    wstaw.run('uwaga', '2026-11-03T21:22:00Z', 'Odmowa: token SEKRET');
    const m = odczyt({ db, kanaly: { sklepy: { nowy: {}, dziala: {}, uwaga: {} } },
      polaczeniaAllegro: [allegroPanelu('stary', 'Allegro wstrzymane', { autoryzacja: 'odlaczone' })],
      integracje: [{ id: 'infakt', skonfigurowana: true, atrapa: false, zrodlo: 'panel' }, { id: 'dpd', skonfigurowana: true, atrapa: false, zrodlo: 'serwer' }] });
    expect(m.map((p: any) => p.kanal ?? p.usluga)).toEqual(['uwaga', 'dziala', 'nowy', 'dpd', 'infakt', 'stary']);
    expect(m.map((p: any) => p.grupa)).toEqual(['sprzedaz', 'sprzedaz', 'sprzedaz', 'wysylka', 'faktury', 'wstrzymane']);
    const uwaga = m[0];
    expect(uwaga.komunikat).toBeTruthy();
    expect(uwaga.akcja).toMatchObject({ href: '/ustawienia/integracje/woocommerce/uwaga', glowna: true });
    expect(m[1]).toMatchObject({ komunikat: null, czasOdczytu: '2026-11-03T21:22:00Z', akcja: { etykieta: 'Zarządzaj', glowna: false } });
    expect(m.filter((p: any) => p.akcja?.glowna)).toHaveLength(1);
    expect(JSON.stringify(m)).not.toContain('SEKRET');
  } finally { await app.close(); db.close(); }
});
it('każdy wiersz ma akcję i ludzką nazwę: atrapa Woo „Zarządzaj”, reklamy z nazwą z katalogu i kontem w drugiej linii (U5, U7)', async () => {
  const { app, db } = nowyPanel();
  try {
    const { zapiszPolaczenie } = await import('../../../src/oms/db/reklamy.js');
    zapiszPolaczenie(db, { typ: 'meta', kontoId: 'act_000000000001' });
    const m = odczyt({ db, proba: true, kanaly: { sklepy: { polcien: {} } }, integracje: [{ id: 'smtp', skonfigurowana: true, atrapa: false, zrodlo: 'serwer' }] });
    const woo = m.find((p: any) => p.kanal === 'polcien');
    expect(woo).toMatchObject({ atrapa: true, etykietaStanu: 'Dane przykładowe', akcja: { etykieta: 'Zarządzaj', href: '/ustawienia/integracje/woocommerce/polcien' } });
    const meta = m.find((p: any) => p.usluga === 'meta');
    expect(meta).toMatchObject({ nazwaLudzka: 'Meta Ads', konto: 'act_000000000001', grupa: 'poczta', akcja: { href: '/ustawienia/integracje/reklamy' } });
    expect(m.find((p: any) => p.usluga === 'smtp')).toMatchObject({ nazwaLudzka: 'Poczta wychodząca', grupa: 'poczta' });
    for (const p of m) { expect(p.akcja?.href, p.id).toMatch(/^\/ustawienia\//); expect(Array.isArray(p.wiecej), p.id).toBe(true); }
  } finally { await app.close(); db.close(); }
});
it('widoki dostają fmtKiedy z defaultContext (czas odczytu formatuje widok)', async () => {
  const { app, db } = nowyPanel();
  try {
    await app.ready();
    const html = await (app as any).view({ raw: '<%= fmtKiedy("2026-11-03T21:22:00Z", new Date("2026-11-03T21:30:00Z")) %>' }, { wlasnyUklad: true });
    expect(String(html).trim()).toBe('dziś 22:22');
  } finally { await app.close(); db.close(); }
});

it('PRZ-136.08: pusta lista pokazuje stan pusty z trzema krokami i linkami z katalogu, bez podsumowania (U12)', async () => {
  const html = await renderuj([]);
  expect(html).not.toContain('pol-podsumowanie');
  expect(html).toContain('class="pol-pusto"');
  const kroki = html.slice(html.indexOf('<ol class="pol-pusto-kroki">'), html.indexOf('</ol>'));
  expect(kroki.match(/<li>/g)).toHaveLength(3);
  expect(html).toContain('href="/ustawienia/integracje/katalog">Zobacz wszystkie integracje</a>');
  const href = (id: string) => KATALOG_INTEGRACJI.find((u) => u.id === id)!.href!;
  for (const id of ['allegro', 'woocommerce', 'dpd', 'inpost', 'infakt', 'ksef']) expect(kroki).toContain(`href="${href(id)}"`);
  // Allegro jest jedyną akcją główną.
  expect(html.match(/btn--glowny/g)).toHaveLength(1);
  expect(kroki).toMatch(/btn--glowny[^>]*href="[^"]*allegro[^"]*">Podłącz Allegro/);
  expect(html).not.toContain('Dodaj pierwszą integrację');
});
it('PRZ-136.08: niepusta lista nie pokazuje stanu pustego', async () => {
  const html = await renderuj([wiersz()]);
  expect(html).not.toContain('pol-pusto');
  expect(html).toContain('pol-podsumowanie');
});
