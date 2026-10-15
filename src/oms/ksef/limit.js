// ⚠️⚠️ KSeF OGRANICZA POBIERANIE DOKUMENTOW DO 16 ZADAN NA MINUTE — i to jest liczba
// ZMIERZONA NA PRODUKCJI (2026-09-02), a nie odczytana z dokumentacji: nocny przebieg
// archiwum kosztow pobral 16 XML-i w ~20 s, a potem KAZDE kolejne zadanie wracalo jako
// „HTTP 429 — Przekroczono limit 16 zadan na minute. Sprobuj ponownie po 54 sekundach".
//
// ⚠️ ODMOWA Z LIMITU NIE JEST AWARIA ZRODLA — JEST PROSBA O CHWILE PRZERWY. To rozroznienie
// jest cala trescia tego modulu. Czuwacz kosztow ma hamulec na martwe zrodlo (trzy bledy
// z rzedu przerywaja archiwizacje, services/czuwacz-kosztow.js) i bez tego rozroznienia
// liczyl 429 jak awarie: przebieg dociagal 16 dokumentow na dobe i konczyl sie „bledem",
// a przy backfillu od stycznia znaczylo to miesiace zamiast kilku nocy.
//
// Kazde miejsce, ktore pobiera z KSeF WIELE dokumentow z rzedu (archiwum kosztow, paczka
// dla biura), owija pojedyncze pobranie ta funkcja. Czekanie jest WSTRZYKIWALNE (`spij`),
// zeby testy nie spaly na prawdziwym zegarze — ta sama zasada, co przy `spij` w client.js.
export const LIMIT_KSEF_NA_MINUTE = 16;

// KSeF podaje czas ponowienia w tresci odmowy (i czasem w naglowku Retry-After), ale gdy nie
// poda ani jednego, czekamy pelna minute — czyli tyle, ile trwa okno limitu.
const DOMYSLNE_CZEKANIE_S = 60;

// ⚠️ SEKUNDA ZAPASU. Okno limitu po stronie MF liczy sie od pierwszego zadania, a nie od
// naszej odpowiedzi; ponowienie dokladnie „po 54 sekundach" trafia w krawedz i wraca kolejnym
// 429 — czyli zjada jedno z trzech ponowien za nic.
const ZAPAS_MS = 1000;

// ⚠️⚠️ SUFIT NA JEDNO CZEKANIE. Liczba sekund przychodzi Z ZEWNATRZ — pisze ja MF, w tresci
// odmowy albo w naglowku `Retry-After` — wiec nie jest naszym parametrem, tylko cudzym
// wejsciem. Wartosc bledna, zlosliwa albo podana w innej jednostce (godziny zamiast sekund)
// zaparkowalaby zadanie na godzine bez ani jednego sladu, a straznik budzetu nie zawsze to
// zlapie: paczka dla biura jedzie z `doKiedy: Infinity` (czlowiek czeka przy przegladarce,
// `requestTimeout: 0`), wiec tam sufit jest JEDYNA bariera. Piec minut to i tak piec okien
// limitu — jesli KSeF prosi o wiecej, lepiej oddac blad niz wisiec.
const MAKS_CZEKANIE_S = 5 * 60;

// ⚠️ TRZY PONOWIENIA, A NIE „do skutku". Czekanie jest tanie tylko dopoki jest skonczone:
// petla bez sufitu zamienialaby zablokowane konto w przebieg wiszacy do konca swiata,
// bez ani jednego sladu w logu.
const MAKS_PONOWIEN = 3;

/**
 * Wola `fn()`; gdy odbije sie od limitu KSeF (blad ze `status === 429`), czeka tyle, ile
 * kazal KSeF (`retryAfterS` z bledu, domyslnie 60 s) i ponawia — najwyzej `MAKS_PONOWIEN` razy.
 *
 * ⚠️⚠️ CZEKANIE MUSI SIE ZMIESCIC W BUDZECIE WOLAJACEGO (`doKiedy`, znacznik czasu w ms).
 * Archiwum kosztow ma na caly przebieg 10 minut (BUDZET_ARCHIWUM_MS): bez tego straznika
 * kolejka setek zaleglych dokumentow spalaby po 55 s przy kazdym z nich, przebieg przekraczalby
 * godzine i zjadal kolejne tykniecia zegara (bootstrap.js) — po cichu, bo z punktu widzenia
 * wolajacego wszystko szloby zgodnie z planem.
 *
 * Gdy budzet nie pozwala poczekac, blad leci dalej z dopisanym `powod: 'limit'` — po TYM
 * znaczniku (a nie po tresci zdania, ktora zmieni sie przy pierwszej poprawce po stronie MF)
 * wolajacy rozpoznaje „to nie awaria, tylko koniec na dzis" i konczy petle spokojnie.
 */
export async function zCzekaniemNa429(fn, {
  spij = (ms) => new Promise((r) => { setTimeout(r, ms); }),
  teraz = () => new Date(),
  doKiedy = Infinity,
  log = () => {},
} = {}) {
  for (let proba = 0; ; proba += 1) {
    try {
      return await fn();
    } catch (e) {
      if (e?.status !== 429 || proba >= MAKS_PONOWIEN) throw e;
      const zadane = Number(e.retryAfterS) > 0 ? Number(e.retryAfterS) : DOMYSLNE_CZEKANIE_S;
      const sekundy = Math.min(zadane, MAKS_CZEKANIE_S);
      const czekanieMs = sekundy * 1000 + ZAPAS_MS;
      if (teraz().getTime() + czekanieMs > doKiedy) {
        // ⚠️ ORYGINALNY BLAD, TYLKO OZNACZONY — tresc od KSeF-u i znacznik `dlaOperatora`
        // zostaja, bo to wciaz jest zdanie, ktore wolno pokazac czlowiekowi przy panelu.
        throw Object.assign(e, { powod: 'limit' });
      }
      log(`KSeF: limit ${LIMIT_KSEF_NA_MINUTE} żądań na minutę — czekam ${Math.round(czekanieMs / 1000)} s przed ponowieniem.`);
      await spij(czekanieMs);
    }
  }
}
