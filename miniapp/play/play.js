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
 const left=state.freeSpins, spins=state.spins??0, blocked=busy||!!pending;
 $('coins').textContent=state.coins;$('dust').textContent=state.dust;
 const freeMinutes=Math.ceil(Math.max(0,state.freeNextAt-clock())/60);
 $('free').textContent=`Бесплатно: ${left} из 5`;
 $('freeTimer').textContent=left===5?'Запас полный · +1 каждые 3 часа':freeMinutes?`Следующая через ${Math.floor(freeMinutes/60)} ч ${freeMinutes%60} мин`:'Обновляем крутки…';
 $('testSpins').textContent=`Тестовые крутки: ${spins}`;
 if(testPanel)testPanel.hidden=!canGrantSpins;
 for(const b of grants)b.disabled=blocked||!canGrantSpins;
 for(const b of buttons){const size=Number(b.dataset.size),cost=Math.max(0,size-left-spins),missing=cost-state.coins;
  b.replaceChildren(node('b',size===1?'Крутить':`×${size}`),node('small',missing>0?`Не хватает ${missing} ◉`:cost?`${cost} ◉`:'Бесплатно'));b.disabled=blocked||missing>0;
 }
 const counts=Object.entries(state.owned);
 $('clearCollection').disabled=blocked||!canGrantSpins||!counts.length;
 $('resetShuffle').disabled=blocked||!canGrantSpins||shuffleReadyAt<=clock();
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
 const scene=$('shuffleScene'), air=$('shuffleAir'), ring=$('shuffleRing'), flash=$('shuffleFlash');
 const wave=$('shuffleWave'), sparks=$('shuffleSparks'), stack=scene.querySelector('.shuffle-stack');
 if($('tool-shuffle').hidden||targetPane()!=='tool-shuffle'||motion.matches||!scene.animate){scene.dataset.phase='aligned';return;}
 const radius=Math.min(158,scene.clientWidth*.35), orbitEnd=4420*.74;
 // Alternate sides of the orbit. The gaps close as the stack gains momentum.
 const order=[5,1,6,2,7,3,0,4], landing=[4270,4350,4420,4480,4530,4574,4612,4646];
 const impact=landing.at(-1), animations=[], epoch=document.timeline.currentTime;
 const animate=(el,frames,options)=>{
  const animation=el.animate(frames,options);animations.push(animation);
  if(epoch!==null)animation.startTime=epoch;
  // Leaving the screen cancels even the layers that haven't started yet.
  animation.finished.catch(()=>{});
  return animation;
 };
 stopScene=()=>animations.forEach(a=>a.cancel());
 try{
  const flights=Array.from({length:8},(_,i)=>{
   const card=node('i',undefined,'shuffle-flying');air.append(card);
   const pose=(x,y,z,rx,ry,rz,s=1)=>`translate3d(${x}px,${y}px,${z}px) rotateX(${rx}deg) rotateY(${ry}deg) rotateZ(${rz}deg) scale(${s})`;
   const orbit=t=>{
    const a=2*Math.PI*(i/8+t*1.08), depth=Math.sin(a), side=Math.cos(a);
    return [side*radius,depth*49-40,depth*96,side*22+12,side*38+depth*17,side*29,.66+depth*.08];
   };
   const rank=order.indexOf(i), end=landing[rank];
   const start=pose((i%3-1)*3,19-i*2,i*2,58,0,-9+(i%3-1)*4);
   const frames=[];
   const at=(ms,transform,easing='linear')=>frames.push({offset:ms/end,transform,easing});
   at(0,start);at(4420*(.015+i*.008),start,'ease-out');
   at(4420*(.12+i*.008),pose((i-3.5)*5,-39+i*4,45+i*4,31,0,-19+i*5,.86),'cubic-bezier(.32,0,.22,1)');
   for(let step=0;step<=48;step++)at(4420*(.24+step/48*.50),pose(...orbit(step/48)));
   const brake=190+(i*47)%155, drift=.045+brake/8600;
   const endOrbit=orbit(1+drift);
   for(let step=1;step<=12;step++){
    const t=step/12;at(orbitEnd+brake*t,pose(...orbit(1+drift*(1-(1-t)**2))));
   }
   const [x,y,z,rx,ry,rz,scale]=endOrbit, release=end-345+rank*12;
   // Each card has its own phase, axis and amount of play; motion starts at rest.
   const phase=i*2.39996, gain=[.85,.48,1,.34,.72,.95,.42,.68][i];
   const side=Math.sign(x)||1;
   for(let step=1;step<=14;step++){
    const t=step/14, p=t*(5.5+i*.73), amp=Math.sin(t*Math.PI/2)*gain;
    at(orbitEnd+brake+(release-orbitEnd-brake)*t,pose(
     x+Math.sin(p+phase)*7*amp,y+Math.cos(p*.83+phase)*5*amp,z+Math.sin(p*.69-phase)*11*amp,
     rx+Math.cos(p+phase)*11*amp,ry+Math.sin(p*.78+phase)*15*amp,rz+Math.sin(p*1.1-phase)*8*amp,scale),
     step===14?'cubic-bezier(.3,.02,.62,.8)':'linear');
   }
   const depth=Math.max(0,rank-2)*3;
   // Arc inward, square the edge, then use the exact resting stack geometry.
   at(release+(end-release)*.40,pose(x*.69+side*9,y*.75-22,z*.6+31,rx*.5+12,ry*.54-side*18,rz*.63+side*13,scale+.12),'cubic-bezier(.42,.05,.8,.64)');
   at(release+(end-release)*.80,pose(x*.22,y*.22-13,depth+19,7,side*10,side*5,.95),'ease-in');
   at(end,pose(depth*-.26,depth*-.28,depth,0,0,0));
   return animate(card,frames,{duration:end,fill:'both'});
  });
  scene.dataset.phase='scattered';
  animate(ring,[
   {offset:0,opacity:0,transform:'translateY(-20px) scale(.35)'},
   {offset:.26*4420/impact,opacity:.7,transform:'translateY(-28px) scale(1)'},
   {offset:orbitEnd/impact,opacity:.45,transform:'translateY(-28px) scale(1.05)'},
   {offset:.91,opacity:.12,transform:'translateY(-23px) scale(.8)'},
   {offset:1,opacity:0,transform:'translateY(-12px) scale(.62)'}
  ],{duration:impact,fill:'both'});
  const burst=animate(flash,[
   {offset:0,opacity:0,transform:'scale(.8)'},
   {offset:.038,opacity:1,transform:'scale(1)'},
   {offset:.11,opacity:.87,transform:'scale(1.06)',easing:'ease-out'},
   {offset:.42,opacity:.14,transform:'scale(1.19)'},
   {offset:1,opacity:0,transform:'scale(1.32)'}
  ],{duration:810,delay:impact-30,fill:'both'});
  animate(wave,[
   {opacity:0,transform:'scale(.27)'},{offset:.09,opacity:.74,transform:'scale(.43)',easing:'cubic-bezier(.12,.67,.23,1)'},
   {offset:.67,opacity:.18,transform:'scale(1.15)'},{opacity:0,transform:'scale(1.43)'}
  ],{duration:690,delay:impact+10,fill:'both'});
  animate(stack,[
   {transform:'translateY(0) scale(1)'},{offset:.18,transform:'translateY(3px) scale(1.022,.965)'},
   {offset:.53,transform:'translateY(-1px) scale(.997,1.009)'},{transform:'translateY(0) scale(1)'}
  ],{duration:310,delay:impact});
  for(const [i,[dx,dy]] of [[-124,-76],[-69,-112],[31,-122],[116,-84],[149,-21],[91,45],[-87,48],[-134,12],[-26,-84],[77,-44]].entries()){
   const spark=node('i');spark.style.setProperty('--w',`${i%3===0?8:4}px`);sparks.append(spark);
   const x=dx*Math.min(1,scene.clientWidth/358), tilt=Math.atan2(dy,x)*180/Math.PI;
   animate(spark,[
    {opacity:0,transform:`translate(${x*.27}px,${dy*.25}px) rotate(${tilt}deg) scaleX(.5)`},
    {offset:.13,opacity:i%3===0?.92:.64,transform:`translate(${x*.55}px,${dy*.55}px) rotate(${tilt}deg) scaleX(1.15)`,easing:'ease-out'},
    {offset:.56,opacity:.4,transform:`translate(${x*.88}px,${dy*.88-3}px) rotate(${tilt}deg) scaleX(.72)`},
    {opacity:0,transform:`translate(${x}px,${dy+18}px) rotate(${tilt+18}deg) scaleX(.23)`}
   ],{duration:390+i%4*85,delay:impact+9+i%4*12,fill:'both'});
  }
  await Promise.all(flights.map(a=>a.finished));
  scene.dataset.phase='aligned';
  air.replaceChildren();
  await burst.finished;
 }finally{
  scene.dataset.phase='aligned';stopScene=null;
  for(const a of animations)a.cancel();
  air.replaceChildren();sparks.replaceChildren();
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
 if(op.kind==='break'){$('breakResult').hidden=true;$('shuffleScene').removeAttribute('data-phase');}
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
   $('breakResult').hidden=true;
   say('Таймер перетасовки сброшен.');
  }
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
