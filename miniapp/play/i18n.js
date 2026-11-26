'use strict';
// I18n.lang is 'ru' or 'en'; text(ru, en) is for trusted UI strings, not inputs.
// Set the language at a stable screen. Reload preserves the URL/hash; it does not
// preserve transient views (e.g. an open dialog or unsaved edits).
const I18n=(()=>{
 const storageKey='grimdeck.language';
 let lang='ru';
 try{if(localStorage.getItem(storageKey)==='en')lang='en';}catch{}
 const text=(ru,en)=>lang==='en'?en:ru;
 function set(next){
  if(next!=='ru'&&next!=='en')return false;
  if(next===lang)return true;
  try{localStorage.setItem(storageKey,next);}catch{return false;}
  location.reload();
  return true;
 }
 // These annotations belong only on static markup. Set text/attributes rather
 // than HTML, and replace only direct text nodes so icons and controls survive.
 const attrs=['aria-label','title','placeholder','alt'];
 const selector=['data-i18n-text',...attrs.map(attr=>`data-i18n-${attr}`)].map(attr=>`[${attr}]`).join(',');
 function applyStatic(){
  document.documentElement.lang=lang;
  if(lang!=='en')return;
  for(const el of document.querySelectorAll(selector)){
   if(el.hasAttribute('data-i18n-text')){
    const label=[...el.childNodes].find(child=>child.nodeType===3&&child.data.trim());
    if(label)label.data=label.data.replace(/\S[\s\S]*\S|\S/,()=>el.getAttribute('data-i18n-text'));
   }
   for(const attr of attrs){
    const translation=el.getAttribute(`data-i18n-${attr}`);
    if(translation!==null)el.setAttribute(attr,translation);
   }
  }
 }
 const errors=new Map([
  ['Профиль не найден','Profile not found'],
  ['Некорректный номер операции','Invalid operation ID'],
  ['Некорректный размер пакета','Invalid pack size'],
  ['Некорректное количество','Invalid quantity'],
  ['Некорректный номер хода','Invalid turn number'],
  ['Операция уже использована','This operation has already been used'],
  ['Операция уже завершена в прошлом сезоне','This operation was completed in the previous season'],
  ['Начался новый сезон. Повтори действие после обновления','A new season has started. Refresh and try again'],
  ['Не хватает пыли','Not enough dust'],
  ['Не хватает повторок этой редкости','Not enough duplicates of this rarity'],
  ['Такой усилитель уже активен','This booster is already active'],
  ['Усилителя нет в инвентаре','This booster is not in your inventory'],
  ['Перетасовка пока недоступна','Shuffling is not available yet'],
  ['Открой игру заново, чтобы войти','Reopen the game to sign in'],
  ['Не удалось войти','Could not sign in'],
  ['Сохранение временно недоступно','Saving is temporarily unavailable'],
  ['Уже взят заказ','You already have a contract'],
  ['Этот заказ больше недоступен','This contract is no longer available'],
  ['У колоды должно быть шесть слотов','Your deck must have six slots'],
  ['Выбери разные карты из своей коллекции','Choose different cards from your collection'],
  ['Заказ недоступен или охота уже началась','The contract is unavailable or the hunt has already started'],
  ['Поставь на стол хотя бы одну карту','Place at least one card on the board'],
  ['Ход уже завершён или охота недоступна','This turn has ended or the hunt is unavailable'],
  ['Выбери, что изменить в профиле','Choose what to change in your profile'],
  ['Некорректное значение','Invalid value'],
  ['Имя должно содержать от 2 до 24 видимых символов','The name must contain 2 to 24 visible characters'],
  ['Такой аватарки нет','Avatar not found'],
  ['Эта рамка пока недоступна','This frame is not available yet']
 ]);
 function serverError(message){
  if(typeof message!=='string'||!message)return text('Запрос не выполнен','Request failed');
  if(lang==='ru')return message;
  const crowns=message.match(/^Не хватает монет: (\d+)$/);
  if(crowns)return `Not enough crowns: ${crowns[1]} short`;
  const limit=message.match(/^Лимит тестовых круток: (\d+)$/);
  if(limit)return `Test spin limit: ${limit[1]}`;
  return errors.get(message)??'Request failed';
 }
 const crowns=n=>text(n%100>=11&&n%100<=14?'крон':n%10===1?'крона':n%10>=2&&n%10<=4?'кроны':'крон',n===1?'crown':'crowns');
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',applyStatic,{once:true});
 else applyStatic();
 return Object.freeze({get lang(){return lang;},get locale(){return text('ru-RU','en-GB');},set,text,serverError,crowns});
})();
