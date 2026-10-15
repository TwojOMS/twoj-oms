import {
  polaczenia, zapiszDni, zapiszTransakcje, zapiszMetaKampanie, zapiszStan,
} from '../../../oms/db/reklamy.js';

function dzienWStrefie(data, strefa) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: strefa || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(data);
}

function minusDni(dzien, ile) {
  const data = new Date(`${dzien}T12:00:00Z`);
  data.setUTCDate(data.getUTCDate() - ile);
  return data.toISOString().slice(0, 10);
}

function kodBledu(e) {
  if ([401, 403].includes(e?.status ?? e?.statusCode)) return 'BRAK_UPRAWNIEN';
  if (e?.status === 429) return 'LIMIT_API';
  return 'BLAD_ODCZYTU';
}

// Jedno źródło nie może zgasić pozostałych ani całego OMS. Każde połączenie
// zachowuje osobny ostatni sukces, a trasie wolno czytać wyłącznie lustra.
export function createCzuwaczReklam({
  db, klientDlaPolaczenia, teraz = () => new Date(),
}) {
  if (typeof klientDlaPolaczenia !== 'function') throw new TypeError('Brak fabryki klienta reklam.');
  let trwa = false;

  async function przebieg() {
    if (trwa) return { pominiety: true, sukcesy: 0, bledy: 0 };
    trwa = true;
    try {
      const zrodla = polaczenia(db);
      let sukcesy = 0;
      let bledy = 0;
      for (const p of zrodla) {
        const chwila = teraz();
        const pobranoAt = chwila.toISOString();
        const doDnia = dzienWStrefie(chwila, p.strefa);
        const od = minusDni(doDnia, 34);
        try {
          if (p.typ === 'google_ads') {
            zapiszStan(db, { polaczenieId: p.id, ostatniaProbaAt: pobranoAt, kodBledu: 'BRAK_ADAPTERA' });
            continue;
          }
          const klient = await klientDlaPolaczenia(p);
          if (!klient?.raportReklam) throw new Error('Brak klienta reklam');
          const raport = p.typ === 'ga4'
            ? await klient.raportReklam({ wlasciwosc: p.kontoId, od, do: doDnia })
            : await klient.raportReklam({ konto: p.kontoId, od, do: doDnia });
          if (raport.waluta && p.waluta && raport.waluta !== p.waluta) {
            const e = new Error('Waluta źródła inna niż konfiguracja połączenia.');
            e.kod = 'NIEZGODNA_WALUTA';
            throw e;
          }
          db.exec('SAVEPOINT odswiezenie_reklamy');
          try {
          if (!p.waluta && /^[A-Z]{3}$/.test(String(raport.waluta ?? ''))) {
            db.prepare('UPDATE reklamy_polaczenia SET waluta = ? WHERE id = ?').run(raport.waluta, p.id);
          }
          if (!p.strefa && raport.strefa) {
            new Intl.DateTimeFormat('en', { timeZone: raport.strefa });
            db.prepare('UPDATE reklamy_polaczenia SET strefa = ? WHERE id = ?').run(raport.strefa, p.id);
          }
          if (p.typ === 'ga4') {
            zapiszDni(db, { typ: 'ga4', polaczenieId: p.id, wiersze: raport.dni, pobranoAt, od, do: doDnia });
            zapiszTransakcje(db, { polaczenieId: p.id, wiersze: raport.transakcje,
              pobranoAt, od, do: doDnia });
          } else {
            const nazwy = new Map((raport.kampanie ?? []).map((k) => [String(k.id), k.nazwa]));
            zapiszDni(db, { typ: 'meta', polaczenieId: p.id, pobranoAt, od, do: doDnia,
              wiersze: raport.dni.map((d) => ({ ...d, nazwa: nazwy.get(String(d.kampaniaId)) ?? null })) });
            zapiszMetaKampanie(db, { polaczenieId: p.id, pobranoAt,
              kampanie: raport.kampanie.map((k) => ({ ...k, waluta: raport.waluta })) });
          }
          zapiszStan(db, { polaczenieId: p.id, ostatniaProbaAt: pobranoAt,
            ostatniSukcesAt: pobranoAt, kodBledu: null });
          db.exec('RELEASE SAVEPOINT odswiezenie_reklamy');
          } catch (e) {
            db.exec('ROLLBACK TO SAVEPOINT odswiezenie_reklamy');
            db.exec('RELEASE SAVEPOINT odswiezenie_reklamy');
            throw e;
          }
          sukcesy += 1;
        } catch (e) {
          zapiszStan(db, { polaczenieId: p.id, ostatniaProbaAt: pobranoAt,
            kodBledu: e.kod ?? kodBledu(e) });
          bledy += 1;
        }
      }
      return { sukcesy, bledy };
    } finally {
      trwa = false;
    }
  }

  return { przebieg };
}
