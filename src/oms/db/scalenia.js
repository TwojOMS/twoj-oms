// Scalanie zamówień — zapis i odczyt grupy (PRZ-101.04). Reguły: domena/scalanie.js.
import { pobierzZamowienie, dopiszLog } from './zamowienia.js';
import { bladOperatora } from '../../domena/bledy.js';
import { maTabeleStatusow } from './statusy.js';
import {
  idsDolaczonych, decyzjaScalenia, zamowienieGrupy, sprawdzCzlonkowGrupy, DECYZJE_WYSYLKI, PREFIKS_BLEDU_DOLACZONYCH,
} from '../../domena/scalanie.js';

const teraz = () => new Date().toISOString();

/** Dołączone zamówienia głównego `z` (odczyt jak na karcie); pusta lista, gdy `z` nie jest głównym. */
export function dolaczoneZamowienia(db, z) {
  return idsDolaczonych(z).map((id) => pobierzZamowienie(db, id)).filter((d) => d && d.scalone_do === z.id);
}

/**
 * Zamówienie do FAKTURY i PROFORMY: pojedyncze — bez zmian; główne grupy — `zamowienieGrupy`
 * (pozycje całej grupy, wysyłka wg decyzji) po sprawdzeniu każdego członka osobno.
 * Dołączone wraca bez zmian: odmawia mu `powodOdmowyFaktury` / `czyWolnoWystawic`.
 */
export function zamowienieDoDokumentu(db, id) {
  const z = pobierzZamowienie(db, id);
  if (!z || !idsDolaczonych(z).length) return z;
  const dolaczone = dolaczoneZamowienia(db, z);
  if (!dolaczone.length) return z;
  sprawdzCzlonkowGrupy(z, dolaczone);
  return zamowienieGrupy(z, dolaczone);
}

/**
 * Zamówienie do WYDRUKU i KARTY: to samo zamówienie grupy, co dla faktury (`zamowienieGrupy`),
 * ale bez bariery członków — kartka do paczki i karta mają się pokazać także przy rozjeździe
 * kwot (faktura i tak go odrzuci). `z` — już odczytane zamówienie (karta albo lista).
 */
export function zamowienieZGrupa(db, z) {
  if (!z || !idsDolaczonych(z).length) return z;
  const dolaczone = dolaczoneZamowienia(db, z);
  return dolaczone.length ? zamowienieGrupy(z, dolaczone) : z;
}

/**
 * Zapis scalenia — JEDNĄ transakcją: dołączone dostają `scalone_do`, główne `scalenie_json`.
 * Odmowy domeny sprawdza wołający PRZED zapisem; tu zostaje bariera wyścigu (dwie zakładki):
 * zamówienie, które w międzyczasie zostało scalone, nie przejdzie warunku `IS NULL`.
 */
export function scalZamowienia(db, { glowneId, dolaczoneIds, wysylka, kto }) {
  if (!DECYZJE_WYSYLKI.includes(wysylka)) throw bladOperatora('Wybierz koszt wysyłki: z zamówienia głównego albo suma wysyłek.');
  const ids = [...new Set(dolaczoneIds.map(Number))].filter((i) => i !== Number(glowneId));
  if (!ids.length) throw bladOperatora('Nie ma czego dołączyć — zaznacz co najmniej dwa zamówienia.');
  const decyzja = { wysylka, dolaczone: ids, at: teraz(), kto: kto ?? null };
  db.exec('BEGIN IMMEDIATE');
  try {
    const znaki = ids.map(() => '?').join(',');
    const zmienione = db.prepare(`UPDATE zamowienia SET scalone_do = ?, zmienione_at = ? WHERE id IN (${znaki})
      AND scalone_do IS NULL AND scalenie_json IS NULL`).run(glowneId, teraz(), ...ids).changes;
    const glowne = db.prepare(`UPDATE zamowienia SET scalenie_json = ?, zmienione_at = ? WHERE id = ?
      AND scalone_do IS NULL AND scalenie_json IS NULL`).run(JSON.stringify(decyzja), teraz(), glowneId).changes;
    if (zmienione !== ids.length || glowne !== 1) {
      throw bladOperatora('Któreś z zamówień zostało w międzyczasie scalone — odśwież listę i spróbuj ponownie.');
    }
    // Status własny (PRZ-101.02) DOŁĄCZONEGO kasujemy: dołączone nie ma wiersza na liście, jego stan
    // niesie główne, a ręczna zmiana statusu dołączonego jest odmawiana (status-reczny.js) — przypisanie
    // zostałoby martwe, a po „Rozdziel” wracałoby z nieaktualnym etapem. Status własny głównego zostaje.
    if (maTabeleStatusow(db)) {
      db.prepare(`DELETE FROM zamowienia_status_wlasny WHERE zamowienie_id IN (${znaki})`).run(...ids);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return decyzja;
}

/**
 * „Rozdziel” — powrót do osobnych zamówień. Odmowa, gdy grupa ma już fakturę albo jest wysłana:
 * faktura głównego obejmuje pozycje dołączonych, a rozdzielone dołączone mogłoby dostać drugą.
 */
export function rozdzielZamowienia(db, glowneId) {
  const z = pobierzZamowienie(db, glowneId);
  const decyzja = decyzjaScalenia(z);
  if (!decyzja) throw bladOperatora('To zamówienie nie jest scalone.');
  if (z.faktura) throw bladOperatora('Zamówienie scalone ma już fakturę obejmującą dołączone pozycje — rozdzielenie dałoby drugą fakturę za te same pozycje.');
  if (z.wyslane_at || z.przesylki.length) throw bladOperatora('Zamówienie scalone ma już przesyłkę albo jest wysłane — nie da się go rozdzielić.');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE zamowienia SET scalone_do = NULL, zmienione_at = ? WHERE scalone_do = ?').run(teraz(), glowneId);
    db.prepare('UPDATE zamowienia SET scalenie_json = NULL, zmienione_at = ? WHERE id = ?').run(teraz(), glowneId);
    // Recenzja, W4: ślad „dołączone …” to nieodesłany status DOŁĄCZONYCH (services/sync-sklep.js) —
    // po rozdzieleniu nie należy do głównego i trzymałby je na „Do zrobienia” bez wyjścia (ponowienie
    // odsyła już tylko główne). Własny błąd głównego zostaje.
    if (String(z.sync_woo_blad ?? '').startsWith(PREFIKS_BLEDU_DOLACZONYCH)) {
      db.prepare('UPDATE zamowienia SET sync_woo_blad = NULL WHERE id = ?').run(glowneId);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return decyzja.dolaczone;
}

/**
 * „Odłącz anulowane” (ponowna recenzja, N1) — wyjście dla głównego, którego dołączone klient anulował
 * w sklepie PO scaleniu. „Rozdziel” odmawia przy fakturze i przesyłce, a bez tej akcji główne wisi na
 * „Do zrobienia” na zawsze, a reszty towaru nie da się nadać (gotowość nadania odmawia).
 *
 * Zdejmuje `scalone_do` WYŁĄCZNIE z dołączonych anulowanych (`d.anulowane` — ten sam warunek, co
 * `sprawdzCzlonkowGrupy` i `uwagaDolaczonychAnulowanych`) i wypisuje je z `scalenie_json`. Działa
 * także przy fakturze i przesyłce: nie tworzy drugiego dokumentu (odłączone jest anulowane — faktura,
 * proforma i nadanie i tak mu odmawiają), a wystawiona faktura grupy wymaga KOREKTY, o czym mówi
 * wynik (`fakturaGrupy`) — wołający zapisuje to w logu i pokazuje operatorowi.
 * Ostatni dołączony odłączony = grupy już nie ma (`scalenie_json = NULL`, jak przy „Rozdziel”).
 */
export function odlaczAnulowane(db, glowneId) {
  const z = pobierzZamowienie(db, glowneId);
  const decyzja = decyzjaScalenia(z);
  if (!decyzja) throw bladOperatora('To zamówienie nie jest scalone.');
  const anulowane = dolaczoneZamowienia(db, z).filter((d) => d.anulowane);
  if (!anulowane.length) throw bladOperatora('To zamówienie nie ma anulowanych dołączonych zamówień — nie ma czego odłączać.');
  const ids = anulowane.map((d) => d.id);
  const zostaja = decyzja.dolaczone.filter((id) => !ids.includes(id));
  const { wysylka, at, kto, odlaczone = [] } = decyzja;
  const nowa = zostaja.length
    ? JSON.stringify({ wysylka, dolaczone: zostaja, at, kto, odlaczone: [...odlaczone, ...ids.map((id) => ({ id, at: teraz() }))] })
    : null;
  db.exec('BEGIN IMMEDIATE');
  try {
    const znaki = ids.map(() => '?').join(',');
    const zmienione = db.prepare(`UPDATE zamowienia SET scalone_do = NULL, zmienione_at = ? WHERE id IN (${znaki}) AND scalone_do = ?`)
      .run(teraz(), ...ids, glowneId).changes;
    if (zmienione !== ids.length) throw bladOperatora('Grupa zmieniła się w międzyczasie — odśwież kartę i spróbuj ponownie.');
    db.prepare('UPDATE zamowienia SET scalenie_json = ?, zmienione_at = ? WHERE id = ?').run(nowa, teraz(), glowneId);
    if (!nowa && String(z.sync_woo_blad ?? '').startsWith(PREFIKS_BLEDU_DOLACZONYCH)) {
      db.prepare('UPDATE zamowienia SET sync_woo_blad = NULL WHERE id = ?').run(glowneId);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { glowne: z, odlaczone: anulowane, fakturaGrupy: z.faktura ?? null };
}

/** Wpis w logu każdego członka — historia karty głównego i (w bazie) dołączonego. */
export function zalogujScalenie(db, glowne, dolaczone, opis) {
  dopiszLog(db, glowne.id, { akcja: 'scalenie', wynik: opis });
  for (const d of dolaczone) dopiszLog(db, d.id, { akcja: 'scalenie', wynik: `${opis} Zamówienie główne: ${glowne.numer}.` });
}
