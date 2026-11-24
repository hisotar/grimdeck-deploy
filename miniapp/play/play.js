'use strict';
const $=id=>document.getElementById(id);
const rarities={C:['Обычная','♠',34],R:['Редкая','✧',27],E:['Эпическая','☾',21],L:['Легендарная','♜',16],M:['Мифическая','✦',2]};
const rarityGroups=[['M','Мифические'],['L','Легендарные'],['E','Эпические'],['R','Редкие'],['C','Обычные']];
const catalog=window.GRIM_CARDS;
const cards=new Map(catalog.map(c=>[c[0],c]));
const buttons=[...document.querySelectorAll('[data-size]')];
const grants=[...document.querySelectorAll('[data-grant]')];
const testPanel=$('testPanel'), clearConfirm=$('clearConfirm');
const testerButtons=[...grants,$('clearCollection'),$('resetShuffle')];
const toolButtons=[...document.querySelectorAll('[data-tool]')];
const local=document.body.dataset.mode==='local';
const tg=local?null:window.Telegram?.WebApp;
const motion=matchMedia('(prefers-reduced-motion: reduce)');
let state, shuffleReadyAt=0, offset=0, busy=false, pending=null, art=new Set(), key, syncing=false, canGrantSpins=false;
let shuffleMastery;
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
 if(out.shuffleMastery)shuffleMastery=out.shuffleMastery;
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
const loot=[
 ['dust2','Пыль ×2','M12 2 14.5 9.5 22 12 14.5 14.5 12 22 9.5 14.5 2 12 9.5 9.5Z'],
 ['spins','3 крутки','M5 9a7 7 0 0 1 12-3l2 2m0-5v5h-5M19 15a7 7 0 0 1-12 3l-2-2m0 5v-5h5'],
 ['dust10','Пыль ×10','M12 2l2 7 7-2-4 5 4 5-7-2-2 7-2-7-7 2 4-5-4-5 7 2Z'],
 ['legendary','Легендарная карта','M6 3h12v18H6zM9 12l3-4 3 4-3 4z'],
 ['mythic','Мифическая карта','M5 3h14v18H5zM12 6l1.4 4.6L17 12l-3.6 1.4L12 18l-1.4-4.6L7 12l3.6-1.4z']
];
const percent=new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2});
const svgNS='http://www.w3.org/2000/svg';
const lootRows=loot.map(([kind,label,d])=>{
 const icon=document.createElementNS(svgNS,'svg'), path=document.createElementNS(svgNS,'path');
 icon.setAttribute('viewBox','0 0 24 24');icon.setAttribute('class','loot-icon');icon.dataset.kind=kind;icon.setAttribute('aria-hidden','true');
 path.setAttribute('d',d);path.setAttribute('fill','none');path.setAttribute('stroke','currentColor');
 path.setAttribute('stroke-width','1.4');path.setAttribute('stroke-linejoin','round');path.setAttribute('stroke-linecap','round');
 icon.append(path);
 const item=node('li'), chance=node('b','—');item.dataset.kind=kind;item.append(icon,node('span',label),chance);$('shuffleLoot').append(item);
 return [kind,chance];
});
function refreshShuffle(blocked){
 const now=clock(), wait=Math.ceil(Math.max(0,shuffleReadyAt-now)/60);
 $('breakInfo').textContent=`Гарантированно: 1–5 пыли. ${wait?`Следующая через ${Math.floor(wait/60)} ч ${wait%60} мин.`:'Повторы не нужны.'}`;
 $('break').disabled=blocked||!!wait;
 if(!shuffleMastery)return;
 const expired=now>=shuffleMastery.resetsAt, count=expired?0:shuffleMastery.count, level=expired?1:shuffleMastery.level;
 [...$('masterySteps').children].forEach((step,i)=>{if(i+1===level)step.setAttribute('aria-current','step');else step.removeAttribute('aria-current');});
 $('masteryInfo').textContent=`Сегодня: ${count} · Следующая: ×${level} к шансам · Сброс в 00:00 UTC`;
 for(const [kind,chance] of lootRows)chance.textContent=`${percent.format(shuffleMastery.weights[kind]*level/100)}%`;
}
let shuffleRevealTimer=0;
function hideShuffleReveal(){
 clearTimeout(shuffleRevealTimer);
 const reveal=$('shuffleReveal');
 reveal.hidden=true;reveal.replaceChildren();reveal.style.removeProperty('--reveal-hold');
}
function showShuffleReveal(out,extra,cardName){
 hideShuffleReveal();
 const reveal=$('shuffleReveal'), hold=out.rewardCard?5000:3000;
 reveal.dataset.kind=out.bonus||'';
 reveal.style.setProperty('--reveal-hold',`${hold}ms`);
 const copy=node('div',undefined,'shuffle-reveal-copy');
 copy.append(node('span','НАГРАДА','shuffle-reveal-label'),node('strong',`+${out.gain} пыли`));
 if(extra)copy.append(node('span',extra,'shuffle-reveal-extra'));
 if(cardName)copy.append(node('b',cardName,'shuffle-reveal-name'));
 const crest=out.rewardCard?media(out.rewardCard.id):node('span','✦','shuffle-reveal-mark');
 reveal.append(crest,copy);
 reveal.hidden=false;
 shuffleRevealTimer=setTimeout(hideShuffleReveal,hold+440);
}
function showShuffleReward(out){
 const result=$('breakResult');
 result.dataset.kind=out.bonus||'';
 const extra=out.rewardCard?`${out.bonus==='mythic'?'Мифическая':'Легендарная'} карта${out.rewardCard.new?' · Новая':''}`:
  out.bonus==='spins'?'+3 наградные крутки':out.bonus==='dust2'||out.bonus==='dust10'?`Базовая пыль: ${out.baseDust} ×${out.bonus==='dust2'?2:10}`:'';
 const title=`Получено пыли: +${out.gain}`;
 result.replaceChildren(node('strong',title));
 if(extra)result.append(node('div',extra));
 const cardName=out.rewardCard&&cards.get(out.rewardCard.id)[1];
 if(out.rewardCard){
  const {id}=out.rewardCard, card=node('button',cardName);card.type='button';card.onclick=()=>detail(id);result.append(card);
 }
 result.hidden=false;
 const onShuffle=targetPane()==='tool-shuffle'&&!$('tool-shuffle').hidden;
 if(onShuffle)showShuffleReveal(out,extra,cardName);
 say(onShuffle?'':[title,extra,cardName].filter(Boolean).join(' · '));
}
function refresh(){
 if(!state)return;
 const left=state.freeSpins, spins=state.spins??0, rewardSpins=state.rewardSpins??0, blocked=busy||!!pending;
 $('coins').textContent=state.coins;$('dust').textContent=state.dust;
 const freeMinutes=Math.ceil(Math.max(0,state.freeNextAt-clock())/60);
 $('free').textContent=`Бесплатно: ${left} из 5`;
 $('freeTimer').textContent=left===5?'Запас полный · +1 каждые 3 часа':freeMinutes?`Следующая через ${Math.floor(freeMinutes/60)} ч ${freeMinutes%60} мин`:'Обновляем крутки…';
 $('rewardSpins').hidden=!rewardSpins;$('rewardSpins').textContent=`Наградные крутки: ${rewardSpins}`;
 $('testSpins').textContent=`Тестовые крутки: ${spins}`;
 if(testPanel)testPanel.hidden=!canGrantSpins;
 for(const b of grants)b.disabled=blocked||!canGrantSpins;
 for(const b of buttons){const size=Number(b.dataset.size),cost=Math.max(0,size-left-spins-rewardSpins),missing=cost-state.coins;
  b.replaceChildren(node('b',size===1?'Крутить':`×${size}`),node('small',missing>0?`Не хватает ${missing} ◉`:cost?`${cost} ◉`:'Бесплатно'));b.disabled=blocked||missing>0;
 }
 const counts=Object.entries(state.owned);
 $('clearCollection').disabled=blocked||!canGrantSpins||!counts.length;
 $('resetShuffle').disabled=blocked||!canGrantSpins||shuffleReadyAt<=clock();
 $('count').textContent=`Собрано ${counts.length} из ${catalog.length} · Копий: ${counts.reduce((n,[,k])=>n+k,0)}`;
 refreshShuffle(blocked);
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
 if(id!=='tool-shuffle')hideShuffleReveal();
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
 if(id==='home'&&!$('detail').open&&!clearConfirm.open)tg?.BackButton?.hide();else tg?.BackButton?.show();
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
 const scene=$('shuffleScene'), air=$('shuffleAir'), ring=$('shuffleRing'), contact=$('shuffleContact');
 if($('tool-shuffle').hidden||targetPane()!=='tool-shuffle'||motion.matches||!scene.animate){scene.dataset.phase='aligned';return;}
 const radius=Math.min(158,scene.clientWidth*.35), orbitEnd=4420*.74;
 const fanEnd=orbitEnd+340, firstRelease=fanEnd+145, spacing=128, travel=240;
 const width=Math.min(235,scene.clientWidth-106), impact=firstRelease+7*spacing+travel;
 const animations=[], epoch=document.timeline.currentTime;
 const animate=(el,frames,options)=>{
  const animation=el.animate(frames,options);animations.push(animation);
  if(epoch!=null)animation.startTime=epoch;
  animation.finished.catch(()=>{});
  return animation;
 };
 const angle=(i,t)=>2*Math.PI*(i/8+t*1.08);
 const order=Array.from({length:8},(_,i)=>i).sort((a,b)=>Math.cos(angle(a,1))-Math.cos(angle(b,1)));
 stopScene=()=>animations.forEach(a=>a.cancel());
 try{
  const flights=Array.from({length:8},(_,i)=>{
   const card=node('i',undefined,'shuffle-flying');air.append(card);
   const pose=(x,y,z,rx,ry,rz,s=1)=>`translate3d(${x}px,${y}px,${z}px) rotateX(${rx}deg) rotateY(${ry}deg) rotateZ(${rz}deg) scale(${s})`;
   const orbit=t=>{
    const a=angle(i,t), depth=Math.sin(a), side=Math.cos(a);
    return pose(side*radius,depth*49-40,depth*96,side*22+12,side*38+depth*17,side*29,.66+depth*.08);
   };
   const rank=order.indexOf(i), u=rank/3.5-1;
   const release=firstRelease+rank*spacing, end=release+travel, depth=rank*3;
   const restX=depth*-.26, restY=depth*-.28;
   const start=pose((i%3-1)*3,19-i*2,i*2,58,0,-9+(i%3-1)*4);
   const frames=[];
   const at=(ms,transform,easing='linear')=>frames.push({offset:ms/end,transform,easing});
   at(0,start);at(4420*(.015+i*.008),start,'ease-out');
   at(4420*(.12+i*.008),pose((i-3.5)*5,-39+i*4,45+i*4,31,0,-19+i*5,.86),'cubic-bezier(.32,0,.22,1)');
   for(let step=0;step<=48;step++)at(4420*(.24+step/48*.50),orbit(step/48),step===48?'cubic-bezier(.24,.68,.32,1)':'linear');
   const fan=pose(u*width/2,-80+u*u*26,27+rank*3,8,-u*12,u*24,.77);
   at(fanEnd,fan);at(release,fan,'cubic-bezier(.32,.13,.5,1)');
   at(release+travel*.60,pose(u*width*.19,-25,depth+28,4,-u*4,u*8,.94),'cubic-bezier(.55,0,.82,.62)');
   at(end,pose(restX,restY,depth,0,0,0));
   return animate(card,frames,{duration:end,fill:'both'});
  });
  scene.dataset.phase='scattered';
  animate(ring,[
   {offset:0,opacity:0,transform:'translateY(-20px) scale(.35)'},
   {offset:.26*4420/fanEnd,opacity:.7,transform:'translateY(-28px) scale(1)'},
   {offset:orbitEnd/fanEnd,opacity:.45,transform:'translateY(-28px) scale(1.05)'},
   {offset:1,opacity:0,transform:'translateY(-28px) scale(.94)'}
  ],{duration:fanEnd,fill:'both'});
  // Both layers share the same resting geometry, so the handoff stays visible.
  const settle=animate(scene.querySelector('.shuffle-stack'),[
   {transform:'translateY(0) scale(1)'},{offset:.23,transform:'translateY(2px) scale(1.012,.982)'},
   {offset:.56,transform:'translateY(-.7px) scale(.999,1.005)'},{transform:'translateY(0) scale(1)'}
  ],{duration:230,delay:impact,fill:'both'});
  const light=animate(contact,[
   {opacity:0,transform:'scale(.85)'},{offset:.23,opacity:.9,transform:'scale(1)'},{opacity:0,transform:'scale(1.22)'}
  ],{duration:310,delay:impact+30,fill:'both'});
  await Promise.all(flights.map(a=>a.finished));
  scene.dataset.phase='aligned';
  air.replaceChildren();
  await Promise.all([settle.finished,light.finished]);
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
 catch(e){if(version===operationVersion&&e.status===401){state=null;canGrantSpins=false;if(testPanel)testPanel.hidden=true;for(const b of [...buttons,...testerButtons,$('break')])b.disabled=true;say(e.message);}}
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
 if(op.kind==='break'){hideShuffleReveal();$('breakResult').hidden=true;$('shuffleScene').removeAttribute('data-phase');}
 say('Сохраняем результат…');
 let conflict=false;
 try{
  const out=await api(op.kind,{op:op.op,size:op.size});
  accept(out);
  pending=null;remember();
  if(op.kind==='draw')await reveal(out);
  else if(op.kind==='grant')say(`Начислено тестовых круток: ${out.granted}`);
  else if(op.kind==='clear-collection'){
   resetTable(table(''));resetTable(table('pack-'));
   hasPack=false;$('packRest').hidden=true;$('packGrid').replaceChildren();
   if(location.hash==='#pack')await route();
   say(`Коллекция очищена · удалено видов карт: ${out.removed}`);
  } else if(op.kind==='reset-shuffle'){
   hideShuffleReveal();$('breakResult').hidden=true;
   say('Таймер перетасовки сброшен.');
  }
  else {
   try{await shuffleDeck();}catch{} // A visual failure must not undo a confirmed operation.
   showShuffleReward(out);
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
$('clearCollection').onclick=()=>{clearConfirm.returnValue='';clearConfirm.showModal();tg?.BackButton?.show();};
clearConfirm.addEventListener('close',()=>{
 if(targetPane()==='home')tg?.BackButton?.hide();
 if(canGrantSpins&&clearConfirm.returnValue==='clear')transact('clear-collection',0);
});
$('resetShuffle').onclick=()=>{if(canGrantSpins)transact('reset-shuffle',0);};
$('break').onclick=()=>transact('break',0);$('retry').onclick=()=>transact();
document.querySelector('main').addEventListener('click',e=>{
 const link=e.target.closest('a[href^="#"]');
 if(!link||e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;
 e.preventDefault();go(link.hash.slice(1));
});
window.addEventListener('hashchange',route);window.addEventListener('focus',sync);
setInterval(()=>{if(!busy)refresh();if(state?.freeNextAt&&clock()>=state.freeNextAt)sync();},5000);
tg?.BackButton?.onClick(()=>{if(clearConfirm.open)clearConfirm.close('cancel');else if($('detail').open)$('detail').close();else go('home');});
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
