import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { przelacznikStanow, migawkaStanow } from '../../oms/db/stany-magazynowe.js';
import { ofertaPoId, ustawieniaOfertKonta } from '../../oms/db/oferty-kanalow.ts';
import { iloscDlaKanalu, PROBLEMY_ILOSCI } from '../../domena/ilosc-kanalu.js';
import { podgladPrzejecia, przejmijStany, obejmijStany, odczytajOstrzezenia, zamrozonyStock, skutekObjecia, roznicaStanuErli } from './services/przejecie-stanow.js';
import { pobierzOfertyReczne } from './services/przejecie-ofert-erli.js';

export function registerStanyKanalow(app, { db, definicje = [], kontaErli = () => [], sklepy = {}, kontaAllegro = () => [] }) {
  const sekret = randomBytes(32);
  const odczyty = new Map();
  const odmowa = (reply, kod, tekst) => reply.code(kod).view('pusta-strona.ejs', {
    title: 'Stany w kanałach', naglowek: 'Stany w kanałach', opis: tekst,
  });
  const dostep = (req, reply) => {
    if (!przelacznikStanow(db).wlaczone) { odmowa(reply, 404, 'Nie znaleziono strony.'); return false; }
    if (req.konto?.admin !== true) { odmowa(reply, 403, 'Brak prawa edycji magazynu.'); return false; }
    return true;
  };
  const konta = () => definicje.filter(d => ['woo', 'allegro', 'erli'].includes(d.typ));
  const lista = kanal => db.prepare('SELECT id FROM oferty_kanalow WHERE kanal = ? AND pochodzenie = ? ORDER BY id').all(kanal, 'przejeta').map(w => ofertaPoId(db, Number(w.id)));
  const odczyt = (req, konto) => odczyty.get(JSON.stringify([req.konto.login, konto]));
  const produkty = (req, konto) => odczyt(req, konto)?.produkty ?? [];
  const czasOdczytu = (req, konto) => { const czas = odczyt(req, konto)?.czas; return czas ? new Date(czas).toISOString() : null; };
  const planDla = (req, konto) => podgladPrzejecia(db, konto.klucz, konto.typ, produkty(req, konto.klucz), czasOdczytu(req, konto.klucz));
  const dane = (req, konto, plan) => {
    const migawka = migawkaStanow(db);
    // To prognoza po zatwierdzeniu, bez zmiany bezpiecznika D51 w bazie ani w pętlach.
    const prognoza = { ...migawka, zatwierdzenie: { przelaczenieId: migawka.przelaczenieId } };
    const ustawienia = ustawieniaOfertKonta(db, konto.klucz);
    const oferty = lista(konto.klucz);
    const karty = new Map();
    // Uwzględniamy także istniejący rejestr, lecz każdą ofertę tylko raz.
    const wszystkie = new Map(db.prepare('SELECT id_zewnetrzne, karta_id FROM oferty_kanalow WHERE kanal = ?').all(konto.klucz)
      .map(o => [o.id_zewnetrzne, Number(o.karta_id)]));
    for (const w of plan.wiersze) if (w.kartaId) wszystkie.set(w.idZewnetrzne, w.kartaId);
    for (const id of wszystkie.values()) karty.set(id, (karty.get(id) ?? 0) + 1);
    const ostrzezeniaKanalu = odczyt(req, konto.klucz)?.ostrzezenia ?? { fulfillment: null, backorders: null };
    return { konto, plan, ostrzezeniaKanalu, roznice: konto.typ === 'erli' ? roznicaStanuErli(db, konto.klucz, plan.wiersze) : [], oferty: oferty.map(o => {
      const cel = iloscDlaKanalu({ migawka: prognoza, kartaId: o.kartaId, tryb: o.tryb, iloscZOms: true, bufor: ustawienia.buforSzt });
      return { ...o, cel, celNapis: cel.ilosc ?? PROBLEMY_ILOSCI[cel.powod]?.tekst ?? 'Brak celu ilości.',
        skutek: skutekObjecia(konto.typ, o, cel.ilosc, ostrzezeniaKanalu.fulfillmentIds) };
    }), ostrzezenia: [...karty].filter(([, n]) => n > 1).map(([id, n]) =>
      `Karta ${id}: karta ma ${n} ofert na tym koncie — sprzedaż może przekroczyć stan o ${n - 1} sztuk w oknie ≤ 3,7 min. Ustaw bufor konta.`),
    ustawienia, zatwierdzone: !!migawka.zatwierdzenie, bezKarty: migawka.bezKarty,
    nieznane: [...new Set(wszystkie.values())].filter(id => !migawka.znane.has(Number(id))).length };
  };
  const podpisPlanu = plan => [plan.bezStanow, plan.wiersze.map(w => [w.idZewnetrzne, w.kartaId, w.stan, w.zamrozone])];
  const stanPodpisu = (req, konto, akcja, ids) => {
    const migawka = migawkaStanow(db);
    return JSON.stringify([req.konto.login, konto, akcja, ids,
      // Tylko pola, od których zależy decyzja: pętle co 5 min przepisują odczyty i znaczniki czasu.
      podpisPlanu(planDla(req, konto)), lista(konto.klucz).map(o => [o.id, o.kanal, o.idZewnetrzne, o.kartaId, o.tryb, o.iloscZOms, o.odczytZamrozone, o.odczytStatus]),
      przelacznikStanow(db), ustawieniaOfertKonta(db, konto.klucz),
      [...migawka.znane].sort((a, b) => a - b), [...migawka.otwarcia].sort(([a], [b]) => a - b),
      db.prepare('SELECT MAX(id) id FROM ruchy_magazynowe').get()]);
  };
  const podpis = (stan, czas) => createHmac('sha256', sekret).update(JSON.stringify([stan, czas])).digest('hex');
  const tokenDla = stan => { const czas = String(Date.now()); return `${czas}.${podpis(stan, czas)}`; };
  const wazny = (token, stan) => {
    if (typeof token !== 'string') return false;
    const [czas, mac, nadmiar] = token.split('.');
    return !nadmiar && /^\d+$/.test(czas) && Number(czas) <= Date.now() && Date.now() - Number(czas) <= 30 * 60_000
      && /^[a-f0-9]{64}$/.test(mac ?? '') && timingSafeEqual(Buffer.from(mac), Buffer.from(podpis(stan, czas)));
  };
  app.get('/magazyn/stany/kanaly', async (req, reply) => {
    if (!dostep(req, reply)) return reply;
    return reply.view('magazyn-stany-kanaly.ejs', { title: 'Stany w kanałach', konta: konta(), dane: null, podglad: null });
  });
  for (const akcja of ['przejecie', 'objecie']) app.post(`/magazyn/stany/kanaly/${akcja}`, async (req, reply) => {
    if (!dostep(req, reply)) return reply;
    const konto = konta().find(k => k.klucz === req.body?.konto);
    if (!konto) return odmowa(reply, 400, 'Wybierz konto kanału.');
    const surowe = req.body?.zaznaczone;
    const ids = [...new Set((Array.isArray(surowe) ? surowe : surowe ? [surowe] : []).map(String))].sort();
    const zatwierdz = req.body?.zatwierdz === '1';
    if (akcja === 'objecie' && (!ids.length || ids.some(id => !/^\d+$/.test(id) || !lista(konto.klucz).some(o => String(o.id) === id)))) {
      return odmowa(reply, 400, 'Wybierz przejęte oferty z tego konta.');
    }
    if (akcja === 'objecie' && ids.some(id => zamrozonyStock(ofertaPoId(db, Number(id))?.odczytZamrozone))) {
      return odmowa(reply, 409, 'ERLI: zamrożony stock — odmowa objęcia.');
    }
    if (!zatwierdz && konto.typ !== 'erli') {
      try {
        const ostrzezenia = await odczytajOstrzezenia(db, konto, { sklepy, kontaAllegro });
        for (const [klucz, w] of odczyty) if (Date.now() - w.czas > 30 * 60_000) odczyty.delete(klucz);
        if (odczyty.size >= 100) odczyty.delete(odczyty.keys().next().value);
        odczyty.set(JSON.stringify([req.konto.login, konto.klucz]), { ostrzezenia, czas: Date.now() });
      } catch { return odmowa(reply, 502, 'Nie udało się odczytać ostrzeżeń kanału. Pokaż podgląd ponownie.'); }
    }
    if (konto.typ === 'erli' && akcja === 'przejecie' && !zatwierdz) {
      const k = kontaErli().find(k => k.klucz === konto.klucz);
      if (!k) return odmowa(reply, 400, 'Konto ERLI jest niedostępne.');
      try {
        const wynik = await pobierzOfertyReczne(k);
        if (wynik.limit) return odmowa(reply, 409, 'Lista ERLI jest częściowa. Przejęcie przerwane.');
        for (const [klucz, w] of odczyty) if (Date.now() - w.czas > 30 * 60_000) odczyty.delete(klucz);
        if (odczyty.size >= 100) odczyty.delete(odczyty.keys().next().value);
        odczyty.set(JSON.stringify([req.konto.login, konto.klucz]), { produkty: wynik.produkty, czas: Date.now() });
      } catch { return odmowa(reply, 502, 'Nie udało się odczytać ofert ERLI.'); }
    }
    if (zatwierdz) {
      if (!wazny(req.body?.podglad, stanPodpisu(req, konto, akcja, ids))) return odmowa(reply, 409, 'Podgląd wygasł lub dane zmieniły się. Pokaż podgląd ponownie.');
      try {
        if (akcja === 'przejecie') przejmijStany(db, konto.klucz, konto.typ, produkty(req, konto.klucz), czasOdczytu(req, konto.klucz));
        else obejmijStany(db, konto.klucz, ids, konto.typ);
      } catch (e) { return odmowa(reply, 409, e.message); }
      return reply.redirect('/magazyn/stany/kanaly', 303);
    }
    const plan = planDla(req, konto);
    const widok = dane(req, konto, plan);
    return reply.view(akcja === 'objecie' ? 'magazyn-stany-objecie.ejs' : 'magazyn-stany-kanaly.ejs', {
      title: akcja === 'objecie' ? 'Obejmij stany' : 'Przejmij oferty', konta: konta(), dane: widok, ids,
      podglad: tokenDla(stanPodpisu(req, konto, akcja, ids)),
    });
  });
}
