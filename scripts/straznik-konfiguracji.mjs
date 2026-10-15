import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import ts from 'typescript';

// Git checkout line endings differ between Windows and container builds.
export const hash = text => createHash('sha256').update(String(text).replaceAll('\r\n','\n')).digest('hex');
const unwrap = n => { while(n && (ts.isParenthesizedExpression(n)||ts.isAsExpression(n)||ts.isNonNullExpression(n)||ts.isTypeAssertionExpression(n))) n=n.expression; return n; };
const prop = n => ts.isIdentifier(n)||ts.isStringLiteralLike(n) ? n.text : undefined;
export function expandChannelNames(definitions, manifest) {
  const result=new Set();
  for(const {typ,prefiks} of definitions) {
    if(!['woo','allegro'].includes(typ)||!/^[A-Z][A-Z0-9_]*$/.test(prefiks)) throw Error('Niepoprawny typ/prefiks kanału');
    for(const suffix of manifest.prefiksy[typ]) result.add(`${prefiks}_${suffix}`);
  }
  return result;
}
/** Pure static scan: no product execution, process values or env files. Dynamic
 * readers/escapes require a reviewed closed map plus exact source fingerprint.
 * A changed helper is rejected until its call sites and suffixes are reviewed. */
export function scanSources(sources, manifest) {
  for(const typ of ['woo','allegro']) {
    const expected=manifest.zmienne.filter(v=>v.dynamiczna&&v.typyKanalow.includes(typ)).map(v=>v.nazwa.slice(4)).sort();
    if(JSON.stringify([...manifest.prefiksy[typ]].sort())!==JSON.stringify(expected))throw Error('Niespójna zamknięta rodzina '+typ);
  }
  const allNames=new Set(manifest.zmienne.map(v=>v.nazwa));
  for(const file of manifest.straznik?.plikiDynamiczne??[])for(const read of file.odczyty)
    if(!read.names.length||read.names.some(n=>!allNames.has(n)))throw Error('Niemapowane nazwy dynamicznego czytnika');
  const options={allowJs:true,noResolve:false,noLib:true,target:ts.ScriptTarget.Latest};
  const virtual=new Map([...sources].map(([f,text])=>['/'+f,text]));
  const host=ts.createCompilerHost(options);
  host.getCurrentDirectory=()=>'/';
  host.getSourceFile=(f,t)=>virtual.has(f)?ts.createSourceFile(f,virtual.get(f),t,true):undefined;
  host.fileExists=f=>virtual.has(f); host.readFile=f=>virtual.get(f);
  host.resolveModuleNames=(names,containing)=>names.map(name=>{
    if(!name.startsWith('.'))return undefined;
    const base=path.posix.normalize(path.posix.join(path.posix.dirname(containing),name));
    const resolved=[base,base+'.ts',base+'.js',base+'/index.ts',base+'/index.js'].find(f=>virtual.has(f));
    return resolved?{resolvedFileName:resolved}:undefined;
  });
  const program=ts.createProgram([...virtual.keys()],options,host), checker=program.getTypeChecker();
  const aliases=new Map(), tainted=new Set(), taintedPatterns=new Set(), functions=new Map(), errors=[], reads=[], forwards=[];
  const alias=(name,value)=>{const s=checker.getSymbolAtLocation(name);if(s)aliases.set(s,[...(aliases.get(s)??[]),value]);};
  const symbol=n=>{const s=checker.getSymbolAtLocation(n);return s&&(s.flags&ts.SymbolFlags.Alias)?checker.getAliasedSymbol(s):s;};
  const target=(n,seen=new Set())=>{
    const s=symbol(n);if(!s||seen.has(s))return undefined;seen.add(s);
    if(functions.has(s))return functions.get(s);
    for(const a of aliases.get(s)??[]){const f=target(unwrap(a),new Set(seen));if(f)return f;}
    return undefined;
  };
  const walk=(n,fn)=>{fn(n);ts.forEachChild(n,c=>walk(c,fn));};
  const root=(n,seen=new Set())=>{
    n=unwrap(n); if(!n)return false;
    if(ts.isPropertyAccessExpression(n)&&n.name.text==='env')return true;
    if(ts.isElementAccessExpression(n)&&ts.isStringLiteralLike(n.argumentExpression)&&n.argumentExpression.text==='env')return true;
    if(ts.isIdentifier(n)) {const s=symbol(n); if(n.text==='env'||tainted.has(s))return true; if(s&&aliases.has(s)&&!seen.has(s)){seen.add(s);return aliases.get(s).some(a=>root(a,new Set(seen)));} }
    if(ts.isObjectLiteralExpression(n))return n.properties.some(p=>ts.isSpreadAssignment(p)&&root(p.expression,new Set(seen)));
    if(ts.isCallExpression(n)&&n.expression.getText().replaceAll(' ','')==='Object.assign')return n.arguments.some(a=>root(a,new Set(seen)));
    if(ts.isCallExpression(n)) {
      const fn=target(n.expression);
      if(fn&&!seen.has(fn)){seen.add(fn);let result=false;
        if(fn.body&&ts.isBlock(fn.body))walk(fn.body,c=>{if(ts.isReturnStatement(c)&&root(c.expression,new Set(seen)))result=true;});
        else result=root(fn.body,new Set(seen));
        return result;
      }
    }
    return false;
  };
  const files=program.getSourceFiles();
  for(const sf of files) walk(sf,n=>{
    if((ts.isVariableDeclaration(n)||ts.isParameter(n))&&ts.isIdentifier(n.name)&&n.initializer)alias(n.name,n.initializer);
    if(ts.isBinaryExpression(n)&&n.operatorToken.kind===ts.SyntaxKind.EqualsToken&&ts.isIdentifier(n.left))alias(n.left,n.right);
    if(ts.isFunctionDeclaration(n)&&n.name)functions.set(symbol(n.name),n);
    if(ts.isVariableDeclaration(n)&&ts.isIdentifier(n.name)&&n.initializer&&(ts.isArrowFunction(n.initializer)||ts.isFunctionExpression(n.initializer)))functions.set(symbol(n.name),n.initializer);
    if(ts.isBindingElement(n)&&prop(n.propertyName??n.name)==='env'&&ts.isIdentifier(n.name))tainted.add(symbol(n.name));
  });
  // Fixed point propagates env through destructuring rest and local function parameters.
  for(let changed=true;changed;) {changed=false;
    const mark=n=>{const s=symbol(n);if(s&&!tainted.has(s)){tainted.add(s);changed=true;}};
    const markBinding=n=>{
      if(ts.isIdentifier(n))mark(n);
      else if(ts.isObjectBindingPattern(n)) {
        if(!taintedPatterns.has(n)){taintedPatterns.add(n);changed=true;}
        for(const e of n.elements)if(e.dotDotDotToken&&ts.isIdentifier(e.name))mark(e.name);
      }
    };
    for(const sf of files)walk(sf,n=>{
      if(ts.isVariableDeclaration(n)&&ts.isObjectBindingPattern(n.name)&&root(n.initializer))for(const e of n.name.elements)if(e.dotDotDotToken&&ts.isIdentifier(e.name))mark(e.name);
      if(ts.isBinaryExpression(n)&&n.operatorToken.kind===ts.SyntaxKind.EqualsToken&&root(n.right)&&ts.isObjectLiteralExpression(unwrap(n.left)))
        for(const p of unwrap(n.left).properties)if(ts.isSpreadAssignment(p)&&ts.isIdentifier(p.expression))mark(p.expression);
      // ModulOms.konfiguracja is dispatched through m.konfiguracja(o.env),
      // so its parameter is env even when no concrete call exists in the AST.
      if(ts.isPropertyAssignment(n)&&prop(n.name)==='konfiguracja') {
        const fn=ts.isArrowFunction(n.initializer)||ts.isFunctionExpression(n.initializer)?n.initializer:target(n.initializer);
        if(fn?.parameters[0])markBinding(fn.parameters[0].name);
      }
      if(ts.isMethodDeclaration(n)&&prop(n.name)==='konfiguracja'&&n.parameters[0])markBinding(n.parameters[0].name);
      if(ts.isCallExpression(n)){const fn=target(n.expression);if(fn)n.arguments.forEach((a,i)=>{if(root(a)&&fn.parameters[i])markBinding(fn.parameters[i].name);});}
    });
  }
  const known=new Set(manifest.zmienne.filter(v=>!['tooling','declared_only'].includes(v.zakres)&&!v.dynamiczna).map(v=>v.nazwa));
  for(const sf of files) {
    const fileName=sf.fileName.slice(1), digest=hash(virtual.get(sf.fileName));
    const location=n=>({path:fileName,line:sf.getLineAndCharacterOfPosition(n.getStart(sf)).line+1,expression:n.getText(sf)});
    const fail=(n,reason)=>errors.push({...location(n),reason});
    const approved=manifest.straznik?.plikiDynamiczne?.find(p=>p.path===fileName&&p.sha256===digest);
    if(sf.parseDiagnostics.length)fail(sf,'Błąd parsera');
    walk(sf,n=>{
      if(ts.isPropertyAssignment(n)&&root(n.initializer)&&prop(n.name)!=='env')fail(n,'Env zapisane w nieprzeanalizowanym kontenerze');
      if(ts.isBinaryExpression(n)&&n.operatorToken.kind===ts.SyntaxKind.EqualsToken&&root(n.right)&&ts.isObjectLiteralExpression(unwrap(n.left)))
        for(const p of unwrap(n.left).properties){
          if(ts.isSpreadAssignment(p))continue;
          const key=prop(p.name);reads.push({...location(p),key:key??null});
          if(!key||!known.has(key))fail(p,'Nieznany czytnik destrukturyzowany w przypisaniu');
        }
      if((ts.isPropertyAccessExpression(n)||ts.isElementAccessExpression(n))&&root(n.expression)) {
        if(ts.isDeleteExpression(n.parent)||(ts.isBinaryExpression(n.parent)&&n.parent.left===n&&n.parent.operatorToken.kind===ts.SyntaxKind.EqualsToken))return;
        const key=ts.isPropertyAccessExpression(n)?n.name.text:ts.isStringLiteralLike(n.argumentExpression)?n.argumentExpression.text:undefined;
        reads.push({...location(n),key:key??null});
        if(key) {if(!known.has(key))fail(n,`Nieznany czytnik ${key}`);}
        else if(!approved||!approved.odczyty.some(r=>r.expression===n.getText(sf)))fail(n,'Dynamiczny czytnik bez aktualnego zamkniętego mapowania');
      }
      if((ts.isVariableDeclaration(n)||ts.isParameter(n))&&ts.isObjectBindingPattern(n.name)&&(root(n.initializer)||taintedPatterns.has(n.name)))for(const e of n.name.elements){
        if(e.dotDotDotToken)continue;
        const key=prop(e.propertyName??e.name); reads.push({...location(e),key:key??null});
        if(!key||!known.has(key))fail(e,'Nieznany czytnik destrukturyzowany');
      }
      if(ts.isCallExpression(n))for(const a of n.arguments)if(root(a)){
        forwards.push({...location(n),expression:a.getText(sf),callee:n.expression.getText(sf),call:n.getText(sf)});
        if(!target(n.expression)&&n.expression.getText().replaceAll(' ','')!=='Object.assign'){
          const entry=manifest.straznik?.przekazania?.find(p=>p.path===fileName&&p.sha256===digest&&p.expression===n.getText(sf));
          if(!entry)fail(n,'Przekazanie env do nieprzeanalizowanej funkcji');
        }
      }
    });
  }
  return {files:files.length,reads,forwards,errors};
}
const canonical=value=>JSON.stringify(value);
const sortBySignature=items=>[...items].sort((a,b)=>canonical(a).localeCompare(canonical(b)));
const same= (a,b) => canonical(sortBySignature(a))===canonical(sortBySignature(b));
const sameNames=(a,b)=>canonical([...a].sort())===canonical([...b].sort());
const walkAst=(node,fn)=>{fn(node);ts.forEachChild(node,child=>walkAst(child,fn));};
function dynamicznePowiazaniaHelperow(sources) {
  const result=[];
  for(const [path,text] of sources) {
    const source=ts.createSourceFile(path,text,ts.ScriptTarget.Latest,true);
    const calls=[]; walkAst(source,node=>{if(ts.isCallExpression(node))calls.push(node);});
    walkAst(source,node=>{
      if(!ts.isElementAccessExpression(node)||!ts.isIdentifier(node.expression)||node.expression.text!=='env'||!ts.isIdentifier(node.argumentExpression))return;
      let fn=node.parent;while(fn&&!ts.isFunctionDeclaration(fn)&&!ts.isArrowFunction(fn)&&!ts.isFunctionExpression(fn)&&!ts.isMethodDeclaration(fn))fn=fn.parent;
      const parameterIndex=fn?.parameters.findIndex(p=>ts.isIdentifier(p.name)&&p.name.text===node.argumentExpression.text)??-1; if(parameterIndex<0)return;
      const name=ts.isFunctionDeclaration(fn)&&fn.name?.text || ts.isVariableDeclaration(fn?.parent)&&ts.isIdentifier(fn.parent.name)&&fn.parent.name.text; if(!name)return;
      const names=new Set();
      for(const call of calls)if(call.expression.getText(source)===name) {
        const argument=call.arguments[parameterIndex];const match=argument?.getText(source).match(/^`\$\{p\}_([A-Z0-9_]+)`$/);if(match)names.add(`<P>_${match[1]}`);
      }
      if(names.size)result.push({path,line:source.getLineAndCharacterOfPosition(node.getStart(source)).line+1,expression:node.getText(source),names:[...names].sort()});
    });
  }
  return result;
}
function validateSecondaryMetadata(directory, manifest, scan, sources) {
  const errors=[];
  const sourceHashLists=[manifest.odciskiPlikowOdczytow,manifest.dodatkoweDowody];
  for(const list of sourceHashLists)for(const item of list??[]) {
    const full=path.join(directory,item.path);
    if(!fs.existsSync(full)||item.sha256!==hash(fs.readFileSync(full,'utf8'))) errors.push({reason:`META_HASH_NIEZGODNY:${item.path}`});
  }
  const primary=new Map();
  for(const file of manifest.straznik?.plikiDynamiczne??[])for(const read of file.odczyty??[]) {
    const key=`${file.path}\u0000${read.expression}`;
    primary.set(key,[...(primary.get(key)??[]),read.names]);
  }
  const actualDynamic=scan.reads.filter(read=>read.key===null).map(({path,line,expression})=>({path,line,expression}));
  const secondary=(manifest.mapowaniaDynamiczne??[]).map(({path,line,expression,names})=>({path,line,expression,names}));
  const secondaryLocations=secondary.map(({path,line,expression})=>({path,line,expression}));
  const primaryMismatch=secondary.some(read=>!(primary.get(`${read.path}\u0000${read.expression}`)??[]).some(names=>canonical(names)===canonical(read.names)));
  if(!same(secondaryLocations,actualDynamic)||primaryMismatch) errors.push({reason:'META_DYNAMIC_MAP_NIEZGODNA'});
  const bindings=dynamicznePowiazaniaHelperow(sources);
  const bindingMismatch=bindings.some(binding=>{
    const mapped=secondary.find(read=>read.path===binding.path&&read.line===binding.line&&read.expression===binding.expression);
    const primaryNames=primary.get(`${binding.path}\u0000${binding.expression}`)??[];
    return !mapped||!sameNames(mapped.names,binding.names)||!primaryNames.some(names=>sameNames(names,binding.names));
  });
  if(bindingMismatch) errors.push({reason:'META_DYNAMIC_POWIAZANIE_HELPERA_NIEZGODNE'});
  const actualForwards=scan.forwards.map(({path,line,expression,callee,call})=>({path,line,expression,callee,call}));
  const secondaryForwards=(manifest.przekazaniaEnv??[]).map(({path,line,expression,callee,call})=>({path,line,expression,callee,call}));
  if(!same(secondaryForwards,actualForwards)) errors.push({reason:'META_FORWARD_NIEZGODNY'});
  return errors;
}
export function scanRepository(repo, manifest) {
  const directory=repo instanceof URL?fileURLToPath(repo):repo, sources=new Map();
  const collect=dir=>{if(!fs.existsSync(dir))return;for(const e of fs.readdirSync(dir,{withFileTypes:true})) {
    const f=path.join(dir,e.name);if(e.isDirectory())collect(f);
    else if(/\.(?:[cm]?[jt]s|[jt]sx)$/.test(e.name)&&!/\.d\.[cm]?ts$/.test(e.name))sources.set(path.relative(directory,f).replaceAll('\\','/'),fs.readFileSync(f,'utf8'));
  }};
  collect(path.join(directory,'src'));
  const cli='scripts/oms-import-istniejacy-podjazd-dpd.mjs';if(fs.existsSync(path.join(directory,cli)))sources.set(cli,fs.readFileSync(path.join(directory,cli),'utf8'));
  const result=scanSources(sources,manifest);
  result.errors.push(...validateSecondaryMetadata(directory,manifest,result,sources));
  return result;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const repo=process.argv.find(a=>a.startsWith('--repo='))?.slice(7)??fileURLToPath(new URL('..',import.meta.url));
  const manifest=JSON.parse(fs.readFileSync(path.join(repo,'docs/konfiguracja.json'),'utf8'));
  const result=scanRepository(repo,manifest);console.log(JSON.stringify(result,null,2));process.exitCode=result.errors.length?1:0;
}
