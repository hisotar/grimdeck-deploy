'use strict';
const HuntUI=(()=>{
 const t=I18n.text;
 const monsters=new Map([
  ["Альгуль", "Alghoul"],
  ["Главоглаз", "Gazer"],
  ["Земляной элементаль", "Earth Elemental"],
  ["Огненный элементаль", "Fire Elemental"],
  ["Ледяной элементаль", "Ice Elemental"],
  ["Ифрит", "Ifrit"],
  ["Голем", "Golem"],
  ["Волколак", "Werewolf"],
  ["Полуденница", "Noonwraith"],
  ["Полуночница", "Nightwraith"],
  ["Тролль", "Troll"],
  ["Хим", "Hym"],
  ["Катакан", "Katakan"],
  ["Брукса", "Bruxa"],
  ["Леший", "Leshen"],
  ["Вилохвост", "Forktail"],
  ["Грифон", "Griffin"]
 ]);
 const monsterName=name=>t(name,monsters.get(name)??name);
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
     const {coins}=rewards.shift(), unit=I18n.crowns(coins);
     toast.textContent=t(`Задание выполнено · +${coins} ${unit}`,`Quest complete · +${coins} ${unit}`);
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
  const titles={draw:t('Открыть карты','Open cards'),craft:t('Выполнить рецепты','Craft recipes'),break:t('Перетасовать колоду','Shuffle the deck')};
  const notices=state?.board?.notices??[];
  $('questBoard').replaceChildren(...notices.filter(q=>!q.taken).map(q=>{
   const isHunt=q.kind==='hunt', complete=!isHunt&&q.goal===q.progress;
   const paper=node('article',undefined,`quest-paper ${isHunt?'quest-contract':'quest-task'}`);
   paper.dataset.quest=q.id;
   if(complete)paper.classList.add('quest-complete');
   paper.append(node('small',isHunt?t('ЗАКАЗ НА ЧУДОВИЩЕ','MONSTER CONTRACT'):t('ЕЖЕДНЕВНОЕ ЗАДАНИЕ','DAILY QUEST')),node('h2',isHunt?monsterName(q.name):titles[q.kind]),node('b',`◉ ${q.reward} ${I18n.crowns(q.reward)}`,'quest-pay'));
   if(isHunt){
    paper.append(button(state.contract?t('Уже взят заказ','Contract already taken'):t('Сорвать заказ','Take contract'),()=>transact('take-contract',0,1,{contract:q.id}),blocked||!!state.contract));
   }else{
    const count=node('p',t(`Прогресс: ${q.progress} / ${q.goal}`,`Progress: ${q.progress} / ${q.goal}`));
    paper.append(count,node('small',complete?t('✓ Выполнено','✓ Complete'):t('Засчитывается автоматически','Tracked automatically')));
   }
   return paper;
  }));
 }
 function pick(i){
  const selections=slots();pickerSlot=i;
  const choices=$('deckChoices');
  const unset=button(t('Освободить слот','Clear slot'),()=>saveSlot(null),!selections[i]);
  choices.replaceChildren(unset,...catalog.filter(([id])=>qty(id)&&(!selections.includes(id)||selections[i]===id)).map(([id,name,,atk,hp])=>{
   const b=button(`${name} · ⚔ ${atk} · ♥ ${hp}`,()=>saveSlot(id),selections[i]===id);
   b.prepend(media(id));return b;
  }));
  if(!Object.keys(state.owned).length)choices.append(node('p',t('Сначала открой хотя бы одну карту.','Open at least one card first.')));
  $('deckPickerTitle').textContent=i<3?t(`Фронт · слот ${i+1}`,`Front · slot ${i+1}`):t(`Тыл · слот ${i-2}`,`Rear · slot ${i-2}`);
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
   // Screen the targeted row, then prioritize full damage from the remaining rear slots.
   const defending=contractTactic==='rear'?rear:front;
   defending.push(available.sort(byHp).shift()[0]);
   rear.push(...available.sort(byAtk).splice(0,3-rear.length).map(c=>c[0]));
   front.push(...available.sort(byHp).slice(0,3-front.length).map(c=>c[0]));
  }
  const next=Array.from({length:6},(_,i)=>(i<3?front[i]:rear[i-3])??null);
  transact('save-deck',0,1,{slots:next});
 }
 function table(el, units, editable, blocked, target){
  el.replaceChildren(...[t('Фронт · защита','Front · defense'),t('Тыл · атака','Rear · attack')].map((title,row)=>{
   const band=node('div',undefined,'battle-band');
   const label=node('h2',title);label.dataset.emblem=row?'✦':'⬟';band.append(label);
   const grid=node('div',undefined,'battle-slots');
   for(let i=row*3;i<row*3+3;i++){
    const unit=units[i], cid=editable?unit:unit?.id, c=cards.get(cid);
    const el=editable?button(undefined,()=>pick(i),blocked):node('div');
    el.classList.add('battle-slot');el.dataset.slot=i;
    if(c){
     const stats=node('small',undefined,'battle-stats');
     const atk=editable?c[3]:unit.atk;
     const attack=node('span',`⚔ ${i<3?Math.ceil(atk/2):atk}`,'slot-atk');
     const health=node('span','♥ ','slot-hp');health.append(node('b',editable?c[4]:unit.hp,'unit-hp'));
     stats.append(attack,health);el.append(cardPortrait(cid,true),node('b',c[1]),stats);
     if(i===target)el.classList.add('counter-target');
     if(!editable&&!unit.hp)el.classList.add('defeated');
    }else el.append(node('span',editable?'+':'—','slot-empty'));
    if(editable)el.setAttribute('aria-label',t(`${title}, слот ${i%3+1}: ${c?.[1]??'выбрать карту'}`,`${title}, slot ${i%3+1}: ${c?.[1]??'choose a card'}`));
    grid.append(el);
   }
   band.append(grid);return band;
  }));
 }
 function enemy(info){
  const portrait=node('div',undefined,'hunt-portrait');
  const id=info.art??huntPortraits?.[info.name];
  const image=id&&art.has(id)?media(id,false,true).querySelector('img'):null;
  if(image){
   portrait.classList.add('has-art');
   image.className='hunt-image';
   image.onerror=()=>{image.remove();portrait.classList.remove('has-art');};
   portrait.append(image);
  }
  portrait.append(node('span','◇','hunt-sigil'));
  portrait.append(node('h2',monsterName(info.name)));
  if(info.hp!==undefined){
   const health=node('p',t('Здоровье: ','Health: '),'enemy-health');
   health.append(node('b',info.hp,'enemy-hp'),` / ${info.maxHp}`);portrait.append(health);
  }
  return portrait;
 }
 function render(blocked){
  if(animating)return;
  const fight=state?.fight, contract=state?.contract;
  const signature=JSON.stringify([state?.board,state?.deck,contract,fight,huntTarget,blocked,!!state,Object.keys(state?.owned??{}),art.size,huntPortraits]);
  if(signature===renderKey)return;
  renderKey=signature;
  board(blocked);
  table($('battleDeck'),slots(),true,blocked||!state);
  $('autoDeck').disabled=blocked||!Object.keys(state?.owned??{}).length;
  $('resetDeck').disabled=blocked||!slots().some(Boolean);
  const panel=$('battleContract');
  panel.replaceChildren(node('p',t('ЗАКАЗ НА ЧУДОВИЩЕ','MONSTER CONTRACT'),'hunt-kicker'));
  if(!contract){
   const link=node('a',t('На доску объявлений →','To the notice board →'),'hunt-link');link.href='#tool-quests';
   panel.append(node('p',t('Нет взятого заказа.','No active contract.')),link);
  }else{
   panel.append(enemy(contract),node('p',t(`Награда: ◉ ${contract.reward}`,`Reward: ◉ ${contract.reward}`), 'hunt-note'));
   const targetsRear=contractTactic==='rear';
   panel.append(node('p',targetsRear?t('Целится в тыл','Targets the rear'):t('Давит на фронт','Targets the front'),'hunt-note'));
   if(fight?.status==='active'){
    const link=node('a',t('Продолжить охоту →','Continue hunting →'),'hunt-link');link.href='#hunt';panel.append(link);
   }else{
    const start=button(t('Выполнить заказ','Start hunt'),()=>transact('start-hunt',0,1,{contract:contract.id}),blocked||!slots().some(Boolean));
    start.classList.add('primary','hunt-wide');panel.append(start);
    if(!slots().some(Boolean))panel.append(node('p',t('Поставь на стол хотя бы одну карту.','Place at least one card on the board.'),'hunt-note'));
   }
  }
  const strike=$('strike');strike.hidden=!fight||fight.status!=='active';strike.disabled=blocked||strike.hidden;
  const intent=$('huntIntent');intent.hidden=true;intent.textContent='';
  $('huntReturn').hidden=!fight||fight.status==='active';
  $('huntDeck').replaceChildren();$('huntOutcome').textContent='';$('huntOutcome').className='';
  const monster=$('huntEnemy');
  const portraitKey=fight?JSON.stringify([fight.id,fight.monster.name,fight.monster.art??huntPortraits?.[fight.monster.name],art.size]):'';
  if(monster.dataset.portrait!==portraitKey){
   monster.replaceChildren(...(fight?[enemy(fight.monster)]:[]));
   monster.dataset.portrait=portraitKey;
  }
  if(fight){
   monster.querySelector('.enemy-hp').textContent=fight.monster.hp;
   table($('huntDeck'),fight.units,false,true,huntTarget);
   if(Number.isInteger(huntTarget)&&fight.status==='active'){
    const name=cards.get(fight.units[huntTarget]?.id)?.[1]??t('карта','card');
    const tactic=fight.monster.tactic==='rear'?t('Целится в тыл','Targets the rear'):t('Давит на фронт','Targets the front');
    intent.hidden=false;intent.textContent=t(`${tactic} · ответ по ${huntTarget<3?'фронту':'тылу'}: ${name} · ${fight.monster.atk} урона`,`${tactic} · counters the ${huntTarget<3?'front':'rear'}: ${name} · ${fight.monster.atk} damage`);
   }
   strike.textContent=t(`Ударить · осталось ${3-fight.turn} из 3`,`Strike · ${3-fight.turn} of 3 left`);
   if(fight.status!=='active')outcome(fight);
  }else $('huntOutcome').textContent=state?t('Нет начатой охоты.','No hunt in progress.'):t('Загружаем охоту…','Loading the hunt…');
 }
 function outcome(fight){
  const o=$('huntOutcome'), won=fight.status==='won';
  o.className=won?'hunt-victory':'hunt-defeat';
  o.textContent=won?t(`Заказ выполнен · +${fight.monster.reward} ◉`,`Contract complete · +${fight.monster.reward} ◉`):t('Заказ провален','Contract failed');
 }
 function animateOutcome(fight){
  if(fight.status!=='active'&&!motion.matches)$('huntOutcome').animate?.([{opacity:0,transform:'scale(.9)'},{opacity:1,transform:'none'}],{duration:330});
 }
 function impact(target, counter, damage){
  const fx=node('span',undefined,`hunt-impact ${counter?'hunt-impact-counter':''}`);
  fx.setAttribute('aria-hidden','true');fx.append(node('b',`−${damage}`));target.append(fx);
  setTimeout(()=>fx.remove(),440);
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
    showRewards(out.questRewards);refresh();animateOutcome(fight);return;
   }
   const version=navigation;
   animating=true;
   try{
    for(const event of strike.events){
     if(navigation!==version||targetPane()!=='hunt')break;
     const el=$('huntDeck').querySelector(`[data-slot="${event.slot}"]`), monster=$('huntEnemy').firstElementChild;
     if(!el||!monster)break;
     const counter=event.unitHp!==undefined;
     const mover=counter?monster:el, target=counter?(el.querySelector('.card-portrait')||el):monster;
     let contact='none', approach;
     if(!motion.matches){
      const a=mover.getBoundingClientRect(), b=target.getBoundingClientRect();
      const x=b.left+b.width/2-a.left-a.width/2, y=b.top+b.height/2-a.top-a.height/2;
      contact=`translate(${x}px,${y}px) scale(${counter ? .36 : .82})`;
      approach=mover.animate?.([
       {transform:'none',zIndex:6},
       {transform:`translate(${-x*.04}px,${counter?-9:8}px) rotate(${counter?4:-5}deg)`,zIndex:6,offset:.32},
       {transform:contact,zIndex:6}
      ],{duration:counter?235:200,fill:'forwards',easing:'cubic-bezier(.56,.04,.73,.68)'});
      await approach?.finished.catch(()=>{});
     }
     approach?.cancel();
     if(navigation!==version||targetPane()!=='hunt')break;
     if(counter){el.querySelector('.unit-hp').textContent=event.unitHp;el.classList.toggle('defeated',!event.unitHp);}
     else monster.querySelector('.enemy-hp').textContent=event.monsterHp;
     DrawSound.cue(counter?'hunt-counter':'hunt-hit');
     if(!motion.matches){
      impact(target,counter,event.damage);
      target.animate?.([{transform:'none'},{transform:`translate(${counter?4:-4}px,${counter?5:-3}px) rotate(${counter?4:-2}deg)`,offset:.22},{transform:'none'}],{duration:210});
      await mover.animate?.([{transform:contact,zIndex:6},{transform:'none',zIndex:6}],{duration:counter?240:160,easing:'ease-out'}).finished.catch(()=>{});
     }
    }
   }finally{animating=false;renderKey='';refresh();}
   showRewards(out.questRewards);
   if(navigation===version)animateOutcome(fight);
  }
 }
 function bind(){
  $('autoDeck').onclick=auto;
  $('resetDeck').onclick=()=>transact('save-deck',0,1,{slots:Array(6).fill(null)});
  $('strike').onclick=()=>transact('strike',0,1,{contract:state.fight.id,turn:state.fight.turn});
 }
 return {render,apply,showRewards,bind};
})();
