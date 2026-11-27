'use strict';
const $=id=>document.getElementById(id);
const rarities={C:[I18n.text('Обычная','Common'),'♠'],R:[I18n.text('Редкая','Rare'),'✧'],E:[I18n.text('Эпическая','Epic'),'☾'],L:[I18n.text('Легендарная','Legendary'),'♜'],M:[I18n.text('Мифическая','Mythic'),'✦']};
const rarityGroups=[['M',I18n.text('Мифические','Mythic')],['L',I18n.text('Легендарные','Legendary')],['E',I18n.text('Эпические','Epic')],['R',I18n.text('Редкие','Rare')],['C',I18n.text('Обычные','Common')]];
const catalog=window.GRIM_CARDS;
const cards=new Map(catalog.map(c=>[c[0],c]));
const buttons=[...document.querySelectorAll('[data-size]')];
const grants=[...document.querySelectorAll('[data-grant]')];
const testPanel=$('testPanel'), clearConfirm=$('clearConfirm');
const dustConfirm=$('dustConfirm');
const testerButtons=[...grants,$('clearCollection'),$('resetShuffle'),$('clearDust'),$('renewBoard')];
const toolButtons=[...document.querySelectorAll('[data-tool]')];
const local=document.body.dataset.mode==='local';
const tg=local?null:window.Telegram?.WebApp;
const systemMotion=matchMedia('(prefers-reduced-motion: reduce)');
const motion={get matches(){return systemMotion.matches||SettingsUI.noMotion();}};
const frameUrl='/art/card-frame.webp';
async function waitForFrame(image){
 // Decode the actual layer that will rotate. A decorative asset must not strand a draw.
 if(!image.decode)return;
 let timer;
 try{await Promise.race([image.decode().catch(()=>{}),new Promise(resolve=>{timer=setTimeout(resolve,1800);})]);}
 finally{clearTimeout(timer);}
}
let state, shuffleReadyAt=0, offset=0, busy=false, pending=null, art=new Set(), key, syncing=false, canGrantSpins=false;
let shuffleMastery, craftRecipes, huntTarget, seasonEndsAt, drawOdds, huntPortraits, contractTactic, legacyHuntStats;
let spinInfluence=1;
const clock=()=>Math.floor(Date.now()/1000)+offset;
const node=(tag,text,cls)=>{const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(cls)el.className=cls;return el;};
const say=text=>{$('notice').textContent=text;};
const qty=id=>state?.owned[id]||0;

async function api(path,data,signal){
 const options=data===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)};
 const res=await fetch(`/api/${path}`,{...options,signal});
 const out=await res.json();
 if(!res.ok)throw Object.assign(new Error(I18n.serverError(out.error)),{status:res.status});
 return out;
}
function accept(out){
 const seasonChanged=!!state&&state.season!==out.state.season;
 state=out.state;seasonEndsAt=out.seasonEndsAt;huntTarget=out.huntTarget;
 if(seasonChanged){
  resetTable(table(''));resetTable(table('pack-'));
  hasPack=false;$('packRest').hidden=true;$('packGrid').replaceChildren();
  hideShuffleReveal();$('breakResult').hidden=true;
  if(['#hunt','#pack','#detail'].includes(location.hash))history.replaceState(null,'','#home');
  void route();
 }
 offset=out.now-Math.floor(Date.now()/1000);
 shuffleReadyAt=out.shuffleReadyAt??(state.lastBreak?state.lastBreak+7200:0);
 drawOdds=out.drawOdds??drawOdds;huntPortraits=out.huntPortraits??huntPortraits;spinInfluence=out.spinInfluence??spinInfluence;
 contractTactic=out.contractTactic;legacyHuntStats=out.legacyHuntStats;
 warmAlbum();
 if(out.shuffleMastery)shuffleMastery=out.shuffleMastery;
 if(out.craftRecipes)craftRecipes=out.craftRecipes;
 if(out.maxCraftBatch)craftLimit=out.maxCraftBatch;
 if(typeof out.canGrantSpins==='boolean')canGrantSpins=out.canGrantSpins;
}
function remember(){try{if(pending)sessionStorage.setItem(key,JSON.stringify(pending));else sessionStorage.removeItem(key);}catch{}}
const albumArtUrl=id=>`/art/album/${id}.webp`;
function media(id,locked=false,eager=false,preview=false){
 const el=node('span',locked?'◇':rarities[id[4]][1],'media');el.setAttribute('aria-hidden','true');
 if(!locked&&art.has(id)){
  const original=`/art/${id}.webp`, img=new Image();img.alt='';img.loading=eager?'eager':'lazy';img.decoding='async';
  img.onerror=()=>img.remove();
  if(preview)img.onerror=()=>{img.onerror=()=>img.remove();img.src=original;};
  img.src=preview?albumArtUrl(id):original;el.append(img);
 }
 return el;
}
function cardPortrait(id,eager=false,preview=false){
 const portrait=node('span',undefined,'card-portrait');
 portrait.dataset.r=id[4];
 const frame=node('img',undefined,'card-frame');
 frame.alt='';frame.loading=eager?'eager':'lazy';frame.onerror=()=>frame.remove();frame.src=frameUrl;
 portrait.append(media(id,false,eager,preview),frame);
 return portrait;
}
function renderDetail(id){
 const [,name,lore,atk,hp]=cards.get(id), [rarity,mark]=rarities[id[4]];
 $('detail').dataset.r=id[4];
 $('detailArt').replaceChildren(cardPortrait(id,true));
 $('detailTitle').textContent=name;
 $('detailRarity').textContent=`${mark} ${rarity}`;
 $('detailLore').textContent=lore;
 $('detailStats').replaceChildren(...[[I18n.text('Атака','Attack'),atk],[I18n.text('Здоровье','Health'),hp],[I18n.text('Влияние','Influence'),I18n.text(`+${spinInfluence} за крутку`,`+${spinInfluence} per spin`)]].map(([label,value])=>{
  const stat=node('div');stat.append(node('dt',label),node('dd',value));return stat;
 }));
}
function bindDetail(button,id){
 button.dataset.cardId=id;
 button.onclick=()=>{
  const from=targetPane();
  if(activePane!==from||from==='detail'||!$(from).contains(button))return;
  const index=detailTriggers(from,id).indexOf(button);
  history.pushState({cardView:{stamp:pageStamp,id,from,top:window.scrollY,index}},'','#detail');
  route();
 };
}
function roman(n){
 let text='';
 for(const [value,glyph] of [[50,'L'],[40,'XL'],[10,'X'],[9,'IX'],[5,'V'],[4,'IV'],[1,'I']]){
  while(n>=value){text+=glyph;n-=value;}
 }
 return text;
}
function paint(button,id,eager=false,preview=false){
 const [,name]=cards.get(id), r=id[4], portrait=cardPortrait(id,eager,preview);
 button.dataset.r=r;
 portrait.append(node('span',name,'tarot-title'));
 button.replaceChildren(portrait);
 button.setAttribute('aria-label',`${name} · ${rarities[r][0]}`);
 bindDetail(button,id);
}
function tile(id,eager,preview){const b=node('button',undefined,'tile');b.type='button';paint(b,id,eager,preview);return b;}
const albumWarmLimit=9;
const albumWarm=new Map();
function warmAlbum(){
 if(targetPane()==='album')return;
 const ids=rarityGroups.flatMap(([r])=>catalog.filter(([id])=>id[4]===r&&qty(id)).map(([id])=>id)).slice(0,albumWarmLimit);
 for(const id of albumWarm.keys())if(!ids.includes(id))albumWarm.delete(id);
 for(const id of ids){
  if(!art.has(id)||albumWarm.has(id))continue;
  const img=new Image();img.decoding='async';img.fetchPriority='low';img.src=albumArtUrl(id);
  albumWarm.set(id,img);void img.decode().catch(()=>{});
 }
}
let albumKey;
function album(){
 if(!state)return;
 const collected=catalog.filter(([id])=>qty(id)>0);
 const key=collected.map(([id])=>art.has(id)?`${id}+`:id).join(',');
 // Keep the existing image nodes and their loaded artwork on return from detail.
 if(key===albumKey)return;
 let tiles=0;
 const sections=rarityGroups.map(([r,name])=>{
  const all=catalog.filter(([id])=>id[4]===r);
  const owned=collected.filter(([id])=>id[4]===r);
  const section=node('section',undefined,'album-category');
  const header=node('h2',undefined,'album-category-title');
  header.append(node('span',name),node('span',`${owned.length} / ${all.length}`,'album-category-count'));
  section.append(header);
  if(owned.length){
   const grid=node('div',undefined,'grid');
   grid.append(...owned.map(([id])=>tile(id,tiles++<albumWarmLimit,true)));
   section.append(grid);
  }
  return section;
 });
 $('albumGrid').replaceChildren(...sections);
 albumKey=key;
}
const loot=[
 ['dust',I18n.text('1–5 пыли','1–5 dust'),'M12 3l4 9-4 9-4-9zM3 12h2m14 0h2'],
 ['dust2',I18n.text('Пыль ×2','Dust ×2'),'M12 2 14.5 9.5 22 12 14.5 14.5 12 22 9.5 14.5 2 12 9.5 9.5Z'],
 ['spins',I18n.text('3 крутки','3 spins'),'M5 9a7 7 0 0 1 12-3l2 2m0-5v5h-5M19 15a7 7 0 0 1-12 3l-2-2m0 5v-5h5'],
 ['dust10',I18n.text('Пыль ×10','Dust ×10'),'M12 2l2 7 7-2-4 5 4 5-7-2-2 7-2-7-7 2 4-5-4-5 7 2Z'],
 ['legendary',I18n.text('Легендарная карта','Legendary card'),'M6 3h12v18H6zM9 12l3-4 3 4-3 4z'],
 ['mythic',I18n.text('Мифическая карта','Mythic card'),'M5 3h14v18H5zM12 6l1.4 4.6L17 12l-3.6 1.4L12 18l-1.4-4.6L7 12l3.6-1.4z']
];
const percent=new Intl.NumberFormat(I18n.locale,{maximumFractionDigits:2});
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
// Separate silhouettes and two metal tones keep the emblems readable at 32 px.
const craftIcons={
 spins:['M4 10 11 4l17 14-6 8Z M3 13h26v4a2.5 2.5 0 0 0 0 5v5H3v-5a2.5 2.5 0 0 0 0-5Z','M5 15h22M5 25h22M11 16v8M20 16l1.2 2.8L24 20l-2.8 1.2L20 24l-1.2-2.8L16 20l2.8-1.2Z'],
 draw:['M13 7V5a3 3 0 0 1 6 0v2M16 6 27 14l-3 12-8 4-8-4-3-12Z','M8 15l8-6 8 6-2 9-6 3-6-3Z M16 12l2 5 4 2-4 2-2 4-2-4-4-2 4-2Z'],
 shuffle:['M16 2 20 5l5 1 1 5 4 5-4 4-1 5-5 1-4 4-4-4-5-1-1-5-4-4 4-5 1-5 5-1Z','M8 15a8 8 0 0 1 13-5l2 2m0-5v5h-5m6 5a8 8 0 0 1-13 5l-2-2m0 5v-5h5m2-7v6m-3-3h6'],
 arena:['M5 6 16 3l11 3v9c0 6-4 11-11 15C9 26 5 21 5 15Z','M8 8l8-2 8 2v7c0 5-3 9-8 12-5-3-8-7-8-12Z M13 21l8-11-4 1-6 8m-1-2 5 4m-3-2-2 3'],
 arenaHealth:['M5 6 16 3l11 3v9c0 6-4 11-11 15C9 26 5 21 5 15Z','M8 8l8-2 8 2v7c0 5-3 9-8 12-5-3-8-7-8-12Z M16 21l-5-5c-3-4 2-7 5-3 3-4 8-1 5 3Z']
};
const boostInfo={draw:[I18n.text('Талисман удачи','Lucky Talisman'),I18n.text('×1,5 к шансу легендарных и мифических · 10 круток','×1.5 legendary and mythic odds · 10 spins')],shuffle:[I18n.text('Печать мастерства','Seal of Mastery'),I18n.text('Повышает мастерство на 1 уровень на следующие 4 перетасовки','Raises mastery by 1 level for the next 4 shuffles')],arena:[I18n.text('Руна атаки','Attack Rune'),I18n.text('+1 к атаке на арене','+1 attack in the arena')],arenaHealth:[I18n.text('Руна здоровья','Health Rune'),I18n.text('+1 к здоровью на арене','+1 health in the arena')]};
const arenaRunes=new Set(['arena','arenaHealth']);
const materialNames={C:['обычная','обычные','обычных'],R:['редкая','редкие','редких'],E:['эпическая','эпические','эпических'],L:['легендарная','легендарные','легендарных'],M:['мифическая','мифические','мифических']};
function craftIcon(kind){
 const icon=document.createElementNS(svgNS,'svg');
 icon.setAttribute('viewBox','0 0 32 32');icon.setAttribute('class','craft-icon');icon.setAttribute('aria-hidden','true');icon.dataset.kind=kind;
 for(const [i,d] of craftIcons[kind].entries()){
  const path=document.createElementNS(svgNS,'path');path.setAttribute('d',d);
  path.setAttribute('class',i?'craft-engraving':'craft-metal');icon.append(path);
 }
 return icon;
}
const plural=(n,one,few,many)=>n%100>=11&&n%100<=14?many:n%10===1?one:n%10>=2&&n%10<=4?few:many;
const spinLabel=n=>I18n.text(`${n} ${plural(n,'крутка','крутки','круток')}`,`${n} ${n===1?'spin':'spins'}`);
const craftTitle=(recipe,n=1)=>recipe.boost?`${boostInfo[recipe.boost][0]}${n>1?` ×${n}`:''}`:`+${spinLabel(recipe.spins*n)}`;
function materialIcon(kind){
 if(kind==='dust'){
  const icon=$('dust').previousElementSibling.querySelector('svg').cloneNode(true);
  icon.setAttribute('class','craft-material-icon');return icon;
 }
 const icon=document.createElementNS(svgNS,'svg'), path=document.createElementNS(svgNS,'path');
 icon.setAttribute('viewBox','0 0 32 32');icon.setAttribute('class','craft-material-icon');
 icon.setAttribute('aria-hidden','true');icon.dataset.r=kind;
 path.setAttribute('d','M6 23V8l10-4m10 4v16l-10 5-8-4m2-17 7-4 6 3v15l-9 4-4-2Zm5 5 2-3 2 2-2 4Z');
 icon.append(path);return icon;
}
const recipeRows=[], inventoryRows=[];
let craftLimit=1;
function buildCraft(){
 for(const [key,recipe] of Object.entries(craftRecipes)){
  const id=Number(key), {boost}=recipe, row=node('div',undefined,'craft-row craft-recipe');
  const copy=node('div'), title=node('strong',craftTitle(recipe)), amount=node('span');
  const material=node('small',undefined,'craft-material');material.append(materialIcon(recipe.material),amount);
  copy.append(title,material);if(boost)copy.append(node('small',boostInfo[boost][1]));
  const controls=node('div',undefined,'craft-quantity');
  const count=node('input'), max=node('button',I18n.text('Макс.','Max')), reset=node('button',I18n.text('Сброс','Reset'));
  count.type='range';count.min='1';count.max='1';count.step='1';count.value='1';
  const quantity=node('output','×1','craft-batch');
  count.setAttribute('aria-label',I18n.text(`Количество выполнений: ${title.textContent}`,`Crafting quantity: ${title.textContent}`));
  max.type='button';max.setAttribute('aria-label',I18n.text(`Максимальное количество: ${title.textContent}`,`Set maximum quantity: ${title.textContent}`));
  reset.type='button';reset.setAttribute('aria-label',I18n.text(`Сбросить количество до 1: ${title.textContent}`,`Reset quantity to 1: ${title.textContent}`));
  const button=node('button',I18n.text('Создать','Craft'),'primary craft-submit');button.type='button';
  button.setAttribute('aria-label',I18n.text(`Создать: ${title.textContent}`,`Craft: ${title.textContent}`));
  const receipt=node('small',undefined,'craft-receipt');receipt.setAttribute('role','status');
  const entry={recipe,id,amount,material,title,count,quantity,max,reset,button,receipt,limit:0};
  count.oninput=()=>updateRecipe(entry,busy||!!pending);
  count.onkeydown=e=>{if(e.key==='Enter'&&!button.disabled){e.preventDefault();button.click();}};
  max.onclick=()=>{count.value=entry.limit;updateRecipe(entry,busy||!!pending);};
  reset.onclick=()=>{count.value='1';updateRecipe(entry,busy||!!pending);};
  button.onclick=()=>{const n=Number(count.value);count.blur();transact('craft',id,n);};
  controls.append(count,quantity,max,reset);row.append(craftIcon(boost||'spins'),copy,button,controls,receipt);
  $(boost?'craftBoostList':'craftSpinList').append(row);recipeRows.push(entry);
  if(boost){
   const item=node('div',undefined,'craft-row'), info=node('div'), status=node('small');
   const activate=node('button',I18n.text('Активировать','Activate'));activate.type='button';activate.setAttribute('aria-label',I18n.text(`Активировать: ${boostInfo[boost][0]}`,`Activate: ${boostInfo[boost][0]}`));activate.onclick=()=>transact('activate-boost',id);
   info.append(node('strong',boostInfo[boost][0]),status);item.append(craftIcon(boost),info,activate);$('craftInventory').append(item);
   inventoryRows.push({boost,status,button:activate});
  }
 }
}
function updateRecipe({recipe,amount,material,title,count,quantity,max,reset,button,limit,have},blocked){
 const n=Number(count.value), cost=recipe.cost*n, adjectives=materialNames[recipe.material];
 title.textContent=craftTitle(recipe,n);
 const name=adjectives?`${plural(cost,...adjectives)} ${plural(cost,'повторка','повторки','повторок')}`:'пыли';
 const materialEn=adjectives?`${rarities[recipe.material][0].toLowerCase()} ${cost===1?'duplicate':'duplicates'}`:'dust';
 amount.textContent=I18n.text(`${cost} ${name} · есть ${have}`,`${cost} ${materialEn} · have ${have}`);
 material.classList.toggle('insufficient',!limit);
 quantity.value=`×${n}`;
 count.disabled=blocked||limit<=1;
 reset.disabled=blocked||n===1;max.disabled=blocked||n>=limit;
 button.disabled=blocked||!limit;
}
function refreshCraft(blocked){
 if(craftRecipes&&!recipeRows.length)buildCraft();
 const stock={dust:state.dust};
 for(const [id,n] of Object.entries(state.owned))if(cards.has(id))stock[id[4]]=(stock[id[4]]||0)+Math.max(0,n-1);
 const active=state.activeBoosts||{}, inventory=state.boostInventory||{};
 for(const entry of recipeRows){
  entry.have=stock[entry.recipe.material]||0;
  const limit=Math.min(craftLimit,Math.floor(entry.have/entry.recipe.cost));
  if(limit!==entry.limit){
   const previous=Number(entry.count.value);
   entry.count.max=Math.max(1,limit);
   entry.count.value=Math.max(1,Math.min(previous,limit));
  }
  entry.limit=limit;
  updateRecipe(entry,blocked);
 }
 for(const {boost,status,button} of inventoryRows){
  const n=inventory[boost]||0, left=active[boost]||0;
  status.textContent=I18n.text(`В запасе: ${n}${arenaRunes.has(boost)?' · Арена ещё не открыта':left?` · Осталось применений: ${left}`:''}`,`In stock: ${n}${arenaRunes.has(boost)?' · Arena not open yet':left?` · Uses left: ${left}`:''}`);
  button.disabled=blocked||!n||!!left||arenaRunes.has(boost);
 }
 const percent=new Intl.NumberFormat(I18n.lang==='en'?'en-GB':'ru-RU',{style:'percent',maximumFractionDigits:2});
 const fmt=bp=>percent.format(bp/10000).replace(/\s+%/,'%');
 const boosted=drawOdds?.boosted;
 const drawBoost=boosted?I18n.text(`Усиленные шансы: легендарная ${fmt(boosted.L)} · мифическая ${fmt(boosted.M)}`,`Boosted odds: legendary ${fmt(boosted.L)} · mythic ${fmt(boosted.M)}`):I18n.text('×1,5 к шансу легендарных и мифических','×1.5 legendary and mythic odds');
 for(const [id,kind,text] of [['drawBoost','draw',drawBoost],['shuffleBoost','shuffle',I18n.text('+1 к мастерству перетасовки','+1 shuffle mastery')]]){
  const el=$(id), left=active[kind]||0;
  el.hidden=!left;if(left)el.textContent=I18n.text(`${text} · Осталось: ${left}`,`${text} · Uses left: ${left}`);
 }
 const chances=$('drawChances');
 chances.replaceChildren();
 if(drawOdds){
  const list=weights=>Object.entries(rarities).map(([r,[label]])=>`${label} ${fmt(weights[r])}`).join(' · ');
  chances.append(node('span',list(drawOdds.base)));
  if(active.draw)chances.append(node('span',I18n.text(`С усилителем (следующие ${active.draw}): `,`With a booster (next ${active.draw}): `)+list(drawOdds.boosted)));
  chances.append(node('span',I18n.text('Внутри редкости шансы карт равны.','All cards of the same rarity are equally likely.')));
 }
 chances.hidden=!drawOdds;
}
for(const [id,isBoost] of [['craftSpinTab',false],['craftBoostTab',true]])$(id).onclick=()=>{
 $('craftSpinTab').setAttribute('aria-pressed',String(!isBoost));$('craftBoostTab').setAttribute('aria-pressed',String(isBoost));
 $('craftSpinList').hidden=isBoost;$('craftBoostList').hidden=!isBoost;
};
function refreshShuffle(blocked){
 const now=clock(), wait=Math.ceil(Math.max(0,shuffleReadyAt-now)/60);
 $('breakInfo').textContent=wait?I18n.text(`Следующая через ${Math.floor(wait/60)} ч ${wait%60} мин.`,`Next in ${Math.floor(wait/60)}h ${wait%60}m.`):I18n.text('Готово к перетасовке. Повторы не нужны.','Ready to shuffle. No duplicates needed.');
 $('break').disabled=blocked||!!wait;
 if(!shuffleMastery)return;
 const expired=now>=shuffleMastery.resetsAt, count=expired?0:shuffleMastery.count, level=expired?1:shuffleMastery.level;
 [...$('masterySteps').children].forEach((step,i)=>{if(i+1===level)step.setAttribute('aria-current','step');else step.removeAttribute('aria-current');});
 const boosted=(state.activeBoosts?.shuffle||0)>0, effective=level+Number(boosted);
 $('masteryInfo').textContent=I18n.text(`Сегодня: ${count} · Следующая: мастерство ×${effective}${boosted?` (временный уровень ${roman(effective)})`:''} · Сброс в 00:00 UTC`,`Today: ${count} · Next: mastery ×${effective}${boosted?` (temporary level ${roman(effective)})`:''} · Resets at 00:00 UTC`);
 const {weights}=shuffleMastery, total=Object.values(weights).reduce((sum,weight)=>sum+weight,0);
 for(const [kind,chance] of lootRows){
  const points=kind==='dust'?10000-total*effective:weights[kind]*effective;
  chance.textContent=`${percent.format(points/100)}%`;
 }
}
let shuffleRevealTimer=0;
function hideShuffleReveal(){
 clearTimeout(shuffleRevealTimer);
 const reveal=$('shuffleReveal');
 reveal.hidden=true;reveal.replaceChildren();reveal.style.removeProperty('--reveal-hold');
}
function showShuffleReveal(out,title,extra,cardName){
 hideShuffleReveal();
 const reveal=$('shuffleReveal'), hold=out.rewardCard?5000:3000;
 reveal.dataset.kind=out.bonus||'';
 reveal.style.setProperty('--reveal-hold',`${hold}ms`);
 const copy=node('div',undefined,'shuffle-reveal-copy');
 copy.append(node('span',I18n.text('НАГРАДА','REWARD'),'shuffle-reveal-label'),node('strong',title));
 if(extra)copy.append(node('span',extra,'shuffle-reveal-extra'));
 if(cardName)copy.append(node('b',cardName,'shuffle-reveal-name'));
 const crest=out.rewardCard?cardPortrait(out.rewardCard.id):node('span','✦','shuffle-reveal-mark');
 reveal.append(crest,copy);
 reveal.hidden=false;
 shuffleRevealTimer=setTimeout(hideShuffleReveal,hold+440);
}
function showShuffleReward(out){
 const result=$('breakResult');
 result.dataset.kind=out.bonus||'';
 const isSidePrize=out.rewardCard||out.bonus==='spins';
 const title=out.rewardCard?(out.bonus==='mythic'?I18n.text('Мифическая карта','Mythic card'):I18n.text('Легендарная карта','Legendary card')):
  out.bonus==='spins'?I18n.text('+3 крутки','+3 spins'):I18n.text(`+${out.gain} пыли`,`+${out.gain} dust`);
 const notes=[];
 if(out.rewardCard?.new)notes.push(I18n.text('Новая карта','New card'));
 if(out.bonus==='dust2'||out.bonus==='dust10')notes.push(I18n.text(`${out.baseDust} пыли ×${out.bonus==='dust2'?2:10}`,`${out.baseDust} dust ×${out.bonus==='dust2'?2:10}`));
 // Saved receipts from before the change keep their original dust award on retry.
 if(isSidePrize&&out.gain>0)notes.push(I18n.text(`+${out.gain} пыли по старым правилам`,`+${out.gain} dust under the previous rules`));
 const extra=notes.join(' · ');
 result.replaceChildren(node('strong',title));
 if(extra)result.append(node('div',extra));
 const cardName=out.rewardCard&&cards.get(out.rewardCard.id)[1];
 if(out.rewardCard){
  const {id}=out.rewardCard, card=node('button',cardName);card.type='button';bindDetail(card,id);result.append(card);
 }
 result.hidden=false;
 const onShuffle=targetPane()==='tool-shuffle'&&!$('tool-shuffle').hidden;
 if(onShuffle)showShuffleReveal(out,title,extra,cardName);
 say(onShuffle?'':[title,extra,cardName].filter(Boolean).join(' · '));
}
function refresh(){
 if(!state)return;
 const left=state.freeSpins, spins=state.spins??0, rewardSpins=state.rewardSpins??0, blocked=busy||!!pending;
 const total=left+spins+rewardSpins;
 $('totalSpins').textContent=total;$('coins').textContent=state.coins;$('dust').textContent=state.dust;$('influence').textContent=state.influence??0;
 const freeMinutes=Math.ceil(Math.max(0,state.freeNextAt-clock())/60);
 $('free').textContent=I18n.text(`Бесплатные: ${left} из 5`,`Free spins: ${left} of 5`);
 $('freeTimer').textContent=left===5?I18n.text('Запас полный · +1 каждые 3 часа','Full · +1 every 3 hours'):freeMinutes?I18n.text(`Следующая через ${Math.floor(freeMinutes/60)} ч ${freeMinutes%60} мин`,`Next in ${Math.floor(freeMinutes/60)}h ${freeMinutes%60}m`):I18n.text('Обновляем крутки…','Refilling spins…');
 $('testSpins').textContent=I18n.text(`Тестовые крутки: ${spins}`,`Test spins: ${spins}`);
 if(testPanel)testPanel.hidden=!canGrantSpins;
 for(const b of grants)b.disabled=blocked||!canGrantSpins;
 for(const b of buttons){const size=Number(b.dataset.size),cost=Math.max(0,size-total),missing=cost-state.coins;
  const available=I18n.text(`Доступно: ${total}`,`Available: ${total}`);
  const note=missing>0?I18n.text(`Не хватает ${missing} ◉`,`Need ${missing} more ◉`):cost?`${cost} ◉`:available;
  b.replaceChildren(node('b',size===1?I18n.text('Крутить','Spin'):`×${size}`),node('small',size===1?available:note));
  if(size===1&&cost)b.append(node('small',note));
  b.disabled=blocked||missing>0;
 }
 $('clearCollection').disabled=blocked||!canGrantSpins||!Object.keys(state.owned).length;
 $('resetShuffle').disabled=blocked||!canGrantSpins||shuffleReadyAt<=clock();
 $('clearDust').disabled=blocked||!canGrantSpins||!state.dust;
 $('renewBoard').disabled=blocked||!canGrantSpins;
 refreshShuffle(blocked);refreshCraft(blocked);HuntUI.render(blocked);
 $('retry').hidden=!pending||busy;SeasonUI.block(blocked);
}
const panes=['home','album','tool-shuffle','tool-craft','tool-quests','tool-rank','profile','glory','pack','detail','battle','hunt',...SettingsUI.screens];
const rarityRank=new Map(rarityGroups.map(([r],i)=>[r,i]));
let activePane=null, activeDetail=null, transition=null, navigation=0, hasPack=false, stopScene=null;
const main=document.querySelector('main'), pageStamp=crypto.randomUUID();
const detailTriggers=(pane,id)=>[...$(pane).querySelectorAll('[data-card-id]')].filter(b=>b.dataset.cardId===id);
const returnFromDetail=()=>{if(targetPane()==='detail')history.back();};
// The router restores the card's source after it is visible, not during history traversal.
if('scrollRestoration' in history)history.scrollRestoration='manual';
function targetPane(){
 const id=location.hash.slice(1);
 if(/^profile(?:\/[0-9a-f]{24})?$/.test(id))return 'profile';
 if(id==='detail')return history.state?.cardView?.stamp===pageStamp?'detail':'home';
 return panes.includes(id)&&(id!=='pack'||hasPack)?id:'home';
}
function go(id){
 if(location.hash!==`#${id}`)history.pushState(id==='profile'?{profileFrom:targetPane()}:null,'',`#${id}`);
 return route();
}
async function route(){
 const version=++navigation;
 transition?.cancel();
 const id=targetPane();
 if(id==='home'&&['#pack','#detail'].includes(location.hash))history.replaceState(null,'','#home');
 const returning=activeDetail?.from===id?activeDetail:null;
 if(activePane!==id)stopScene?.();
 if(id!=='tool-shuffle')hideShuffleReveal();
 const animate=!main.inert&&activePane&&activePane!==id&&!motion.matches&&$(id).animate;
 if(animate){
  transition=$(activePane).animate([{opacity:1},{opacity:0}],{duration:85,fill:'forwards'});
  try{await transition.finished;}catch{}
  if(version!==navigation)return;
  transition.cancel();
 }
 if(returning&&(id==='home'||id==='pack'))$(id).classList.add('draw-resumed');
 activeDetail=id==='detail'?history.state.cardView:null;
 if(activeDetail)renderDetail(activeDetail.id);
 main.classList.toggle('viewing-card',id==='detail');
 for(const p of panes)$(p).hidden=p!==id;
 activePane=id;
 if(animate){
  const frames=id==='detail'?[{opacity:0,transform:'translateY(14px) scale(.98)'},{opacity:1,transform:'none'}]:[{opacity:0,transform:'translateY(5px)'},{opacity:1,transform:'none'}];
  transition=$(id).animate(frames,{duration:id==='detail'?240:165,easing:'ease-out'});
 }
 for(const a of document.querySelectorAll('nav a')){if(a.hash===`#${['hunt','glory'].includes(id)?'battle':id}`)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');}
 if(id==='album')album();
 void SeasonUI.open(id);
 SettingsUI.open(id);
 if(id==='pack'&&$('notice').querySelector('.notice-link'))say('');
 if(id==='home'&&!clearConfirm.open&&!dustConfirm.open)tg?.BackButton?.hide();else tg?.BackButton?.show();
 window.scrollTo({top:returning?.top??0,behavior:'instant'});
 if(activeDetail)$('detailTitle').focus({preventScroll:true});
 if(!main.inert&&SettingsUI.screens.includes(id)&&!returning)$(`${id}-title`).focus({preventScroll:true});
 if(returning)detailTriggers(id,returning.id)[returning.index]?.focus({preventScroll:true});
}
function table(prefix){
 return {face:$(`${prefix}face`),holder:$(`${prefix}card`),stage:$(`${prefix}stage`),label:$(`${prefix}newCardPanel`),rarity:$(`${prefix}drawRarity`)};
}
function resetTable({face,holder,stage,label,rarity}){
 stage.closest('section').classList.remove('draw-resumed');
 face.hidden=true;face.inert=true;face.replaceChildren();face.removeAttribute('data-r');
 label.hidden=true;rarity.textContent='';rarity.parentElement.classList.remove('shown');stage.removeAttribute('data-r');holder.classList.remove('open');
}
async function flip(entry,{face,holder,stage,label,rarity},pane){
 // Mount the inert face before turning; backface culling hides it until the edge.
 paint(face,entry.id,true);face.setAttribute('aria-hidden','true');face.hidden=false;
 if(!motion.matches)await waitForFrame(face.querySelector('.card-frame'));
 let turn,frame,exposed=false;
 const visible=()=>!$(pane).hidden&&targetPane()===pane;
 const expose=()=>{
  if(exposed)return;
  const r=entry.id[4];
  exposed=true;stage.dataset.r=r;
  rarity.textContent=I18n.text(`Выпала ${rarities[r][0].toLowerCase()}`,`${rarities[r][0]} card drawn`);
  label.hidden=!entry.new;rarity.parentElement.classList.add('shown');
  if(visible())DrawSound.reveal(r);
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
  expose();face.removeAttribute('aria-hidden');face.inert=false;
 }
}
async function reveal(out){
 const list=out.cards;
 if(list.length===1){
  const [entry]=list;
  await flip(entry,table(''),'home');
  return;
 }
 const featured=list.reduce((best,{id},i)=>rarityRank.get(id[4])<rarityRank.get(list[best].id[4])?i:best,0);
 const scene=table('pack-');
 resetTable(scene);
 $('packTitle').textContent=I18n.text(`Результаты ×${list.length}`,`Results ×${list.length}`);
 $('packRest').hidden=true;
 $('packGrid').replaceChildren(...list.flatMap(({id,new:isNew},i)=>{
  if(i===featured)return [];
  const item=node('div',undefined,'pack-entry');item.append(tile(id));
  if(isNew){const slot=node('div',undefined,'pack-new-slot');slot.append(node('span',I18n.text('Новая','New'),'new-card-label'));item.append(slot);}
  return [item];
 }));
 $('summary').textContent=I18n.text(`Новых карт: ${out.newCount} из ${list.length}`,`New cards: ${out.newCount} of ${list.length}`);
 hasPack=true;
 say('');
 if(targetPane()==='home')await go('pack');
 try{await flip(list[featured],scene,'pack');}
 finally{
  $('packRest').hidden=false;
  if(targetPane()!=='pack'){
   const link=node('a',I18n.text(`Смотреть результаты ×${list.length}`,`View results ×${list.length}`),'notice-link');link.href='#pack';$('notice').replaceChildren(link);
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
 const animations=[], timers=[], epoch=document.timeline.currentTime;
 const animate=(el,frames,options)=>{
  const animation=el.animate(frames,options);animations.push(animation);
  if(epoch!=null)animation.startTime=epoch;
  animation.finished.catch(()=>{});
  return animation;
 };
 const angle=(i,t)=>2*Math.PI*(i/8+t*1.08);
 const order=Array.from({length:8},(_,i)=>i).sort((a,b)=>Math.cos(angle(a,1))-Math.cos(angle(b,1)));
 stopScene=()=>{animations.forEach(a=>a.cancel());timers.forEach(clearTimeout);};
 const earlyCues=[[4420*.065,'shuffle-lift'],[4420*.25,'shuffle-orbit'],[orbitEnd+165,'shuffle-fan']];
 for(const [ms,cue] of earlyCues)timers.push(setTimeout(()=>DrawSound.cue(cue),ms));
 for(let i=0;i<8;i++)timers.push(setTimeout(()=>DrawSound.cue('paper'),firstRelease+i*spacing+travel*.6));
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
  timers.forEach(clearTimeout);
  air.replaceChildren();
 }
}

async function craftAtBench(id,quantity){
 const recipe=craftRecipes[id], title=craftTitle(recipe,quantity);
 const onBench=()=>targetPane()==='tool-craft'&&!$('tool-craft').hidden;
 const overlay=$('craftOverlay'), table=$('craftBench'), hammer=$('craftHammer'), bag=$('craftBag'), stack=$('craftStack'), air=$('craftParticles'), item=$('craftItem');
 const receipt=recipeRows.find(row=>row.id===id)?.receipt;
 const confirm=()=>{if(receipt)receipt.textContent=I18n.text(`Создано: ${title}`,`Crafted: ${title}`);};
 if(!onBench()){confirm();say(I18n.text(`Создано: ${title}`,`Crafted: ${title}`));return;}
 say('');
 if(motion.matches||!table.animate){confirm();DrawSound.cue('forge-ready');return;}
 item.hidden=true;overlay.hidden=false;
 const jobs=[], timers=[], epoch=document.timeline.currentTime, duration=1890, strikes=[815,1165,1515];
 const animate=(el,frames,options)=>{
  const a=el.animate(frames,options);jobs.push(a);if(epoch!=null)a.startTime=epoch;a.finished.catch(()=>{});return a;
 };
 const cleanup=()=>{jobs.forEach(a=>a.cancel());timers.forEach(clearTimeout);air.replaceChildren();};
 stopScene=cleanup;
 for(const [i,ms] of strikes.entries())timers.push(setTimeout(()=>DrawSound.cue('hammer',i),ms));
 try{
  const dust=recipe.material==='dust';
  const at=(ms,frame)=>({...frame,offset:ms/duration});
  const pose=(x,y,angle,scale=1)=>`translate(${x}px,${y}px) rotate(${angle}deg) scale(${scale})`;
  if(dust){
   const pour=pose(-58,-49,115);
   animate(bag,[at(0,{opacity:0,transform:pose(-125,-32,-12)}),at(165,{opacity:1,transform:pose(-65,-45,-6)}),at(310,{opacity:1,transform:pour}),at(555,{opacity:1,transform:pour}),at(735,{opacity:0,transform:pose(-128,-35,38)}),at(duration,{opacity:0})],{duration,fill:'both'});
   for(let i=0;i<26;i++){
    const grain=node('i',undefined,'bench-dust');air.append(grain);
    const start=320+8*i, theta=i*2.4, ring=.24+(i%7)*.12;
    const x=Math.cos(theta)*21*ring, y=Math.sin(theta)*11*ring;
    const frames=[at(0,{opacity:0}),at(start,{opacity:0,transform:pose(-40,-40,0)}),at(start+16,{opacity:1,transform:pose(-36,-35,15)}),at(start+145,{opacity:1,transform:pose(x,y,i*35)})];
    for(const [idx,ms] of strikes.entries()){
     const f=1-idx*.24;
     frames.push(at(ms,{opacity:1,transform:pose(x*f,y*f,i*35)}),at(ms+55,{opacity:1,transform:pose(x*(f+.3),y*f-7-i%6,i*51)}),at(ms+135,{opacity:idx===2?0:1,transform:pose(x*(f-.24),y*(f-.24),i*35,idx===2?.2:1)}));
    }
    frames.push(at(duration,{opacity:0}));animate(grain,frames,{duration,fill:'both'});
   }
  }else{
   const first=strikes[0];
   animate(stack,[at(0,{opacity:0,transform:pose(-140,0,-8)}),at(155,{opacity:1,transform:pose(-95,0,-8)}),at(455,{opacity:1,transform:pose(0,0,0),easing:'ease-out'}),at(first,{opacity:1,transform:pose(0,0,0)}),at(first+70,{opacity:0,transform:pose(0,0,0,.65)}),at(duration,{opacity:0})],{duration,fill:'both'});
   for(let i=0;i<14;i++){
    const bit=node('i',undefined,'bench-scrap');bit.dataset.r=recipe.material;air.append(bit);
    const theta=i*2.4, x=Math.cos(theta)*(24+i%6*6), y=Math.sin(theta)*(12+i%5*5);
    const frames=[at(0,{opacity:0}),at(first,{opacity:0,transform:pose(0,0,i*32,.65)}),at(first+52,{opacity:1,transform:pose(x*.86,y*.75-10,i*64)}),at(first+145,{opacity:1,transform:pose(x,y,i*72)})];
    for(const [idx,ms] of strikes.entries())if(idx){
     const f=idx===1?1:.55;
     frames.push(at(ms,{opacity:1,transform:pose(x*f,y*f,i*72)}),at(ms+56,{opacity:1,transform:pose(x*f*.8,y*f-10,i*72+19)}),at(ms+145,{opacity:idx===2?0:1,transform:pose(x*(f-.45),y*(f-.45),i*72,idx===2?.2:1)}));
    }
    frames.push(at(duration,{opacity:0}));animate(bit,frames,{duration,fill:'both'});
   }
  }
  const rest='translate(66px,15px) rotate(-49deg)', raised='translate(62px,-32px) rotate(-60deg)', hit='translate(34px,-4px) rotate(-96deg)';
  const motionFrames=[at(0,{transform:rest})];
  for(const ms of strikes)motionFrames.push(at(ms-205,{transform:raised,easing:'cubic-bezier(.72,0,.9,.42)'}),at(ms,{transform:hit,easing:'ease-out'}),at(ms+105,{transform:raised}));
  motionFrames.push(at(duration,{transform:rest}));
  const finish=animate(hammer,motionFrames,{duration,fill:'both'});
  const impact=$('craftImpact');
  for(const [i,ms] of strikes.entries()){
   animate(impact,[
    {opacity:.88+i*.06,transform:'scale(.42,.6)'},{offset:.23,opacity:.68,transform:'scale(.86)'},
    {opacity:0,transform:'scale(1.27,1.12)'}
   ],{duration:290,delay:ms,easing:'ease-out'});
   animate(table,[{transform:'translateY(0)'},{offset:.12,transform:'translateY(2px)'},{offset:.32,transform:'translateY(-1px)'},{transform:'translateY(0)'}],{duration:145,delay:ms});
  }
  const spread=Math.min(102,table.clientWidth*.31);
  for(const [idx,ms] of strikes.entries())for(let i=0;i<18;i++){
   const ember=i>=12, spark=node('i',undefined,ember?'bench-ember':'bench-spark');air.append(spark);
   const theta=ember?(i-12+.4)*Math.PI/6:(i+.35)*Math.PI/12;
   const x=Math.cos(theta)*spread*(.57+i%5*.11+idx*.09), y=-Math.sin(theta)*(35+i%7*6+idx*6);
   const turn=-theta*180/Math.PI;
   animate(spark,[
    {transform:`translate(0,0) rotate(${turn}deg) scale(.62)`,opacity:1},
    {offset:.54,transform:`translate(${x*.72}px,${y}px) rotate(${turn}deg) scale(${ember?1:.83})`,opacity:.84},
    {transform:`translate(${x}px,${y+(ember?22:7)}px) rotate(${turn}deg) scale(.2)`,opacity:0}
   ],{duration:(ember?332:235)+i%4*10,delay:ms+(ember?23:0),easing:'cubic-bezier(.2,.6,.25,1)'});
  }
  await finish.finished;
 }catch{}finally{
  cleanup();confirm();
  if(onBench()){
   item.dataset.kind=recipe.boost||'spins';
   item.replaceChildren(craftIcon(item.dataset.kind),node('small',I18n.text('СОЗДАНО','CRAFTED')),node('b',title));item.hidden=false;
   DrawSound.cue('forge-ready');
   await new Promise(resolve=>{
    const hold=setTimeout(resolve,680);
    stopScene=()=>{clearTimeout(hold);resolve();};
   });
  }else say(I18n.text(`Создано: ${title}`,`Crafted: ${title}`));
  overlay.hidden=true;stopScene=null;
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
const huntActions=new Set(['take-contract','save-deck','start-hunt','strike','auto-hunt']);
async function transact(kind,size,quantity=1,params){
 if(!state||busy)return;
 if(pending&&kind)return;
 if(!pending){pending={kind,op:crypto.randomUUID(),size,season:state.season,...(kind==='craft'?{quantity}:{}),...params};remember();}
 operationVersion++;
 busy=true;refresh();
 const op=pending, fromNavigation=navigation;
 if(op.kind==='draw'){if(op.size===1)resetTable(table(''));DrawSound.play();}
 if(op.kind!=='edit-profile')DrawSound.prepareQuest();
 if(op.kind==='break'||op.kind==='craft'||huntActions.has(op.kind))DrawSound.unlock();
 if(op.kind==='break'){hideShuffleReveal();$('breakResult').hidden=true;$('shuffleScene').removeAttribute('data-phase');}
 say('');
 let conflict=false;
 try{
  const {kind:action,...payload}=op;
  const out=await api(action,payload);
  const prior=state.fight;
  accept(out);
  pending=null;remember();
  if(!['strike','auto-hunt','edit-profile'].includes(op.kind))HuntUI.showRewards(out.questRewards);
  if(huntActions.has(op.kind))await HuntUI.apply(out,op,prior,fromNavigation);
  else if(op.kind==='edit-profile'){SeasonUI.saved(out.profileIdentity);say(I18n.text('Профиль сохранён.','Profile saved.'));}
  else if(op.kind==='draw'){SettingsUI.drawRecorded();await reveal(out);}
  else if(op.kind==='craft')await craftAtBench(out.crafted,out.craftedQuantity??1);
  else if(op.kind==='activate-boost')say(I18n.text(`Активировано: ${boostInfo[out.activated][0]}`,`Activated: ${boostInfo[out.activated][0]}`));
  else if(op.kind==='grant')say(I18n.text(`Начислено тестовых круток: ${out.granted}`,`Test spins granted: ${out.granted}`));
  else if(op.kind==='clear-collection'){
   resetTable(table(''));resetTable(table('pack-'));
   hasPack=false;$('packRest').hidden=true;$('packGrid').replaceChildren();
   if(location.hash==='#pack')await route();
   say(I18n.text(`Коллекция очищена · удалено видов карт: ${out.removed}`,`Collection cleared · card types removed: ${out.removed}`));
  } else if(op.kind==='reset-shuffle'){
   hideShuffleReveal();$('breakResult').hidden=true;
   say(I18n.text('Таймер перетасовки сброшен.','Shuffle timer reset.'));
  }else if(op.kind==='clear-dust')say(I18n.text(`Пыль обнулена · удалено: ${out.dustRemoved}`,`Dust cleared · removed: ${out.dustRemoved}`));
  else if(op.kind==='renew-board')say(I18n.text('На доске новый комплект объявлений.','New notices are up on the board.'));
  else {
   try{await shuffleDeck();}catch{} // A visual failure must not undo a confirmed operation.
   if(targetPane()==='tool-shuffle')DrawSound.cue('shuffle-ready',!!out.bonus);
   showShuffleReward(out);
  }
 }catch(e){
  if(!pending)say(I18n.text('Операция сохранена, но результат не удалось показать.','The operation was saved, but its result could not be displayed.'));
  else if(e.status===400||e.status===409){conflict=e.status===409;pending=null;remember();say(e.message);}
  else say(e.status===401?I18n.text('Открой игру заново. Запрос сохранён.','Reopen the game. Your request was saved.'):I18n.text('Ответ не получен. Повтори тот же запрос: двойного списания не будет.','No response was received. Retry the same request; you will not be charged twice.'));
 }finally{busy=false;refresh();if(!$('album').hidden)album();}
 if(conflict)sync();
}
function sound(){ $('sound').textContent=DrawSound.enabled?I18n.text('Звук: вкл.','Sound: on'):I18n.text('Звук: выкл.','Sound: off');$('sound').setAttribute('aria-pressed',String(DrawSound.enabled)); }
$('sound').onclick=()=>{DrawSound.toggle();if(DrawSound.enabled)DrawSound.unlock();sound();};sound();
for(const b of buttons)b.onclick=()=>transact('draw',Number(b.dataset.size));
for(const b of grants)b.onclick=()=>{if(canGrantSpins)transact('grant',Number(b.dataset.grant));};
for(const [id,dialog,action] of [['clearCollection',clearConfirm,'clear-collection'],['clearDust',dustConfirm,'clear-dust']]){
 $(id).onclick=()=>{dialog.returnValue='';dialog.showModal();tg?.BackButton?.show();};
 dialog.addEventListener('close',()=>{
  if(targetPane()==='home')tg?.BackButton?.hide();
  if(canGrantSpins&&dialog.returnValue==='clear')transact(action,0);
 });
}
$('renewBoard').onclick=()=>{if(canGrantSpins)transact('renew-board',0);};
$('resetShuffle').onclick=()=>{if(canGrantSpins)transact('reset-shuffle',0);};
$('break').onclick=()=>transact('break',0);$('retry').onclick=()=>transact();
main.addEventListener('click',e=>{
 const link=e.target.closest('a[href^="#"]');
 if(!link||e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;
 e.preventDefault();go(link.hash.slice(1));
});
window.addEventListener('hashchange',route);window.addEventListener('focus',sync);
setInterval(()=>{if(!busy)refresh();if((state?.freeNextAt&&clock()>=state.freeNextAt)||state?.board?.resetsAt<=clock()||seasonEndsAt<=clock())sync();},5000);
$('detailBack').onclick=returnFromDetail;
tg?.BackButton?.onClick(()=>{if(clearConfirm.open)clearConfirm.close('cancel');else if(dustConfirm.open)dustConfirm.close('cancel');else if($('deckPicker').open)$('deckPicker').close();else if(['hunt','glory'].includes(targetPane()))go('battle');else if(targetPane()==='profile')go($('profileBack').hash.slice(1));else if(targetPane()==='detail')returnFromDetail();else if(SettingsUI.screens.slice(1).includes(targetPane()))go('settings');else go('home');});
HuntUI.bind();
SettingsUI.bind();

function gameStyleReady(signal){
 const style=$('gameStyle');
 if(style.media==='all')return Promise.resolve();
 if(style.dataset.failed)return Promise.reject(new Error('game stylesheet unavailable'));
 return new Promise((resolve,reject)=>{
  const cleanup=()=>{
   style.removeEventListener('load',ready);style.removeEventListener('error',failed);
   signal.removeEventListener('abort',failed);
  };
  const ready=()=>{cleanup();resolve();};
  const failed=()=>{cleanup();reject(new Error('game stylesheet unavailable'));};
  style.addEventListener('load',ready);style.addEventListener('error',failed);
  signal.addEventListener('abort',failed,{once:true});
 });
}
async function optionalStartup(promise,fallback,ms){
 let timer;
 try{return await Promise.race([promise.catch(()=>fallback),new Promise(resolve=>{timer=setTimeout(resolve,ms,fallback);})]);}
 finally{clearTimeout(timer);}
}
async function firstScreenArt(){
 const pane=$(activePane), images=[...pane.querySelectorAll('img')].filter(img=>{
  const box=img.getBoundingClientRect();return box.width>0&&box.height>0&&box.bottom>0&&box.top<innerHeight;
 });
 const hasBack=activePane==='home'||activePane==='tool-shuffle';
 const back=hasBack?new Image():null;
 if(back){back.src='/art/GrimDeck_card_back.webp';images.push(back);}
 // Wait only for images in the first viewport. Failed or slow art keeps its styled placeholder.
 const unready=new Set(images);
 await optionalStartup(Promise.all(images.map(async img=>{
  img.loading='eager';await img.decode();unready.delete(img);
 }).map(task=>task.catch(()=>{}))),null,2000);
 for(const img of unready){
  if(img===back){for(const el of pane.querySelectorAll('.back,.stack,.shuffle-stack i'))el.classList.add('startup-back-fallback');}
  else if(img.classList.contains('deck-emblem'))img.style.visibility='hidden';
  else if(activePane!=='album')img.remove();
 }
}
(async()=>{
 if(!grimBoot.start())return;
 const {signal}=grimBoot;
 try{
  tg?.ready();tg?.expand();
  const [session]=await Promise.all([api('session',local?{}:{initData:tg?.initData||''},signal),gameStyleReady(signal)]);
  if(signal.aborted)return;
  key=`grimdeck.pending.${session.player}`;
  try{pending=JSON.parse(sessionStorage.getItem(key));}catch{}
  const artRequest=api('art',undefined,signal);
  const [out,images]=await Promise.all([api('state',undefined,signal),optionalStartup(artRequest,null,2200)]);
  if(signal.aborted)return;
  art=new Set(images??[]);accept(out);refresh();await route();
  if(!images)void artRequest.then(late=>{
   if(signal.aborted)return;
   art=new Set(late);warmAlbum();refresh();
   if(activePane==='album')album();
   if(activeDetail)renderDetail(activeDetail.id);
  }).catch(()=>{});
  say(pending?I18n.text('Предыдущий запрос не завершён. Можно повторить.','The previous request did not finish. You can retry it.'):local?I18n.text('Локальный стенд · стартовый баланс 120 монет','Local test mode · 120 starting crowns'):'');
  await firstScreenArt();
  if(signal.aborted)return;
  grimBoot.show(main);
 }catch(e){grimBoot.fail(e.status?e.message:undefined);}
})();
