/* Season ledger and GrimDeck-only identity. All player text is rendered as text. */
const SeasonUI=(()=>{
 const number=new Intl.NumberFormat('ru-RU');
 const day=new Intl.DateTimeFormat('ru-RU',{day:'numeric',month:'long',year:'numeric',timeZone:'Europe/Moscow'});
 const month=new Intl.DateTimeFormat('ru-RU',{month:'long',year:'numeric',timeZone:'Europe/Moscow'});
 const time=new Intl.DateTimeFormat('ru-RU',{hour:'2-digit',minute:'2-digit',hourCycle:'h23',timeZone:'Europe/Moscow'});
 const sigils={wolf:['✦','Ведьмак'],raven:['♜','Ворон'],moon:['☾','Луна'],swords:['⚔','Клинки']};
 const frameNames={ember:'Искры Пограничья',ivy:'Терновый венец',frost:'Северное сияние',blood:'Кровь древних'};
 let request=0, controller, editing='', loaded, topData, confirmedIdentity;
 const profileId=()=>location.hash.match(/^#profile\/([0-9a-f]{24})$/)?.[1]||'me';
 function portrait(avatar,frame){
  const box=node('span',undefined,'season-portrait');box.dataset.frame=frame;
  box.setAttribute('aria-hidden','true');
  const face=node('span',sigils[avatar]?.[0]||'✦','season-face');box.append(face);
  const remote=typeof avatar==='string'&&/^https:\/\/(?:t\.me\/i\/userpic\/|(?:(?:cdn[0-9]*\.)?telegram-cdn\.org)\/)/.test(avatar);
  if(remote||avatar==='wolf'||/^WIT_[CRELM][0-9]{2}$/.test(avatar)){
   const img=new Image();img.alt='';img.loading='lazy';img.decoding='async';img.referrerPolicy='no-referrer';
   const loadMedallion=()=>{img.className='avatar-medallion';img.onerror=()=>img.remove();img.src='/art/witcher-icon.png';};
   img.onerror=remote?loadMedallion:()=>img.remove();
   if(avatar==='wolf')loadMedallion();else img.src=remote?avatar:`/art/${avatar}.webp`;
   face.append(img);
  }
  return box;
 }
 function button(text,click){const b=node('button',text);b.type='button';b.addEventListener('click',click);return b;}
 function top(data){
  topData=data;
  const ends=data.endsAt*1000,[spin,task,contract]=data.rules;
  const label=month.format(ends-1);
  $('topMonth').textContent=label[0].toUpperCase()+label.slice(1);
  $('topDeadline').dateTime=new Date(ends).toISOString();
  $('topEndDate').textContent=day.format(ends);$('topEndTime').textContent=`${time.format(ends)} МСК`;
  $('topSeason').hidden=false;
  $('topStatus').textContent=data.rows.length?`Влияние: +${spin} за крутку, +${task} за задание, +${contract} за заказ.`:'В этом сезоне пока нет игроков.';
  $('topRows').replaceChildren(...data.rows.map(p=>{
   const li=node('li'), link=node('a',undefined,'season-row');link.href=`#profile/${p.id}`;
   const place=node('span',`#${p.rank}`,'season-place');
   if(p.rank<=3)place.dataset.podium=String(p.rank);
   const label=node('span',undefined,'season-identity');
   label.append(node('b',p.name),node('small',p.universe+(p.id===data.me?' · Ты':'')));
   const score=node('strong',undefined,'season-score');
   score.append($('profile').querySelector('.influence-icon').cloneNode(true),node('span',number.format(p.influence)));
   score.setAttribute('aria-label',`Влияние: ${p.influence}`);
   link.append(place,portrait(p.avatar,p.frame),label,score);li.append(link);return li;
  }));
 }
 function statsRow(label,value){const row=node('div');row.append(node('dt',label),node('dd',value));return row;}
 function setEditing(mode){editing=mode;renderEditor();$('profileEditor').querySelector('input, button')?.focus();}
 function renderEditor(){
  const p=loaded, area=$('profileEditor');area.hidden=!p?.mine||!editing;
  if(area.hidden){area.replaceChildren();return;}
  const act=(field,value)=>{if(!busy&&!pending)void transact('edit-profile',0,1,{[field]:value});};
  if(editing==='portrait'){
   area.replaceChildren(node('h2','Оформление профиля'),button('Сменить аватарку',()=>setEditing('avatar')),button('Сменить рамку',()=>setEditing('frame')));
  }else if(editing==='name'){
   const form=node('form'),label=node('label','Новое имя '),input=node('input');
   input.required=true;input.minLength=2;input.maxLength=24;input.value=p.name;input.autocomplete='off';label.append(input);
   const save=node('button','Сохранить имя');save.type='submit';save.dataset.profileSave='';
   form.append(label,save);form.onsubmit=e=>{e.preventDefault();act('name',input.value);};area.replaceChildren(form);
  }else{
   const grid=node('div',undefined,'cosmetic-grid');
   const avatarOptions=()=>[...(p.telegramAvatar?[['telegram','Из Telegram']]:[]),...p.avatars.map(id=>[id,sigils[id]?.[1]||cards.get(id)?.[1]||id])];
   const options=editing==='avatar'?avatarOptions():p.frames;
   const owned=new Set([...p.frames.slice(0,3).map(f=>f[0]),...p.achievements]);
   for(const [id,name,note] of options){
    const isFrame=editing==='frame', avatar=id==='telegram'?p.telegramAvatar:id;
    const mode=editing;
    const tile=button(undefined,()=>act(mode,id));tile.className='cosmetic-tile';tile.dataset.choice=id;
    tile.append(portrait(isFrame?p.avatar:avatar,isFrame?id:p.frame),node('b',name));
    if(note)tile.append(node('small',note));
    if(!isFrame||owned.has(id))tile.dataset.profileSave='';else tile.disabled=true;
    grid.append(tile);
   }
   area.replaceChildren(node('h2',editing==='avatar'?'Аватарки':'Рамки'),grid);
  }
  area.append(button('Закрыть',()=>{setEditing('');$('profilePortrait').querySelector('button')?.focus();}));
  block(busy||!!pending);
 }
 function profile(p){
  loaded=p;
  const art=portrait(p.avatar,p.frame);
  if(p.mine){
   const b=button(undefined,()=>setEditing(editing==='portrait'?'':'portrait'));b.className='portrait-button';
   b.setAttribute('aria-label','Изменить аватарку или рамку');b.append(art);$('profilePortrait').replaceChildren(b);
  }else $('profilePortrait').replaceChildren(art);
  $('profileRank').textContent=`МЕСТО В ТОПЕ · #${p.rank}`;
  $('profileTitle').replaceChildren(node('span',p.name));
  if(p.mine){const b=button('Изменить имя',()=>setEditing('name'));b.className='rename-button';$('profileTitle').append(b);}
  $('profileUniverse').textContent=p.universe;
  $('profileInfluence').textContent=number.format(p.influence);
  const rows=[statsRow(`Коллекция · ${p.universe}`,`${p.cards} из ${p.totalCards}`),statsRow('Победы на арене',number.format(p.arenaWins)),statsRow('Выполненные заказы',number.format(p.contracts))];
  if(p.mine)rows.push(statsRow('Премиум',p.premiumUntil?`Активен до ${day.format(p.premiumUntil*1000)}`:'Неактивен'));
  $('profileStats').replaceChildren(...rows);
  $('profileMedals').replaceChildren(...(p.achievements.length?p.achievements.map(key=>node('li',frameNames[key]||key)):[node('li','Пока нет открытых рамок за достижения')]));
  renderEditor();$('profileContent').hidden=false;
 }
 async function open(pane){
  controller?.abort();const version=++request;
  editing='';loaded=null;topData=null;
  if(!['tool-rank','profile'].includes(pane))return;
  controller=new AbortController();
  const isTop=pane==='tool-rank',status=$(isTop?'topStatus':'profileStatus');
  status.textContent='Загрузка…';
  if(isTop){$('topRows').replaceChildren();$('topSeason').hidden=true;}
  else $('profileContent').hidden=true;
  const hash=location.hash, previousIdentity=confirmedIdentity;
  if(!isTop){const back=$('profileBack');back.href=profileId()==='me'&&history.state?.profileFrom!=='tool-rank'?'#home':'#tool-rank';back.querySelector('span').textContent=back.hash==='#home'?'Колода':'Топ';}
  try{
   const data=await api(isTop?'top':`profile/${profileId()}`,undefined,controller.signal);
   if(request!==version||hash!==location.hash)return;
   status.textContent='';
   if(isTop){
    if(previousIdentity!==confirmedIdentity)Object.assign(data.rows.find(p=>p.id===data.me)||{},confirmedIdentity);
    top(data);
   }else{
    if(data.mine&&previousIdentity!==confirmedIdentity)Object.assign(data,confirmedIdentity);
    profile(data);
   }
  }catch(e){
   if(request!==version||hash!==location.hash)return;
   status.replaceChildren(node('span',e.message+' '),button('Повторить',()=>open(pane)));
  }
 }
 function saved(identity){
  confirmedIdentity=identity;
  if(topData&&targetPane()==='tool-rank'){
   const p=topData.rows.find(p=>p.id===topData.me);
   if(p){Object.assign(p,identity);top(topData);}
  }
  if(!loaded?.mine||targetPane()!=='profile'||![loaded.id,'me'].includes(profileId()))return;
  const changedAvatar=loaded.avatar!==identity.avatar;
  Object.assign(loaded,identity);
  $('profileTitle').querySelector('span').textContent=loaded.name;
  const art=$('profilePortrait').querySelector('.season-portrait');
  if(changedAvatar)art.replaceWith(portrait(loaded.avatar,loaded.frame));else art.dataset.frame=loaded.frame;
  if(editing==='name')$('profileEditor').querySelector('input').value=loaded.name;
  if(changedAvatar&&editing==='frame')renderEditor();
  else if(editing==='avatar')for(const tile of $('profileEditor').querySelectorAll('[data-choice]'))tile.querySelector('.season-portrait').dataset.frame=loaded.frame;
 }
 function block(blocked){
  const area=$('profileEditor');
  const avatarChoice=loaded?.telegramAvatar&&loaded.avatar===loaded.telegramAvatar?'telegram':loaded?.avatar;
  const selected=editing==='frame'?loaded?.frame:avatarChoice;
  for(const tile of area.querySelectorAll('[data-choice]'))tile.setAttribute('aria-pressed',String(tile.dataset.choice===selected));
  for(const b of area.querySelectorAll('[data-profile-save]'))b.disabled=blocked||(b.dataset.choice!==undefined&&b.dataset.choice===selected);
 }
 return {open,block,profileId,saved};
})();
