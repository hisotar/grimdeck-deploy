'use strict';
const $=id=>document.getElementById(id);
const rarities={C:['Обычная','♠',34],R:['Редкая','✧',27],E:['Эпическая','☾',21],L:['Легендарная','♜',16],M:['Мифическая','✦',2]};
const rarityGroups=[['M','Мифические'],['L','Легендарные'],['E','Эпические'],['R','Редкие'],['C','Обычные']];
const catalog=window.GRIM_CARDS;
const cards=new Map(catalog.map(c=>[c[0],c]));
const buttons=[...document.querySelectorAll('[data-size]')];
const grants=[...document.querySelectorAll('[data-grant]')];
const testPanel=$('testPanel');
const toolButtons=[...document.querySelectorAll('[data-tool]')];
const local=document.body.dataset.mode==='local';
const tg=local?null:window.Telegram?.WebApp;
const motion=matchMedia('(prefers-reduced-motion: reduce)');
const day=86400;
let state, shuffleReadyAt=0, offset=0, busy=false, pending=null, art=new Set(), key, syncing=false, canGrantSpins=false;
const clock=()=>Math.floor(Date.now()/1000)+offset;
const node=(tag,text,cls)=>{const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(cls)el.className=cls;return el;};
const say=text=>{$('notice').textContent=text;};
const qty=id=>state?.owned[id]||0;

async function api(path,data){
 const res=await fetch(`/api/${path}`,data===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
 const out=await res.json();
 if(!res.ok)throw Object.assign(new Error(out.error||'Запрос не выполнен'),{status:res.status});
 return out;
}
function accept(out){
 state=out.state;offset=out.now-Math.floor(Date.now()/1000);
 shuffleReadyAt=out.shuffleReadyAt??(state.lastBreak?state.lastBreak+7200:0);
 if(typeof out.canGrantSpins==='boolean')canGrantSpins=out.canGrantSpins;
}
function remember(){try{if(pending)sessionStorage.setItem(key,JSON.stringify(pending));else sessionStorage.removeItem(key);}catch{}}
function media(id,locked=false){
 const el=node('span',locked?'◇':rarities[id[4]][1],'media');el.setAttribute('aria-hidden','true');
 if(!locked&&art.has(id)){const img=new Image();img.alt='';img.loading='lazy';img.decoding='async';img.onerror=()=>img.remove();img.src=`/art/${id}.webp`;el.append(img);}
 return el;
}
function detail(id){
 const [_,name,lore,atk,hp,value,dust]=cards.get(id), box=$('detailBody');box.dataset.r=id[4];
 const title=node('h2',name);title.id='detailTitle';$('detail').setAttribute('aria-labelledby',title.id);
 box.replaceChildren(media(id),title,node('p',rarities[id[4]][0]),node('p',`Атака ${atk} · Здоровье ${hp} · Ценность ${value}`),node('p',lore),node('p',`Копий: ${qty(id)} · Пыль за лишнюю копию: ${dust}`));
 $('detail').showModal();tg?.BackButton?.show();
}
function roman(n){
 let text='';
 for(const [value,glyph] of [[50,'L'],[40,'XL'],[10,'X'],[9,'IX'],[5,'V'],[4,'IV'],[1,'I']]){
  while(n>=value){text+=glyph;n-=value;}
 }
 return text;
}
function paint(button,id,{album=false}={}){
 const [_,name]=cards.get(id), r=id[4], number=roman(Number(id.slice(5))), copies=album?qty(id):0;
 button.dataset.r=r;
 const filigree=node('span',undefined,'tarot-filigree');filigree.setAttribute('aria-hidden','true');
 for(let i=0;i<4;i++)filigree.append(node('i'));
 const artwork=media(id);
 if(copies)artwork.append(node('span',`×${copies}`,'tarot-copies'));
 button.replaceChildren(node('span',number,'tarot-number'),artwork,node('span',name,'tarot-title'),filigree);
 button.setAttribute('aria-label',`${name} · ${rarities[r][0]} · ${number}${copies?` · Копий: ${copies}`:''}`);
 button.onclick=()=>detail(id);
}
function tile(id,options){const b=node('button',undefined,'tile');b.type='button';paint(b,id,options);return b;}
function album(){
 if(!state)return;
 const sections=rarityGroups.map(([r,name])=>{
  const all=catalog.filter(([id])=>id[4]===r);
  const owned=all.filter(([id])=>qty(id)>0);
  const section=node('section',undefined,'album-category');
  const header=node('h2',undefined,'album-category-title');
  header.append(node('span',name),node('span',`${owned.length} / ${all.length}`,'album-category-count'));
  section.append(header);
  if(owned.length){
   const grid=node('div',undefined,'grid');
   grid.append(...owned.map(([id])=>tile(id,{album:true})));
   section.append(grid);
  }
  return section;
 });
 $('albumGrid').replaceChildren(...sections);
}
function refresh(){
 if(!state)return;
 const left=5-state.used, spins=state.spins??0, blocked=busy||!!pending;
 $('coins').textContent=state.coins;$('dust').textContent=state.dust;
 $('free').textContent=`Бесплатно: ${left} из 5 · сброс в 00:00 UTC${spins?` · Тестовые: ${spins}`:''}`;
 if(testPanel)testPanel.hidden=!canGrantSpins;
 for(const b of grants)b.disabled=blocked||!canGrantSpins;
 for(const b of buttons){const size=Number(b.dataset.size),cost=Math.max(0,size-left-spins),missing=cost-state.coins;
  b.replaceChildren(node('b',size===1?'Крутить':`×${size}`),node('small',missing>0?`Не хватает ${missing} ◉`:cost?`${cost} ◉`:'Бесплатно'));b.disabled=blocked||missing>0;
 }
 const counts=Object.entries(state.owned);
 $('count').textContent=`Собрано ${counts.length} из ${catalog.length} · Копий: ${counts.reduce((n,[,k])=>n+k,0)}`;
 let extra=0,gain=0;
 for(const [id,n] of counts){extra+=n-1;gain+=(n-1)*cards.get(id)[6];}
 const wait=Math.max(0,shuffleReadyAt-clock());
 const min=Math.ceil(wait/60);
 $('breakInfo').textContent=`${extra?`Лишних копий: ${extra} · Пыль: +${gain}.`:'Лишних копий пока нет.'} ${wait?`Перетасовка через ${Math.floor(min/60)} ч ${min%60} мин.`:'Один экземпляр каждой карты останется.'}`;
 $('break').disabled=blocked||!extra||!!wait;
 $('retry').hidden=!pending||busy;
}
const panes=['home','album','tool-shuffle','tool-craft','tool-quests','tool-rank','pack'];
const rarityRank=new Map(rarityGroups.map(([r],i)=>[r,i]));
let activePane=null, transition=null, navigation=0, hasPack=false, stopScene=null;
function targetPane(){
 const id=location.hash.slice(1);
 return panes.includes(id)&&(id!=='pack'||hasPack)?id:'home';
}
function go(id){
 if(location.hash!==`#${id}`)history.pushState(null,'',`#${id}`);
 return route();
}
async function route(){
 const version=++navigation;
 transition?.cancel();
 const id=targetPane();
 if(location.hash==='#pack'&&!hasPack)history.replaceState(null,'','#home');
 if(activePane!==id)stopScene?.();
 const animate=activePane&&activePane!==id&&!motion.matches&&$(id).animate;
 if(animate){
  transition=$(activePane).animate([{opacity:1},{opacity:0}],{duration:85,fill:'forwards'});
  try{await transition.finished;}catch{}
  if(version!==navigation)return;
  transition.cancel();
 }
 for(const p of panes)$(p).hidden=p!==id;
 activePane=id;
 if(animate)transition=$(id).animate([{opacity:0,transform:'translateY(5px)'},{opacity:1,transform:'none'}],{duration:165,easing:'ease-out'});
 for(const a of document.querySelectorAll('nav a')){if(a.hash===`#${id}`)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');}
 if(id==='album')album();
 if(id==='pack'&&$('notice').querySelector('.notice-link'))say('');
 if(id==='home'&&!$('detail').open)tg?.BackButton?.hide();else tg?.BackButton?.show();
 window.scrollTo(0,0);
}
function table(prefix){
 return {face:$(`${prefix}face`),holder:$(`${prefix}card`),stage:$(`${prefix}stage`),label:$(`${prefix}newCardPanel`)};
}
function resetTable({face,holder,stage,label}){
 face.hidden=true;face.inert=true;face.replaceChildren();face.removeAttribute('data-r');
 label.hidden=true;stage.removeAttribute('data-r');holder.classList.remove('open');
}
async function flip(entry,{face,holder,stage,label},pane){
 let turn,frame;
 const visible=()=>!$(pane).hidden&&targetPane()===pane;
 const expose=()=>{
  if(!face.hidden)return;
  paint(face,entry.id);face.hidden=false;stage.dataset.r=entry.id[4];
  if(visible())DrawSound.reveal(entry.id[4]);
 };
 try{
  if(!motion.matches&&visible()&&holder.animate){
   // Preserve the approved single-card reveal curve and expose only at the edge.
   turn=holder.animate([{transform:'rotateY(0deg)'},{transform:'rotateY(180deg)'}],{duration:1350,easing:'cubic-bezier(.55,.04,.22,1)',fill:'both'});
   stopScene=()=>turn.cancel();
   stage.classList.add('turning');
   const watchEdge=()=>{
    if(turn.effect.getComputedTiming().progress>=0.5)expose();
    else frame=requestAnimationFrame(watchEdge);
   };
   frame=requestAnimationFrame(watchEdge);
   await turn.finished.catch(()=>{});
  }
 }finally{
  stopScene=null;cancelAnimationFrame(frame);holder.classList.add('open');turn?.cancel();stage.classList.remove('turning');
  expose();face.inert=false;label.hidden=!entry.new;
 }
}
async function reveal(out){
 const list=out.cards;
 if(list.length===1){
  const [entry]=list;
  await flip(entry,table(''),'home');
  say(entry.new?'':`Повтор: ${cards.get(entry.id)[1]}`);
  return;
 }
 const featured=list.reduce((best,{id},i)=>rarityRank.get(id[4])<rarityRank.get(list[best].id[4])?i:best,0);
 const scene=table('pack-');
 resetTable(scene);
 $('packTitle').textContent=`Результаты ×${list.length}`;
 $('packRest').hidden=true;
 $('packGrid').replaceChildren(...list.flatMap(({id,new:isNew},i)=>{
  if(i===featured)return [];
  const item=node('div',undefined,'pack-entry');item.append(tile(id));
  if(isNew){const slot=node('div',undefined,'pack-new-slot');slot.append(node('span','Новая','new-card-label'));item.append(slot);}
  return [item];
 }));
 $('summary').textContent=`Новых карт: ${out.newCount} из ${list.length}`;
 hasPack=true;
 say('');
 if(targetPane()==='home')await go('pack');
 try{await flip(list[featured],scene,'pack');}
 finally{
  $('packRest').hidden=false;
  if(targetPane()!=='pack'){
   const link=node('a',`Смотреть результаты ×${list.length}`,'notice-link');link.href='#pack';$('notice').replaceChildren(link);
  }
 }
}
for(const button of toolButtons)button.onclick=()=>go(button.getAttribute('aria-controls'));

async function shuffleDeck(){
 const scene=$('shuffleScene'), air=$('shuffleAir'), ring=$('shuffleRing'), flash=$('shuffleFlash');
 if($('tool-shuffle').hidden||targetPane()!=='tool-shuffle'||motion.matches||!scene.animate){scene.dataset.phase='aligned';return;}
 const radius=Math.min(158,scene.clientWidth*.35), duration=4420;
 const animations=[];
 const animate=(el,frames,options)=>{
  const animation=el.animate(frames,options);animations.push(animation);
  // Navigation can cancel all layers at once, including the delayed flash.
  animation.finished.catch(()=>{});
  return animation;
 };
 stopScene=()=>animations.forEach(a=>a.cancel());
 try{
  const flights=Array.from({length:8},(_,i)=>{
   const card=node('i',undefined,'shuffle-flying');air.append(card);
   const pose=(x,y,z,rx,ry,rz,s=1)=>`translate3d(${x}px,${y}px,${z}px) rotateX(${rx}deg) rotateY(${ry}deg) rotateZ(${rz}deg) scale(${s})`;
   const orbit=(t,jitter=0)=>{
    const a=2*Math.PI*(i/8+t*1.08), depth=Math.sin(a), side=Math.cos(a);
    return pose(side*radius+jitter,depth*49-40+jitter*.6,depth*96,side*22+12,side*38+depth*17,side*29+jitter,.66+depth*.08);
   };
   const start=pose((i%3-1)*3,19-i*2,i*2,58,0,-9+(i%3-1)*4);
   const frames=[{offset:0,transform:start},{offset:.015+i*.008,transform:start,easing:'ease-out'},
    {offset:.12+i*.008,transform:pose((i-3.5)*5,-39+i*4,45+i*4,31,0,-19+i*5,.86),easing:'cubic-bezier(.32,0,.22,1)'}];
   for(let step=0;step<=48;step++)frames.push({offset:.24+step/48*.50,transform:orbit(step/48)});
   for(let step=1;step<=8;step++)frames.push({offset:.74+step*.026,transform:orbit(1,(step%2?1:-1)*(1+step*.7+i%3)),easing:step===8?'cubic-bezier(.66,.02,.9,.55)':'linear'});
   frames.push({offset:1,transform:pose(i*-.5,i*-.5,i*2,0,0,0)});
   return animate(card,frames,{duration,fill:'both'});
  });
  scene.dataset.phase='scattered';
  animate(ring,[
   {offset:0,opacity:0,transform:'translateY(-20px) scale(.35)'},
   {offset:.26,opacity:.7,transform:'translateY(-28px) scale(1)'},
   {offset:.74,opacity:.45,transform:'translateY(-28px) scale(1.05)'},
   {offset:.95,opacity:.9,transform:'translateY(-28px) scale(1)'},
   {offset:1,opacity:0,transform:'translateY(0) scale(.2)'}
  ],{duration,fill:'both'});
  const burst=animate(flash,[
   {offset:0,opacity:0,transform:'scale(.56)'},
   {offset:.07,opacity:1,transform:'scale(1)'},
   {offset:.26,opacity:1,transform:'scale(1.1)'},
   {offset:1,opacity:0,transform:'scale(1.45)'}
  ],{duration:1060,delay:duration-72,fill:'both'});
  await Promise.all(flights.map(a=>a.finished));
  scene.dataset.phase='aligned';
  air.replaceChildren();
  await burst.finished;
 }finally{
  scene.dataset.phase='aligned';stopScene=null;
  for(const a of animations)a.cancel();
  air.replaceChildren();
 }
}

// A background read must never overwrite a newer operation's state.
let operationVersion=0;
async function sync(){
 if(!state||busy||syncing)return;
 const version=operationVersion;
 syncing=true;
 try{const out=await api('state');if(version===operationVersion){accept(out);refresh();if(!$('album').hidden)album();}}
 catch(e){if(version===operationVersion&&e.status===401){state=null;canGrantSpins=false;if(testPanel)testPanel.hidden=true;for(const b of [...buttons,...grants,$('break')])b.disabled=true;say(e.message);}}
 finally{syncing=false;}
}
async function transact(kind,size){
 if(!state||busy)return;
 if(pending&&kind)return;
 if(!pending){pending={kind,op:crypto.randomUUID(),size};remember();}
 operationVersion++;
 busy=true;refresh();
 const op=pending;
 if(op.kind==='draw'){if(op.size===1)resetTable(table(''));DrawSound.play();}
 if(op.kind==='break'){$('breakResult').hidden=true;$('shuffleScene').removeAttribute('data-phase');}
 say('Сохраняем результат…');
 let conflict=false;
 try{
  const out=await api(op.kind,{op:op.op,size:op.size});
  accept(out);
  pending=null;remember();
  if(op.kind==='draw')await reveal(out);
  else if(op.kind==='grant')say(`Начислено тестовых круток: ${out.granted}`);
  else {
   try{await shuffleDeck();}catch{} // A visual failure must not undo a confirmed operation.
   const result=$('breakResult');result.textContent=`Получено пыли: +${out.gain}`;result.hidden=false;
   say(targetPane()!=='tool-shuffle'?result.textContent:'');
  }
 }catch(e){
  if(!pending)say('Операция сохранена, но результат не удалось показать.');
  else if(e.status===400||e.status===409){conflict=e.status===409;pending=null;remember();say(e.message);}
  else say(e.status===401?'Открой игру заново. Запрос сохранён.':'Ответ не получен. Повтори тот же запрос: двойного списания не будет.');
 }finally{busy=false;refresh();if(!$('album').hidden)album();}
 if(conflict)sync();
}
function sound(){ $('sound').textContent=DrawSound.enabled?'Звук: вкл.':'Звук: выкл.';$('sound').setAttribute('aria-pressed',String(DrawSound.enabled)); }
$('sound').onclick=()=>{DrawSound.toggle();sound();};sound();
for(const b of buttons)b.onclick=()=>transact('draw',Number(b.dataset.size));
for(const b of grants)b.onclick=()=>{if(canGrantSpins)transact('grant',Number(b.dataset.grant));};
$('break').onclick=()=>transact('break',0);$('retry').onclick=()=>transact();
document.querySelector('main').addEventListener('click',e=>{
 const link=e.target.closest('a[href^="#"]');
 if(!link||e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;
 e.preventDefault();go(link.hash.slice(1));
});
window.addEventListener('hashchange',route);window.addEventListener('focus',sync);
setInterval(()=>{if(!busy)refresh();if(state&&new Date(clock()*1000).toISOString().slice(0,10)!==state.day)sync();},5000);
tg?.BackButton?.onClick(()=>{if($('detail').open)$('detail').close();else go('home');});
$('detail').addEventListener('close',()=>{if(targetPane()==='home')tg?.BackButton?.hide();});
route();
(async()=>{
 try{
  tg?.ready();tg?.expand();
  const session=await api('session',local?{}:{initData:tg?.initData||''});
  key=`grimdeck.pending.${session.player}`;
  try{pending=JSON.parse(sessionStorage.getItem(key));}catch{}
  const [out,images]=await Promise.all([api('state'),api('art').catch(()=>[])]);
  art=new Set(images);accept(out);refresh();if(!$('album').hidden)album();
  say(pending?'Предыдущий запрос не завершён. Можно повторить.':local?'Локальный стенд · стартовый баланс 120 монет':'');
 }catch(e){say(e.message);}
})();
