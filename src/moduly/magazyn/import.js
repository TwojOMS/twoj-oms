// Ekran „Importuj produkty" (`/magazyn/import`): jedno połączenie, pięć typów,
// „Sprawdź" (odczyt katalogu TYLKO tego kanału + podgląd liczb) i „Importuj" (wykonanie, ekran wyniku).
//
// ⚠️ „Sprawdź" czyta kanał istniejącym przebiegiem (`magazyn.start`) z `trescKart: false`: odczyt zapisuje
// wyłącznie LUSTRO katalogu (`produkty_sklepowe`), treść Woo zostaje w stanie przebiegu i trafia do kart dopiero
// po „Importuj". Karty, ich zdjęcia i źródła pól zmienia tylko `wykonajImport`.
// Uprawnienia: strażnik ról po przedrostku `/magazyn` (edycja Magazynu) — te same co przyciski listy.
import { stronaOdmowy } from '../../core/web/odmowa.js';
import { rodzajKanalu } from '../../domena/kanaly.js';
import { kanalyZrodloweKart } from '../../domena/karta-z-produktu.js';
import { przelacznikStanow } from '../../oms/db/stany-magazynowe.js';
import { TYPY_IMPORTU, typImportu, planImportu, wykonajImport } from './services/import-kanalu.js';

const ADRES = '/magazyn/import';
const adresEkranu = (kanal, typ) => `${ADRES}?kanal=${encodeURIComponent(kanal)}&typ=${encodeURIComponent(typ)}`;

export function registerImportMagazynu(app, { db, magazyn, pomoc, trescAllegro, kontaErli, definicje }) {
  const kanaly = () => (magazyn && magazyn.gotowy?.() !== false ? (magazyn.kanaly?.() ?? []) : []);
  const czyAllegro = (kanal) => pomoc.KANALY_ALLEGRO.includes(kanal);
  const opisKanalu = (klucz) => ({
    klucz,
    etykieta: pomoc.adresKanalu(klucz),
    rodzaj: rodzajKanalu(klucz, definicje),
    allegro: czyAllegro(klucz),
  });
  const zrodlowe = () => kanalyZrodloweKart([...pomoc.KANALY_SKLEPOW], [...pomoc.KANALY_ALLEGRO]);
  const wynikKanalu = (stan, kanal) => stan.kanaly.find((k) => k.kanal === kanal) ?? null;
  // Odczyt „Sprawdź" tego kanału skończony i bez błędu — tylko wtedy podgląd i „Importuj" mają sens.
  const odczytGotowy = (stan, kanal) =>
    stan.zakres === kanal &&
    !stan.trwa &&
    !stan.blad &&
    !wynikKanalu(stan, kanal)?.blad &&
    Boolean(wynikKanalu(stan, kanal));

  const wspolne = () => ({
    szerokosc: 'formularz',
    stanyWlaczone: przelacznikStanow(db).wlaczone,
    erli: (kontaErli?.() ?? []).length > 0,
    typy: TYPY_IMPORTU,
  });
  const odmowa = (reply, status, komunikat, wroc = ADRES) =>
    stronaOdmowy(reply, status, komunikat, {
      tytul: 'Import produktów',
      napisWroc: 'Wróć do importu',
      wroc,
    });

  app.get(ADRES, async (req, reply) => {
    const lista = kanaly().map(opisKanalu);
    const kanal = lista.some((k) => k.klucz === req.query?.kanal) ? req.query.kanal : null;
    const typ = typImportu(req.query?.typ);
    const stan = magazyn?.stan?.() ?? null;
    const wybrany = kanal ? opisKanalu(kanal) : null;
    if (stan && kanal && typ && stan.zakres === kanal) {
      if (stan.trwa)
        return reply.view('magazyn-import.ejs', {
          ...wspolne(),
          krok: 'trwa',
          kanaly: lista,
          wybrany,
          typ,
          postep: stan.postep,
          odswiez: adresEkranu(kanal, typ.klucz),
        });
      const blad = stan.blad ?? wynikKanalu(stan, kanal)?.blad ?? null;
      if (blad || !wynikKanalu(stan, kanal)) {
        return reply.view('magazyn-import.ejs', {
          ...wspolne(),
          krok: 'wybor',
          kanaly: lista,
          wybrany,
          typ,
          blad: blad ?? 'Odczyt nie zwrócił wyniku dla tego kanału.',
        });
      }
      const plan = planImportu(db, {
        kanal,
        typ,
        kanalyZrodlowe: zrodlowe(),
        allegro: wybrany.allegro,
        tresc: wynikKanalu(stan, kanal).tresc ?? [],
      });
      return reply.view('magazyn-import.ejs', {
        ...wspolne(),
        krok: 'podglad',
        kanaly: lista,
        wybrany,
        typ,
        liczby: plan.liczby,
        powody: plan.powody,
        juzPowiazane: plan.juzPowiazane,
        odczytane: wynikKanalu(stan, kanal).zapisane,
        dlaczego: `/magazyn/pominiete?kanal=${encodeURIComponent(kanal)}`,
      });
    }
    const trwaInny = Boolean(stan?.trwa);
    return reply.view('magazyn-import.ejs', {
      ...wspolne(),
      krok: 'wybor',
      kanaly: lista,
      wybrany: wybrany ?? (lista.length === 1 ? lista[0] : null),
      typ,
      trwaInny,
    });
  });

  // „Sprawdź": odczyt katalogu wybranego kanału w tle, potem 303 na ekran, który pokaże postęp albo podgląd.
  app.post(`${ADRES}/sprawdz`, async (req, reply) => {
    const kanal = req.body?.kanal;
    const typ = typImportu(req.body?.typ);
    if (!kanaly().includes(kanal) || !typ)
      return odmowa(reply, 400, 'Wybierz połączenie i typ importu, potem kliknij „Sprawdź".');
    const { wystartowal } = magazyn.start({ kanal, trescKart: false });
    if (!wystartowal && magazyn.stan().zakres !== kanal) {
      return odmowa(
        reply,
        409,
        'Trwa już odczyt katalogów — poczekaj, aż się skończy, i kliknij „Sprawdź" jeszcze raz.',
      );
    }
    return reply.code(303).redirect(adresEkranu(kanal, typ.klucz));
  });

  // „Importuj": wykonanie wybranego typu na lustrze ze świeżego „Sprawdź" tego kanału.
  app.post(`${ADRES}/importuj`, async (req, reply) => {
    const kanal = req.body?.kanal;
    const typ = typImportu(req.body?.typ);
    if (!kanaly().includes(kanal) || !typ)
      return odmowa(reply, 400, 'Wybierz połączenie i typ importu, potem kliknij „Sprawdź".');
    const stan = magazyn.stan();
    if (!odczytGotowy(stan, kanal)) {
      return odmowa(
        reply,
        409,
        'Ten kanał nie ma świeżego odczytu — kliknij „Sprawdź", obejrzyj liczby i dopiero wtedy importuj.',
        adresEkranu(kanal, typ.klucz),
      );
    }
    const wybrany = opisKanalu(kanal);
    const wynik = wykonajImport(db, {
      kanal,
      typ,
      kanalyZrodlowe: zrodlowe(),
      allegro: wybrany.allegro,
      tresc: wynikKanalu(stan, kanal).tresc ?? [],
      trescAllegro,
    });
    return reply.view('magazyn-import.ejs', {
      ...wspolne(),
      krok: 'wynik',
      kanaly: [],
      wybrany,
      typ,
      liczby: wynik.liczby,
      powody: wynik.powody,
      juzPowiazane: wynik.juzPowiazane,
      trescAllegro: wynik.trescAllegro,
      dlaczego: `/magazyn/pominiete?kanal=${encodeURIComponent(kanal)}`,
    });
  });
}
