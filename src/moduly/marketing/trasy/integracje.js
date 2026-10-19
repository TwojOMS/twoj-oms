import { tytulEkranuDlaAdresu } from '../../../domena/ekrany.js';
import {randomUUID} from 'node:crypto';
import {polaczenia,stanPolaczenia,zapiszPolaczenie,zapiszStan} from '../../../oms/db/reklamy.js';
import {promptReklam} from '../../../domena/prompt-reklam.js';
import {testPolaczenie,KROKI} from '../uslugi/test-polaczenia-reklam.js';
import {nawigacjaUstawien} from '../../ustawienia/nawigacja.js';
const ZRODLA = Object.freeze({ ga4: 'Google przez GA4', google_ads: 'Google Ads API', meta: 'Meta' });
const KROK_NIESKONFIGUROWANY = 'TEST_NIESKONFIGUROWANY';
const KOMUNIKAT_NIESKONFIGUROWANY = 'Test połączeń reklam nie jest skonfigurowany na tym serwerze.';

// PRZ-094.14: wynik „Test odczytu” wraca na ekran reklam przez przekierowanie (PRG). Adres niesie tylko
// identyfikator połączenia i krótki kod z whitelisty — treść komunikatu składamy po stronie serwera
// ze znanych tekstów, więc nic z adresu nie trafia na ekran, a surowa odpowiedź API nie wychodzi nigdy.
function adresWynikuTestu(polaczenieId, wynik) {
  const q = new URLSearchParams({ test: wynik.stan === 'dziala' ? 'dziala' : 'blad' });
  if (wynik.stan !== 'dziala') q.set('kod', wynik.kodBledu);
  q.set('polaczenie', String(polaczenieId));
  return `/ustawienia/integracje/reklamy?${q}`;
}

function komunikatTestu(query, polaczenia) {
  const polaczenie = polaczenia.find((p) => String(p.id) === String(query?.polaczenie ?? ''));
  if (!polaczenie || !['dziala', 'blad'].includes(query?.test)) return null;
  const gdzie = `${ZRODLA[polaczenie.typ] ?? polaczenie.typ}, konto ${polaczenie.kontoId}`;
  if (query.test === 'dziala') return { ok: true, tekst: `Odczyt działa — ${gdzie}.` };
  const krok = query.kod === KROK_NIESKONFIGUROWANY ? KOMUNIKAT_NIESKONFIGUROWANY
    : Object.hasOwn(KROKI, query.kod) ? KROKI[query.kod] : null;
  if (!krok) return null;
  return { ok: false, tekst: `Test odczytu nie powiódł się — ${gdzie}. ${krok}` };
}

export function createWidokReklam({db,stanyKanalow=null,wiazanieKanalow=null,reklamy=null}) {
 const wspolnyKontekst=(req,reply)=>({nawigacja:nawigacjaUstawien(req,reply),zapisano:req.query?.zapisano==='reklamy'?'Zapisano połączenie reklam.':req.query?.zapisano==='kanal'?'Rozpoczęto wiązanie kanału Allegro.':null});
  function widokIntegracji(req, reply, { blad = null, tylkoReklamy = false } = {}) {
    const nazwy = { ga4: 'Google przez GA4', google_ads: 'Google Ads API', meta: 'Meta' };
    const wszystkie = polaczenia(db);
    const zrodlaReklam = Object.entries(nazwy).map(([typ, etykieta]) => {
      const przypisane = wszystkie.filter((p) => p.typ === typ);
      return { typ, etykieta, stan: przypisane.length
        ? przypisane.map((p) => ({ ...p, sekretRef: undefined, stan: stanPolaczenia(db, p.id) }))
        : [], prompt: przypisane.length ? null : promptReklam(typ) };
    });
    // Nie ufamy X-Forwarded-Proto bez jawnej funkcji z zaufanego reverse proxy.
    const bezpieczneHttps = req.raw.socket.encrypted === true || reklamy?.zaufaneHttps?.(req) === true;
    return reply.view('ustawienia-integracje.ejs', {
      ...wspolnyKontekst(req, reply), title: tytulEkranuDlaAdresu(req.url), blad,
      testOdczytu: tylkoReklamy ? komunikatTestu(req.query, wszystkie) : null,
      tylkoReklamy, zrodlaReklam, mozeKonfigurowacReklamy: req.konto?.admin === true,
      formularzSekretu: bezpieczneHttps && !!reklamy?.magazyn,
      kanaly: (stanyKanalow?.() ?? []).map((stan) => ({ stan, wiazanie: wiazanieKanalow?.stan?.(stan.kanal) ?? null })),
    });
  }


 return widokIntegracji;
}
export function registerUstawieniaRoutes(app,{db,reklamy=null}) {
  app.post('/ustawienia/integracje/reklamy/zapisz', async (req, reply) => {
    if (req.konto?.admin !== true) return reply.code(403).send('Tylko administrator może zmieniać połączenia reklam.');
    const bezpieczneHttps = req.raw.socket.encrypted === true || reklamy?.zaufaneHttps?.(req) === true;
    if (!bezpieczneHttps) return reply.code(403).send('Poświadczenie można przesłać wyłącznie przez HTTPS.');
    if (!reklamy?.magazyn) return reply.code(503).send('Magazyn sekretów reklam nie jest skonfigurowany.');
    const { typ, kontoId, kanal, tresc } = req.body ?? {};
    if (!['ga4', 'meta'].includes(typ) || !kontoId || !kanal || typeof tresc !== 'string' || !tresc) {
      return reply.code(400).send('Uzupełnij źródło, konto, kanał i poświadczenie.');
    }
    try {
      const obecne = polaczenia(db).find((p) => p.typ === typ && p.kontoId === kontoId);
      const poprzednieId = obecne?.sekretRef?.startsWith(`${typ}:`)
        ? obecne.sekretRef.slice(typ.length + 1) : null;
      const sekretRef = await reklamy.magazyn.zapisz({ typ, polaczenieId: poprzednieId ?? randomUUID(), tresc });
      if (obecne) {
        db.prepare('UPDATE reklamy_polaczenia SET kanal = ?, sekret_ref = ? WHERE id = ?')
          .run(kanal, sekretRef, obecne.id);
      } else {
        zapiszPolaczenie(db, { typ, kontoId, kanal, sekretRef });
      }
      return reply.redirect('/ustawienia/integracje/reklamy?zapisano=reklamy');
    } catch {
      return reply.code(400).send('Nie udało się zapisać połączenia reklam.');
    }
  });

  app.post('/ustawienia/integracje/reklamy/test', async (req, reply) => {
    if (req.konto?.admin !== true) return reply.code(403).send('Tylko administrator może testować połączenia reklam.');
    const id = Number(req.body?.polaczenieId);
    const polaczenie = polaczenia(db).find((p) => p.id === id);
    if (!polaczenie) return reply.code(404).send('Nie znaleziono połączenia reklam.');
    if (!reklamy?.magazyn || !reklamy?.klienci) {
      return reply.code(303).redirect(adresWynikuTestu(id, { stan: 'blad', kodBledu: KROK_NIESKONFIGUROWANY }));
    }
    const wynik = await testPolaczenie({ ...polaczenie, magazyn: reklamy.magazyn, klienci: reklamy.klienci });
    if (wynik.stan === 'dziala') {
      db.prepare('UPDATE reklamy_polaczenia SET waluta = ?, strefa = COALESCE(?, strefa) WHERE id = ?')
        .run(wynik.waluta, wynik.strefa, id);
    }
    zapiszStan(db, { polaczenieId: id, ostatniaProbaAt: new Date().toISOString(),
      ostatniSukcesAt: wynik.stan === 'dziala' ? wynik.pobranoAt : null,
      kodBledu: wynik.kodBledu });
    return reply.code(303).redirect(adresWynikuTestu(id, wynik));
  });
}
