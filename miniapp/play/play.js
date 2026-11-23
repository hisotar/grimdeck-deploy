'use strict';
const $=id=>document.getElementById(id);
const rarities={C:['Обычная','♠',34],R:['Редкая','✧',27],E:['Эпическая','☾',21],L:['Легендарная','♜',16],M:['Мифическая','✦',2]};
const rarityGroups=[['M','Мифические'],['L','Легендарные'],['E','Эпические'],['R','Редкие'],['C','Обычные']];
const catalog=window.GRIM_CARDS;
const cards=new Map(catalog.map(c=>[c[0],c]));
const buttons=[...document.querySelectorAll('[data-size]')];
const grants=[...document.querySelectorAll('[data-grant]')];
const testPanel=$('testPanel');
const local=document.body.dataset.mode==='local';
const tg=local?null:window.Telegram?.WebApp;
const motion=matchMedia('(prefers-reduced-motion: reduce)');
const day=86400;
let state, offset=0, busy=false, pending=null, art=new Set(), key, syncing=false, canGrantSpins=false;
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
function paint(button,id,{fresh=false,album=false}={}){
 const [_,name]=cards.get(id), r=id[4];button.dataset.r=r;
 button.classList.toggle('new',fresh);
 button.replaceChildren(media(id,album&&!qty(id)),node('strong',name),node('small',`${rarities[r][0]}${album?(qty(id)?` · ×${qty(id)}`:' · Не открыта'):fresh?' · Новая':''}`));
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
 const wait=state.lastBreak?Math.max(0,state.lastBreak+day-clock()):0;
 const min=Math.ceil(wait/60);
 $('breakInfo').textContent=`${extra?`Лишних копий: ${extra} · Пыль: +${gain}.`:'Лишних копий пока нет.'} ${wait?`Следующий разбор через ${Math.floor(min/60)} ч ${min%60} мин.`:'Один экземпляр каждой карты останется.'}`;
 $('break').disabled=blocked||!extra||!!wait;
 $('retry').hidden=!pending||busy;
}
let activePane=null, transition=null, navigation=0;
async function route(){
 const version=++navigation;
 transition?.cancel();
 const panes=['home','album','workshop'], id=panes.includes(location.hash.slice(1))?location.hash.slice(1):'home';
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
 if(id==='home')tg?.BackButton?.hide();else tg?.BackButton?.show();
 window.scrollTo(0,0);
}
function resetTable(){
 const face=$('face');face.hidden=true;face.inert=true;face.replaceChildren();face.removeAttribute('data-r');face.classList.remove('new');
 $('card').classList.remove('open');$('pack').hidden=true;$('packGrid').replaceChildren();
}
async function reveal(out){
 const entry=out.cards[out.featured], face=$('face'), holder=$('card');
 let turn,frame;
 const expose=()=>{if(!face.hidden)return;paint(face,entry.id,{fresh:entry.new});face.hidden=false;DrawSound.reveal(entry.id[4]);};
 try{
  if(!motion.matches&&!$('home').hidden&&holder.animate){
   // Same duration, perspective and single unbroken curve as the approved Drowner.
   turn=holder.animate([{transform:'rotateY(0deg)'},{transform:'rotateY(180deg)'}],{duration:1350,easing:'cubic-bezier(.55,.04,.22,1)',fill:'both'});
   $('stage').classList.add('turning');
   const watchEdge=()=>{
    if(turn.effect.getComputedTiming().progress>=0.5)expose();
    else frame=requestAnimationFrame(watchEdge);
   };
   frame=requestAnimationFrame(watchEdge);await turn.finished;
  }
 }finally{cancelAnimationFrame(frame);holder.classList.add('open');turn?.cancel();$('stage').classList.remove('turning');expose();face.inert=false;}
 if(out.cards.length>1){$('packGrid').replaceChildren(...out.cards.flatMap(({id,new:fresh},i)=>i===out.featured?[]:[tile(id,{fresh})]));$('summary').textContent=`Новых карт: ${out.newCount} из ${out.cards.length}`;$('pack').hidden=false;}
 say(out.cards.length===1?`${entry.new?'Новая карта':'Повтор'}: ${cards.get(entry.id)[1]}`:`Открыто карт: ${out.cards.length}`);
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
 if(pending.kind==='draw'){resetTable();DrawSound.play();}
 say('Сохраняем результат…');
 let conflict=false;
 try{
  const out=await api(pending.kind,{op:pending.op,size:pending.size});
  if(pending.kind==='draw')await reveal(out);
  else if(pending.kind==='grant')say(`Начислено тестовых круток: ${out.granted}`);
  else say(`Получено пыли: ${out.gain}`);
  accept(out);
  pending=null;remember();
 }catch(e){
  if(e.status===400||e.status===409){conflict=e.status===409;pending=null;remember();say(e.message);}
  else say(e.status===401?'Открой игру заново. Запрос сохранён.':'Ответ не получен. Повтори тот же запрос: двойного списания не будет.');
 }finally{busy=false;refresh();if(!$('album').hidden)album();}
 if(conflict)sync();
}
function sound(){ $('sound').textContent=DrawSound.enabled?'Звук: вкл.':'Звук: выкл.';$('sound').setAttribute('aria-pressed',String(DrawSound.enabled)); }
$('sound').onclick=()=>{DrawSound.toggle();sound();};sound();
for(const b of buttons)b.onclick=()=>transact('draw',Number(b.dataset.size));
for(const b of grants)b.onclick=()=>{if(canGrantSpins)transact('grant',Number(b.dataset.grant));};
$('break').onclick=()=>transact('break',0);$('retry').onclick=()=>transact();
window.addEventListener('hashchange',route);window.addEventListener('focus',sync);
setInterval(()=>{if(!busy)refresh();if(state&&new Date(clock()*1000).toISOString().slice(0,10)!==state.day)sync();},5000);
tg?.BackButton?.onClick(()=>{if($('detail').open)$('detail').close();else location.hash='home';});
$('detail').addEventListener('close',()=>{if(!location.hash||location.hash==='#home')tg?.BackButton?.hide();});
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
