// CZUWACZ OSTRZEŻEŃ (2026-08-29) — osobny zegar godzinowy piszący LUSTRA dla tabelki
// ostrzeżeń strony głównej (spec docs/superpowers/specs/2026-08-29-oms-ostrzezenia-
// strona-glowna-design.md, przewodnik 4.72). Strona główna nie dotyka sieci — sieć jest
// tutaj.
//
// ⚠️⚠️ DLACZEGO OSOBNY ZEGAR, a nie kolejny krok czuwacza KSeF (wzorzec `zweryfikujPliki`):
// ARYTMETYKA BUDŻETU. Najgorszy przebieg czuwacza KSeF to 54:10 (50×60 s + 50×5 s);
// krok luk dokładał 5:00 (59:10 — mieściło się o włos), a krok terminów dokłada kolejne
// 11:00 (pełna paginacja pasa długów do globalnego sufitu klienta) — razem 70:10 > 60:00,
// więc strażnik w bootstrapie słusznie położyłby panel przy starcie. Luster będzie
// przybywać razem z typami ostrzeżeń, więc dostają własny zegar z własnym budżetem
// (dziś 16:00 z zapasem 44 min) i własnym wpisem w pulsie /health.
//
// Dwa kroki, IZOLOWANE: awaria jednego lustra nie zabiera drugiego, ale przebieg kończy
// się wtedy błędem — puls zgłosi „ostatni przebieg zakończył się błędem", czyli wiersz
// `integracja` na stronie głównej.

import {
  LIMIT_ZADANIA_MS as LIMIT_ZADANIA_INFAKTU_MS, SUFIT_STRON, ROWNOLEGLE_STRON,
} from '../../../oms/infakt/client.js';
import { coWolnoWyslac } from '../../../domena/wysylka-ksef.js';
import { podmienLukiKsef, podmienPoTerminie } from '../../../oms/db/ostrzezenia.js';
import { dzienWarszawa } from '../../../domena/format-daty.js';

const teraz = () => new Date().toISOString();

// Okno odczytu luk: od pierwszego dnia POPRZEDNIEGO miesiąca do dziś (zakładka faktur
// jest miesięczna, a wysyłanie dokumentów z zeszłego miesiąca to zwykły tryb właściciela).
// Sufit 20 stron = 200 dokumentów w oknie. ⚠️ POLICZONE, NIE ZAOKRĄGLONE: pełne dwa
// miesiące to dziś ~122 dokumenty (lipiec 64 — pomiar 06.08, sierpień 58 — stan 28.08;
// sonda 29.08 potwierdziła 122), więc sufit 12 odmawiałby OD PIERWSZEGO PRZEBIEGU.
// Przekroczenie to głośna ODMOWA klienta (błąd przebiegu → puls → `integracja`), nigdy
// cicha część wyniku. Gdy sprzedaż urośnie: podnieść sufit — budżet niżej przeliczy się
// sam, a strażnik w bootstrapie pilnuje sumy.
export const SUFIT_STRON_LUK = 20;

// Ile SEKWENCYJNYCH tur żądań kosztuje paginacja przy danym sufcie stron: pierwsza
// strona + partie po ROWNOLEGLE_STRON (wszystkieStrony w infakt/client.js).
const tury = (sufitStron) => 1 + Math.ceil((sufitStron - 1) / ROWNOLEGLE_STRON);

export const LIMIT_KROKU_LUK_MS = tury(SUFIT_STRON_LUK) * LIMIT_ZADANIA_INFAKTU_MS;

// Krok terminów jedzie listą nieopłaconych (fakturyWidok.nieoplacone) — ta paginuje do
// GLOBALNEGO sufitu klienta (60 stron = 600 dokumentów; historyczny szczyt pasa długów
// to 67 wierszy, realnie 1 strona).
export const LIMIT_KROKU_TERMINOW_MS = tury(SUFIT_STRON) * LIMIT_ZADANIA_INFAKTU_MS;

export const NAJDLUZSZY_PRZEBIEG_OSTRZEZEN_MS = LIMIT_KROKU_LUK_MS + LIMIT_KROKU_TERMINOW_MS;

/**
 * Okno odczytu luk: od pierwszego dnia poprzedniego miesiąca do dnia podanego.
 * Czysta arytmetyka na napisach 'RRRR-MM-DD' — bez Date, więc bez pułapek stref.
 */
export function oknoLukKsef(dzis) {
  const [r, m] = String(dzis).split('-').map(Number);
  const od = m === 1 ? `${r - 1}-12-01` : `${r}-${String(m - 1).padStart(2, '0')}-01`;
  return { od, do: dzis };
}

export function createCzuwaczOstrzezen({ db, infakt = null, fakturyWidok = null }) {
  // ⚠️ JEDEN PRZEBIEG NARAZ — ten sam strażnik, co w pollerze i czuwaczu KSeF, i z tego
  // samego powodu: setInterval tyka co godzinę niezależnie od tego, czy poprzedni
  // przebieg się skończył. Zwalniany w `finally` — blokada zostawiona po błędzie
  // wyciszyłaby czuwacza NA ZAWSZE.
  let wTrakcie = false;

  async function przebieg() {
    if (wTrakcie) return { pominiety: true };
    wTrakcie = true;
    try {
      return await jedenPrzebieg();
    } finally {
      wTrakcie = false;
    }
  }

  /**
   * Lustro „dokumentów, które WOLNO wysłać do KSeF, a nikt nie wysłał". Zakres liczy
   * `coWolnoWyslac` — DOKŁADNIE ta sama bariera, co pola wyboru na /faktury (rodzaj vat,
   * brak numeru KSeF, nabywca z NIP-em, brak rezerwacji panelu) — nigdy własna kopia.
   *
   * ⚠️ `ksefZleconaAt` DOKLEJAMY Z `wysylki_ksef` przed barierą, tak samo jak robi to
   * services/faktury-widok.js: świeżo pobrana lista jest przez ~70 s ślepa na wysyłkę
   * zleconą przed chwilą z panelu, a bariera pyta o FAKT z tabeli, nie o napis.
   *
   * ⚠️ Odpowiedź, która nie jest tablicą, to ODMOWA, nie pusta lista — puste lustro
   * znaczy „nie ma zaległości", a to jest zdanie, nie brak informacji (ta sama doktryna,
   * co `nieoplacone` w services/faktury-widok.js). Nieudany odczyt zostawia poprzednie
   * wiersze lustra nietknięte (stęchłe dane niosą swoją datę `sprawdzona_at`).
   */
  async function odswiezLukiKsef() {
    if (typeof infakt?.listaFaktur !== 'function') return;
    const chwila = teraz();
    const dokumenty = await infakt.listaFaktur(
      { ...oknoLukKsef(dzienWarszawa(chwila)), pole: 'invoice_date' },
      { sufitStron: SUFIT_STRON_LUK },
    );
    if (!Array.isArray(dokumenty)) {
      throw new Error('inFakt oddał listę dokumentów w kształcie, którego panel nie rozumie — lustro luk KSeF zostaje bez zmian.');
    }
    const zlecone = new Map(
      db.prepare('SELECT uuid, zlecona_at FROM wysylki_ksef').all().map((w) => [w.uuid, w.zlecona_at]),
    );
    const lista = dokumenty.filter(Boolean).map((d) => ({ ...d, ksefZleconaAt: zlecone.get(d?.uuid) ?? null }));
    const poUuid = new Map(lista.map((d) => [d.uuid, d]));
    const { doWyslania } = coWolnoWyslac(lista.map((d) => d.uuid), lista);
    podmienLukiKsef(
      db,
      doWyslania.map(({ uuid, numer }) => ({ uuid, numer, invoiceDate: poUuid.get(uuid)?.invoice_date ?? null })),
      { sprawdzonaAt: chwila },
    );
  }

  /**
   * Lustro „faktur po terminie płatności" — z pasa długów zakładki /faktury, TĄ SAMĄ
   * usługą (`fakturyWidok.nieoplacone`: `czekaNaPrzelew` + pobrania bez gotówki + wzbogac
   * ze `stanTerminu`), nigdy własną kopią reguł. Do lustra idzie WYŁĄCZNIE podzbiór
   * `stanTerminu === 'po_terminie'` — dług przed terminem nie jest ostrzeżeniem.
   *
   * `nieoplacone()` samo ODMAWIA przy zdegradowanej odpowiedzi (nie-tablica) — milczenie
   * kosztuje tu więcej niż odmowa, więc niczego nie łagodzimy.
   */
  async function odswiezPoTerminie() {
    if (typeof fakturyWidok?.nieoplacone !== 'function') return;
    const chwila = teraz();
    const lista = await fakturyWidok.nieoplacone();
    podmienPoTerminie(
      db,
      lista.filter((d) => d?.stanTerminu === 'po_terminie').map((d) => ({
        uuid: d.uuid,
        numer: d.number ?? null,
        paymentDate: d.payment_date ?? null,
        pozostaloGr: Number(d.left_to_pay ?? 0),
      })),
      { sprawdzonaAt: chwila },
    );
  }

  async function jedenPrzebieg() {
    // ⚠️ IZOLACJA NA KROK: każde lustro w swoim try, błędy ZBIERANE i rzucane PO obu
    // krokach. Awaria luk nie zabiera terminów (i odwrotnie), a przebieg z jakąkolwiek
    // awarią kończy się błędem — puls zgłosi go jako ostrzeżenie `integracja`.
    const bledy = [];
    try { await odswiezLukiKsef(); } catch (e) { bledy.push(`luki KSeF: ${e.message}`); }
    try { await odswiezPoTerminie(); } catch (e) { bledy.push(`terminy płatności: ${e.message}`); }
    if (bledy.length) throw new Error(bledy.join(' | '));
    return { pominiety: false };
  }

  return { przebieg };
}
