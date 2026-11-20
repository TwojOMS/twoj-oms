import { KOLEJNOSC, oczyscUkryteTypy, sprawdzUkryteTypy, ukrytePrzezWszystkich } from '../../domena/powiadomienia.js';
import { WYGASANIE_INTEGRACJI_MS, czyZignorowane, wierszeDlaKonta } from '../../domena/ostrzezenia.js';

const maId = (id) => Number.isInteger(id) && id > 0;
const kluczKonta = (id) => `powiadomienia.ukryte.${id}`;

export function ukryteTypyKonta(db, id) {
  if (!maId(id)) return [];
  const zapis = db.prepare('SELECT wartosc FROM ustawienia WHERE klucz = ?').get(kluczKonta(id));
  if (!zapis) return [];
  // Uszkodzony zapis pokazuje wszystkie ostrzeżenia, zamiast zabierać stronę zamówień.
  try {
    return oczyscUkryteTypy(JSON.parse(zapis.wartosc));
  } catch {
    return [];
  }
}

export function zapiszUkryteTypy(db, id, typy) {
  if (!maId(id)) throw new Error('Konto serwisowe nie ma osobistych ustawień powiadomień.');
  const poprawne = sprawdzUkryteTypy(typy);
  db.prepare(
    `INSERT INTO ustawienia (klucz, wartosc, zmienione_at) VALUES (?, ?, ?)
    ON CONFLICT(klucz) DO UPDATE SET wartosc=excluded.wartosc, zmienione_at=excluded.zmienione_at`,
  ).run(kluczKonta(id), JSON.stringify(poprawne), new Date().toISOString());
}

export function rodzajeNiewidoczneDlaFirmy(db) {
  const konta = db.prepare('SELECT id FROM konta WHERE czynne = 1').all();
  return ukrytePrzezWszystkich(konta.map((k) => ukryteTypyKonta(db, k.id)));
}

const isoTeraz = (teraz) => (teraz instanceof Date ? teraz : new Date(teraz ?? Date.now())).toISOString();
const pozycja = (typ) => {
  const i = KOLEJNOSC.indexOf(typ);
  return i < 0 ? KOLEJNOSC.length : i;
};

function wierszZBazy(r) {
  return {
    klucz: r.klucz,
    typ: r.typ,
    tekst: r.tekst,
    title: r.title ?? undefined,
    przycisk: r.href ? { href: r.href, etykieta: r.etykieta_przycisku ?? 'Pokaż' } : null,
    etykietaOdrzucenia: r.etykieta_odrzucenia ?? null,
    pilne: r.pilne === 1,
    pierwszyRazAt: r.pierwszy_raz_at,
    ostatnioAt: r.ostatnio_at,
    przeczytane: r.przeczytane_at != null,
    _rozwiazaneAt: r.rozwiazane_at,
    _odrzuconeAt: r.odrzucone_at,
    _odrzucil: r.odrzucil_imie ?? r.odrzucone_przez ?? null,
  };
}

/**
 * Powiadomienia oczami jednego konta — JEDEN odczyt dla dzwonka, strony i pasa, żeby te trzy miejsca nie
 * rozjechały się w tym, co konto widzi. Czyta tylko migawkę (reguł nie liczy od nowa), więc licznik jest tani.
 * „Ignoruj” jest wspólne dla firmy (tabela odrzuceń), przeczytanie — osobne dla konta. Wyciszenie awarii
 * integracji wygasa po dobie według tej samej reguły, co tabelka na liście (`czyZignorowane`).
 *
 * Zwraca `{ aktualne, archiwum, nieprzeczytane, pilne }`; `pilne` liczy aktualne pilne bez względu na
 * przeczytanie — czerwony dzwonek mówi o trwającej awarii, nie o tym, czy ktoś ją już kliknął.
 */
export function powiadomieniaKonta(db, konto, { teraz = new Date(), archiwum = true } = {}) {
  const t = teraz instanceof Date ? teraz.getTime() : Number(teraz);
  const kontoId = maId(konto?.id) ? konto.id : 0;
  const surowe = db
    .prepare(
      `SELECT p.*, r.przeczytane_at, o.odrzucone_at, o.odrzucone_przez, k.imie AS odrzucil_imie
       FROM powiadomienia p
       LEFT JOIN powiadomienia_przeczytane r ON r.klucz = p.klucz AND r.konto_id = ?
       LEFT JOIN ostrzezenia_odrzucone o ON o.klucz = p.klucz
       LEFT JOIN konta k ON k.login = o.odrzucone_przez
       ${archiwum ? '' : 'WHERE p.rozwiazane_at IS NULL'}`,
    )
    .all(kontoId);
  const widoczne = wierszeDlaKonta({
    wiersze: surowe.map(wierszZBazy),
    konto,
    ukryteTypy: ukryteTypyKonta(db, kontoId),
  });
  const aktualne = [];
  const stare = [];
  for (const { _rozwiazaneAt, _odrzuconeAt, _odrzucil, ...w } of widoczne) {
    if (czyZignorowane(w.typ, _odrzuconeAt, t)) {
      stare.push(
        w.typ === 'integracja'
          ? {
              ...w,
              status: 'wyciszone',
              statusAt: new Date(Date.parse(_odrzuconeAt) + WYGASANIE_INTEGRACJI_MS).toISOString(),
            }
          : { ...w, status: 'zignorowane', statusAt: _odrzuconeAt, statusKto: _odrzucil },
      );
    } else if (_rozwiazaneAt) {
      stare.push({ ...w, status: 'rozwiazane', statusAt: _rozwiazaneAt });
    } else {
      aktualne.push({ ...w, status: 'aktualne' });
    }
  }
  aktualne.sort(
    (a, b) =>
      Number(a.przeczytane) - Number(b.przeczytane) ||
      Number(b.pilne) - Number(a.pilne) ||
      pozycja(a.typ) - pozycja(b.typ) ||
      String(b.ostatnioAt).localeCompare(String(a.ostatnioAt)),
  );
  stare.sort((a, b) => String(b.statusAt).localeCompare(String(a.statusAt)));
  return {
    aktualne,
    archiwum: stare,
    nieprzeczytane: aktualne.filter((w) => !w.przeczytane).length,
    pilne: aktualne.filter((w) => w.pilne).length,
  };
}

/** Przeczytanie jednego powiadomienia przez konto. Klucz spoza migawki nie zostawia śladu (false). */
export function oznaczPrzeczytane(db, kontoId, klucz, { teraz = new Date() } = {}) {
  if (!maId(kontoId) || typeof klucz !== 'string') return false;
  const wynik = db
    .prepare(
      `INSERT INTO powiadomienia_przeczytane (konto_id, klucz, przeczytane_at)
       SELECT ?, klucz, ? FROM powiadomienia WHERE klucz = ?
       ON CONFLICT(konto_id, klucz) DO NOTHING`,
    )
    .run(kontoId, isoTeraz(teraz), klucz);
  if (wynik.changes > 0) return true;
  return Boolean(db.prepare('SELECT 1 FROM powiadomienia WHERE klucz = ?').get(klucz));
}

/** „Oznacz wszystkie jako przeczytane” — tylko aktualne, które to konto widzi. Zwraca liczbę nowych oznaczeń. */
export function oznaczWszystkiePrzeczytane(db, konto, { teraz = new Date() } = {}) {
  if (!maId(konto?.id)) return 0;
  const { aktualne } = powiadomieniaKonta(db, konto, { teraz, archiwum: false });
  const wstaw = db.prepare(
    `INSERT INTO powiadomienia_przeczytane (konto_id, klucz, przeczytane_at) VALUES (?, ?, ?)
     ON CONFLICT(konto_id, klucz) DO NOTHING`,
  );
  const kiedy = isoTeraz(teraz);
  let n = 0;
  db.exec('BEGIN');
  try {
    for (const w of aktualne) if (!w.przeczytane) n += Number(wstaw.run(konto.id, w.klucz, kiedy).changes);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return n;
}
