const teraz = () => new Date().toISOString();

function jakoJson(wartosc, nazwa) {
  if (!wartosc || typeof wartosc !== 'object') throw new Error(`Brak ${nazwa} podjazdu.`);
  return JSON.stringify(wartosc);
}

function poprawnePrzesylki(przesylki) {
  if (!Array.isArray(przesylki) || przesylki.length === 0 || przesylki.length > 100) {
    throw new Error('Podjazd musi obejmować od 1 do 100 przesyłek.');
  }
  const ids = przesylki.map((p) => p?.przesylkaId);
  const shipmentIds = przesylki.map((p) => p?.shipmentId);
  if (ids.some((id) => !Number.isInteger(id)) || shipmentIds.some((id) => !id)
    || new Set(ids).size !== ids.length || new Set(shipmentIds).size !== shipmentIds.length) {
    throw new Error('Zestaw przesyłek podjazdu jest nieprawidłowy.');
  }
}

export function pobierzPodjazd(db, id) {
  return db.prepare('SELECT * FROM podjazdy WHERE id = ?').get(id) ?? null;
}

export function pobierzPodjazdPoCommandId(db, commandId) {
  return db.prepare('SELECT * FROM podjazdy WHERE command_id = ?').get(commandId) ?? null;
}

export function zapiszPodgladPodjazdu(db, {
  id, kto = null, snapshot, wygasaAt, utworzonyAt = teraz(),
}) {
  if (!id || !wygasaAt) throw new Error('Podgląd podjazdu wymaga identyfikatora i czasu wygaśnięcia.');
  const snapshotJson = jakoJson(snapshot, 'snapshotu');
  db.prepare(
    'INSERT INTO podjazdy_podglady (id, kto, snapshot_json, wygasa_at, utworzony_at) VALUES (?,?,?,?,?)',
  ).run(id, kto, snapshotJson, wygasaAt, utworzonyAt);
  return db.prepare('SELECT * FROM podjazdy_podglady WHERE id = ?').get(id);
}

export function powiazanePrzesylkiPodjazdu(db, podjazdId) {
  return db.prepare('SELECT * FROM podjazdy_przesylki WHERE podjazd_id = ? ORDER BY przesylka_id').all(podjazdId);
}

// Jedyny zwyciezca przejscia moze wykonac nieodwracalny POST. Po awarii procesu
// przed siecia stan pozostaje do wyjasnienia przez GET, nigdy do slepego ponowienia.
export function rozpocznijWysylkePodjazdu(db, podjazdId) {
  const info = db.prepare("UPDATE podjazdy SET stan='oczekuje' WHERE id=? AND stan='zarezerwowany'")
    .run(podjazdId);
  return Number(info.changes) === 1;
}

// Atomowy lease między procesami. Po awarii wygasa i kolejny czuwacz może wykonać GET;
// token właściciela zapobiega zapisaniu odpowiedzi po wygaśnięciu lease'u.
export function zajmijSprawdzeniePodjazdu(db, id, { token, teraz: czas, do: koniec }) {
  if (!token || !czas || !koniec || koniec <= czas) throw new Error('Nieprawidłowy lease sprawdzenia podjazdu.');
  const info = db.prepare(`UPDATE podjazdy SET sprawdzenie_token=?, nastepne_sprawdzenie_at=?
    WHERE id=? AND stan IN ('zarezerwowany','oczekuje','nieznany')
      AND (nastepne_sprawdzenie_at IS NULL OR nastepne_sprawdzenie_at <= ?)`)
    .run(token, koniec, id, czas);
  return Number(info.changes) === 1;
}

// UUID jest zapisywany PRZED siecia. BEGIN IMMEDIATE obejmuje odczyt idempotencji,
// zlecenie i wszystkie paczki; indeks czesciowy jest druga, miedzyprocesowa siatka.
export function zarezerwujPodjazd(db, {
  podgladId, grupaId, commandId, kanal, przewoznik, adres, termin, przesylki, kto = null,
  utworzonaAt = teraz(), nastepneSprawdzenieAt = null,
}) {
  if (!podgladId || !grupaId || !commandId || !kanal || !przewoznik) throw new Error('Brak danych zlecenia podjazdu.');
  poprawnePrzesylki(przesylki);
  const adresJson = jakoJson(adres, 'adresu');
  const terminJson = jakoJson(termin, 'terminu');
  db.exec('BEGIN IMMEDIATE');
  try {
    const poprzedni = db.prepare('SELECT * FROM podjazdy WHERE podglad_id = ? AND grupa_id = ?')
      .get(podgladId, grupaId);
    if (poprzedni) {
      db.exec('COMMIT');
      return poprzedni;
    }
    const info = db.prepare(
      "INSERT INTO podjazdy (podglad_id, grupa_id, command_id, kanal, przewoznik, adres_json, termin_json, stan, kto, utworzony_at, nastepne_sprawdzenie_at)"
      + " VALUES (?,?,?,?,?,?,?,'zarezerwowany',?,?,?)",
    ).run(podgladId, grupaId, commandId, kanal, przewoznik, adresJson, terminJson, kto, utworzonaAt, nastepneSprawdzenieAt);
    const podjazdId = Number(info.lastInsertRowid);
    const dodaj = db.prepare(
      'INSERT INTO podjazdy_przesylki (podjazd_id, przesylka_id, shipment_id, numer_listu, aktywna_rezerwacja) VALUES (?,?,?,?,1)',
    );
    for (const p of przesylki) dodaj.run(podjazdId, p.przesylkaId, p.shipmentId, p.numerListu ?? null);
    db.exec('COMMIT');
    return pobierzPodjazd(db, podjazdId);
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* transakcja mogla juz nie istniec */ }
    if (String(error?.message).includes('podjazdy_przesylki_jedna_aktywna')
      || String(error?.message).includes('podjazdy_przesylki.przesylka_id')) {
      throw new Error('Co najmniej jedna przesyłka ma już aktywną rezerwację podjazdu.');
    }
    throw error;
  }
}

// `odrzucony` jest jedynym wynikiem, ktory zwalnia paczki. SUCCESS nie dowodzi jeszcze
// fizycznego odbioru, wiec pozostaje aktywny az do zapisu jednoznacznego skanu.
export function zapiszWynikPodjazdu(db, id, {
  stan, pickupId = null, carrierPickupId = null, ostatniaProbaAt = teraz(),
  pickupCarrier = null, nastepneSprawdzenieAt = null, bladOpis = null,
  sprawdzenieToken = null,
}) {
  if (!['zarezerwowany', 'oczekuje', 'nieznany', 'potwierdzony', 'odrzucony'].includes(stan)) {
    throw new Error('Nieznany stan zlecenia podjazdu.');
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const info = db.prepare(
      'UPDATE podjazdy SET stan = ?, pickup_id = COALESCE(?, pickup_id), carrier_pickup_id = COALESCE(?, carrier_pickup_id),'
      + ' pickup_carrier = COALESCE(?, pickup_carrier),'
      + ' ostatnia_proba_at = ?, nastepne_sprawdzenie_at = ?, blad_opis = ?, sprawdzenie_token = NULL'
      + " WHERE id = ? AND stan IN ('zarezerwowany','oczekuje','nieznany')"
      + (sprawdzenieToken ? ' AND sprawdzenie_token = ?' : ' AND sprawdzenie_token IS NULL'),
    ).run(stan, pickupId, carrierPickupId, pickupCarrier, ostatniaProbaAt, nastepneSprawdzenieAt,
      bladOpis, id, ...(sprawdzenieToken ? [sprawdzenieToken] : []));
    if (Number(info.changes) === 1 && stan === 'odrzucony') {
      db.prepare('UPDATE podjazdy_przesylki SET aktywna_rezerwacja = 0 WHERE podjazd_id = ?').run(id);
    }
    db.exec('COMMIT');
    return pobierzPodjazd(db, id);
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

// Dowod jest monotoniczny: pozniejsza pusta albo starsza odpowiedz sledzenia nie moze
// przywrocic paczki do oczekujacych. `przejeta_at` jest czasem naszego rozpoznania.
export function zapiszPrzejecie(db, przesylkaId, { zrodlo, kod, zdarzenieAt = null }) {
  if (!zrodlo || !kod) throw new Error('Dowód przejęcia wymaga źródła i kodu.');
  const info = db.prepare(
    'UPDATE przesylki SET przejeta_at = ?, przejecie_zdarzenie_at = ?, przejecie_zrodlo = ?, przejecie_kod = ?'
    + ' WHERE id = ? AND przejeta_at IS NULL',
  ).run(teraz(), zdarzenieAt, zrodlo, kod, przesylkaId);
  if (Number(info.changes) === 0) return null;
  return db.prepare('SELECT * FROM przesylki WHERE id = ?').get(przesylkaId) ?? null;
}

// Jednorazowe ujęcie odbioru potwierdzonego wcześniej w Allegro. Wywołujący musi
// zweryfikować GET komendy i GET szczegółów odbioru na właściwym koncie; ta
// transakcja pilnuje zgodności z lokalną paczką i blokuje ponowny POST z OMS.
export function importujPotwierdzonyPodjazd(db, {
  przesylkaId, shipmentId, numerListu, kanal, metoda, commandId, pickupId,
  pickupCarrier, carrierPickupId = null, adres, termin, kto = 'import Allegro',
  utworzonyAt = teraz(),
}) {
  if (!Number.isSafeInteger(przesylkaId) || !shipmentId || !numerListu || !kanal || !metoda
    || !commandId || !pickupId || !pickupCarrier || !adres || !termin?.date
    || !termin?.minTime || !termin?.maxTime) {
    throw new Error('Import podjazdu wymaga kompletnych, potwierdzonych danych.');
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const p = db.prepare(`SELECT p.*, z.sklep FROM przesylki p
      JOIN zamowienia z ON z.id=p.zamowienie_id WHERE p.id=?`).get(przesylkaId);
    if (!p || p.kurier !== 'allegro_wza' || p.status !== 'nadana'
      || p.sklep !== kanal || p.id_przesylki_kuriera !== shipmentId
      || p.numer_listu !== numerListu) {
      throw new Error('Dane podjazdu nie zgadzają się z lokalną przesyłką WzA.');
    }
    const poprzedni = db.prepare('SELECT * FROM podjazdy WHERE command_id=?').get(commandId);
    if (poprzedni) {
      const powiazanie = db.prepare('SELECT * FROM podjazdy_przesylki WHERE podjazd_id=?').all(poprzedni.id);
      if (poprzedni.pickup_id !== pickupId || poprzedni.pickup_carrier !== pickupCarrier
        || powiazanie.length !== 1 || powiazanie[0].przesylka_id !== przesylkaId
        || powiazanie[0].shipment_id !== shipmentId) {
        throw new Error('Istniejąca komenda podjazdu ma inne dane.');
      }
      db.exec('COMMIT');
      return poprzedni;
    }
    if (db.prepare('SELECT 1 FROM podjazdy_przesylki WHERE przesylka_id=? AND aktywna_rezerwacja=1').get(przesylkaId)) {
      throw new Error('Przesyłka ma już aktywną rezerwację podjazdu.');
    }
    const podgladId = `allegro-external:${commandId}`;
    db.prepare('INSERT INTO podjazdy_podglady (id,kto,snapshot_json,wygasa_at,utworzony_at) VALUES (?,?,?,?,?)')
      .run(podgladId, kto, JSON.stringify({ data: termin.date, adres, grupy: [] }), utworzonyAt, utworzonyAt);
    const info = db.prepare(`INSERT INTO podjazdy
      (podglad_id,grupa_id,command_id,kanal,przewoznik,adres_json,termin_json,stan,
       pickup_id,carrier_pickup_id,pickup_carrier,kto,utworzony_at,ostatnia_proba_at)
      VALUES (?,?,?,?,?,?,?,'potwierdzony',?,?,?,?,?,?)`).run(
      podgladId, metoda, commandId, kanal, metoda, JSON.stringify(adres), JSON.stringify(termin),
      pickupId, carrierPickupId, pickupCarrier, kto, utworzonyAt, utworzonyAt,
    );
    db.prepare(`INSERT INTO podjazdy_przesylki
      (podjazd_id,przesylka_id,shipment_id,numer_listu,aktywna_rezerwacja) VALUES (?,?,?,?,?)`)
      .run(Number(info.lastInsertRowid), przesylkaId, shipmentId, numerListu, p.przejeta_at ? 0 : 1);
    db.exec('COMMIT');
    return pobierzPodjazd(db, Number(info.lastInsertRowid));
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

// Zapytania wiązane przez moduł do jego kontekstu bazy; istniejące eksporty zachowują parytet testów.
export function createZapytania(db) {
  return {
    pobierzPodjazd: (...args) => pobierzPodjazd(db, ...args),
    pobierzPodjazdPoCommandId: (...args) => pobierzPodjazdPoCommandId(db, ...args),
    zapiszPodgladPodjazdu: (...args) => zapiszPodgladPodjazdu(db, ...args),
    powiazanePrzesylkiPodjazdu: (...args) => powiazanePrzesylkiPodjazdu(db, ...args),
    rozpocznijWysylkePodjazdu: (...args) => rozpocznijWysylkePodjazdu(db, ...args),
    zajmijSprawdzeniePodjazdu: (...args) => zajmijSprawdzeniePodjazdu(db, ...args),
    zarezerwujPodjazd: (...args) => zarezerwujPodjazd(db, ...args),
    zapiszWynikPodjazdu: (...args) => zapiszWynikPodjazdu(db, ...args),
    zapiszPrzejecie: (...args) => zapiszPrzejecie(db, ...args),
    importujPotwierdzonyPodjazd: (...args) => importujPotwierdzonyPodjazd(db, ...args),
  };
}
