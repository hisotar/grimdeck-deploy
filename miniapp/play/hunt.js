'use strict';
const HuntUI=(()=>{
 const slots=()=>state?.deck??Array(6).fill(null);
 const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 let renderKey='', animating=false, pickerSlot=null, rewardPlaying=false;
 const rewards=[];
 function button(text, run, disabled=false){
  const b=node('button',text);b.type='button';b.disabled=disabled;b.onclick=run;return b;
 }
 function showRewards(items){
  rewards.push(...(items||[]));
  if(rewardPlaying||!rewards.length)return;
  rewardPlaying=true;
  const toast=$('questToast');
  (async()=>{
   try{
    while(rewards.length){
     const {coins}=rewards.shift(), last=coins%10, teens=coins%100>=11&&coins%100<=14;
     const unit=teens?'крон':last===1?'крона':last>=2&&last<=4?'кроны':'крон';
     toast.textContent=`Задание выполнено · +${coins} ${unit}`;
     toast.classList.add('shown');
     DrawSound.quest();
     await pause(3300);toast.classList.remove('shown');toast.textContent='';
     if(rewards.length)await pause(220);
    }
   }finally{rewardPlaying=false;}
  })();
 }
 function board(blocked){
  $('questHunt').hidden=!state?.contract;
  const titles={draw:'Открыть карты',craft:'Выполнить рецепты',break:'Перетасовать колоду'};
  const notices=state?.board?.notices??[];
  $('questBoard').replaceChildren(...notices.filter(q=>!q.taken).map(q=>{
   const isHunt=q.kind==='hunt', complete=!isHunt&&q.goal===q.progress;
   const paper=node('article',undefined,`quest-paper ${isHunt?'quest-contract':'quest-task'}`);
   paper.dataset.quest=q.id;
   paper.append(node('small',isHunt?'ЗАКАЗ НА ЧУДОВИЩЕ':'ЕЖЕДНЕВНОЕ ЗАДАНИЕ'),node('h2',q.name??titles[q.kind]),node('b',`◉ ${q.reward} ${q.reward===1?'крона':q.reward<5?'кроны':'крон'}`,'quest-pay'));
   if(isHunt){
    paper.append(button(state.contract?'Уже взят заказ':'Сорвать заказ',()=>transact('take-contract',0,1,{contract:q.id}),blocked||!!state.contract));
   }else{
    const count=node('p',`Прогресс: ${q.progress} / ${q.goal}`);
    paper.append(count,node('small',complete?'✓ Выполнено':'Засчитывается автоматически'));
   }
   return paper;
  }));
 }
 function pick(i){
  const selections=slots();pickerSlot=i;
  const choices=$('deckChoices');
  const unset=button('Освободить слот',()=>saveSlot(null),!selections[i]);
  choices.replaceChildren(unset,...catalog.filter(([id])=>qty(id)&&(!selections.includes(id)||selections[i]===id)).map(([id,name,,atk,hp])=>{
   const b=button(`${name} · ⚔ ${atk} · ♥ ${hp}`,()=>saveSlot(id),selections[i]===id);
   b.prepend(media(id));return b;
  }));
  if(!Object.keys(state.owned).length)choices.append(node('p','Сначала открой хотя бы одну карту.'));
  $('deckPickerTitle').textContent=i<3?`Фронт · слот ${i+1}`:`Тыл · слот ${i-2}`;
  $('deckPicker').showModal();tg?.BackButton?.show();
 }
 function saveSlot(id){
  const next=slots().slice();next[pickerSlot]=id;$('deckPicker').close();
  transact('save-deck',0,1,{slots:next});
 }
 function auto(){
  const available=catalog.filter(([id])=>qty(id));
  const byAtk=(a,b)=>b[3]-a[3]||b[4]-a[4]||a[0].localeCompare(b[0]);
  const byHp=(a,b)=>b[4]-a[4]||b[3]-a[3]||a[0].localeCompare(b[0]);
  const front=[], rear=[];
  if(available.length===1)rear.push(available[0][0]);
  else if(available.length){
   // Reserve at least one defender, then prioritize efficient rear damage.
   front.push(available.sort(byHp).shift()[0]);
   rear.push(...available.sort(byAtk).splice(0,3).map(c=>c[0]));
   front.push(...available.sort(byHp).slice(0,2).map(c=>c[0]));
  }
  const next=Array.from({length:6},(_,i)=>(i<3?front[i]:rear[i-3])??null);
  transact('save-deck',0,1,{slots:next});
 }
 function table(el, units, editable, blocked){
  el.replaceChildren(...['Фронт · защита','Тыл · атака'].map((title,row)=>{
   const band=node('div',undefined,'battle-band');
   band.append(node('h2',title));
   const grid=node('div',undefined,'battle-slots');
   for(let i=row*3;i<row*3+3;i++){
    const unit=units[i], cid=editable?unit:unit?.id, c=cards.get(cid);
    const el=editable?button(undefined,()=>pick(i),blocked):node('div');
    el.classList.add('battle-slot');el.dataset.slot=i;
    if(c){
     el.append(cardPortrait(cid,true),node('b',c[1]),node('small',`⚔ ${i<3?Math.ceil(c[3]/2):c[3]} · ♥ `));
     el.lastChild.append(node('span',editable?c[4]:unit.hp,'unit-hp'));
     if(!editable&&!unit.hp)el.classList.add('defeated');
    }else el.append(node('span',editable?'+':'—','slot-empty'));
    if(editable)el.setAttribute('aria-label',`${title}, слот ${i%3+1}: ${c?.[1]??'выбрать карту'}`);
    grid.append(el);
   }
   band.append(grid);return band;
  }));
 }
 function enemy(info){
  const portrait=node('div',undefined,'hunt-portrait');
  if(info.art&&art.has(info.art))portrait.append(media(info.art,false,true));
  else portrait.append(node('span','◇','hunt-sigil'));
  portrait.append(node('h2',info.name));
  if(info.hp!==undefined){
   const health=node('p','Здоровье: ','enemy-health');
   health.append(node('b',info.hp,'enemy-hp'),` / ${info.maxHp}`);portrait.append(health);
  }
  return portrait;
 }
 function render(blocked){
  if(animating)return;
  const fight=state?.fight, contract=state?.contract;
  const signature=JSON.stringify([state?.board,state?.deck,contract,fight,blocked,!!state,Object.keys(state?.owned??{}),art.size]);
  if(signature===renderKey)return;
  renderKey=signature;
  board(blocked);
  table($('battleDeck'),slots(),true,blocked||!state);
  $('autoDeck').disabled=blocked||!Object.keys(state?.owned??{}).length;
  $('resetDeck').disabled=blocked||!slots().some(Boolean);
  const panel=$('battleContract');
  panel.replaceChildren(node('p','ЗАКАЗ НА ЧУДОВИЩЕ','hunt-kicker'));
  if(!contract){
   const link=node('a','На доску объявлений →','hunt-link');link.href='#tool-quests';
   panel.append(node('p','Нет взятого заказа.'),link);
  }else{
   panel.append(enemy(contract),node('p',`Награда: ◉ ${contract.reward}`, 'hunt-note'));
   if(fight?.status==='active'){
    const link=node('a','Продолжить охоту →','hunt-link');link.href='#hunt';panel.append(link);
   }else{
    const start=button('Выполнить заказ',()=>transact('start-hunt',0,1,{contract:contract.id}),blocked||!slots().some(Boolean));
    start.classList.add('primary','hunt-wide');panel.append(start);
    if(!slots().some(Boolean))panel.append(node('p','Поставь на стол хотя бы одну карту.','hunt-note'));
   }
  }
  const strike=$('strike');strike.hidden=!fight||fight.status!=='active';strike.disabled=blocked||strike.hidden;
  $('huntEnemy').replaceChildren();$('huntDeck').replaceChildren();$('huntOutcome').textContent='';
  if(fight){
   $('huntEnemy').append(enemy(fight.monster));
   table($('huntDeck'),fight.units,false,true);
   strike.textContent=`Ударить · осталось ${3-fight.turn} из 3`;
   if(fight.status!=='active')outcome(fight);
  }else $('huntOutcome').textContent=state?'Нет начатой охоты.':'Загружаем охоту…';
 }
 function outcome(fight){
  const o=$('huntOutcome'), won=fight.status==='won';
  o.className=won?'hunt-victory':'hunt-defeat';
  o.textContent=won?`Заказ выполнен · +${fight.monster.reward} ◉`:'Заказ провален';
 }
 async function finish(fight, version){
  if(fight.status==='active'||targetPane()!=='hunt')return;
  outcome(fight);
  if(!motion.matches)$('huntOutcome').animate?.([{opacity:0,transform:'scale(.9)'},{opacity:1,transform:'none'}],{duration:330});
  await pause(1600);
  if(navigation===version&&targetPane()==='hunt'){
   history.replaceState(null,'','#battle');await route();
  }
 }
 async function apply(out, op, prior){
  if(op.kind==='take-contract'){
   const paper=[...$('questBoard').children].find(el=>el.dataset.quest===out.taken);
   if(paper&&!$('tool-quests').hidden){
    DrawSound.cue('paper');
    if(!motion.matches)await paper.animate?.([{transform:'none',opacity:1},{transform:'translate(24px,-28px) rotate(13deg)',opacity:0}],{duration:290,easing:'ease-in',fill:'forwards'}).finished.catch(()=>{});
   }
  }else if(op.kind==='start-hunt'&&targetPane()==='battle'&&state.fight?.status==='active'&&state.fight.id===out.started){
   refresh();await go('hunt');
  }else if(op.kind==='strike'){
   const fight=state.fight, strike=out.strike;
   if(fight?.id!==strike.id||fight.turn!==strike.turn||targetPane()!=='hunt'||$('hunt').hidden){
    showRewards(out.questRewards);return;
   }
   if(prior?.id!==fight.id||prior.turn!==fight.turn-1){
    showRewards(out.questRewards);refresh();await finish(fight,navigation);return;
   }
   const version=navigation;
   animating=true;
   try{
    for(const event of strike.events){
     if(navigation!==version||targetPane()!=='hunt')break;
     const el=$('huntDeck').querySelector(`[data-slot="${event.slot}"]`), monster=$('huntEnemy').firstElementChild;
     if(!el||!monster)break;
     const counter=event.unitHp!==undefined;
     if(!motion.matches){
      const a=el.getBoundingClientRect(), b=monster.getBoundingClientRect();
      const x=b.left+b.width/2-a.left-a.width/2, y=b.top+b.height/2-a.top-a.height/2;
      const mover=counter?monster:el;
      const lift=counter?`translate(${-.30*x}px,${-.30*y}px) scale(.95)`:`translate(${x}px,${y}px) scale(.76)`;
      const flight=mover.animate?.([{transform:'none',zIndex:3},{transform:lift,zIndex:3,offset:.55},{transform:'none',zIndex:3}],{duration:counter?240:360,easing:'ease-in-out'});
      await flight?.finished.catch(()=>{});
     }
     if(navigation!==version||targetPane()!=='hunt')break;
     if(counter){el.querySelector('.unit-hp').textContent=event.unitHp;el.classList.toggle('defeated',!event.unitHp);}
     else monster.querySelector('.enemy-hp').textContent=event.monsterHp;
    }
   }finally{animating=false;renderKey='';refresh();}
   showRewards(out.questRewards);
   if(navigation===version)await finish(fight,version);
  }
 }
 function resumed(){
  if(!busy&&!pending&&targetPane()==='hunt'&&state?.fight&&state.fight.status!=='active')void finish(state.fight,navigation);
 }
 function bind(){
  $('autoDeck').onclick=auto;
  $('resetDeck').onclick=()=>transact('save-deck',0,1,{slots:Array(6).fill(null)});
  $('strike').onclick=()=>transact('strike',0,1,{contract:state.fight.id,turn:state.fight.turn});
 }
 return {render,apply,showRewards,resumed,bind};
})();
