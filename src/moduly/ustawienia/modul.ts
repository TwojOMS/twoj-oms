import type { ModulOms } from '../../core/kontrakty.ts';
import { registerLogowanieRoutes } from './trasy/logowanie.js';
import { nazwaCiasteczkaOms } from '../../core/bezpieczenstwo/sesja.js';
import { registerKontaRoutes } from './trasy/konta.js';
import { registerUstawieniaWysylkiRoutes } from './trasy/wysylka.js';
import { registerUstawieniaMagazynuRoutes } from './trasy/magazyn.js';
import { registerUstawieniaModulowRoutes } from './trasy/moduly.js';
import { registerPowiadomieniaRoutes } from './trasy/powiadomienia.js';
import { registerUstawieniaStatusowRoutes } from './trasy/statusy.js';
import {registerUstawieniaRoutes} from '../marketing/trasy/integracje.js';
import { createWidokIntegracji } from './integracje.js';
import { stanIntegracji } from './services/polaczenia-integracji.ts';
import { registerUstawieniaFormulkiRoutes } from '../wiadomosci/trasy/ustawienia.js';
import { registerDiagnostykaRoutes } from './trasy/diagnostyka.js';
import { registerPanelRoutes } from './trasy/panel.js';
import { celeDiagnostyki } from './cele-diagnostyki.ts';
import { migracjaRol } from './migracje/0001-role.ts';
import { migracjaEmailILinkow } from './migracje/0002-email-linki.ts';
import { adresPaneluZEnv } from './adres-panelu.ts';
import { synchronizujRole, opisSynchronizacjiRol } from './role.js';
import { registerRoleRoutes } from './trasy/role.js';
import { zarejestrujMenuKontaRol } from './menu-konta-rol.js';
import { registerMojeKontoRoutes } from './trasy/moje-konto.js';
import { mailerOpcjonalny, pocztaOpcjonalna, podpisOpcjonalny } from './poczta-kont.js';
import { registerHasloLinkRoutes } from './trasy/haslo-link.js';
import { registerUstawieniaPocztyRoutes } from './trasy/poczta.js';
import { adresPaneluZZapisu } from './adres-panelu.ts';
import { wczytajKonfiguracjeIntegracji } from '../../oms/db/konfiguracja-integracji.js';
import { registerUstawieniaAktualizacjiRoutes } from './trasy/aktualizacje.js';
import { registerUstawieniaWkrotceRoutes } from './trasy/wkrotce.js';
import { odczytajWydanie, sprawdzNajnowsze } from './aktualizacje.ts';
import { transport } from '../../integracje/transport.js';
import { registerLogoRoutes } from './trasy/logo.js';
import { registerKopieRoutes } from './trasy/kopie.js';
import { MODULY_KURIEROW, type KluczKuriera } from '../../domena/moduly-kurierow.ts';

/** PRZ-135 D6: kurierzy z własnym konfiguratorem (umowa własna, z metodami nadania), w kolejności rejestru. */
const kurierzyWlasni = () => Object.values(MODULY_KURIEROW).filter((opis) => opis.umowa === 'wlasna' && opis.metody.length > 0);

/** Usługa modułu wysyłki z kurierem z Ustawień i klucz w konfiguracja_integracji — rejestr nie ma na to pól
 *  (właściciel rejestru: 04a), więc mapa zostaje tu, po kluczach rejestru. */
const KONFIGURACJA_KURIEROW: Partial<Record<KluczKuriera, { usluga: string; integracja: string }>> = {
  dpd: { usluga: 'kurierDpd', integracja: 'dpd' },
  inpost: { usluga: 'kurierInpost', integracja: 'inpost' },
};

/** Zachowane ustawienia, konta, logowanie i wspólna rama panelu. */
export const modulUstawienia: ModulOms<{ adresPanelu: string | null }> = {
  nazwa:'ustawienia',wersja:'1.0.0',wymaga:['rdzen','web','kanaly','marketing'],
  konfiguracja:(env)=>({ adresPanelu: adresPaneluZEnv(env.OMS_ADRES_PANELU) }),migracje:[migracjaRol,migracjaEmailILinkow],
  uprawnienia:[{klucz:'ustawienia',etykieta:'Ustawienia',role:['administrator']}],
  menu:[{dzial:'ustawienia',etykieta:'Ustawienia',adres:'/ustawienia',uprawnienie:'ustawienia',kolejnosc:100}],
  zbuduj:ctx=>{
    const opcjonalna=(modul:string,nazwa:string):any=>{
      try{return ctx.usluga(modul,nazwa);}catch(e){
        if(e instanceof Error && e.message.startsWith('Usługa „'))return null;
        throw e;
      }
    };
    const wynikRol = synchronizujRole(ctx.db, { teraz: ctx.teraz }); // PRZ-068: synchronicznie, przed pierwszym zapytaniem (patrz plan §0.5)
    const opisRol = opisSynchronizacjiRol(wynikRol); // loginy i klucze ról, bez danych wrażliwych (recenzja D8 r1)
    if (opisRol) ctx.log(opisRol);
    const widokIntegracji=createWidokIntegracji({
      db:ctx.db,reklamy:ctx.usluga('marketing','reklamy'),
      zgodaTf: () => { try { return ctx.usluga<{ zgoda?: boolean }>('faktury', 'wyborProgramu')?.zgoda === true; } catch { return false; } },
      programFakturowy: () => { try { return ctx.usluga<any>('faktury', 'programFakturowy'); } catch { return null; } },
      stanyKanalow:()=>ctx.usluga<()=>any[]>('kanaly','stanyKanalow')(),
      wiazanieKanalow:ctx.usluga('kanaly','wiazanieKanalow'),
      kanaly:()=>ctx.usluga('kanaly','config'), proba:ctx.usluga<{proba?:boolean}>('web','config')?.proba===true,
      polaczeniaAllegro:()=>{
        const config=ctx.usluga<any>('kanaly','config');
        return (opcjonalna('kanaly','repozytoriumKanalow')?.lista()??[]).filter((p:any)=>!config.kanaly[p.klucz]?.atrapa);
      },
      sklepyWoo:()=>opcjonalna('kanaly','repozytoriumKanalow')?.listaTypu('woo')??[],
      integracje:()=>{
        const zapisane = new Set(ctx.db.prepare('SELECT integracja FROM konfiguracja_integracji').all().map((r:any)=>r.integracja));
        const kurierzy = kurierzyWlasni().flatMap((o)=>{ const k=KONFIGURACJA_KURIEROW[o.klucz]; return k?[{id:o.idKatalogu,...k}]:[]; });
        const klucze:Record<string,string>={...Object.fromEntries(kurierzy.map((k)=>[k.id,k.integracja])),infakt:'infakt',ksef:'ksef',gus:'gus',smtp:'poczta'};
        const uslugi:Record<string,any>={...Object.fromEntries(kurierzy.map((k)=>[k.id,opcjonalna('wysylka',k.usluga)])),
          infakt:opcjonalna('faktury','konfiguracjaInfaktu'),ksef:opcjonalna('koszty','zrodloKsef'),gus:opcjonalna('zamowienia','konfiguracjaGus'),smtp:pocztaOpcjonalna(ctx.usluga)()};
        // B1: atrapa nie podłącza — ten sam warunek co ekran usługi (zapis albo plik konfiguracji).
        return Object.entries(klucze).map(([id,klucz])=>({id,...stanIntegracji({usluga:uslugi[id],zapisany:zapisane.has(klucz)})}));
      },
    });
    const lacznosc = { sprawdz: () => import('../../oms/services/lacznosc.js').then(async ({ sprawdzLacznosc }) => {
      return sprawdzLacznosc({ cele: celeDiagnostyki(ctx.usluga) as any });
    }) };
    // PRZ-080: piaskownica i produkcja na jednym gospodarzu — nazwa ciasteczka z trybu modułu web.
    const nazwaCiasteczka = nazwaCiasteczkaOms(ctx.usluga<{proba?:boolean}>('web','config')?.proba);
    // PRZ-094.04: adres panelu do linków w mailach — OMS_ADRES_PANELU wygrywa; bez niego zapis z Ustawień → Integracje →
    // Poczta wychodząca, czytany przy każdym mailu (zmiana bez restartu).
    const adresPanelu = () => ctx.konfiguracja.adresPanelu ?? adresPaneluZZapisu(wczytajKonfiguracjeIntegracji(ctx.db, 'adres_panelu'));
    const mailer = mailerOpcjonalny(ctx.usluga);
    // PRZ-099: /app/wydanie.json (tylko obraz z paczki klienta) + GitHub Releases na kliknięcie; limit 10 s, bez ponowień.
    const aktualizacje = {
      wydanie: () => odczytajWydanie(new URL('../../../wydanie.json', import.meta.url)),
      sprawdz: () => sprawdzNajnowsze({ http: transport({ limitCzasuMs: 10_000 }) }),
    };
    return {uslugi:{widokIntegracji,lacznosc,aktualizacje},trasy:app=>{
    zarejestrujMenuKontaRol(app,{db:ctx.db});
    registerLogoRoutes(app,{db:ctx.db});
    registerKopieRoutes(app,{konfiguracja:()=>opcjonalna('zdrowie','konfiguracjaKopii')?.()??{},teraz:ctx.teraz,
      nadzor:()=>ctx.usluga<()=>any>('zdrowie','kopie')()});
    registerLogowanieRoutes(app,{db:ctx.db,config:ctx.usluga('web','config')});
    registerUstawieniaPocztyRoutes(app,{db:ctx.db,adresPaneluZEnv:ctx.konfiguracja.adresPanelu,poczta:pocztaOpcjonalna(ctx.usluga),mailer,podpis:podpisOpcjonalny(ctx.usluga),log:ctx.log});
    registerKontaRoutes(app,{db:ctx.db,teraz:ctx.teraz,adresPanelu,mailer,
      loginSerwisowy:ctx.usluga<{auth?:{user?:string}}>('web','config')?.auth?.user??null,nazwaCiasteczka});
    registerRoleRoutes(app,{db:ctx.db,teraz:ctx.teraz});
    registerMojeKontoRoutes(app,{db:ctx.db,teraz:ctx.teraz,
      loginDemo:ctx.usluga<{demo?:{login:string}|null}>('web','config')?.demo?.login??null,nazwaCiasteczka});
    registerHasloLinkRoutes(app,{db:ctx.db,teraz:ctx.teraz});
    registerUstawieniaWysylkiRoutes(app,{db:ctx.db});
    registerUstawieniaMagazynuRoutes(app,{db:ctx.db});
    registerUstawieniaModulowRoutes(app,{db:ctx.db});
    registerPowiadomieniaRoutes(app,{db:ctx.db,loginDemo:ctx.usluga<{demo?:{login:string}|null}>('web','config')?.demo?.login??null});
    registerUstawieniaStatusowRoutes(app,{db:ctx.db});
    registerUstawieniaFormulkiRoutes(app,{db:ctx.db});
    registerDiagnostykaRoutes(app,{db:ctx.db,config:ctx.usluga('kanaly','config'),lacznosc:ctx.usluga('ustawienia','lacznosc')});
    registerPanelRoutes(app);
    registerUstawieniaAktualizacjiRoutes(app,{aktualizacje:ctx.usluga('ustawienia','aktualizacje')});
    registerUstawieniaWkrotceRoutes(app,{kopie:()=>ctx.usluga<()=>any>('zdrowie','kopie')(),drukFaktur:()=>ctx.usluga<()=>any>('faktury','stanDrukuFaktur')?.()});
    app.get('/ustawienia/integracje',(req,reply)=>widokIntegracji(req,reply));
    app.get('/ustawienia/integracje/katalog',(req,reply)=>widokIntegracji(req,reply));
    app.get('/ustawienia/integracje/reklamy',(req,reply)=>widokIntegracji(req,reply,{tylkoReklamy:true}));
    registerUstawieniaRoutes(app,{db:ctx.db,reklamy:ctx.usluga('marketing','reklamy')});
  }};},
};
