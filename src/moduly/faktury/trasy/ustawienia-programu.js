// PRZ-121.02: Ustawienia → Integracje → Moduł faktur. Wybór modułu: Brak, inFakt, Fakturownia (wkrótce), TwojeFaktury
// (wkrótce). Reguła, lista i zdania — domena/wybor-programu.js; zapis — oms/db/wybor-programu.js (wiersz
// „program_fakturowy”, bez migracji).
//
// Dostęp: strażnik po prefiksie `/ustawienia` wpuszcza konto z uprawnieniem „ustawienia” — takie konto widzi ekran
// tylko do odczytu. Zapis tylko admin (wyłączenie faktur dotyczy całej firmy). Wybór z pliku (OMS_PROGRAM_FAKTUROWY)
// wygrywa: pola nieaktywne, zapis 409. Zmiana działa po ponownym uruchomieniu OMS-u (usługi składają się raz).
// ⚠️ Klucz API nie trafia tu nigdy: ekran dostaje tylko informację, skąd klucz jest (plik / zapis / brak).
// Nazwa programu fakturowego idzie przez `odmianaNazwyProgramu`/`ekranProgramu` (strażnik nazw PRZ-118.10).
import { odmianaNazwyProgramu, ekranProgramu } from '../../../domena/nazwa-programu.js';
import { tytulEkranuDlaAdresu } from '../../../domena/ekrany.js';
import { MODULY_FAKTUR, EKRAN_WYBORU_PROGRAMU, ZMIENNA_PROGRAMU, etykietaModulu, sprawdzFormularzWyboru,
  zdanieCzekaniaNaRestart } from '../../../domena/wybor-programu.js';
import { zapiszWyborProgramu, liczbaDokumentowWgProgramu } from '../../../oms/db/wybor-programu.js';
import { nawigacjaUstawien } from '../../ustawienia/nawigacja.js';

const KOMUNIKATY = { zapisano: 'Zapisano wybór modułu faktur.' };

// Zdanie pod polem, co moduł robi. Moduł bez wpisu (dziś inFakt) opisuje stan klucza.
const OPISY = {
  brak: 'OMS nie wystawia faktur. Proformy działają dalej.',
  fakturownia: 'Wystawianie faktur w Fakturowni.',
  twojefaktury: 'OMS sam wystawia faktury i wysyła je do KSeF, bez zewnętrznego programu.',
};

const jednostka = (n) => (n === 1 ? 'jedna' : n % 10 >= 2 && n % 10 <= 4 && !(n % 100 >= 12 && n % 100 <= 14) ? 'kilka' : 'wiele');

/**
 * Ostrzeżenie przy przejściu z programu na „Brak”: ile dokumentów zostaje w programie. `gdzie` — miejscownik bez „w”
 * („inFakcie”, „programie „X””).
 */
export function zdanieOPrzelaczeniu(ile, gdzie) {
  const j = jednostka(ile);
  const poczatek = j === 'jedna' ? `W OMS-ie jest ${ile} faktura wystawiona`
    : j === 'kilka' ? `W OMS-ie są ${ile} faktury wystawione` : `W OMS-ie jest ${ile} faktur wystawionych`;
  const co = j === 'jedna' ? 'jej PDF-a' : 'ich PDF-ów';
  return `${poczatek} w ${gdzie}. Po przełączeniu OMS nie pobierze ${co} ani nie wyśle do KSeF — ${j === 'jedna' ? 'zostaje' : 'zostają'} w ${gdzie}.`;
}

const odmowaAdmina = (reply) => reply.code(403).view('brak-dostepu.ejs', { title: 'Brak dostępu', wlasnyUklad: true });

// PRZ-121.06: przycisk „Uruchom OMS ponownie” (OMS_RESTART_Z_PANELU). `tak` — proces ma nadzorcę, który go podniesie
// (Docker `restart: unless-stopped`): przycisk działa. `atrapa` (demo publiczne) — przycisk widoczny, nieaktywny.
// Brak zmiennej albo inna wartość — bez przycisku (to nie błąd startu), zamiast niego zdanie z poleceniem.
export const ZMIENNA_RESTARTU = 'OMS_RESTART_Z_PANELU';
export const ADRES_RESTARTU = `${EKRAN_WYBORU_PROGRAMU}/restart`;
const SEKUNDY_ODSWIEZENIA = 10;
export function trybRestartu(wartosc) {
  const w = String(wartosc ?? '').trim().toLowerCase();
  return w === 'tak' || w === 'atrapa' ? w : null;
}

/**
 * `restart` — `{ tryb: 'tak' | 'atrapa' | null, zakoncz, log }`; `zakoncz` to szew ubicia procesu (w produkcji SIGTERM
 * do siebie: main.ts zamyka łagodnie, Docker podnosi kontener).
 */
export function registerUstawieniaProgramuRoutes(app, { db, wyborProgramu, konfiguracjaInfaktu: k, program = null, restart = /** @type {any} */ (null) }) {
  const nazwa = odmianaNazwyProgramu(program);
  const tryb = restart?.tryb ?? null;

  function model(req) {
    const dziala = { program: wyborProgramu.program, zrodlo: wyborProgramu.zrodlo, uwaga: wyborProgramu.uwaga };
    const zapisany = wyborProgramu.teraz();
    const zPliku = dziala.zrodlo === 'plik';
    const moznaZmieniac = req.konto?.admin === true && !zPliku;

    let zrodlo;
    if (zPliku) zrodlo = `Ustawione w pliku konfiguracji (${ZMIENNA_PROGRAMU}) — tam to zmienisz.`;
    else if (dziala.zrodlo === 'ustawienia') zrodlo = 'Wybrane w tym ekranie.';
    else zrodlo = dziala.program === 'brak' ? 'Nic nie wybrano i żaden program nie jest podłączony.'
      : 'Nic nie wybrano. OMS używa tego modułu, bo jest podłączony.';

    // Zmiana czeka na restart tylko wtedy, gdy to wybór człowieka (jak w Zdrowiu).
    const czeka = zapisany.zrodlo !== 'domyslny' && !zPliku
      ? zdanieCzekaniaNaRestart(dziala, zapisany, { gotowy: wyborProgramu.gotowy?.() ?? true }) : null;

    const stanKlucza = k.atrapa ? 'niepotrzebny — działa atrapa piaskownicy' : k.zEnv ? 'w pliku konfiguracji' : k.kluczZapisany?.() ? 'zapisany w Ustawieniach' : 'nie wpisany';
    const liczby = dziala.program === 'brak' ? {} : liczbaDokumentowWgProgramu(db);
    const ile = liczby[dziala.program] ?? 0;
    const gdzie = dziala.program === k.idModulu ? nazwa.miejscownik : `programie „${etykietaModulu(dziala.program)}”`;

    const pola = MODULY_FAKTUR.map((m) => ({
      id: m.id, etykieta: m.etykieta, wkrotce: !m.dostepny, zaznaczone: m.id === zapisany.program,
      nieaktywne: !m.dostepny || !moznaZmieniac,
      opis: m.id === k.idModulu ? `Klucz API ${nazwa.dopelniacz}: ${stanKlucza}.` : (OPISY[m.id] ?? null),
      odnosnik: m.id === k.idModulu ? { adres: ekranProgramu(program), tekst: `Ustawienia ${nazwa.dopelniacz}` } : null,
      ostrzezenie: m.id === 'brak' && ile > 0 ? zdanieOPrzelaczeniu(ile, gdzie) : null,
    }));
    // Przycisk tylko przy zdaniu o czekaniu na restart i tylko dla admina; bez nadzorcy — zdanie z poleceniem.
    const ponowneUruchomienie = !czeka ? null
      : tryb ? (req.konto?.admin === true ? { adres: ADRES_RESTARTU, nieaktywny: tryb !== 'tak' } : null)
        : { recznie: true };
    return { dziala: { etykieta: etykietaModulu(dziala.program), zrodlo }, czeka, ponowneUruchomienie,
      uwaga: zapisany.uwaga ?? dziala.uwaga, pola, moznaZmieniac, zPliku, adres: EKRAN_WYBORU_PROGRAMU };
  }

  function widok(req, reply, { bledy = [] } = {}) {
    return reply.view('ustawienia-programu.ejs', {
      nawigacja: nawigacjaUstawien(req, reply), title: tytulEkranuDlaAdresu(EKRAN_WYBORU_PROGRAMU),
      zapisano: KOMUNIKATY[req.query?.zapisano] ?? null, bledy, ekran: model(req),
    });
  }

  app.get(EKRAN_WYBORU_PROGRAMU, async (req, reply) => widok(req, reply));

  app.post(EKRAN_WYBORU_PROGRAMU, async (req, reply) => {
    if (req.konto?.admin !== true) return odmowaAdmina(reply);
    if (wyborProgramu.zrodlo === 'plik') {
      return reply.code(409).type('text/plain; charset=utf-8')
        .send(`Moduł faktur jest ustawiony w pliku konfiguracji (${ZMIENNA_PROGRAMU}) — tam go zmień. Formularz niczego nie zapisał.`);
    }
    const { ustawienia, bledy } = sprawdzFormularzWyboru(req.body ?? {});
    if (bledy.length) {
      reply.code(400);
      return widok(req, reply, { bledy });
    }
    const konto = req.konto ? { id: req.konto.id ?? null, login: req.konto.login ?? null } : null;
    zapiszWyborProgramu(db, ustawienia.program, { konto });
    return reply.code(303).redirect(`${EKRAN_WYBORU_PROGRAMU}?zapisano=zapisano`);
  });

  // PRZ-121.06: ponowne uruchomienie OMS-u z panelu — tylko admin, tylko przy OMS_RESTART_Z_PANELU=tak (atrapa demo
  // i brak zmiennej: 404, nic się nie dzieje). Ochrona formularza (Origin) jak przy każdym POST panelu.
  app.post(ADRES_RESTARTU, async (req, reply) => {
    if (req.konto?.admin !== true) return odmowaAdmina(reply);
    if (tryb !== 'tak') {
      return reply.code(404).type('text/plain; charset=utf-8')
        .send(`Ponowne uruchomienie z panelu jest wyłączone (${ZMIENNA_RESTARTU}) — uruchom ponownie OMS na serwerze.`);
    }
    restart.log(`PRZ-121.06: ponowne uruchomienie OMS-u z panelu (Moduł faktur) — zlecił ${req.konto.login ?? 'nieznane konto'}`);
    // Sygnał dopiero po wysłaniu całej odpowiedzi (i w następnym obrocie pętli) — przeglądarka dostaje stronę z odświeżeniem.
    reply.raw.once('finish', () => setImmediate(() => restart.zakoncz()));
    return reply.view('brak-dostepu.ejs', { title: 'OMS uruchamia się ponownie', wlasnyUklad: true, restart: true,
      odswiez: { sekundy: SEKUNDY_ODSWIEZENIA, adres: EKRAN_WYBORU_PROGRAMU } });
  });
}
