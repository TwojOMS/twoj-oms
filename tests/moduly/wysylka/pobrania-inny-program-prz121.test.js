// PRZ-121.A04b — czuwacz pobrań i dokument innego programu.
//
// Program testowy o `opis.id = 'test'` podany tak, jak podaje go szew `fabryki.programFakturowy` modułu faktur
// (moduł wysyłki dostaje go pod starą nazwą `infakt`). Doręczone pobrania: faktura inFaktu (nowy wiersz i stary,
// z samym `infakt_uuid`) i dokument `test`. Automat POMIJA dokument innego programu — bez odczytu, bez rezerwacji,
// bez wpisu w logu zamówienia — i idzie dalej: gałąź `bezProgramu` (przerwanie przebiegu) nie może się od niego
// uruchomić, więc dokument `test` za nim zostaje oznaczony.
import { describe, it, expect, beforeEach } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { rozpocznijPrzesylke, zakonczPrzesylke, zapiszStatusDpd } from '../../../src/moduly/wysylka/db/przesylki.js';
import { oznaczenieZaplaty } from '../../../src/moduly/wysylka/db/oznaczenia-zaplaty.js';
import { oznaczDoreczonePobrania } from '../../../src/moduly/wysylka/services/oznaczanie-pobran.js';
import { programTestowy } from '../../pomoc/program-testowy.js';

const zamowienie = (nr) => ({
  zrodlo_id: nr, numer: `PZ-${nr}`,
  klient: { first_name: 'Anna', last_name: 'Półcień', company: 'Pracownia Półcień', email: 'biuro@polcien.invalid' },
  dostawa: {}, metoda_wysylki: 'dpd', kwota_pobrania: '258.00', pobranie: 1, chce_fakture: 1, nip: null,
  kwota_brutto: '258.00', status_woo: 'processing', oplacone_at: null, anulowane: 0, utworzone_at: '2026-10-01T10:00:00Z',
  pozycje: [{ zrodlo_id: 11, nazwa: 'Lampa wisząca Półcień', sku: 'LAMPA-W1', ilosc: 2, cena_brutto: '129.00', vat: null }],
});

/** Doręczone pobranie z fakturą: 'infakt' (program + dokument_id), 'infakt-stara' (sam infakt_uuid), 'test'. */
function doreczonePobranie(db, nr, rodzaj) {
  const id = zapiszZamowienie(db, 'pro', zamowienie(nr), {});
  const dok = `dok-${rodzaj}-${nr}`;
  if (rodzaj === 'infakt-stara') {
    db.prepare('INSERT INTO faktury (zamowienie_id, infakt_uuid, numer, utworzona_at) VALUES (?,?,?,?)')
      .run(id, dok, `FV/${nr}/10/2026`, '2026-10-01T08:00:00.000Z');
  } else {
    db.prepare('INSERT INTO faktury (zamowienie_id, program, dokument_id, numer, utworzona_at) VALUES (?,?,?,?,?)')
      .run(id, rodzaj, dok, `${rodzaj === 'test' ? 'TST' : 'FV'}/${nr}/10/2026`, '2026-10-01T08:00:00.000Z');
  }
  const p = rozpocznijPrzesylke(db, id, 'dpd', 1);
  zakonczPrzesylke(db, p.id, { numerListu: `N${nr}`, etykietaSciezka: '/tmp/e.pdf', surowa: '<x/>' });
  zapiszStatusDpd(db, p.id, { opis: 'Przesyłka doręczona', at: '2026-10-05T14:00:00.000' });
  return { id, dok };
}

const logZamowienia = (db, id) => db.prepare('SELECT wynik FROM log WHERE zamowienie_id = ? ORDER BY id').all(id).map((w) => w.wynik);
const nieoplacona = async (uuid) => ({ uuid, number: 'TST', invoice_date: '2026-10-01', status: 'sent', left_to_pay: 25800 });

let db;
beforeEach(() => { db = openOmsDb(':memory:'); });

describe('PRZ-121.A04b czuwacz pobrań pomija dokument innego programu', () => {
  it('[inFakt, inFakt stara, test]: `oznaczZaplacona` raz, dla `test`; inFakt bez odczytu, rezerwacji i wpisu', async () => {
    const nowa = doreczonePobranie(db, 7101, 'infakt');
    const stara = doreczonePobranie(db, 7102, 'infakt-stara');
    const test = doreczonePobranie(db, 7103, 'test');
    const program = programTestowy({ id: 'test', metody: { pobierzFakture: nieoplacona } });

    // Jak z szwu modułu faktur: program pod starą nazwą `infakt`.
    const wynik = await oznaczDoreczonePobrania({ db, infakt: program });

    expect(program.ile('oznaczZaplacona')).toBe(1);
    expect(program.wywolania.filter(([m]) => m === 'oznaczZaplacona').map(([, uuid]) => uuid)).toEqual([test.dok]);
    expect(program.wywolania.filter(([m]) => m === 'pobierzFakture').map(([, uuid]) => uuid)).toEqual([test.dok]);
    expect(wynik).toMatchObject({ kandydatow: 1, zlecone: 1, bledy: 0, innyProgram: 2 });
    expect(oznaczenieZaplaty(db, test.dok)).toMatchObject({ powod: 'pobranie_doreczone' });
    for (const inny of [nowa, stara]) {
      expect(oznaczenieZaplaty(db, inny.dok)).toBeFalsy();
      expect(logZamowienia(db, inny.id)).toEqual([]);
    }
  });

  it('cudze dokumenty nie zjadają sufitu przebiegu: przy `limit: 1` dokument `test` za inFaktem oznaczony', async () => {
    doreczonePobranie(db, 7151, 'infakt');
    const test = doreczonePobranie(db, 7152, 'test');
    const program = programTestowy({ id: 'test', metody: { pobierzFakture: nieoplacona } });
    const wynik = await oznaczDoreczonePobrania({ db, program, limit: 1 });
    expect(program.wywolania.filter(([m]) => m === 'oznaczZaplacona').map(([, uuid]) => uuid)).toEqual([test.dok]);
    expect(wynik).toMatchObject({ kandydatow: 1, obsluzone: 1, ponadSufit: 0, innyProgram: 1 });
  });

  it('następny przebieg znów pomija inFakt — bez odczytu i bez zlecenia (nic nie zostało zamknięte na zawsze)', async () => {
    const nowa = doreczonePobranie(db, 7201, 'infakt');
    const program = programTestowy({ id: 'test', metody: { pobierzFakture: nieoplacona } });
    await oznaczDoreczonePobrania({ db, program });
    await oznaczDoreczonePobrania({ db, program });
    expect(program.wywolania).toEqual([]);
    expect(oznaczenieZaplaty(db, nowa.dok)).toBeFalsy();
  });

  it('program inFakt (ten sam co dokument): pobranie oznaczone jak dziś', async () => {
    const nowa = doreczonePobranie(db, 7301, 'infakt');
    const stara = doreczonePobranie(db, 7302, 'infakt-stara');
    const test = doreczonePobranie(db, 7303, 'test');
    const program = programTestowy({ id: 'infakt', metody: { pobierzFakture: nieoplacona } });
    const wynik = await oznaczDoreczonePobrania({ db, program });
    expect(program.wywolania.filter(([m]) => m === 'oznaczZaplacona').map(([, uuid]) => uuid).sort())
      .toEqual([nowa.dok, stara.dok].sort());
    expect(wynik).toMatchObject({ zlecone: 2, bledy: 0 });
    expect(oznaczenieZaplaty(db, test.dok)).toBeFalsy();
  });
});
