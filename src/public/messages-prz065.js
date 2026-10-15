(() => {
  'use strict';
  const root=document.getElementById('oms-messages');
  if(!root)return;
  const rows=[...root.querySelectorAll('[data-message-thread]')];
  const search=root.querySelector('#m-search');
  let filter='all';
  root.querySelector('.m-filters').hidden=false;
  root.querySelector('.m-search').hidden=false;
  function applyFilter(){let count=0;for(const row of rows){row.hidden=!((filter==='all'||row.dataset.messageState===filter)&&row.dataset.messageSearch.includes(search.value.toLocaleLowerCase('pl')));if(!row.hidden)count++;}root.querySelector('#m-no-results').hidden=count>0||!rows.length;const selected=root.querySelector('[aria-current="true"]');root.querySelector('.m-detail').classList.toggle('m-filtered-out',!!selected?.hidden);}
  search.addEventListener('input',applyFilter);
  root.querySelectorAll('[data-message-filter]').forEach(button=>button.addEventListener('click',()=>{filter=button.dataset.messageFilter;if(matchMedia('(max-width:650px)').matches)root.querySelector('.m-layout').classList.remove('m-reading');root.querySelectorAll('[data-message-filter]').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));applyFilter();}));
  const form=root.querySelector('[data-message-compose]');
  if(!form)return;
  const field=form.querySelector('textarea');
  const status=form.querySelector('#m-draft-status');
  const filesInput=form.querySelector('#m-files');
  const attach=form.querySelector('[data-message-attach]');
  const fileList=form.querySelector('#m-attachments');
  let files=[];
  filesInput.hidden=true;form.querySelector('.m-attach-tools label').hidden=true;attach.hidden=false;
  attach.addEventListener('click',()=>filesInput.click());
  function fillList(target,removable){target.replaceChildren();files.forEach((file,index)=>{const row=document.createElement('li');const name=document.createElement('span');name.className='m-file-name';name.textContent=file.name;const size=document.createElement('span');size.className='m-file-size';size.textContent=new Intl.NumberFormat('pl-PL',{maximumFractionDigits:1}).format(file.size<1024?file.size:file.size/1024)+(file.size<1024?' B':' KB');row.append(name,size);if(removable){const remove=document.createElement('button');remove.type='button';remove.textContent='Usuń';remove.setAttribute('aria-label','Usuń załącznik '+file.name);remove.addEventListener('click',()=>{files.splice(index,1);syncFiles();status.textContent=files.length?'Wybrane pliki: '+files.length+'. Zostaną wysłane po potwierdzeniu i kliknięciu Wyślij.':'Usunięto załączniki. Treść odpowiedzi pozostała bez zmian.';(fileList.querySelectorAll('button')[Math.min(index,files.length-1)]||attach).focus();});row.append(remove);}target.append(row);});}
  function syncFiles(){const dt=new DataTransfer();files.forEach(f=>dt.items.add(f));filesInput.files=dt.files;fillList(fileList,true);}
  filesInput.addEventListener('change',()=>{const next=files.slice();for(const file of Array.from(filesInput.files)){if(!next.some(f=>f.name===file.name&&f.size===file.size&&f.lastModified===file.lastModified))next.push(file);}if(next.length>5||next.some(f=>f.size===0||f.size>5242880)||next.reduce((n,f)=>n+f.size,0)>20971520){status.textContent='Nie dodano plików. Limit OMS: 5 plików, 5 MiB na plik, 20 MiB łącznie. Puste pliki są niedozwolone.';}else{files=next;status.textContent='Wybrane pliki: '+files.length+'. Zostaną wysłane po potwierdzeniu i kliknięciu Wyślij.';}syncFiles();});
  form.action+='?receipt=1';
  window.addEventListener('pageshow',()=>{const button=form.querySelector('.m-send');button.disabled=false;button.textContent='Wyślij';});
  form.addEventListener('submit',()=>{try{sessionStorage.setItem(key+':pending',field.value);}catch{}const button=form.querySelector('.m-send');button.disabled=true;button.textContent='Wysyłanie…';});
  const key='oms-message-draft:'+form.dataset.draftKey;
  const revision=form.dataset.sentRevision;
  let storageAvailable=true;
  try{const raw=sessionStorage.getItem(key);const saved=raw?JSON.parse(raw):null;const pending=sessionStorage.getItem(key+':pending');const own=!!form.dataset.ownSent&&revision.split(',').includes(form.dataset.ownSent)&&pending===form.dataset.ownText&&saved?.text===pending;if(own){sessionStorage.removeItem(key);sessionStorage.removeItem(key+':pending');}else if(saved&&!field.value&&form.dataset.sendError!=='true'){field.value=saved.text;status.textContent=saved.revision===revision?'Przywrócono szkic z tej karty przeglądarki.':'W wątku pojawiła się nowa odpowiedź. Zachowano Twój niewysłany szkic — sprawdź rozmowę przed wysłaniem.';}}catch{storageAvailable=false;}
  form.querySelector('.m-compose-tools').hidden=false;
  const preview=root.querySelector('.m-preview-dialog');
  function controls(){form.querySelector('#m-count').textContent=field.value.length+'/'+field.maxLength;form.querySelectorAll('[data-message-preview],[data-message-save]').forEach(b=>b.disabled=!field.value.trim());}
  function save(announce=true){if(!storageAvailable){status.textContent='Przeglądarka blokuje zapis szkicu. Skopiuj treść przed opuszczeniem strony.';return;}try{sessionStorage.setItem(key,JSON.stringify({revision,text:field.value}));if(announce)status.textContent='Szkic tekstowy zapisany w tej karcie. Pliki wybierz ponownie po opuszczeniu strony. Nic nie wysłano.';}catch{storageAvailable=false;status.textContent='Nie zapisano szkicu. Skopiuj treść przed opuszczeniem strony.';}}
  field.addEventListener('input',()=>{controls();save(false);});
  form.querySelector('[data-message-save]').addEventListener('click',()=>save());
  form.querySelector('[data-message-preview]').addEventListener('click',()=>{preview.querySelector('.m-preview-text').textContent=field.value;fillList(preview.querySelector('.m-preview-files'),false);preview.showModal();});
  preview.querySelector('[data-message-close]').addEventListener('click',()=>preview.close());
  controls();
})();
