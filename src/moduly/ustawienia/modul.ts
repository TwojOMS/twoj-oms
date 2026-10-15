import type { ModulOms } from '../../core/kontrakty.ts';
import { registerLogowanieRoutes } from './trasy/logowanie.js';
import { nazwaCiasteczkaOms } from '../../core/bezpieczenstwo/sesja.js';
import { registerKontaRoutes } from './trasy/konta.js';
import { registerUstawieniaWysylkiRoutes } from './trasy/wysylka.js';
import {registerUstawieniaRoutes} from '../marketing/trasy/integracje.js';
import { createWidokIntegracji } from './integracje.js';
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
import { mailerOpcjonalny } from './poczta-kont.js';
import { registerHasloLinkRoutes } from './trasy/haslo-link.js';

/** Zachowane ustawienia, konta, logowanie i wspólna rama panelu. */
export const modulUstawienia: ModulOms<{ adresPanelu: string | null }> = {
  nazwa:'ustawienia',wersja:'1.0.0',wymaga:['rdzen','web','kanaly','marketing'],
  konfiguracja:(env)=>({ adresPanelu: adresPaneluZEnv(env.OMS_ADRES_PANELU) }),migracje:[migracjaRol,migracjaEmailILinkow],
  uprawnienia:[{klucz:'ustawienia',etykieta:'Ustawienia',role:['administrator']}],
  menu:[{dzial:'ustawienia',etykieta:'Ustawienia',adres:'/ustawienia',uprawnienie:'ustawienia',kolejnosc:100}],
  zbuduj:ctx=>{
    const wynikRol = synchronizujRole(ctx.db, { teraz: ctx.teraz }); // PRZ-068: synchronicznie, przed pierwszym zapytaniem (patrz plan §0.5)
    const opisRol = opisSynchronizacjiRol(wynikRol); // loginy i klucze ról, bez danych wrażliwych (recenzja D8 r1)
    if (opisRol) ctx.log(opisRol);
    const widokIntegracji=createWidokIntegracji({
      db:ctx.db,reklamy:ctx.usluga('marketing','reklamy'),
      stanyKanalow:()=>ctx.usluga<()=>any[]>('kanaly','stanyKanalow')(),
      wiazanieKanalow:ctx.usluga('kanaly','wiazanieKanalow'),
    });
    const lacznosc = { sprawdz: () => import('../../oms/services/lacznosc.js').then(async ({ sprawdzLacznosc }) => {
      return sprawdzLacznosc({ cele: celeDiagnostyki(ctx.usluga) as any });
    }) };
    // PRZ-080: piaskownica i produkcja na jednym gospodarzu — nazwa ciasteczka z trybu modułu web.
    const nazwaCiasteczka = nazwaCiasteczkaOms(ctx.usluga<{proba?:boolean}>('web','config')?.proba);
    return {uslugi:{widokIntegracji,lacznosc},trasy:app=>{
    zarejestrujMenuKontaRol(app,{db:ctx.db});
    registerLogowanieRoutes(app,{db:ctx.db,config:ctx.usluga('web','config')});
    registerKontaRoutes(app,{db:ctx.db,teraz:ctx.teraz,adresPanelu:ctx.konfiguracja.adresPanelu,mailer:mailerOpcjonalny(ctx.usluga),
      loginSerwisowy:ctx.usluga<{auth?:{user?:string}}>('web','config')?.auth?.user??null,nazwaCiasteczka});
    registerRoleRoutes(app,{db:ctx.db,teraz:ctx.teraz});
    registerMojeKontoRoutes(app,{db:ctx.db,teraz:ctx.teraz,
      loginDemo:ctx.usluga<{demo?:{login:string}|null}>('web','config')?.demo?.login??null,nazwaCiasteczka});
    registerHasloLinkRoutes(app,{db:ctx.db,teraz:ctx.teraz});
    registerUstawieniaWysylkiRoutes(app,{db:ctx.db});
    registerUstawieniaFormulkiRoutes(app,{db:ctx.db});
    registerDiagnostykaRoutes(app,{db:ctx.db,config:ctx.usluga('kanaly','config'),lacznosc:ctx.usluga('ustawienia','lacznosc')});
    registerPanelRoutes(app);
    app.get('/ustawienia/integracje',(req,reply)=>widokIntegracji(req,reply));
    app.get('/ustawienia/integracje/reklamy',(req,reply)=>widokIntegracji(req,reply,{tylkoReklamy:true}));
    registerUstawieniaRoutes(app,{db:ctx.db,reklamy:ctx.usluga('marketing','reklamy')});
  }};},
};
