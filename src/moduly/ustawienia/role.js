// PRZ-068: role w bazie. Źródło prawdy dostępu = role_ekrany; tabela `uprawnienia` jest materializacją,
// dzięki której kontoPoLoginie i strażnik działają bez zmian. Synchronizacja przy starcie wykonuje
// przejście §3.2 idempotentnie: start nie zmienia niczyjego dostępu poza poszerzeniem administratora.
import { randomBytes, createHash } from 'node:crypto';
import { EKRANY, ROLE, ekranyRoli } from '../../domena/ekrany.js';
import { uprawnieniaKonta, ustawUprawnienia } from '../../core/bezpieczenstwo/konta.js';

export const ROLA_ADMINISTRATOR = 'administrator';
/** Klucze spoza EKRANY, które konto może mieć dziś (integracja panelu :3000, „Dodaj do OMS”). */
export const KLUCZE_DODATKOWE = ['api'];
export const kluczeEkranow = () => [...EKRANY.map((e) => e.klucz), ...KLUCZE_DODATKOWE];
export const MAKS_NAZWY_ROLI = 40;
export const nowyKluczRoli = () => `r-${randomBytes(4).toString('hex')}`;
export const malymi = (t) => String(t).toLocaleLowerCase('pl');
const rowne = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

export class BladRoli extends Error {
  constructor(kod, komunikat) { super(komunikat); this.kod = kod; }
}

export function tabeleRolIstnieja(db) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'role_ekrany'").get());
}
const ekranyZBazy = (db, klucz) => new Set(db.prepare('SELECT ekran FROM role_ekrany WHERE rola = ?').all(klucz).map((w) => w.ekran));

export function rolaPoKluczu(db, klucz) {
  const w = db.prepare('SELECT klucz, nazwa, admin, zablokowana, osobista FROM role WHERE klucz = ?').get(String(klucz ?? ''));
  if (!w) return null;
  return { klucz: w.klucz, nazwa: w.nazwa, admin: w.admin === 1, zablokowana: w.zablokowana === 1, osobista: w.osobista === 1,
    ekrany: ekranyZBazy(db, w.klucz) };
}

export function listaRol(db) {
  return db.prepare(`SELECT r.klucz, r.nazwa, r.admin, r.zablokowana, r.osobista,
      (SELECT count(*) FROM konta k WHERE k.rola = r.klucz) AS liczbaKont
    FROM role r ORDER BY r.zablokowana DESC, r.utworzone_at, r.rowid`).all()
    .map((w) => ({ klucz: w.klucz, nazwa: w.nazwa, admin: w.admin === 1, zablokowana: w.zablokowana === 1,
      osobista: w.osobista === 1, liczbaKont: w.liczbaKont, ekrany: ekranyZBazy(db, w.klucz) }));
}

/**
 * Odcisk całej macierzy (SHA-256 posortowanych par „rola:ekran”). Formularz ekranu ról niesie go w ukrytym
 * polu; zapis z innym odciskiem jest odrzucany (druga karta, przypisanie nowego ekranu po restarcie).
 */
export function odciskMacierzy(db) {
  const pary = db.prepare('SELECT rola, ekran FROM role_ekrany').all().map((w) => `${w.rola}:${w.ekran}`).sort();
  return createHash('sha256').update(pary.join('\n')).digest('hex');
}

export function nazwaZajeta(db, nazwa, procz = null) {
  const m = malymi(nazwa);
  return db.prepare('SELECT klucz, nazwa FROM role').all().some((r) => r.klucz !== procz && malymi(r.nazwa) === m);
}

export function unikalnaNazwa(db, baza) {
  let nazwa = baza.slice(0, MAKS_NAZWY_ROLI);
  for (let n = 2; nazwaZajeta(db, nazwa); n++) {
    const dopisek = ` (${n})`;
    nazwa = baza.slice(0, MAKS_NAZWY_ROLI - dopisek.length) + dopisek;
  }
  return nazwa;
}

export function wstawRole(db, { klucz, nazwa, admin = false, zablokowana = false, osobista = false, ekrany = [], teraz }) {
  db.prepare('INSERT INTO role (klucz, nazwa, admin, zablokowana, osobista, utworzone_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(klucz, nazwa, admin ? 1 : 0, zablokowana ? 1 : 0, osobista ? 1 : 0, teraz().toISOString());
  const wstaw = db.prepare('INSERT OR IGNORE INTO role_ekrany (rola, ekran) VALUES (?, ?)');
  for (const e of ekrany) wstaw.run(klucz, String(e));
}

/** Losowy klucz, którego jeszcze nie ma w `role` (kolizja 8 znaków hex jest mało prawdopodobna, ale nie niemożliwa). */
export function wolnyKluczRoli(db, losowyKlucz = nowyKluczRoli) {
  for (let proba = 0; proba < 100; proba++) {
    const klucz = losowyKlucz();
    if (!db.prepare('SELECT 1 FROM role WHERE klucz = ?').get(klucz)) return klucz;
  }
  throw new Error('PRZ-068: nie udało się wylosować wolnego klucza roli');
}

/** Nowa rola osobista z dokładnie podanymi ptaszkami, nazwa „<Etykieta> — <imię>”. Bez transakcji. */
export function rolaOsobista(db, { ekrany, etykietaBazowa, imie, teraz, losowyKlucz = nowyKluczRoli }) {
  const klucz = wolnyKluczRoli(db, losowyKlucz);
  wstawRole(db, { klucz, nazwa: unikalnaNazwa(db, `${etykietaBazowa} — ${imie}`), osobista: true, ekrany: [...ekrany], teraz });
  return klucz;
}

/**
 * Etykieta roli osobistej konta BEZ flagi admin. Konto z kluczem/rolą Administratora nie dostaje nazwy
 * „Administrator — X” — ta rola nie daje admina, więc nazwa mówi to wprost (recenzja D8 r1).
 */
function etykietaOsobista(kluczRoli, rola) {
  if (kluczRoli === ROLA_ADMINISTRATOR || rola?.admin) return 'Własna bez admina';
  return ROLE[kluczRoli]?.etykieta ?? rola?.nazwa ?? (String(kluczRoli || '') || 'Rola');
}

/**
 * Ptaszki konta := ptaszki roli. Konto, którego flaga `admin` nie zgadza się z rolą albo którego rola
 * nie istnieje, jest POMIJANE (fail-safe: żadnej eskalacji ani degradacji poza przypisaniem/synchronizacją).
 * Bez transakcji — wołający trzyma BEGIN IMMEDIATE.
 */
export function materializujKonta(db, ids = null) {
  for (const k of db.prepare('SELECT id, rola, admin FROM konta').all()) {
    if (ids && !ids.includes(k.id)) continue;
    const rola = rolaPoKluczu(db, k.rola);
    if (!rola || (k.admin === 1) !== rola.admin) continue;
    if (!rowne(uprawnieniaKonta(db, k.id), rola.ekrany)) ustawUprawnienia(db, k.id, [...rola.ekrany]);
  }
}

export function przypiszRoleBezTransakcji(db, kontoId, klucz) {
  const rola = rolaPoKluczu(db, klucz);
  if (!rola) throw new BladRoli('nieznana', 'Nie ma takiej roli.');
  db.prepare('UPDATE konta SET rola = ?, admin = ? WHERE id = ?').run(rola.klucz, rola.admin ? 1 : 0, kontoId);
  materializujKonta(db, [kontoId]);
}

export function wTransakcji(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const w = fn(); db.exec('COMMIT'); return w; }
  catch (e) { if (db.isTransaction) db.exec('ROLLBACK'); throw e; }
}

export const przypiszRole = (db, kontoId, klucz) => wTransakcji(db, () => przypiszRoleBezTransakcji(db, kontoId, klucz));

export function synchronizujRole(db, { teraz = () => new Date(), losowyKlucz = nowyKluczRoli } = {}) {
  const wynik = { zasiane: false, przejete: [], poszerzone: [] };
  if (!tabeleRolIstnieja(db)) return wynik;
  return wTransakcji(db, () => {
    if (!db.prepare('SELECT 1 FROM role LIMIT 1').get()) {
      for (const [klucz, r] of Object.entries(ROLE)) {
        const admin = klucz === ROLA_ADMINISTRATOR;
        wstawRole(db, { klucz, nazwa: r.etykieta, admin, zablokowana: admin, ekrany: admin ? kluczeEkranow() : ekranyRoli(klucz), teraz });
      }
      wynik.zasiane = true;
    } else if (!rolaPoKluczu(db, ROLA_ADMINISTRATOR)) {
      // Brak wiersza Administratora przy niepustej tabeli (ręczna ingerencja w bazę): bez niego wstawienie
      // ekranów niżej łamie FK i OMS nie startuje — odtwarzamy go, zanim cokolwiek innego.
      wstawRole(db, { klucz: ROLA_ADMINISTRATOR, nazwa: unikalnaNazwa(db, ROLE[ROLA_ADMINISTRATOR].etykieta),
        admin: true, zablokowana: true, ekrany: kluczeEkranow(), teraz });
    }
    // Tylko brakujące ekrany: start bez zmian nie pisze do bazy (pełny dysk nie może wywrócić startu OMS-u).
    const ekranyAdmina = new Set(db.prepare('SELECT ekran FROM role_ekrany WHERE rola = ?').all(ROLA_ADMINISTRATOR).map((w) => w.ekran));
    const wstaw = db.prepare('INSERT OR IGNORE INTO role_ekrany (rola, ekran) VALUES (?, ?)');
    for (const e of kluczeEkranow()) if (!ekranyAdmina.has(e)) wstaw.run(ROLA_ADMINISTRATOR, e);
    const pelne = new Set(kluczeEkranow());
    for (const k of db.prepare('SELECT id, login, imie, rola, admin FROM konta ORDER BY id').all()) {
      if (k.admin === 1) {
        if (k.rola !== ROLA_ADMINISTRATOR) db.prepare('UPDATE konta SET rola = ? WHERE id = ?').run(ROLA_ADMINISTRATOR, k.id);
        if (!rowne(uprawnieniaKonta(db, k.id), pelne)) wynik.poszerzone.push(k.login);
        continue;
      }
      const rola = rolaPoKluczu(db, k.rola);
      const ptaszki = uprawnieniaKonta(db, k.id);
      if (rola && !rola.admin && rowne(rola.ekrany, ptaszki)) continue;
      const klucz = rolaOsobista(db, { ekrany: ptaszki, etykietaBazowa: etykietaOsobista(k.rola, rola), imie: k.imie, teraz, losowyKlucz });
      db.prepare('UPDATE konta SET rola = ? WHERE id = ?').run(klucz, k.id);
      wynik.przejete.push({ kontoId: k.id, login: k.login, rola: klucz });
    }
    materializujKonta(db);
    return wynik;
  });
}

/** Wiersz logu startu: kto przeszedł na rolę osobistą i kogo poszerzono do Administratora; null, gdy nikogo. */
export function opisSynchronizacjiRol(wynik) {
  const czesci = [];
  if (wynik.przejete.length) czesci.push(`konta przeniesione na role osobiste: ${wynik.przejete.map((p) => `${p.login} → ${p.rola}`).join(', ')}`);
  if (wynik.poszerzone.length) czesci.push(`administratorzy poszerzeni do pełnej roli Administrator: ${wynik.poszerzone.join(', ')}`);
  return czesci.length ? `role (PRZ-068): ${czesci.join('; ')}` : null;
}

// ——— A3: ekran „Role i uprawnienia” ———————————————————————————————————————————————

export function walidujNazweRoli(nazwa) {
  const t = String(nazwa ?? '').trim();
  if (t.length < 1 || t.length > MAKS_NAZWY_ROLI) throw new BladRoli('nazwa', `Nazwa roli musi mieć od 1 do ${MAKS_NAZWY_ROLI} znaków.`);
  return t;
}

export const KOMUNIKAT_NIEAKTUALNA = 'Uprawnienia zmieniły się w międzyczasie — odśwież i zaznacz ponownie.';

/**
 * Jeden zapis całej macierzy (pary „<rola>:<ekran>”); nieznana rola → BladRoli('nieznana'), odcisk inny niż
 * stan bazy (także brak odcisku) → BladRoli('nieaktualna') — w obu przypadkach bez częściowego zapisu.
 */
export function zapiszMacierz(db, { role, pary, odcisk }) {
  const znane = new Set(kluczeEkranow());
  const wybrane = new Set(pary.map(String));
  return wTransakcji(db, () => {
    const klucze = [...new Set(role.map(String))];
    for (const k of klucze) if (!rolaPoKluczu(db, k)) throw new BladRoli('nieznana', 'Nie ma takiej roli.');
    if (String(odcisk ?? '') !== odciskMacierzy(db)) throw new BladRoli('nieaktualna', KOMUNIKAT_NIEAKTUALNA);
    for (const k of klucze) {
      if (rolaPoKluczu(db, k).zablokowana) continue;
      db.prepare('DELETE FROM role_ekrany WHERE rola = ?').run(k);
      const wstaw = db.prepare('INSERT INTO role_ekrany (rola, ekran) VALUES (?, ?)');
      for (const e of znane) if (wybrane.has(`${k}:${e}`)) wstaw.run(k, e);
    }
    materializujKonta(db);
  });
}

export function dodajRole(db, { nazwa, kopiujZ = null, teraz, losowyKlucz = nowyKluczRoli }) {
  const czysta = walidujNazweRoli(nazwa);
  return wTransakcji(db, () => {
    if (nazwaZajeta(db, czysta)) throw new BladRoli('zajeta', `Rola „${czysta}” już istnieje.`);
    const zrodlo = kopiujZ ? rolaPoKluczu(db, kopiujZ) : null;
    if (kopiujZ && !zrodlo) throw new BladRoli('nieznana', 'Nie ma takiej roli.');
    const klucz = wolnyKluczRoli(db, losowyKlucz);
    wstawRole(db, { klucz, nazwa: czysta, ekrany: zrodlo ? [...zrodlo.ekrany] : [], teraz });
    return klucz;
  });
}

export function zmienNazweRoli(db, klucz, nazwa) {
  return wTransakcji(db, () => {
    const rola = rolaPoKluczu(db, klucz);
    if (!rola) throw new BladRoli('nieznana', 'Nie ma takiej roli.');
    if (rola.zablokowana) throw new BladRoli('zablokowana', 'Roli Administrator nie można zmienić nazwy.');
    const czysta = walidujNazweRoli(nazwa);
    if (nazwaZajeta(db, czysta, klucz)) throw new BladRoli('zajeta', `Rola „${czysta}” już istnieje.`);
    db.prepare('UPDATE role SET nazwa = ? WHERE klucz = ?').run(czysta, klucz);
  });
}

export function usunRole(db, klucz) {
  return wTransakcji(db, () => {
    const rola = rolaPoKluczu(db, klucz);
    if (!rola) throw new BladRoli('nieznana', 'Nie ma takiej roli.');
    if (rola.zablokowana) throw new BladRoli('zablokowana', 'Roli Administrator nie można usunąć.');
    const n = db.prepare('SELECT count(*) AS n FROM konta WHERE rola = ?').get(klucz).n;
    if (n > 0) throw new BladRoli('uzywana', `Rola ma konta (${n}, także wyłączone) — przypisz im inną rolę, zanim ją usuniesz.`);
    db.prepare('DELETE FROM role_ekrany WHERE rola = ?').run(klucz);
    db.prepare('DELETE FROM role WHERE klucz = ?').run(klucz);
  });
}

// ——— A4: przypisanie roli kontu ————————————————————————————————————————————————————

/** Stara trasa /uprawnienia: wynik per konto, ale zawsze przez rolę (niezmiennik konto = rola). */
export function ustawPtaszkiPrzezRole(db, kontoId, { ekrany, admin, teraz, losowyKlucz = nowyKluczRoli }) {
  return wTransakcji(db, () => {
    if (admin) return przypiszRoleBezTransakcji(db, kontoId, ROLA_ADMINISTRATOR);
    const konto = db.prepare('SELECT id, imie, rola FROM konta WHERE id = ?').get(kontoId);
    const obecna = rolaPoKluczu(db, konto.rola);
    // Rolę osobistą konta (oznaczoną `osobista`, nie preset, nie Administrator) z jednym kontem aktualizujemy
    // w miejscu, żeby każdy zapis starej trasy nie mnożył ról „<Etykieta> — <imię> (n)”. Rola założona przez
    // admina („Magazynier”) nie jest osobista, nawet gdy ma jedno konto — wtedy powstaje nowa rola osobista.
    const jedyna = obecna && obecna.osobista && !obecna.admin && !obecna.zablokowana && !ROLE[obecna.klucz]
      && db.prepare('SELECT count(*) AS n FROM konta WHERE rola = ?').get(obecna.klucz).n === 1;
    let klucz;
    if (jedyna) {
      klucz = obecna.klucz;
      db.prepare('DELETE FROM role_ekrany WHERE rola = ?').run(klucz);
      const wstaw = db.prepare('INSERT INTO role_ekrany (rola, ekran) VALUES (?, ?)');
      for (const e of new Set(ekrany)) wstaw.run(klucz, e);
    } else {
      klucz = rolaOsobista(db, { ekrany, etykietaBazowa: etykietaOsobista(konto.rola, obecna), imie: konto.imie, teraz, losowyKlucz });
    }
    przypiszRoleBezTransakcji(db, kontoId, klucz);
  });
}

/** Nazwa roli do ekranu; „ + zmiany” wyłącznie przy rozjeździe ptaszków konta z rolą (O5). */
export function opisRoliKonta(db, kontoId) {
  if (!tabeleRolIstnieja(db)) return null;
  const k = db.prepare('SELECT rola FROM konta WHERE id = ?').get(kontoId);
  const rola = k ? rolaPoKluczu(db, k.rola) : null;
  if (!rola) return null;
  return rowne(uprawnieniaKonta(db, kontoId), rola.ekrany) ? rola.nazwa : `${rola.nazwa} + zmiany`;
}
