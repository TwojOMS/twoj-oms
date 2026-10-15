import { transport } from '../../integracje/transport.js';
// Jedyne miejsce w OMS, ktore robi HTTP do Meta Graph API (Etap 1 kampanii, 2026-08-25).
//
// ⚠️ SAME ODCZYTY. Ten modul umie zapytac o statystyki reklam i NIC POZA TYM — nie zaklada
// kampanii, nie zmienia budzetow, nie publikuje. Panel ma mierzyc kampanie, nie prowadzic
// jej; wydawanie pieniedzy zostaje w Business Suite, u czlowieka.
//
// ⚠️ TOKEN NIE TRAFIA ANI DO LOGU, ANI DO KOMUNIKATU BLEDU (niezmiennik 4.10). Idzie
// w naglowku `Authorization`, a NIE w query stringu — adresy z parametrami laduja
// w logach posrednikow, a ten token jest bezterminowy (System User).

const WERSJA = 'v23.0';
const BAZA = 'https://graph.facebook.com';

// Pola, ktorych naprawde uzywamy na ekranie. Wiecej = wolniejsza odpowiedz i wieksza
// szansa, ze Meta odmowi calego zapytania z powodu jednego pola.
const POLA = 'spend,impressions,reach,clicks,inline_link_clicks';

const liczba = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * ⚠️ KWOTA ZOSTAJE NAPISEM (przewodnik 4.5) — i to jest cala reguła pieniędzy w tym module.
 * `spend` przychodzi z Mety jako napis w walucie konta; przepuszczenie go przez Number()
 * i z powrotem zamienia „88.19" w liczbę zmiennoprzecinkową, a arytmetyka groszy w domenie
 * ma dostać dokładnie to, co powiedziała Meta.
 */
const kwota = (v) => {
  const s = String(v ?? '0').trim();
  return /^-?\d+(\.\d+)?$/.test(s) ? s : '0';
};

export function createMetaClient({ token, konta = [], fetchImpl, http = transport({ fetchImpl }), wersja = WERSJA, baseUrl = BAZA }) {
  if (!token) throw new Error('Klient Meta bez tokenu — sekcja konfiguracji miała nie wstać.');

  const bezTokena = (wartosc) => String(wartosc ?? '')
    .split(token).join('[UKRYTO]')
    .split(encodeURIComponent(token)).join('[UKRYTO]');

  async function zapytanie(sciezka, parametry) {
    const url = new URL(`${baseUrl}/${wersja}/${sciezka}`);
    for (const [k, v] of Object.entries(parametry)) url.searchParams.set(k, v);
    let res;
    try {
      res = await http(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    } catch (e) {
      throw new Error(`Meta nieosiągalna: ${bezTokena(e?.message)}`);
    }
    let dane = null;
    try { dane = await res.json(); } catch { dane = null; }
    if (!res.ok) {
      // ⚠️ Komunikat Mety BEZ tokena i bez calego adresu — w `error.message` bywa echo
      // parametrow zapytania. Bierzemy sam powod i typ bledu.
      const powod = bezTokena(dane?.error?.message ?? `kod ${res.status}`);
      const blad = new Error(`Meta odmówiła (${bezTokena(dane?.error?.type ?? res.status)}): ${powod}`);
      blad.status = res.status;
      throw blad;
    }
    return dane;
  }

  async function strzalStrona(sciezka, parametry) {
    const dane = await zapytanie(sciezka, parametry);
    // 200 z cialem, ktore nie jest lista wynikow, wygladaloby jak „zero wydatkow" — czyli
    // dokladnie ten stan, ktory kampania interpretuje jako „reklama nie chodzi".
    if (!Array.isArray(dane?.data)) {
      throw new Error('Meta oddała odpowiedź bez listy „data"');
    }
    return dane;
  }

  async function strzal(sciezka, parametry) {
    return (await strzalStrona(sciezka, parametry)).data;
  }

  async function wszystkieStrony(sciezka, parametry) {
    const wynik = [];
    const kursory = new Set();
    let after;
    for (let nr = 0; nr < 50; nr += 1) {
      // Meta zwraca pełny URL w paging.next. Nigdy go nie wywołujemy: zawierać może token.
      // Z obcego adresu odczytujemy wyłącznie kursor i budujemy własne żądanie do Graph.
      const strona = await strzalStrona(sciezka, after ? { ...parametry, after } : parametry);
      wynik.push(...strona.data);
      if (!strona.paging?.next) return wynik;
      try { after = new URL(strona.paging.next).searchParams.get('after'); } catch { after = null; }
      if (!after || kursory.has(after)) throw new Error('Meta zwróciła nieprawidłowy kursor stronicowania');
      kursory.add(after);
    }
    throw new Error('Meta przekroczyła limit 50 stron odpowiedzi');
  }

  /**
   * Dzienne statystyki reklam w oknie `od..do` (dni WLACZNIE), zsumowane po wszystkich
   * skonfigurowanych kontach.
   *
   * `kampanie` (lista identyfikatorow) zawęża odczyt do wskazanych kampanii reklamowych;
   * pusta lista znaczy „cały wydatek konta" — patrz komentarz przy kolumnie
   * `kampanie.meta_kampanie` w schema.sql.
   *
   * ⚠️⚠️ ZASIEG (`reach`) TO LICZBA OSOB, NIE ZDARZEN — i dlatego NIE WOLNO go sumowac
   * ani po kontach, ani po dniach: ta sama osoba widziana dwa dni z rzedu policzylaby sie
   * dwa razy. Oddajemy go per dzien jako sume kont (przyblizenie, bo konta moga siegac
   * tych samych ludzi) i nigdzie nie sumujemy po oknie — ekran pokazuje wylacznie
   * wyswietlenia jako sume. Dwa konta tej firmy celuja w te sama grupe, wiec bledu nie
   * da sie usunac, tylko nazwac.
   */
  async function dzienneStatystyki({ od, do: doDnia, kampanie = [] }) {
    const wgDni = new Map();
    const wybrane = new Set(kampanie.map(String));

    for (const konto of konta) {
      const parametry = {
        fields: wybrane.size ? `campaign_id,${POLA}` : POLA,
        level: wybrane.size ? 'campaign' : 'account',
        time_increment: '1',
        time_range: JSON.stringify({ since: od, until: doDnia }),
        limit: '500',
      };
      // eslint-disable-next-line no-await-in-loop -- konta po kolei, jak poller po sklepach:
      // dwa rownolegle zapytania do tego samego API nie skracaja niczego, a utrudniaja
      // przypisanie bledu do konta.
      const wiersze = await strzal(`${konto}/insights`, parametry);
      for (const w of wiersze) {
        if (wybrane.size && !wybrane.has(String(w.campaign_id))) continue;
        const dzien = w.date_start;
        if (!dzien) continue;
        const dotad = wgDni.get(dzien) ?? {
          dzien, wydatekGr: 0, wyswietlenia: 0, zasieg: 0, klikniecia: 0, kliknieciaLinku: 0,
        };
        // ⚠️⚠️ SUMUJEMY W GROSZACH I ZAOKRAGLAMY RAZ, NA KONCU — nie po kazdym koncie.
        // Meta potrafi oddac kwote PONIZEJ GROSZA (mikrowydatek dnia na Instagramie:
        // „0.004"), a zaokraglenie kazdego skladnika osobno zamienia dwa takie konta
        // w 0,00 zl zamiast 0,01 zl. Zmierzone, nie oszacowane: 0.004 + 0.004 to 0,8 grosza,
        // czyli po zaokragleniu 1 grosz — a po dwoch osobnych zaokragleniach ZERO.
        // Blad zmiennoprzecinkowy przy kilkudziesieciu skladnikach jest rzedu 1e-10 grosza,
        // wiec jedno zaokraglenie na koncu jest i dokladniejsze, i bezpieczne.
        dotad.wydatekGr += Number(kwota(w.spend)) * 100;
        dotad.wyswietlenia += liczba(w.impressions);
        dotad.zasieg += liczba(w.reach);
        dotad.klikniecia += liczba(w.clicks);
        dotad.kliknieciaLinku += liczba(w.inline_link_clicks);
        wgDni.set(dzien, dotad);
      }
    }

    return [...wgDni.values()]
      .sort((a, b) => a.dzien.localeCompare(b.dzien))
      // JEDNO zaokraglenie do pelnych groszy — panel liczy pieniadze wylacznie w groszach
      // calkowitych (domain/kwoty.js), wiec kwota z ulamkiem grosza nie ma jak do niego wejsc.
      .map(({ wydatekGr, ...reszta }) => ({ ...reszta, wydatek: (Math.round(wydatekGr) / 100).toFixed(2) }));
  }

  async function raportReklam({ konto, od, do: doDnia }) {
    if (!konta.includes(konto)) throw new Error('Konto Meta nie jest skonfigurowane');
    const sciezka = encodeURIComponent(konto);
    const metadane = await zapytanie(sciezka, { fields: 'currency,timezone_name' });
    const [kampanieApi, zestawy, statystyki] = await Promise.all([
      wszystkieStrony(`${sciezka}/campaigns`, {
        fields: 'id,name,status,effective_status,daily_budget,lifetime_budget', limit: '500',
      }),
      wszystkieStrony(`${sciezka}/adsets`, {
        fields: 'id,campaign_id,daily_budget,lifetime_budget,start_time,end_time', limit: '500',
      }),
      wszystkieStrony(`${sciezka}/insights`, {
        fields: 'campaign_id,date_start,spend,impressions,clicks,inline_link_clicks',
        level: 'campaign', time_increment: '1',
        time_range: JSON.stringify({ since: od, until: doDnia }), limit: '500',
      }),
    ]);

    const dni = statystyki.filter((w) => w.campaign_id && w.date_start).map((w) => ({
      kontoId: konto, kampaniaId: String(w.campaign_id), dzien: w.date_start,
      wydatek: kwota(w.spend), wyswietlenia: liczba(w.impressions),
      klikniecia: liczba(w.clicks), kliknieciaLinku: liczba(w.inline_link_clicks),
    })).sort((a, b) => a.dzien.localeCompare(b.dzien) || a.kampaniaId.localeCompare(b.kampaniaId));

    const budzetyDla = (kampania, zestawyKampanii) => {
      const zrodlo = kampania.daily_budget || kampania.lifetime_budget ? [kampania] : zestawyKampanii;
      const poziom = zrodlo[0] === kampania ? 'kampania' : 'zestawy';
      const grupy = new Map();
      for (const w of zrodlo) {
        for (const [pole, typ] of [['daily_budget', 'dzienny'], ['lifetime_budget', 'calkowity']]) {
          if (!/^\d+$/.test(String(w[pole] ?? ''))) continue;
          const okresOd = typ === 'calkowity' ? w.start_time ?? null : null;
          const okresDo = typ === 'calkowity' ? w.end_time ?? null : null;
          const klucz = typ === 'dzienny' ? typ : `${typ}:${okresOd ?? w.id}:${okresDo ?? w.id}`;
          const dotad = grupy.get(klucz);
          grupy.set(klucz, { typ, okresOd, okresDo, suma: (dotad?.suma ?? 0n) + BigInt(w[pole]) });
        }
      }
      return [...grupy.values()].map(({ typ, okresOd, okresDo, suma }) => ({
        poziom, typ, ...(typ === 'calkowity' ? { okresOd, okresDo } : {}), kwotaMinor: String(suma),
      }));
    };
    const kampanie = kampanieApi.map((w) => ({
      kontoId: konto, id: String(w.id), nazwa: w.name ?? '', status: w.status ?? null,
      effectiveStatus: w.effective_status ?? null,
      emituje: dni.some((d) => d.kampaniaId === String(w.id) && (Number(d.wydatek) > 0 || d.wyswietlenia > 0)),
      budzety: budzetyDla(w, zestawy.filter((z) => String(z.campaign_id) === String(w.id))),
    }));
    return { dni, kampanie, waluta: metadane?.currency ?? null, strefa: metadane?.timezone_name ?? null };
  }

  return { dzienneStatystyki, raportReklam };
}
