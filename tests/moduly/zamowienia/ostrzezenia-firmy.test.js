import { it, expect, afterEach } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { MODULY } from '../../../src/moduly/lista.ts';
import { kolejnoscBudowy } from '../../../src/core/sprawdz-moduly.ts';
import { createKontekstZamowien } from '../../../src/moduly/zamowienia/kontekst.js';
import { utworzRegule, wlaczRegule, wstrzymajRegule } from '../../../src/moduly/automatyzacje/db/reguly.js';
import { utworzKarte } from '../../../src/oms/db/magazyn.js';
import { przelaczStany } from '../../../src/oms/db/stany-magazynowe.js';
import { stanKanalu } from '../../../src/domena/kanal-stan.js';
import { zalozKonto, kontoPoLoginie } from '../../../src/core/bezpieczenstwo/konta.js';
import { createMigawkaPowiadomien } from '../../../src/moduly/zamowienia/services/migawka-powiadomien.js';
import { oznaczPrzeczytane, powiadomieniaKonta } from '../../../src/oms/db/powiadomienia.js';
import { stanMigawki } from '../../../src/oms/db/powiadomienia-migawka.js';

// Migawka powiadomień zbiera sprawy całej firmy bez konta: automatyzacja, niski stan i kanały sprzedaży zawsze
// (kto je zobaczy, rozstrzyga odczyt). Wiadomości z Allegro nie są powiadomieniem — mają licznik na zakładce.

const bazy = [];
afterEach(() => {
  for (const db of bazy.splice(0)) db.close();
});

function sprawy({ stany = [], ...opcje } = {}) {
  const db = openOmsDb(':memory:', { moduly: kolejnoscBudowy(MODULY) });
  bazy.push(db);
  const teraz = new Date();
  const id = utworzRegule(
    db,
    {
      nazwa: 'Podziękowanie za lampę',
      zdarzenie: 'test_zdarzenie',
      zdarzenie_json: {},
      warunki: { kanaly: ['sklep'], kanalyZnane: ['sklep'] },
      akcja: 'test_akcja',
      akcja_json: { szablon: 'wlasny-1' },
      opoznienie_min: 0,
      limit_na_godzine: 20,
    },
    { login: 'admin-test', teraz: () => teraz },
  );
  wlaczRegule(db, id, { login: 'admin-test', teraz: () => teraz });
  wstrzymajRegule(db, id, 'brak szablonu');

  const kartaId = utworzKarte(db, { nazwa: 'Lampa Półcień', sku: 'POLCIEN' });
  db.prepare('UPDATE karty_produktow SET prog_niskiego_stanu = 2 WHERE id = ?').run(kartaId);
  przelaczStany(db, { wlacz: true });

  const kontekst = createKontekstZamowien({ db, config: {}, stanyKanalow: () => stany, ...opcje });
  return { db, kontekst, teraz };
}
const typy = (wiersze) => [...new Set(wiersze.map((w) => w.typ))].sort();

it('zbieranie dla firmy: automatyzacja i niski stan zawsze', () => {
  const { kontekst, teraz } = sprawy();
  const { wiersze, nieudane } = kontekst.wierszeOstrzezenFirmy(teraz);
  expect(nieudane).toEqual([]);
  expect(typy(wiersze)).toEqual(['automatyzacja', 'niski-stan']);
  expect(wiersze.find((w) => w.typ === 'automatyzacja').tekst).toContain('Podziękowanie za lampę');
});

it('zbieranie dla firmy liczy kanały sprzedaży: martwy pilny, wygasający z „Ignoruj”', () => {
  const martwy = stanKanalu({ kanal: 'allegro_polcien', polaczony: false });
  const wygasa = stanKanalu({ kanal: 'allegro_cien', polaczony: true, zostaloDni: 3 });
  const zdrowy = stanKanalu({ kanal: 'allegro_jasny', polaczony: true, zostaloDni: 90 });
  const { kontekst, teraz } = sprawy({ stany: [zdrowy, wygasa, martwy] });
  const kanaly = kontekst.wierszeOstrzezenFirmy(teraz).wiersze.filter((w) => w.typ === 'kanal');
  expect(kanaly.map((w) => [w.klucz, w.pilne, w.etykietaOdrzucenia])).toEqual([
    ['kanal:allegro_polcien:pilne', true, null],
    ['kanal:allegro_cien:uprzedzenie', false, 'Ignoruj'],
  ]);
  expect(kanaly[0].przycisk).toEqual({ href: '/ustawienia/integracje', etykieta: 'Połączenia' });
  // Na liście zamówień kanały ma pas nad tabelką — w tabelce byłyby drugi raz.
  expect(kontekst.zbierzOstrzezenia(null).some((w) => w.typ === 'kanal')).toBe(false);
});

it('lista zamówień bez konta: bez automatyzacji (tylko admin) i bez wiadomości z Allegro', () => {
  const { db, kontekst } = sprawy();
  expect(typy(kontekst.zbierzOstrzezenia(null))).toEqual(['niski-stan']);
  zalozKonto(db, { login: 'admin-test', imie: 'Administrator', haslo: 'h', rola: 'administrator', admin: true });
  expect(typy(kontekst.zbierzOstrzezenia({ konto: kontoPoLoginie(db, 'admin-test') }))).toEqual([
    'automatyzacja',
    'niski-stan',
  ]);
});

it('zbieranie dla firmy rzuca, gdy zebrać się nie da (przebieg zostawi poprzednią migawkę)', () => {
  const { db, kontekst, teraz } = sprawy();
  bazy.splice(bazy.indexOf(db), 1);
  db.close();
  expect(() => kontekst.wierszeOstrzezenFirmy(teraz)).toThrow();
  // Odczyt listy dalej połyka błąd i pokazuje pustą tabelkę — jak dotąd.
  expect(kontekst.zbierzOstrzezenia(null)).toEqual([]);
});

it('zbieranie dla firmy oddaje źródła, które zawiodły, zamiast udawać, że ich spraw nie ma', () => {
  const awaria = () => {
    throw new Error('źródło chwilowo niedostępne');
  };
  const { kontekst, teraz } = sprawy({ kopie: awaria, niepewneKsef: awaria });
  const { wiersze, nieudane } = kontekst.wierszeOstrzezenFirmy(teraz);
  expect(nieudane.map((n) => n.prefiks)).toEqual(['integracja:kopia:', 'faktura-ksef:niepewna:']);
  expect(nieudane.every((n) => typeof n.zrodlo === 'string' && n.zrodlo.length > 0)).toBe(true);
  // Reszta spraw dalej się liczy.
  expect(typy(wiersze)).toEqual(['automatyzacja', 'niski-stan']);
  // Lista zamówień pokazuje resztę jak dotąd.
  expect(typy(kontekst.zbierzOstrzezenia(null))).toEqual(['niski-stan']);
});

it('chwilowy błąd źródła nie rozwiązuje jego sprawy: przeczytanie i pierwszy raz zostają, stan ma błąd', async () => {
  let awaria = false;
  const niepewneKsef = () => {
    if (awaria) throw new Error('SQLITE_BUSY');
    return [{ dokument_id: 7, wersja: 1, numer: 'FV 1/11/2026', od: '2026-11-18T08:00:00Z' }];
  };
  const { db, kontekst } = sprawy({ niepewneKsef });
  zalozKonto(db, { login: 'admin-test', imie: 'Administrator', haslo: 'h', rola: 'administrator', admin: true });
  const konto = kontoPoLoginie(db, 'admin-test');
  let t = new Date('2026-11-20T10:00:00Z');
  const migawka = createMigawkaPowiadomien({ db, zbierz: (x) => kontekst.wierszeOstrzezenFirmy(x), teraz: () => t });
  const KLUCZ = 'faktura-ksef:niepewna:7:1';
  const wiersz = () => db.prepare('SELECT * FROM powiadomienia WHERE klucz = ?').get(KLUCZ);
  const ksef = () => powiadomieniaKonta(db, konto, { teraz: t }).aktualne.find((w) => w.klucz === KLUCZ);

  await migawka.przebieg();
  expect(oznaczPrzeczytane(db, konto.id, KLUCZ, { teraz: t })).toBe(true);
  const przed = wiersz();
  expect(przed.rozwiazane_at).toBeNull();

  awaria = true;
  t = new Date(t.getTime() + 60_000);
  await migawka.przebieg();
  expect(wiersz()).toEqual(przed);
  expect(ksef()).toMatchObject({ przeczytane: true });
  expect(stanMigawki(db).blad).toContain('nie odpowiedziało');

  awaria = false;
  t = new Date(t.getTime() + 60_000);
  await migawka.przebieg();
  expect(wiersz()).toMatchObject({ pierwszy_raz_at: przed.pierwszy_raz_at, rozwiazane_at: null });
  expect(ksef()).toMatchObject({ przeczytane: true });
  expect(stanMigawki(db).blad).toBeNull();
});
