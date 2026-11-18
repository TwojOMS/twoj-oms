/** Ręczna decyzja ma tę samą ewidencję źródła i datę karty co pozostałe pola ręczne. */
export function ustawZnacznikAi(db, { kartaId, zdjecieId, ai, at = new Date().toISOString() }) {
  if (![null, 0, 1].includes(ai)) throw new Error('Wybierz poprawny znacznik AI zdjęcia.');
  db.exec('SAVEPOINT znacznik_ai_zdjecia');
  try {
    const zdjecie = db.prepare('SELECT * FROM zdjecia_kart WHERE id = ? AND karta_id = ?').get(zdjecieId, kartaId);
    if (!zdjecie) throw new Error('Zdjęcie na tej karcie nie istnieje.');
    if (zdjecie.wyslane_at) throw new Error('Nie można zmienić znacznika AI zdjęcia wysłanego do kanału.');
    db.prepare('UPDATE zdjecia_kart SET ai = ?, ai_reczne = 1 WHERE id = ? AND karta_id = ?').run(
      ai,
      zdjecieId,
      kartaId,
    );
    db.prepare(
      `INSERT INTO karty_zrodla_pol (karta_id, pole, zrodlo, reczne, zmieniono_at)
      VALUES (?, ?, 'reczne', 1, ?) ON CONFLICT (karta_id, pole) DO UPDATE SET
      zrodlo = 'reczne', reczne = 1, zmieniono_at = excluded.zmieniono_at`,
    ).run(kartaId, `zdjecie:${zdjecie.sha256 ?? zdjecie.adres_zrodlowy ?? zdjecie.id}:ai`, at);
    db.prepare('UPDATE karty_produktow SET zmieniony_at = ? WHERE id = ?').run(at, kartaId);
    db.exec('RELEASE znacznik_ai_zdjecia');
  } catch (e) {
    db.exec('ROLLBACK TO znacznik_ai_zdjecia');
    db.exec('RELEASE znacznik_ai_zdjecia');
    throw e;
  }
}
