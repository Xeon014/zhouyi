const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const main = $('#main');
const dialog = $('#directory');
const notePanel = $('#note-panel');
const wideNotes = window.matchMedia('(min-width: 1280px)');
const contentVersion = $('meta[name="content-version"]').content;
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const toSimple = window.OpenCC.Converter({from:'t', to:'cn'});
const toTraditional = window.OpenCC.Converter({from:'cn', to:'t'});
const defaults = {script:'simple', theme:'light', mode:'both', font:21, refs:true};
let prefs = {...defaults};
try { prefs = {...defaults, ...JSON.parse(localStorage.getItem('zhouyi-preferences') || '{}')}; } catch {}
if (!['simple','traditional'].includes(prefs.script)) prefs.script = 'simple';
if (!['light','dark'].includes(prefs.theme)) prefs.theme = 'light';
if (!['both','original','translation'].includes(prefs.mode)) prefs.mode = 'both';
if (![19,21,23,25].includes(prefs.font)) prefs.font = 21;
const cv = value => prefs.script === 'traditional' ? toTraditional(String(value)) : String(value);
const text = value => escapeHTML(cv(value));
const normalize = value => toSimple(String(value)).normalize('NFKC').toLowerCase();
const kinds = {original:'原文', translation:'译文', note:'注释', explanation:'说明与总论'};
const cache = new Map();
let catalog, currentChapter, searchData, directoryOpener;
let readingView, chapterEntries = [], noteIndex = new Map(), activeNote = null, noteOpener = null;
let noteModal = false, scrollTick = false;
let renderedHash = '', renderSequence = 0, savedViews = {}, anchorNavigation = false;
try { savedViews = JSON.parse(sessionStorage.getItem('zhouyi-tab-views') || '{}'); } catch {}
history.scrollRestoration = 'manual';

function persistPreferences() {
  try { localStorage.setItem('zhouyi-preferences', JSON.stringify(prefs)); } catch {}
  applyPreferences();
}

function applyPreferences() {
  document.documentElement.dataset.theme = prefs.theme;
  document.documentElement.lang = prefs.script === 'traditional' ? 'zh-Hant' : 'zh-Hans';
  document.documentElement.style.setProperty('--fs', `${prefs.font}px`);
  document.body.classList.toggle('without-refs', !prefs.refs);
  $('#script-toggle').textContent = prefs.script === 'simple' ? '繁' : '简';
  $('#script-toggle').setAttribute('aria-label', cv(prefs.script === 'simple' ? '切换为繁体' : '切换为简体'));
  $('#theme-toggle').textContent = cv(prefs.theme === 'dark' ? '日间' : '夜间');
  $('#theme-toggle').setAttribute('aria-label', cv(prefs.theme === 'dark' ? '切换为日间模式' : '切换为夜间模式'));
  $('meta[name="theme-color"]').content = prefs.theme === 'dark' ? '#191e1b' : '#f5f1e8';
  $$('[data-label]').forEach(el => { el.textContent = cv(el.dataset.label); });
  $('#credit').textContent = cv('黄寿祺、张善文 译注');
  $('footer a').textContent = cv('全书目录 ↑');
  $('.brand span').textContent = cv('原典阅读');
  $('#nav-toggle').textContent = cv('菜单');
  $('.skip').textContent = cv('跳至正文');
  $('#directory-title').textContent = cv('全书目录');
  $('#close-directory').textContent = cv('关闭');
  $('#directory-query').placeholder = cv('卦名或篇名');
  $('#close-note').textContent = cv('关闭');
  $('#close-note').setAttribute('aria-label', cv('关闭注释'));
  $('#previous-note').textContent = cv('上一条');
  $('#next-note').textContent = cv('下一条');
  $('#note-select').setAttribute('aria-label', cv('选择注释'));
  const article = $('.reader-article');
  if (article) {
    article.classList.remove('mode-both', 'mode-original', 'mode-translation');
    article.classList.add(`mode-${prefs.mode}`);
    $$('[data-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.mode === prefs.mode)));
  }
}

async function loadJSON(path) {
  if (!cache.has(path)) cache.set(path, fetch(`${path}?v=${encodeURIComponent(contentVersion)}`).then(response => {
    if (!response.ok) throw new Error('暂时无法打开书页，请检查网络连接后重试。');
    return response.json();
  }).catch(error => { cache.delete(path); throw error; }));
  return cache.get(path);
}

function route(hash = location.hash) {
  const [path, query = ''] = (hash.startsWith('#/') ? hash.slice(1) : '/contents').split('?');
  return {path, params:new URLSearchParams(query)};
}

function url(path, params = {}) {
  const query = new URLSearchParams(Object.entries(params).filter(([, value]) => value !== '' && value != null));
  return `#/${path}${query.size ? '?' + query : ''}`;
}

function saveView() {
  if (!renderedHash || main.getAttribute('aria-busy') === 'true') return;
  savedViews[renderedHash] = {y:window.scrollY,open:$$('details[id][open]', main).map(el => el.id),note:activeNote,opener:noteOpener?.id,noteY:$('#note-scroll').scrollTop};
  const keys = Object.keys(savedViews);
  if (keys.length > 90) delete savedViews[keys[0]];
  try { sessionStorage.setItem('zhouyi-tab-views', JSON.stringify(savedViews)); } catch {}
}

function navigate(hash) {
  if (!hash.startsWith('#/')) return;
  if (location.hash === hash) { const {params} = route(hash); if (params.get('at')) revealTarget(params); }
  else { anchorNavigation = route(hash).params.has('at'); location.hash = hash; }
}

function symbol(chapter) {
  return `<span class="hex-symbol" aria-hidden="true">${[...(chapter.lines || [])].reverse().map(line => `<span class="hex-line ${line.yang ? 'yang' : 'yin'}"></span>`).join('')}</span>`;
}

function chapterLink(chapter) {
  return `<a href="${url(`read/${chapter.id}`)}" ${chapter.id === currentChapter?.id ? 'aria-current="page"' : ''}>${text(chapter.type === 'hexagram' ? `${chapter.number}. ${chapter.name}` : chapter.name)}</a>`;
}

function contents(params) {
  const part = ['upper','lower'].includes(params.get('part')) ? params.get('part') : '';
  const query = params.get('q') || '';
  const chapters = catalog.chapters.filter(ch => ch.type === 'hexagram');
  return `<section aria-labelledby="contents-title"><div class="section-head"><h1 id="contents-title">${text('六十四卦')}</h1></div>
    <div class="directory-tools"><nav class="tabs" aria-label="${text('上下经筛选')}">${[['','全部'],['upper','上经'],['lower','下经']].map(([value,label]) => `<a href="${url('contents',{part:value,q:query})}" ${value === part ? 'aria-current="page"' : ''}>${text(label)}</a>`).join('')}</nav>
    <label class="filter-box"><span class="sr-only">${text('查找卦名')}</span><input id="contents-query" type="search" value="${text(query)}" placeholder="${text('查找卦名或序号')}" autocomplete="off"></label></div>
    <div id="hex-grid" class="hex-grid">${chapters.filter(ch => (!part || ch.part === part) && (!query || normalize(ch.name + ' ' + ch.number).includes(normalize(query)))).map(ch => `<a class="hex-card" href="${url(`read/${ch.id}`)}">${symbol(ch)}<div><span class="meta">${String(ch.number).padStart(2,'0')} · ${text(ch.part === 'upper' ? '上经' : '下经')}</span><h3>${text(ch.name)}</h3></div></a>`).join('')}</div>
    <p id="contents-empty" class="empty" hidden>${text('没有找到这卦，请试试其他卦名。')}</p></section>`;
}

function essays() {
  return `<h1>${text('易传')}</h1><div class="essays-list">${catalog.chapters.filter(ch => ch.type === 'essay').map((ch,index) => `<a class="essay-card" href="${url(`read/${ch.id}`)}"><span class="essay-number">0${index+1}</span><h2>${text(ch.name)}</h2><span aria-hidden="true">→</span></a>`).join('')}</div><p class="essay-related"><a href="#/contents">${text('彖 · 象 · 文言')} →</a></p>`;
}

function sidebar() {
  return `<aside class="sidebar" aria-label="${text('篇内导航')}"><a class="sidebar-title" href="#/contents">${text('全书目录')}</a><nav>${chapterEntries.map(entry => `<a data-section="${entry.id}" href="${url(`read/${currentChapter.id}`,{at:entry.id})}">${text(entry.label)}</a>`).join('')}</nav></aside>`;
}

function notesHTML(notes, id) {
  if (!notes?.length) return '';
  return `<button class="notes-entry" id="${id}-notes" data-note="${notes[0].id}" aria-haspopup="dialog" aria-controls="note-panel">${text('注释')} · ${notes.length}</button>`;
}

function toolbar(isGuide = false) {
  return `<div class="toolbar" aria-label="${text('阅读设置')}"><button id="open-directory">${text('目录')}</button>${isGuide ? '' : `<div class="mode-switch" role="group" aria-label="${text('阅读方式')}">${[['original','原文'],['both','对照'],['translation','译文']].map(([value,label]) => `<button data-mode="${value}" aria-pressed="${prefs.mode === value}">${text(label)}</button>`).join('')}</div>`}
    <details class="settings"><summary>${text('设置')}</summary><div class="settings-box"><label>${text('字号')}<select id="font-select">${[[19,'小'],[21,'标准'],[23,'大'],[25,'特大']].map(([value,label]) => `<option value="${value}" ${prefs.font === value ? 'selected' : ''}>${text(label)}</option>`).join('')}</select></label><label>${text('正文注号')}<select id="refs-select"><option value="show" ${prefs.refs ? 'selected' : ''}>${text('显示')}</option><option value="hide" ${prefs.refs ? '' : 'selected'}>${text('隐藏')}</option></select></label></div></details>${chapterEntries.length ? `<select id="chapter-position" aria-label="${text('篇内导航')}">${chapterEntries.map(entry => `<option value="${entry.id}">${text(entry.label)}</option>`).join('')}</select>` : ''}</div>`;
}

const fragment = (id, source) => cv(readingView?.fragments[id] ?? source);

function pairedText(group) {
  const pairs = readingView?.pairs[group.id] || [group];
  return pairs.map((pair, index) => `<div class="reading-pair" id="${group.id}-part${index+1}"><div class="original">${cv(pair.original)}</div><div class="translation"><span class="layer-label">${text('译文')}</span>${cv(pair.translation)}</div></div>`).join('');
}

function prepareChapter(chapter) {
  noteIndex = new Map();
  const labels = new Map();
  chapterEntries = chapter.groups.map(group => {
    const repeated = chapter.groups.filter(g => g.label === group.label).length > 1;
    const count = (labels.get(group.label) || 0) + 1;
    labels.set(group.label, count);
    const label = group.label + (repeated ? ` · ${count}` : '');
    group.notes.forEach((note, index) => noteIndex.set(note.id, {note,index,notes:group.notes,unit:group.id,label}));
    return {id:group.id,label};
  });
  (chapter.notes || []).forEach((note, index) => noteIndex.set(note.id, {note,index,notes:chapter.notes,unit:chapter.id,label:chapter.name}));
  if (chapter.summary) chapterEntries.push({id:chapter.id+'-summary',label:'总论'});
}

function reading(chapter, params) {
  const from = params.get('from');
  const back = from?.startsWith('#/search') ? `<a class="crumb" href="${escapeHTML(from)}">← ${text('返回检索结果')}</a>` : `<a class="crumb" href="${chapter.type === 'essay' ? '#/essays' : '#/contents'}">${text(chapter.type === 'essay' ? '易传' : '六十四卦')} / ${text(chapter.name)}</a>`;
  const isGuide = chapter.type === 'guide';
  const intro = chapter.type === 'hexagram' ? `${chapter.part === 'upper' ? '上经' : '下经'} · 第${chapter.number}卦` : chapter.type === 'essay' ? '易传' : '读易';
  prepareChapter(chapter);
  let guide = '';
  if (isGuide) {
    const template = document.createElement('template');
    template.innerHTML = fragment(chapter.id+'-content', chapter.content);
    $$('p',template.content).filter(p => /^[一二三四五六七八九十]+、/.test(p.textContent)).forEach((p,index) => {
      p.id = `${chapter.id}-section${index+1}`;
      p.classList.add('guide-heading');
      p.setAttribute('role','heading');
      p.setAttribute('aria-level','2');
      chapterEntries.push({id:p.id,label:p.textContent.split('：')[0]});
    });
    guide = template.innerHTML;
  }
  const mainText = isGuide ? `<div class="guide-body" id="${chapter.id}">${guide}</div>${notesHTML(chapter.notes, chapter.id)}` : chapter.groups.map(group => `<section class="reading-unit" data-kind="${group.kind}" id="${group.id}" aria-labelledby="${group.id}-label"><div class="unit-title"><h2 id="${group.id}-label">${text(chapterEntries.find(e => e.id === group.id).label)}</h2><a href="${url(`read/${chapter.id}`,{at:group.id})}" aria-label="${text('定位到' + group.label)}">§</a></div>${pairedText(group)}<div class="unit-support">${notesHTML(group.notes,group.id)}${group.explanation ? `<details class="explanation-toggle" id="${group.id}-explanation"><summary>${text('说明')}</summary><div class="explanation">${fragment(group.id+'-explanation',group.explanation)}</div></details>` : ''}</div></section>`).join('');
  const all = catalog.chapters.filter(ch => ch.type !== 'guide');
  const index = all.findIndex(ch => ch.id === chapter.id);
  const previous = all[index - 1], next = all[index + 1];
  const pager = isGuide ? '' : `<nav class="pager" aria-label="${text('前后篇目')}">${previous ? `<a href="${url(`read/${previous.id}`)}"><small>← ${text('上一篇')}</small>${text(previous.title)}</a>` : ''}${next ? `<a href="${url(`read/${next.id}`)}"><small>${text('下一篇')} →</small>${text(next.title)}</a>` : ''}</nav>`;
  return `<div class="reader-layout">${sidebar()}<article class="reader-article mode-${prefs.mode}">${back}<header class="chapter-head"><div><p class="eyebrow">${text(intro)}</p><h1>${text(chapter.name)}</h1></div>${chapter.type === 'hexagram' ? symbol(chapter) : ''}</header>${toolbar(isGuide)}${mainText}${chapter.summary ? `<details class="chapter-summary" id="${chapter.id}-summary"><summary>${text('总论')}</summary><div class="summary-body">${fragment(chapter.id+'-summary',chapter.summary)}</div></details>` : ''}${pager}</article></div>`;
}

function excerpt(value, query) {
  const converted = cv(value), needle = normalize(query);
  const at = normalize(converted).indexOf(needle), start = Math.max(0, at - 40);
  const end = Math.min(converted.length, Math.max(start + 145, at + needle.length + 35));
  const content = converted.slice(start, end), local = normalize(content).indexOf(needle);
  const marked = local < 0 ? escapeHTML(content) : escapeHTML(content.slice(0,local)) + '<mark>' + escapeHTML(content.slice(local,local+needle.length)) + '</mark>' + escapeHTML(content.slice(local+needle.length));
  return (start ? '…' : '') + marked + (end < converted.length ? '…' : '');
}

function closeNote(restoreFocus = true) {
  const opener = noteOpener;
  const unit = noteIndex.get(activeNote)?.unit;
  if (notePanel.open) notePanel.close();
  document.body.classList.remove('notes-modal');
  $$('[data-note][aria-expanded="true"]', main).forEach(el => el.setAttribute('aria-expanded','false'));
  activeNote = null;
  noteOpener = null;
  if (restoreFocus) {
    const target = opener?.isConnected && opener.getClientRects().length ? opener : document.getElementById(unit+'-notes');
    target?.focus({preventScroll:true});
  }
}

function showNotePanel() {
  const modal = !wideNotes.matches;
  if (notePanel.open && noteModal !== modal) notePanel.close();
  noteModal = modal;
  document.body.classList.toggle('notes-modal', modal);
  if (!notePanel.open) modal ? notePanel.showModal() : notePanel.show();
}

function openNote(id, opener = null, query = '') {
  const item = noteIndex.get(id);
  if (!item) return;
  const wasOpen = notePanel.open;
  if (opener) noteOpener = opener;
  else if (!noteOpener) noteOpener = document.getElementById(id+'-ref') || document.getElementById(item.unit+'-notes');
  activeNote = id;
  $('#note-title').textContent = cv(`${currentChapter.name} · ${item.label} · 注${item.index+1}`);
  $('#note-scroll').innerHTML = `<div class="note-body" id="${id}">${fragment(id,item.note.html)}</div>`;
  $('#note-select').innerHTML = item.notes.map((note,index) => `<option value="${note.id}" ${note.id === id ? 'selected' : ''}>${text('注')} ${index+1} / ${item.notes.length}</option>`).join('');
  $('#previous-note').disabled = item.index === 0;
  $('#next-note').disabled = item.index === item.notes.length-1;
  $$('[data-note]', main).forEach(el => el.setAttribute('aria-expanded',String(el.dataset.note === id)));
  showNotePanel();
  $('#note-scroll').scrollTop = 0;
  highlightIn($('#note-scroll'),query);
  if (!wasOpen) $('#close-note').focus({preventScroll:true});
}

function updatePosition() {
  if (!currentChapter || !chapterEntries.length) return;
  const toolbarBottom = $('.toolbar').getBoundingClientRect().bottom;
  let current = chapterEntries[0];
  for (const entry of chapterEntries) {
    const element = document.getElementById(entry.id);
    if (element && element.getBoundingClientRect().top <= toolbarBottom + 70) current = entry;
    else break;
  }
  $('#chapter-position').value = current.id;
  $$('[data-section]').forEach(link => link.dataset.section === current.id ? link.setAttribute('aria-current','location') : link.removeAttribute('aria-current'));
  const link = $('.sidebar [aria-current="location"]');
  const side = $('.sidebar');
  if (link && side.getClientRects().length) {
    const rect = link.getBoundingClientRect(), parent = side.getBoundingClientRect();
    if (rect.top < parent.top || rect.bottom > parent.bottom) side.scrollTop += rect.top - parent.top - 60;
  }
}

async function search(params) {
  const query = (params.get('q') || '').trim().slice(0,120);
  const scope = ['original','translation','note','explanation'].includes(params.get('scope')) ? params.get('scope') : 'all';
  const limit = Math.min(6000, Math.max(40, Number(params.get('limit')) || 40));
  let results = [];
  if (query) {
    if (!searchData) searchData = (await loadJSON('data/search.json')).map(record => ({...record, normalized:normalize(record.text)}));
    const needle = normalize(query);
    results = searchData.filter(record => (scope === 'all' || record.kind === scope) && record.normalized.includes(needle));
  }
  const from = location.hash || url('search',{q:query,scope});
  const resultHTML = results.slice(0,limit).map(record => {
    const chapter = catalog.chapters.find(ch => ch.id === record.chapter);
    const target = url(`read/${record.chapter}`,{at:record.unit,layer:record.kind,note:record.note,q:query,from});
    return `<article class="search-result"><a href="${escapeHTML(target)}"><h2>${text(chapter.title)} <small>${text(record.label)} · ${text(kinds[record.kind])}</small></h2><p>${excerpt(record.text,query)}</p></a></article>`;
  }).join('');
  return `<section class="search-page"><h1>${text('检索')}</h1><form class="search-form" id="search-form"><label><span class="sr-only">${text('检索文字')}</span><input id="search-query" name="q" type="search" value="${text(query)}" placeholder="${text('检索全文')}" maxlength="120" required></label><select name="scope" aria-label="${text('检索范围')}">${[['all','全部'],...Object.entries(kinds)].map(([value,label]) => `<option value="${value}" ${scope === value ? 'selected' : ''}>${text(label)}</option>`).join('')}</select><button type="submit">${text('检索')}</button></form>${query ? `<p class="search-status" role="status">${text(`${results.length} 处`)}${results.length > limit ? text(` · 已显示 ${limit} 处`) : ''}</p>${results.length ? resultHTML : `<p class="empty">${text('未找到相符文字')}</p>`}${results.length > limit && limit < 6000 ? `<button class="more-results" data-more="${limit+40}">${text('显示更多')}</button>` : ''}` : ''}</section>`;
}

function openAncestors(element) {
  let parent = element;
  while (parent && parent !== main) { if (parent.tagName === 'DETAILS') parent.open = true; parent = parent.parentElement; }
}

function focusTarget(element) {
  if (!element) return;
  openAncestors(element);
  $$('.target',main).forEach(el => el.classList.remove('target'));
  element.classList.add('target');
  if (!element.matches('button,a,input,select,summary')) element.setAttribute('tabindex','-1');
  element.scrollIntoView({block:'start'});
  element.focus({preventScroll:true});
}

function highlightIn(element, query) {
  if (!query) return;
  const needle = normalize(query);
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {acceptNode:node => node.parentElement.closest('button,summary,mark,.unit-title,.layer-label') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT});
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const index = normalize(node.textContent).indexOf(needle);
    if (index < 0) continue;
    const value = node.textContent, fragment = document.createDocumentFragment();
    fragment.append(document.createTextNode(value.slice(0,index)));
    const mark = document.createElement('mark');
    mark.textContent = value.slice(index,index+needle.length);
    fragment.append(mark,document.createTextNode(value.slice(index+needle.length)));
    node.replaceWith(fragment);
  }
}

function revealTarget(params) {
  const id = params.get('note') || params.get('at');
  if (!id) return;
  const unit = document.getElementById(params.get('at'));
  if (params.get('note') && noteIndex.has(id)) {
    const ref = document.getElementById(id+'-ref');
    focusTarget(ref?.getClientRects().length ? ref : unit);
    openNote(id, ref, params.get('q'));
    return;
  }
  let target = document.getElementById(id);
  if (!target || !main.contains(target)) return;
  const layer = params.get('layer');
  if (layer === 'explanation' && unit?.classList.contains('reading-unit')) target = $(`#${unit.id}-explanation`,unit) || target;
  if (layer === 'translation' && prefs.mode === 'original' || layer === 'original' && prefs.mode === 'translation') { prefs.mode = 'both'; persistPreferences(); }
  if (layer) {
    const contents = ['translation','original'].includes(layer) ? $$('.'+layer,target) : [target];
    contents.forEach(content => highlightIn(content,params.get('q')));
  }
  focusTarget($('mark',target)?.closest('.reading-pair') || target);
}

async function render({preserve = false} = {}) {
  saveView();
  closeNote(false);
  const sequence = ++renderSequence, hash = location.hash || '#/contents';
  const forceTarget = anchorNavigation;
  anchorNavigation = false;
  const {path,params} = route(hash), saved = savedViews[hash];
  currentChapter = null;
  main.setAttribute('aria-busy','true');
  main.innerHTML = `<p class="loading" role="status">${text('正在展开书页……')}</p>`;
  try {
    catalog = await loadJSON('data/catalog.json');
    let content, title = '周易 · 原典阅读';
    let nav = path === '/essays' ? 'essays' : path === '/search' ? 'search' : 'contents';
    if (path === '/contents') content = contents(params);
    else if (path === '/essays') { content = essays(); title = '易传 · 周易'; }
    else if (path === '/search') { content = await search(params); title = '检索 · 周易'; }
    else if (path.startsWith('/read/')) {
      const id = path.slice(6), meta = catalog.chapters.find(ch => ch.id === id);
      if (!meta) throw new Error('没有找到这篇文章，请从目录重新选择。');
      const [chapter, view] = await Promise.all([loadJSON(`data/chapters/${id}.json`),loadJSON(`data/reading/${id}.json`)]);
      if (sequence !== renderSequence) return;
      currentChapter = chapter;
      readingView = view;
      content = reading(chapter,params);
      title = `${chapter.title} · 周易`;
      nav = chapter.type === 'guide' ? 'guide' : chapter.type === 'essay' ? 'essays' : 'contents';
    } else throw new Error('没有找到这个页面，请从目录重新选择。');
    if (sequence !== renderSequence) return;
    main.innerHTML = content;
    document.body.classList.toggle('page-reader',Boolean(currentChapter));
    $$('.note-ref',main).forEach(button => { button.setAttribute('aria-controls','note-panel'); button.setAttribute('aria-haspopup','dialog'); button.setAttribute('aria-expanded','false'); });
    renderedHash = hash;
    document.title = cv(title);
    $$('[data-nav]').forEach(el => el.dataset.nav === nav ? el.setAttribute('aria-current','page') : el.removeAttribute('aria-current'));
    applyPreferences();
    $('.site-head').classList.remove('menu-open');
    $('#nav-toggle').setAttribute('aria-expanded','false');
    const empty = $('#contents-empty');
    if (empty) empty.hidden = Boolean($('#hex-grid').children.length);
    if (saved) saved.open.forEach(id => { const element = document.getElementById(id); if (element?.tagName === 'DETAILS') element.open = true; });
    await new Promise(requestAnimationFrame);
    if (sequence !== renderSequence) return;
    if (params.get('at') && (!saved || forceTarget)) revealTarget(params);
    else {
      if (!preserve) main.focus({preventScroll:true});
      window.scrollTo(0,saved?.y || 0);
      if (saved?.note) {
        openNote(saved.note,document.getElementById(saved.opener));
        $('#note-scroll').scrollTop = saved.noteY || 0;
      }
    }
    updatePosition();
    main.dataset.route = hash;
    main.setAttribute('aria-busy','false');
  } catch (error) {
    if (sequence !== renderSequence) return;
    main.setAttribute('aria-busy','false');
    main.innerHTML = `<div class="error" role="alert"><h1>${text('书页暂未展开')}</h1><p>${text(error.message || '请检查网络连接后重试。')}</p><button id="retry">${text('重试')}</button> <a href="#/contents">${text('返回目录')}</a></div>`;
  }
}

function fillDirectory() {
  if (!catalog) return;
  const query = normalize($('#directory-query').value);
  const matches = catalog.chapters.filter(ch => !query || normalize(`${ch.name} ${ch.number || ''}`).includes(query));
  $('#directory-list').innerHTML = matches.length ? [['upper','上经'],['lower','下经'],['essay','易传'],['guide','读易']].map(([part,label]) => {
    const chapters = matches.filter(ch => ch.part === part || ch.type === part);
    return chapters.length ? `<section><h3>${text(label)}</h3>${chapters.map(ch => chapterLink(ch)).join('')}</section>` : '';
  }).join('') : `<p class="empty">${text('没有找到相符篇目。')}</p>`;
}

document.addEventListener('click', event => {
  const element = event.target.closest('button,a');
  if (!element) return;
  if (element.classList.contains('skip')) { event.preventDefault(); main.focus(); main.scrollIntoView({block:'start'}); return; }
  if (element.matches('a[href^="#/"]') && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey && event.button === 0) {
    event.preventDefault();
    if (dialog.open) dialog.close();
    navigate(element.getAttribute('href'));
    return;
  }
  if (element.dataset.note) openNote(element.dataset.note,element);
  else if (element.id === 'close-note') closeNote();
  else if (['previous-note','next-note'].includes(element.id)) {
    const item = noteIndex.get(activeNote);
    const next = item?.notes[item.index + (element.id === 'next-note' ? 1 : -1)];
    if (next) openNote(next.id);
  } else if (element.dataset.mode) { prefs.mode = element.dataset.mode; persistPreferences(); updatePosition(); }
  else if (element.id === 'script-toggle') { prefs.script = prefs.script === 'simple' ? 'traditional' : 'simple'; persistPreferences(); render({preserve:true}); }
  else if (element.id === 'theme-toggle') { prefs.theme = prefs.theme === 'dark' ? 'light' : 'dark'; persistPreferences(); }
  else if (element.id === 'nav-toggle') { const open = $('.site-head').classList.toggle('menu-open'); element.setAttribute('aria-expanded',String(open)); }
  else if (element.id === 'open-directory') {
    closeNote(false);
    directoryOpener = element;
    $('#directory-query').value = '';
    fillDirectory();
    dialog.showModal();
    $('#directory-query').focus();
    $('#directory-list [aria-current="page"]')?.scrollIntoView({block:'center'});
  } else if (element.id === 'close-directory') dialog.close();
  else if (element.id === 'retry') render();
  else if (element.dataset.more) {
    const {params} = route();
    params.set('limit',element.dataset.more);
    const hash = url('search',Object.fromEntries(params));
    savedViews[hash] = {y:window.scrollY,open:[]};
    navigate(hash);
  }
});

document.addEventListener('change', event => {
  if (event.target.id === 'font-select') { prefs.font = Number(event.target.value); persistPreferences(); }
  if (event.target.id === 'refs-select') { prefs.refs = event.target.value === 'show'; persistPreferences(); }
  if (event.target.id === 'note-select') openNote(event.target.value);
  if (event.target.id === 'chapter-position') navigate(url(`read/${currentChapter.id}`,{at:event.target.value}));
});

document.addEventListener('input', event => {
  if (event.target.id === 'directory-query') fillDirectory();
  if (event.target.id === 'contents-query') {
    const {params} = route();
    params.set('q',event.target.value);
    const content = document.createElement('div');
    content.innerHTML = contents(params);
    $('#hex-grid').innerHTML = $('#hex-grid',content).innerHTML;
    $('#contents-empty').hidden = Boolean($('#hex-grid').children.length);
    const newHash = url('contents',Object.fromEntries(params));
    history.replaceState(null,'',newHash);
    renderedHash = newHash;
    $$('.tabs a').forEach(a => { const parsed = route(a.getAttribute('href')); a.href = url('contents',{part:parsed.params.get('part'),q:event.target.value}); });
  }
});

document.addEventListener('submit', event => {
  if (event.target.id !== 'search-form') return;
  event.preventDefault();
  const form = new FormData(event.target);
  navigate(url('search',{q:String(form.get('q')).trim(),scope:form.get('scope')}));
});

dialog.addEventListener('close', () => { if (directoryOpener?.isConnected) directoryOpener.focus({preventScroll:true}); });
dialog.addEventListener('click', event => { if (event.target === dialog && event.clientX < dialog.getBoundingClientRect().left) dialog.close(); });
notePanel.addEventListener('cancel', event => { event.preventDefault(); closeNote(); });
notePanel.addEventListener('click', event => {
  const rect = notePanel.getBoundingClientRect();
  if (event.target === notePanel && (event.clientY < rect.top || event.clientX < rect.left)) closeNote();
});
wideNotes.addEventListener('change', () => { if (notePanel.open) showNotePanel(); });
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && notePanel.open) { event.preventDefault(); closeNote(); return; }
  if (event.key === 'Escape' && dialog.open) { event.preventDefault(); dialog.close(); return; }
  if (event.key === 'Escape' && !dialog.open) {
    const settings = $('.settings[open]');
    if (settings) { settings.open = false; $('summary',settings).focus(); }
    $('.site-head').classList.remove('menu-open');
    $('#nav-toggle').setAttribute('aria-expanded','false');
  }
});
window.addEventListener('hashchange', () => render());
window.addEventListener('pagehide',saveView);
window.addEventListener('scroll', () => {
  if (!scrollTick) requestAnimationFrame(() => { scrollTick = false; updatePosition(); });
  scrollTick = true;
}, {passive:true});
applyPreferences();
render();
