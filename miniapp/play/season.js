/* Season ledger and GrimDeck-only identity. All player text is rendered as text. */
const SeasonUI=(()=>{
 const t=I18n.text;
 const universe=name=>name==='Ведьмак'?t(name,'The Witcher'):name;
 const number=new Intl.NumberFormat(I18n.locale);
 const day=new Intl.DateTimeFormat(I18n.locale,{day:'numeric',month:'long',year:'numeric',timeZone:'Europe/Moscow'});
 const month=new Intl.DateTimeFormat(I18n.locale,{month:'long',year:'numeric',timeZone:'Europe/Moscow'});
 const time=new Intl.DateTimeFormat(I18n.locale,{hour:'2-digit',minute:'2-digit',hourCycle:'h23',timeZone:'Europe/Moscow'});
 const sigils={wolf:['✦',t('Ведьмак','The Witcher')],raven:['♜',t('Ворон','Raven')],moon:['☾',t('Луна','Moon')],swords:['⚔',t('Клинки','Blades')]};
 const frames={
  iron:['Blued Iron','Free'],copper:['Old Copper','Free'],steel:['Moon Steel','Free'],
  ember:['Borderland Sparks','100 influence in one season'],ivy:['Crown of Thorns','Complete 5 contracts'],
  frost:['Northern Lights','Collect 25 different cards in one season'],blood:['Blood of the Ancients','Complete 20 contracts'],
  regal:['Royal Seal','Paid · not yet available'],eclipse:['Black Sun','Paid · not yet available']
 };
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
  $('topEndDate').textContent=day.format(ends);$('topEndTime').textContent=t(`${time.format(ends)} МСК`,`${time.format(ends)} MSK`);
  $('topSeason').hidden=false;
  $('topStatus').textContent=data.rows.length?t(`Влияние: +${spin} за крутку, +${task} за задание, +${contract} за заказ.`,`Influence: +${spin} per spin, +${task} per quest, +${contract} per contract.`):t('В этом сезоне пока нет игроков.','No players this season yet.');
  $('topRows').replaceChildren(...data.rows.map(p=>{
   const li=node('li'), link=node('a',undefined,'season-row');link.href=`#profile/${p.id}`;
   const place=node('span',`#${p.rank}`,'season-place');
   if(p.rank<=3)place.dataset.podium=String(p.rank);
   const label=node('span',undefined,'season-identity');
   label.append(node('b',p.name),node('small',universe(p.universe)+(p.id===data.me?t(' · Ты',' · You'):'')));
   const score=node('strong',undefined,'season-score');
   score.append($('profile').querySelector('.influence-icon').cloneNode(true),node('span',number.format(p.influence)));
   score.setAttribute('aria-label',t(`Влияние: ${p.influence}`,`Influence: ${p.influence}`));
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
   area.replaceChildren(node('h2',t('Оформление профиля','Profile appearance')),button(t('Сменить аватарку','Change avatar'),()=>setEditing('avatar')),button(t('Сменить рамку','Change frame'),()=>setEditing('frame')));
  }else if(editing==='name'){
   const form=node('form'),label=node('label',t('Новое имя ','New name ')),input=node('input');
   input.required=true;input.minLength=2;input.maxLength=24;input.value=p.name;input.autocomplete='off';label.append(input);
   const save=node('button',t('Сохранить имя','Save name'));save.type='submit';save.dataset.profileSave='';
   form.append(label,save);form.onsubmit=e=>{e.preventDefault();act('name',input.value);};area.replaceChildren(form);
  }else{
   const grid=node('div',undefined,'cosmetic-grid');
   const avatarOptions=()=>[...(p.telegramAvatar?[['telegram',t('Из Telegram','From Telegram')]]:[]),...p.avatars.map(id=>[id,sigils[id]?.[1]||cards.get(id)?.[1]||id])];
   const options=editing==='avatar'?avatarOptions():p.frames;
   const owned=new Set([...p.frames.slice(0,3).map(f=>f[0]),...p.achievements]);
   for(const [id,name,note] of options){
    const isFrame=editing==='frame', avatar=id==='telegram'?p.telegramAvatar:id;
    const mode=editing;
    const tile=button(undefined,()=>act(mode,id));tile.className='cosmetic-tile';tile.dataset.choice=id;
    tile.append(portrait(isFrame?p.avatar:avatar,isFrame?id:p.frame),node('b',isFrame?t(name,frames[id]?.[0]??name):name));
    if(note)tile.append(node('small',isFrame?t(note,frames[id]?.[1]??note):note));
    if(!isFrame||owned.has(id))tile.dataset.profileSave='';else tile.disabled=true;
    grid.append(tile);
   }
   area.replaceChildren(node('h2',editing==='avatar'?t('Аватарки','Avatars'):t('Рамки','Frames')),grid);
  }
  area.append(button(t('Закрыть','Close'),()=>{setEditing('');$('profilePortrait').querySelector('button')?.focus();}));
  block(busy||!!pending);
 }
 function profile(p){
  loaded=p;
  const art=portrait(p.avatar,p.frame);
  if(p.mine){
   const b=button(undefined,()=>setEditing(editing==='portrait'?'':'portrait'));b.className='portrait-button';
   b.setAttribute('aria-label',t('Изменить аватарку или рамку','Change avatar or frame'));b.append(art);$('profilePortrait').replaceChildren(b);
  }else $('profilePortrait').replaceChildren(art);
  $('profileRank').textContent=t(`МЕСТО В ТОПЕ · #${p.rank}`,`LEADERBOARD RANK · #${p.rank}`);
  $('profileTitle').replaceChildren(node('span',p.name));
  if(p.mine){const b=button(t('Изменить имя','Edit name'),()=>setEditing('name'));b.className='rename-button';$('profileTitle').append(b);}
  $('profileUniverse').textContent=universe(p.universe);
  $('profileInfluence').textContent=number.format(p.influence);
  const rows=[statsRow(t(`Коллекция · ${p.universe}`,`Collection · ${universe(p.universe)}`),t(`${p.cards} из ${p.totalCards}`,`${p.cards} of ${p.totalCards}`)),statsRow(t('Победы на арене','Arena wins'),number.format(p.arenaWins)),statsRow(t('Выполненные заказы','Completed contracts'),number.format(p.contracts))];
  if(p.mine)rows.push(statsRow(t('Премиум','Premium'),p.premiumUntil?t(`Активен до ${day.format(p.premiumUntil*1000)}`,`Active until ${day.format(p.premiumUntil*1000)}`):t('Неактивен','Inactive')));
  $('profileStats').replaceChildren(...rows);
  $('profileMedals').replaceChildren(...(p.achievements.length?p.achievements.map(key=>node('li',t(frameNames[key]||key,frames[key]?.[0]??key))):[node('li',t('Пока нет открытых рамок за достижения','No achievement frames unlocked yet'))]));
  renderEditor();$('profileContent').hidden=false;
 }
 async function open(pane){
  controller?.abort();const version=++request;
  editing='';loaded=null;topData=null;
  if(!['tool-rank','profile'].includes(pane))return;
  controller=new AbortController();
  const isTop=pane==='tool-rank',status=$(isTop?'topStatus':'profileStatus');
  status.textContent=t('Загрузка…','Loading…');
  if(isTop){$('topRows').replaceChildren();$('topSeason').hidden=true;}
  else $('profileContent').hidden=true;
  const hash=location.hash, previousIdentity=confirmedIdentity;
  if(!isTop){
   const back=$('profileBack'),from=history.state?.profileFrom;
   const [target,label]=profileId()!=='me'||from==='tool-rank'?['tool-rank',t('Топ','Leaderboard')]
    :from==='settings'?['settings',t('Настройки','Settings')]:['home',t('Колода','Deck')];
   back.href=`#${target}`;
   back.querySelector('span').textContent=label;
  }
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
   status.replaceChildren(node('span',(e.status?e.message:t('Не удалось загрузить данные','Could not load data'))+' '),button(t('Повторить','Retry'),()=>open(pane)));
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
