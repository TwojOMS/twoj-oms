// Ustawienia → Magazyn — przełącznik „Włącz stany magazynowe”.
// Reguły i zapis przełącznika siedzą w rdzeniu (oms/db/stany-magazynowe.js); ta trasa tylko pokazuje i przełącza.
//
// Kto może przełączyć: strażnik po prefiksie `/ustawienia` wpuszcza wyłącznie konto z uprawnieniem „ustawienia”,
// a gościa demo w podglądzie zatrzymuje na każdym POST-cie (core/bezpieczenstwo/podglad-demo.js) — tu nie
// powtarzamy żadnej z tych blokad.
import { przelacznikStanow, przelaczStany } from '../../../oms/db/stany-magazynowe.js';
import { nawigacjaUstawien } from '../nawigacja.js';
import { stronaOdmowy } from '../../../core/web/odmowa.js';
import { kolejnoscZrodel, polaczeniaZrodel, zapiszKolejnoscZrodel } from '../../magazyn/services/kolejnosc-zrodel.js';

const KOMUNIKATY = {
  wlaczono: 'Stany magazynowe są włączone. Ustal stan otwarcia i zatwierdź podgląd ilości w kanałach.',
  wylaczono: 'Stany magazynowe są wyłączone.',
  bez_zmian: 'Nic się nie zmieniło — stany były już w tym położeniu.',
};

export function registerUstawieniaMagazynuRoutes(app, { db }) {
  const liczniki = () => {
    const maRejestr = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'oferty_kanalow'").get();
    if (!maRejestr) return { zarzadzane: 0, przejete: 0 };
    return db
      .prepare(
        `SELECT COUNT(CASE WHEN tryb = 'zarzadzana' THEN 1 END) zarzadzane,
      COUNT(CASE WHEN tryb = 'obserwowana' AND ilosc_z_oms = 1 THEN 1 END) przejete FROM oferty_kanalow`,
      )
      .get();
  };
  app.get('/ustawienia/magazyn', async (req, reply) => {
    const przelacznik = przelacznikStanow(db);
    return reply.view('ustawienia-magazyn.ejs', {
      nawigacja: nawigacjaUstawien(req, reply),
      title: 'Stany magazynowe',
      przelacznik,
      liczniki: przelacznik.wlaczone ? liczniki() : { zarzadzane: 0, przejete: 0 },
      zrodla: kolejnoscZrodel(db).map((klucz) => polaczeniaZrodel(db).find((p) => p.klucz === klucz)),
      // Było już kiedyś włączone — ponowne włączenie zacznie liczyć od nowa (ostrzeżenie przy przycisku).
      bylWlaczony: przelacznik.historia.some((w) => w.wlaczone),
      zapisano:
        req.query?.zapisano === 'zrodla'
          ? 'Zapisano kolejność źródeł treści karty.'
          : (KOMUNIKATY[req.query?.zapisano] ?? null),
    });
  });

  // Wspólne haki /ustawienia: uprawnienie, podgląd demo i CSRF tak samo jak przy stanach.
  app.post('/ustawienia/magazyn/zrodla', async (req, reply) => {
    const lista = req.body?.kolejnosc;
    const kolejnosc = typeof lista === 'string' ? [lista] : lista;
    try {
      if (req.body?.przesun !== undefined) {
        const przesun = String(req.body.przesun);
        const granica = przesun.indexOf(':');
        const kierunek = przesun.slice(0, granica);
        const klucz = przesun.slice(granica + 1);
        const indeks = Array.isArray(kolejnosc) ? kolejnosc.indexOf(klucz) : -1;
        const cel = indeks + (kierunek === 'wyzej' ? -1 : 1);
        if (!['wyzej', 'nizej'].includes(kierunek) || indeks < 0 || cel < 0 || cel >= kolejnosc.length) {
          throw new Error('Kolejność musi wskazywać połączenie i dostępny kierunek przesunięcia.');
        }
        [kolejnosc[indeks], kolejnosc[cel]] = [kolejnosc[cel], kolejnosc[indeks]];
      }
      zapiszKolejnoscZrodel(db, kolejnosc);
    } catch (e) {
      if (!(e instanceof Error) || !e.message.startsWith('Kolejność musi')) throw e;
      return stronaOdmowy(reply, 400, e.message, {
        tytul: 'Nie udało się zapisać kolejności źródeł',
        wroc: '/ustawienia/magazyn',
        napisWroc: 'Wróć do ustawień magazynu',
      });
    }
    return reply.code(303).redirect('/ustawienia/magazyn?zapisano=zrodla#ust-zrodla');
  });

  app.post('/ustawienia/magazyn/stany', async (req, reply) => {
    if (req.konto?.admin !== true)
      return stronaOdmowy(reply, 403, 'Tylko administrator może przełączać stany.', {
        tytul: 'Stany magazynowe',
        wroc: '/ustawienia/magazyn',
        napisWroc: 'Wróć do ustawień magazynu',
      });
    const wartosc = String(req.body?.wlacz ?? '');
    if (wartosc !== '1' && wartosc !== '0') {
      return stronaOdmowy(reply, 400, 'Pole „wlacz” musi mieć wartość 1 albo 0.', {
        tytul: 'Nie udało się zmienić stanów magazynowych',
        wroc: '/ustawienia/magazyn',
        napisWroc: 'Wróć do ustawień magazynu',
      });
    }
    const wlacz = wartosc === '1';
    const { zarzadzane, przejete } = liczniki();
    if (!wlacz && przelacznikStanow(db).wlaczone && zarzadzane + przejete > 0 && req.body?.rozumiem !== '1') {
      return stronaOdmowy(
        reply,
        400,
        `${zarzadzane} ofert wróci do stałej ilości, ${przejete} przejętych przestanie być synchronizowanych. Zaznacz „Rozumiem”.`,
        { tytul: 'Potwierdź wyłączenie stanów', wroc: '/ustawienia/magazyn', napisWroc: 'Wróć do ustawień magazynu' },
      );
    }
    const konto = req.konto ? { id: req.konto.id ?? null, login: req.konto.login ?? null } : null;
    const { zmieniono } = przelaczStany(db, { wlacz, konto });
    const zapisano = !zmieniono ? 'bez_zmian' : wlacz ? 'wlaczono' : 'wylaczono';
    return reply.code(303).redirect(`/ustawienia/magazyn?zapisano=${zapisano}`);
  });
}
