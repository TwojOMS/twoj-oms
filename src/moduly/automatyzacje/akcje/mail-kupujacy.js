// PRZ-108.08 (zmiana C1 planu automatyzacji, sekcja 4): akcja „Wyślij mail do kupującego” z wybranego szablonu.
//
// Woła TĘ SAMĄ usługę co przycisk na karcie zamówienia (`wiadomosci.wyslij`) — ten sam skład treści, ta sama zgoda
// domeny, ten sam rejestr `wiadomosci` i dziennik karty; różni się tylko ślad (`tryb: 'automat'`).
//
// Kolejność sprawdzeń PRZED rezerwacją (`zgoda`, silnik woła ją po warunkach w chwili wykonania):
//  1. szablon własny usunięty z Ustawień → pominięte „szablon usunięty”;
//  2. ten sam mail już poszedł do zamówienia (rejestr `wiadomosci`: ten sam temat albo szablon własny; ręcznie albo
//     inną regułą) → pominięte z datą i kim — chroni przed parą reguł z tym samym szablonem i przed operatorem, który
//     wysłał ręcznie, zanim minęło opóźnienie;
//  3. zgoda domeny (`czyWolnoWyslac` / `czyWolnoWyslacWlasny`): brak adresu, anulowane, brak paczki z numerem →
//     pominięte z powodem domeny. Bez tego kroku `wyslij` zapisałby na karcie „NIE UDAŁO SIĘ PRZYGOTOWAĆ…” — błąd,
//     a właściciel chciał pominięcia.
//     Automat pomija anulowane także przy szablonie własnym; ręczna wysyłka z podglądem na karcie pozostaje dozwolona.
import { czyWolnoWyslac, czyWolnoWyslacWlasny, NAZWA_TEMATU } from '../../../domena/wiadomosci.js';
import { adresatKlienta } from '../../../domena/adresat-klienta.js';
import { fmtDataCzasKrotko } from '../../../domena/format-daty.js';
import { ostatniaWiadomosc } from '../../../oms/db/wiadomosci.js';
import { wczytajSzablonyWiadomosci } from '../../../oms/db/szablony-wiadomosci.js';

const WLASNY = /^wlasny-\d+$/;
const PRZEDROSTEK_AUTOMATU = 'automat: ';
const odmowa = (kod, powod) => ({ ok: false, kod, powod });

/** `RRRR-MM-DD GG:MM` (czas Warszawy) → `DD.MM o GG:MM`. */
function kiedy(iso) {
  const m = /^\d{4}-(\d{2})-(\d{2}) (\d{2}:\d{2})/.exec(fmtDataCzasKrotko(iso) ?? '');
  return m ? `${m[2]}.${m[1]} o ${m[3]}` : String(iso ?? '');
}
function ktoWyslal(kto) {
  const s = String(kto ?? '');
  return s.startsWith(PRZEDROSTEK_AUTOMATU) ? `regułą „${s.slice(PRZEDROSTEK_AUTOMATU.length)}”` : `ręcznie (${s || 'operator'})`;
}

/** Nazwa szablonu dla człowieka: wbudowany ze słownika domeny, własny z Ustawień; `null`, gdy go nie ma. */
export function nazwaSzablonu(db, szablon) {
  if (Object.hasOwn(NAZWA_TEMATU, szablon)) return NAZWA_TEMATU[szablon];
  return wczytajSzablonyWiadomosci(db).wlasne.find((s) => s.id === szablon)?.nazwa ?? null;
}

/** @param {{ wiadomosci: () => any }} zaleznosci usługa wiadomości czytana przy każdym wykonaniu (null = brak poczty) */
export function akcjaMailKupujacy({ wiadomosci }) {
  const usluga = () => wiadomosci?.() ?? null;

  async function zgoda({ db, regula, wykonanie }) {
    const u = usluga();
    if (!u) return odmowa('brak_poczty', 'brak poczty wychodzącej — podłącz ją w Ustawienia → Integracje → Poczta wychodząca.');
    const szablon = regula.akcja_param?.szablon ?? regula.akcja_json?.szablon ?? null;
    const nazwa = nazwaSzablonu(db, szablon);
    if (!szablon || !nazwa) {
      return odmowa('szablon_usuniety', 'Szablonu maila tej reguły już nie ma (usunięty w Ustawienia → Szablony wiadomości) — wybierz inny w edycji reguły.');
    }
    const juz = ostatniaWiadomosc(db, wykonanie.zamowienie_id, szablon);
    if (juz) {
      return odmowa('juz_wyslany', `„${nazwa}” poszło już do tego zamówienia ${ktoWyslal(juz.kto)} ${kiedy(juz.wyslana_at)}.`);
    }
    // Poprawka po recenzji 08 (usterka 2): rejestr `wiadomosci` pisze się dopiero po udanym `sendMail`. Wysyłka tego
    // samego szablonu do tego zamówienia, która jest „niepewna” (list mógł dojść) albo właśnie trwa — w dowolnej regule —
    // też blokuje: wolimy jeden brakujący mail niż dwa wysłane.
    const watpliwa = db.prepare(`SELECT w.stan, r.nazwa FROM automatyzacje_wykonania w JOIN automatyzacje_reguly r ON r.id = w.regula_id
      WHERE w.zamowienie_id = ? AND w.szablon = ? AND w.stan IN ('niepewne', 'w_toku') AND w.id IS NOT ? ORDER BY w.id DESC LIMIT 1`)
      .get(wykonanie.zamowienie_id, szablon, wykonanie.id ?? null);
    if (watpliwa) {
      return odmowa('niepewne_wczesniej', `„${nazwa}” do tego zamówienia ${watpliwa.stan === 'w_toku' ? 'właśnie wychodzi' : 'ma niepewną wysyłkę'} `
        + `z reguły „${watpliwa.nazwa}” — nie wiadomo, czy klient go dostał. Sprawdź w skrzynce nadawczej, zanim wyślesz ręcznie.`);
    }
    let k;
    try { k = u.kontekst(wykonanie.zamowienie_id); } catch (e) { return odmowa('brak_zamowienia', e?.message ?? 'Nie ma zamówienia.'); }
    if (WLASNY.test(szablon) && k.z.anulowane) return odmowa('anulowane', czyWolnoWyslac(k.z, 'wyslane', k).powod);
    const zg = WLASNY.test(szablon) ? czyWolnoWyslacWlasny(k.z) : czyWolnoWyslac(k.z, szablon, k);
    if (!zg.wolno) {
      const kod = !adresatKlienta(k.z) ? 'brak_adresu' : k.z.anulowane ? 'anulowane' : 'odmowa';
      return odmowa(kod, zg.powod);
    }
    return { ok: true, adresat: adresatKlienta(k.z) };
  }

  return Object.freeze({
    klucz: 'mail_kupujacy',
    etykieta: 'Wyślij mail do kupującego',
    wymagaPoczty: true,
    szablon: true,
    zgoda,
    async wykonaj({ regula, wykonanie }) {
      const u = usluga();
      if (!u) throw Object.assign(new Error('brak poczty wychodzącej'), { przedWysylka: true });
      const wynik = await u.wyslij(wykonanie.zamowienie_id, regula.akcja_param?.szablon,
        { ktoKlikal: `${PRZEDROSTEK_AUTOMATU}${regula.nazwa}`, tryb: 'automat', regula: regula.nazwa });
      return { adresat: wynik?.do ?? null };
    },
    /** Podgląd maila w „Sprawdź na 30 dniach” — ta sama funkcja, co podgląd na karcie (i wysyłka). */
    async podglad({ zamowienie_id, szablon }) {
      const u = usluga();
      return u ? u.podglad(zamowienie_id, szablon) : null;
    },
  });
}
