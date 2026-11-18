import type { ModulOms } from '../../core/kontrakty.ts';
import { registerEkranAutomatyzacji } from './trasy/ekran.js';
import { migracjaRegul } from './migracje/0001-reguly.ts';
import { migracjaIndeksow } from './migracje/0002-indeksy.ts';
import { migracjaOdbioruPrzesylki } from './migracje/0003-odbior-przesylki.ts';
import { migracjaOdbioruUKuriera } from './migracje/0004-odbior-u-kuriera.ts';
import { createSilnikAutomatyzacji } from './services/silnik.js';
import { sprawdzanieWarunkow } from './services/warunki.js';
import { zegarAutomatyzacji } from './zegary.ts';
import { ZDARZENIA } from './zdarzenia/index.js';
import { utworzAkcje } from './akcje/index.js';
import { regulyDoOstrzezen } from './db/reguly.js';

/**
 * Ekran Ustawienia → Automatyzacje (tylko admin) z automatami systemowymi — automat wysyłki do KSeF (logika i zapis
 * zostają w module faktur) i odnośnik do autoodpowiedzi Allegro.
 * Reguły „zdarzenie → warunki → akcja”: trzy tabele (migracja 0001), silnik z zegarem co minutę, kreator, dziennik.
 * Przy zerze włączonych reguł przebieg zegara to jedno SELECT i zero zapisów. Testy podają sztuczne rejestry przez
 * `nadpisania` aplikacji (`automatyzacje.zdarzenia`, `automatyzacje.akcje`, `automatyzacje.sprawdzWarunki`, `automatyzacje.pocztaGotowa`).
 * Zdarzenia: „Paczka nadana”, „Status zmienił się na”, „Kurier odebrał paczkę” i „Nowe zamówienie”; akcja „Wyślij mail
 * do kupującego” (usługa wiadomości); warunki w chwili wykonania (status, numer listu, dostawa, pobranie).
 * Migracje: 0002 — indeksy detektora statusu i ostrzeżeń; 0003 — `przesylki.odebrana_at`, `odebrana_dowod`;
 * 0004 — `odebrana_kurier_at` (chwila odbioru u kuriera, do odrzucenia spóźnionego dowodu).
 */
export const modulAutomatyzacje: ModulOms<null> = {
  nazwa: 'automatyzacje',
  wersja: '1.2.0',
  wymaga: ['rdzen', 'web', 'kanaly', 'faktury', 'wiadomosci', 'zamowienia', 'wysylka'],
  migracje: [migracjaRegul, migracjaIndeksow, migracjaOdbioruPrzesylki, migracjaOdbioruUKuriera],
  menu: [],
  uprawnienia: [],
  konfiguracja: () => null,
  zbuduj: (ctx) => {
    // Nadpisanie z testu albo wartość modułu — własne usługi modułu nie istnieją jeszcze w chwili budowy.
    const nadpisane = <T>(nazwa: string, domyslna: T): T => {
      try {
        return ctx.usluga<T>('automatyzacje', nazwa);
      } catch {
        return domyslna;
      }
    };
    // Usługa wiadomości czytana przy każdym wykonaniu (null w wąskim składzie bez modułu wiadomości).
    const wiadomosci = () => {
      try {
        return ctx.usluga<any>('wiadomosci', 'wiadomosci') ?? null;
      } catch {
        return null;
      }
    };
    const zdarzenia = nadpisane<readonly any[]>('zdarzenia', ZDARZENIA);
    const akcje = nadpisane<readonly any[]>('akcje', utworzAkcje({ wiadomosci }));
    const sprawdzWarunki = nadpisane('sprawdzWarunki', sprawdzanieWarunkow);
    // Usługa wiadomości istnieje zawsze; czy poczta jest TERAZ ustawiona, mówi `gotowe()` (zapis poczty
    // w Ustawieniach działa bez restartu).
    const pocztaGotowa = nadpisane<() => boolean>('pocztaGotowa', () => Boolean(wiadomosci()?.gotowe?.()));
    const silnik = createSilnikAutomatyzacji({
      db: ctx.db,
      zdarzenia,
      akcje,
      sprawdzWarunki,
      pocztaGotowa,
      teraz: ctx.teraz,
      log: ctx.log,
    });
    // `w_toku` → `niepewne` robi pierwszy przebieg zegara, nie budowa modułu: skrypt budujący aplikację na tej samej
    // bazie nie przestawi trwającej wysyłki serwera.
    return {
      uslugi: { silnik, zdarzenia, akcje },
      // Wstrzymana reguła jako uwaga zdrowia modułu (wzór: kanaly/modul.ts).
      // Uwaga: zbiorcze `zdrowie()` aplikacji czytają dziś tylko testy — na stronie głównej adminowi pokazuje ją tabelka
      // ostrzeżeń (domena/ostrzezenia.js, `ostrzezeniaAutomatyzacji`, zamowienia/kontekst.js).
      zdrowie: () => ({
        alarmy: [],
        uwagi: regulyDoOstrzezen(ctx.db, new Date(ctx.teraz().getTime() - 7 * 24 * 3600 * 1000).toISOString())
          .filter((r: any) => r.wstrzymana_powod)
          .map((r: any) => `automatyzacja „${r.nazwa}” wstrzymana: ${r.wstrzymana_powod}`),
      }),
      zegary: [zegarAutomatyzacji({ silnik, log: ctx.log })],
      trasy: (app) => {
        const faktury = <T>(nazwa: string) => ctx.usluga<T>('faktury', nazwa);
        const definicje = ctx.usluga<{ definicje?: readonly unknown[] }>('kanaly', 'config').definicje ?? [];
        registerEkranAutomatyzacji(app, {
          db: ctx.db,
          teraz: ctx.teraz,
          konfiguracjaProgramu: faktury('konfiguracjaProgramu'),
          automatKsef: faktury('automatKsef'),
          infakt: faktury('infakt'),
          reguly: { definicje, zdarzenia, akcje, sprawdzWarunki, pocztaGotowa },
        });
      },
    };
  },
};
