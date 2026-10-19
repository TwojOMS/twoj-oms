import multipart from '@fastify/multipart';
import {odczytajOdpowiedz,MAKS_PLIK,MAKS_PLIKOW} from '../zalaczniki.js';
// Trasy Centrum wiadomosci Allegro.
//
// ⚠️ EKRAN CZYTA WYLACZNIE LUSTRO (`allegro_watki`, `allegro_wiadomosci`, `allegro_odpowiedzi`)
// i NIGDY nie dzwoni do Allegro — ta sama zasada, co przy /kampania. Jedynym wyjsciem na
// zewnatrz jest POST odpowiedzi, i tylko za swiadomym potwierdzeniem czlowieka.

import {
  listaWatkow, watek, dowody, zapiszDowod, oznaczWyslane, oznaczBlad, wiadomosciWatku,
  zamknijWatek,
} from '../../../oms/db/allegro-watki.js';
import { czyjRuch } from '../../../domena/czyj-ruch-watku.js';
import { sprawyOtwarte } from '../services/dyskusje.js';
import { MAKS_ZNAKOW_WIADOMOSCI } from '../../../domena/ustawienia-formulki.js';
import { wczytajSzablonyWiadomosci } from '../../../oms/db/szablony-wiadomosci.js';
import { zamowienieWatku } from '../../../oms/db/allegro-watki.js';
import { pobierzZamowienie } from '../../../oms/db/zamowienia.js';
import { tekstDoWatku } from '../szablony.js';
import { PODPIS } from '../../../domena/potwierdzenie-zamowienia.js';

export function registerWiadomosciRoutes(app, options) {
  app.register(async scoped => {
    await scoped.register(multipart, {limits:{files:MAKS_PLIKOW,fileSize:MAKS_PLIK,fields:2,fieldSize:8192,parts:7},preservePath:true});
    registerRoutes(scoped,options);
  });
}
function registerRoutes(app, { db, klienci = {}, podpis = PODPIS }) {
  /**
   * PRZ-101.03: „Wstaw szablon" — szablony własne z podstawionymi polami TEGO wątku. Zamówienie wątku = najnowsze
   * zamówienie z tego konta Allegro z tym samym loginem kupującego; bez niego pola z zamówienia są puste
   * (nigdy dosłowne `{…}`), a bloki zamówienia znikają. Liczone z lustra i bazy — bez zapytań do Allegro.
   */
  function szablonyWatku(w) {
    if (!w || w.typ === 'POST_PURCHASE_ISSUE') return { szablony: [], zamowienieSzablonow: null };
    const wlasne = wczytajSzablonyWiadomosci(db).wlasne;
    if (!wlasne.length) return { szablony: [], zamowienieSzablonow: null };
    const idZ = zamowienieWatku(db, w.kanal, w.interlocutor_login);
    const z = idZ ? pobierzZamowienie(db, idZ) : null;
    return {
      szablony: wlasne.map((s) => ({ id: s.id, nazwa: s.nazwa, tekst: tekstDoWatku(z, s, { podpis }) })),
      zamowienieSzablonow: z ? { id: z.id, numer: z.numer } : null,
    };
  }
  // UI context reads only the existing SQLite mirror. No external request on GET.
  function kontekst(wybrany = undefined, czytanie = false, blad = null, szkic = '') {
    const watki = listaWatkow(db).map((w) => ({
      ...w, stan: czyjRuch(w, dowody(db, w.kanal, w.thread_id)),
    })).sort((a, b) => Number(b.typ === 'POST_PURCHASE_ISSUE') - Number(a.typ === 'POST_PURCHASE_ISSUE'));
    const w = wybrany === undefined ? (watki.find(t => t.typ !== 'POST_PURCHASE_ISSUE' && t.stan === 'czeka') || watki[0] || null) : wybrany;
    const lista = w ? dowody(db, w.kanal, w.thread_id).map(d=>({...d,zalaczniki:db.prepare('SELECT nazwa,mime,rozmiar,stan,blad FROM allegro_odpowiedzi_zalaczniki WHERE odpowiedz_id=? ORDER BY id').all(d.id)})) : [];
    return {
      title: 'Wiadomości', watki, sprawy: sprawyOtwarte(db), w, lista,
      korespondencja: w ? wiadomosciWatku(db, w.kanal, w.thread_id) : [],
      stan: w ? czyjRuch(w, lista) : null,
      maks: MAKS_ZNAKOW_WIADOMOSCI, blad, szkic, czytanie, brak: czytanie && !w,
      ...szablonyWatku(w),
    };
  }
  app.get('/wiadomosci', async (req, reply) => reply.view('wiadomosci.ejs', kontekst()));
  app.get('/wiadomosci/:kanal/:threadId', async (req, reply) => {
    const w = watek(db, req.params.kanal, req.params.threadId);
    const ctx = kontekst(w || null, true);
    // PRZ-101.03: bez JavaScriptu „Wstaw" to GET z `?szablon=` — pole odpowiedzi przychodzi wypełnione.
    const wstawiony = ctx.szablony.find((s) => s.id === String(req.query?.szablon ?? ''));
    if (wstawiony) ctx.szkic = wstawiony.tekst;
    return reply.code(w ? 200 : 404).view('wiadomosci.ejs', {...ctx,potwierdzonyDowod:String(req.query?.wyslano??'')} );
  });

  app.post('/wiadomosci/:kanal/:threadId/odpowiedz', async (req, reply) => {
    const { kanal, threadId } = req.params;
    const w = watek(db, kanal, threadId);
    if (!w) return reply.code(404).send('Nie ma takiego wątku.');

    // ⚠️ TA SAMA BARIERA, CO W CZUWACZU, i celowo powtorzona: adres da sie wpisac z palca,
    // a odpowiedz w sporze wyslana stad omijalaby komplet narzedzi i dowodow w Allegro.
    if (w.typ === 'POST_PURCHASE_ISSUE') {
      return reply.code(400).send('To problem z zakupem — odpowiedz w Allegro, nie stąd.');
    }
    // ⚠️ WYSYLKA JEST NIEODWRACALNA — krok potwierdzenia, jak przy nadaniu paczki.
    // Sprawdzamy PRZED zapisem dowodu, zeby kliknieciе bez ptaszka nie zostawialo sladu.
    let odpowiedz;
    try { odpowiedz=await odczytajOdpowiedz(req); }
    catch (error) { return reply.code(400).view('wiadomosci.ejs',kontekst(w,true,'Nie odczytano załączników. Sprawdź formaty, limit 5 plików / 5 MiB każdy / 20 MiB łącznie i wybierz pliki ponownie.',String(error.szkic??req.body?.tresc??''))); }
    if (odpowiedz.potwierdzam !== 'tak') {
      return reply.code(400).send('Brak potwierdzenia — nic nie wysłano.');
    }

    const {tresc,pliki}=odpowiedz;
    if(!tresc.trim()||tresc.length>MAKS_ZNAKOW_WIADOMOSCI)return reply.code(400).view('wiadomosci.ejs',kontekst(w,true,'Wpisz treść odpowiedzi, najwyżej '+MAKS_ZNAKOW_WIADOMOSCI+' znaków.',tresc));
    const klient = klienci[kanal];
    if (!klient) return reply.code(503).send('Kanał Allegro nie jest skonfigurowany.');

    // ⚠️ DOWOD PRZED STRZALEM — ta sama zasada, co w czuwaczu formulki. Gdy polaczenie padnie
    // PO wyslaniu, wpis zostaje i widac, ze cos poszlo.
    let dowod;
    try {
      db.exec('BEGIN IMMEDIATE');
      try {
        dowod = zapiszDowod(db, { kanal, threadId, rodzaj: 'reczna', tresc });
        for(const p of pliki){const row=db.prepare('INSERT INTO allegro_odpowiedzi_zalaczniki(odpowiedz_id,nazwa,mime,rozmiar,sha256) VALUES(?,?,?,?,?)').run(dowod.id,p.nazwa,p.mime,p.rozmiar,p.sha256);p.dowodId=Number(row.lastInsertRowid);}
        db.exec('COMMIT');
      } catch(error) { db.exec('ROLLBACK');throw error; }
    } catch (e) {
      return reply.code(409).send(`Nie zapisano dowodu wysyłki, więc nic nie wysłano: ${e.message}`);
    }

    let wysylkaRozpoczeta=false;
    try {
      const ids=[];
      for(const p of pliki){try {
        const d=await klient.deklarujZalacznikWiadomosci(p.nazwa,p.rozmiar);
        db.prepare("UPDATE allegro_odpowiedzi_zalaczniki SET allegro_id=?,stan='zadeklarowany' WHERE id=?").run(d.id,p.dowodId);
        await klient.wgrajZalacznikWiadomosci(d.id,p.bajty,p.mime);
        db.prepare("UPDATE allegro_odpowiedzi_zalaczniki SET stan='wgrany' WHERE id=?").run(p.dowodId);
        ids.push(d.id);
      } catch(error){db.prepare("UPDATE allegro_odpowiedzi_zalaczniki SET stan='blad',blad=? WHERE id=?").run(String(error.message),p.dowodId);throw error;}}
      if(ids.length){wysylkaRozpoczeta=true;const result=await klient.wyslijWiadomosc(threadId, tresc, ids);if(!result?.id)throw Error('Brak potwierdzenia wysłania. Sprawdź wątek w Allegro przed ponownym wysłaniem.');}
      else await klient.wyslijWiadomosc(threadId, tresc);
      oznaczWyslane(db, dowod.id);
      return reply.redirect(`/wiadomosci/${encodeURIComponent(kanal)}/${encodeURIComponent(threadId)}`+(req.query?.receipt==='1'?'?wyslano='+dowod.id:''));
    } catch (e) {
      if(wysylkaRozpoczeta)e.message='Brak potwierdzenia wysłania. Sprawdź wątek w Allegro przed ponownym wysłaniem.';
      oznaczBlad(db, dowod.id, e.message);
      // ⚠️ NIE UDAJEMY SUKCESU. Czlowiek ma zobaczyc, ze nie poszlo — inaczej uzna sprawe za
      // zalatwiona, a kupujacy czeka.
      return reply.code(502).view('wiadomosci.ejs', kontekst(w, true, e.message, tresc));
    }
  });

  // RECZNE „ZALATWIONE" — prosba wlasciciela z 29.08.2026: sa watki, w ktorych kupujacy
  // napisal na koniec „Dziekuje" i nie ma na co odpisywac. Panel nie ma jak odroznic
  // podziekowania od pytania, wiec te jedna rzecz musi mu powiedziec czlowiek.
  //
  // ⚠️⚠️ NIC NIE WYCHODZI DO ALLEGRO. To zmiana WYLACZNIE u nas: kupujacy nie ma prawa
  // dostac wiadomosci dlatego, ze ktos posprzatal sobie kolejke. Ekran dalej nie dzwoni
  // na zewnatrz — jedynym wyjsciem zostaje POST odpowiedzi.
  app.post('/wiadomosci/:kanal/:threadId/zalatwione', async (req, reply) => {
    const { kanal, threadId } = req.params;
    const w = watek(db, kanal, threadId);
    if (!w) return reply.code(404).send('Panel nie zna tego wątku.');
    // ⚠️ BEZ DATY NIE MA CZEGO ZAKOTWICZYC. Zamkniecie obejmuje stan NA CHWILE klikniecia,
    // wiec bez daty albo uciszyloby watek na zawsze, albo nie zrobilo nic. Odmowa jest
    // uczciwsza niz jedno i drugie.
    if (!w.last_message_date_time) {
      return reply.code(409).send('Wątek nie ma daty ostatniej wiadomości — nie ma czego zamknąć.');
    }
    zamknijWatek(db, kanal, threadId, w.last_message_date_time, new Date().toISOString());
    // Wracamy do kolejki: „zalatwione" klika sie po to, zeby przejsc do nastepnego.
    return reply.redirect('/wiadomosci');
  });
}
