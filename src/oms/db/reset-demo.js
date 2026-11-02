import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { KLUCZ_ZLECENIA_RESETU, ZACHOWANE_PRZY_RESECIE } from '../../domena/reset-demo.js';

const maNumeracje = (db) => ['tf_serie', 'tf_liczniki'].every(nazwa =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(nazwa));

export function zlecResetDemo(db, { login, teraz = new Date() }) {
  const zlecono = teraz.toISOString();
  db.prepare(`INSERT INTO ustawienia (klucz, wartosc, zmienione_at) VALUES (?, ?, ?)
    ON CONFLICT(klucz) DO UPDATE SET wartosc=excluded.wartosc, zmienione_at=excluded.zmienione_at`)
    .run(KLUCZ_ZLECENIA_RESETU, JSON.stringify({ zlecono, login }), zlecono);
}

export function odczytajZlecenieResetu(db) {
  // Baza bez tabeli `ustawienia` (np. pusty plik) = brak zlecenia — start jak przed RESET-DEMO.
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ustawienia'").get()) return null;
  const wpis = db.prepare('SELECT wartosc FROM ustawienia WHERE klucz = ?').get(KLUCZ_ZLECENIA_RESETU);
  if (!wpis) return null;
  let zlecenie;
  try { zlecenie = JSON.parse(wpis.wartosc); } catch { throw new Error('Niepoprawne zlecenie resetu demo'); }
  const odczyt = db.prepare('SELECT integracja, ustawienia_json, konto_login, zmieniono_at FROM konfiguracja_integracji WHERE integracja = ?');
  const zachowane = ZACHOWANE_PRZY_RESECIE.map(k => odczyt.get(k)).filter(Boolean);
  const numeracja = maNumeracje(db) ? {
    serie: db.prepare('SELECT kod, rodzaj, format, reset, zmieniono_at, konto_login FROM tf_serie').all(),
    liczniki: db.prepare('SELECT s.kod, l.okres, l.ostatni FROM tf_liczniki l JOIN tf_serie s ON s.id = l.seria_id').all(),
  } : null;
  return { zlecenie, zachowane, numeracja };
}

export function przywrocPoResecie(db, { zachowane, numeracja }) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const integracja = db.prepare(`INSERT INTO konfiguracja_integracji (integracja, ustawienia_json, sekrety_json, konto_id, konto_login, zmieniono_at)
      VALUES (?, ?, '{}', NULL, ?, ?) ON CONFLICT(integracja) DO UPDATE SET ustawienia_json=excluded.ustawienia_json,
      sekrety_json='{}', konto_id=NULL, konto_login=excluded.konto_login, zmieniono_at=excluded.zmieniono_at`);
    for (const w of zachowane) integracja.run(w.integracja, w.ustawienia_json, w.konto_login, w.zmieniono_at);
    const dostepna = numeracja && maNumeracje(db);
    if (dostepna) {
      const seria = db.prepare(`INSERT INTO tf_serie (kod, rodzaj, format, reset, zmieniono_at, konto_login) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(kod) DO UPDATE SET format=excluded.format, reset=excluded.reset,
        zmieniono_at=excluded.zmieniono_at, konto_login=excluded.konto_login`);
      for (const s of numeracja.serie) seria.run(s.kod, s.rodzaj, s.format, s.reset, s.zmieniono_at, s.konto_login);
      const licznik = db.prepare(`INSERT INTO tf_liczniki (seria_id, okres, ostatni)
        VALUES ((SELECT id FROM tf_serie WHERE kod = ?), ?, ?)
        ON CONFLICT(seria_id, okres) DO UPDATE SET ostatni=MAX(tf_liczniki.ostatni, excluded.ostatni)`);
      for (const l of numeracja.liczniki) licznik.run(l.kod, l.okres, l.ostatni);
    }
    db.exec('COMMIT');
    return dostepna ? 'zachowana' : 'brak';
  } catch (e) {
    db.exec('ROLLBACK');
    throw new Error('Nie udało się przywrócić danych po resecie demo', { cause: e });
  }
}

// Kopia `dane` obok bazy żyje od skasowania starej bazy do COMMIT w nowej: reset przerwany w tym oknie (np. błąd
// migracji) dokończy następny start z kopii, zamiast zgubić numerację TF (KSeF TEST odrzuciłby powtórzony numer).
export const kopiaResetu = (baza) => `${baza}.reset-demo.json`;

// Uszkodzona kopia (np. pad w trakcie zapisu sprzed zapisu atomowego, ENOSPC) przy całej bazie jest zbędna — zlecenie
// czytamy wtedy z bazy. Bez bazy nie ma z czego go odtworzyć: jasny błąd z nazwą pliku zamiast pętli restartów.
function czytajKopie(kopia, baza) {
  if (!fs.existsSync(kopia)) return null;
  try {
    return JSON.parse(fs.readFileSync(kopia, 'utf8'));
  } catch {
    if (!fs.existsSync(baza)) throw new Error(`Uszkodzona kopia resetu demo ${kopia} i brak bazy — usuń ten plik, start założy świeże demo`);
    fs.rmSync(kopia, { force: true });
    return null;
  }
}

export async function wykonajZlecenieResetu({ baza, utworzBaze }) {
  const kopia = kopiaResetu(baza);
  if (!fs.existsSync(baza) && !fs.existsSync(kopia)) return null;
  const zKopii = czytajKopie(kopia, baza);
  try {
    let dane = zKopii;
    if (!dane) {
      const db = new DatabaseSync(baza, { readOnly: true });
      try { dane = odczytajZlecenieResetu(db); } finally { db.close(); }
      if (!dane) return null;
      fs.writeFileSync(`${kopia}.tmp`, JSON.stringify(dane), { mode: 0o600 });
      fs.renameSync(`${kopia}.tmp`, kopia);
    }
    for (const plik of [baza, `${baza}-wal`, `${baza}-shm`]) fs.rmSync(plik, { force: true });
    await utworzBaze();
    const nowa = new DatabaseSync(baza);
    let numeracja;
    try { numeracja = przywrocPoResecie(nowa, dane); } finally { nowa.close(); }
    fs.rmSync(kopia, { force: true });
    return { zlecenie: dane.zlecenie, zachowane: dane.zachowane.map(w => w.integracja), numeracja };
  } catch (e) {
    throw new Error('Nie udało się wykonać resetu demo', { cause: e });
  }
}
