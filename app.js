(() => {
  'use strict';

  const DATA = window.CURRICULUM;
  if (!DATA) throw new Error('Curriculum data is missing.');

  const STORAGE_KEY = 'dailyEnglishState.v1';
  const DB_NAME = 'dailyEnglishDB';
  const DB_VERSION = 1;
  const BOOK_STORE = 'books';
  const REVIEW_INTERVALS = [1, 3, 7, 14, 30];

  const main = document.getElementById('main-content');
  const pageTitle = document.getElementById('page-title');
  const toastEl = document.getElementById('toast');
  const installBtn = document.getElementById('install-btn');
  const finishDialog = document.getElementById('finish-dialog');

  const grammarByUnit = new Map(DATA.grammar.map(item => [item.unit, item]));
  const vocabByKey = new Map(DATA.vocab.map(item => [`${item.week}-${item.day}`, item]));
  let activeTab = 'today';
  let deferredInstallPrompt = null;
  let toastTimer = null;

  const DEFAULT_STATE = {
    version: 1,
    startedAt: null,
    grammarIndex: 0,
    vocabSession: 0,
    courseDaysCompleted: 0,
    streak: 0,
    lastCompletionDate: null,
    lastCompleted: null,
    history: [],
    wordReview: {},
    grammarBookmarks: [],
    notes: {},
    sourcePdfNames: {},
    finishPromptShown: false
  };

  let state = loadState();
  if (!state.startedAt) {
    state.startedAt = dateKey(new Date());
    saveState();
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return structuredClone(DEFAULT_STATE);
      const parsed = JSON.parse(raw);
      return {
        ...structuredClone(DEFAULT_STATE),
        ...parsed,
        wordReview: parsed.wordReview || {},
        grammarBookmarks: parsed.grammarBookmarks || [],
        notes: parsed.notes || {},
        history: parsed.history || [],
        sourcePdfNames: parsed.sourcePdfNames || {}
      };
    } catch (error) {
      console.warn('Could not read saved state:', error);
      return structuredClone(DEFAULT_STATE);
    }
  }

  function saveState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function dateKey(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function persianDate(date = new Date()) {
    try {
      return new Intl.DateTimeFormat('fa-IR-u-ca-persian', {
        weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
      }).format(date);
    } catch {
      return new Intl.DateTimeFormat('fa-IR', { dateStyle: 'full' }).format(date);
    }
  }

  function percent(value, total) {
    if (!total) return 0;
    return Math.max(0, Math.min(100, Math.round((value / total) * 100)));
  }

  function currentCourseDay() {
    const doneToday = state.lastCompletionDate === dateKey(new Date());
    return doneToday ? Math.max(1, state.courseDaysCompleted) : state.courseDaysCompleted + 1;
  }

  function isDoneToday() {
    return state.lastCompletionDate === dateKey(new Date());
  }

  function sessionInfo(index) {
    if (index == null || index < 0 || index >= DATA.meta.vocabCoreSessions) return null;
    return { index, week: Math.floor(index / 5) + 1, day: (index % 5) + 1 };
  }

  function currentVocabInfo(forDisplay = false) {
    if (forDisplay && isDoneToday() && state.lastCompleted?.vocabSessionIndex != null) {
      return sessionInfo(state.lastCompleted.vocabSessionIndex);
    }
    return sessionInfo(state.vocabSession);
  }

  function getWeekWords(week) {
    const result = [];
    for (let day = 1; day <= 4; day++) {
      const item = vocabByKey.get(`${week}-${day}`);
      if (item?.words) result.push(...item.words);
    }
    return result;
  }

  function grammarForProgress(vocabIndex = state.vocabSession) {
    if (state.grammarIndex < DATA.meta.grammarUnits) {
      const unit = state.grammarIndex + 1;
      return { item: grammarByUnit.get(unit), mode: 'new' };
    }
    if (state.vocabSession >= DATA.meta.vocabCoreSessions) return null;

    const bookmarks = state.grammarBookmarks.filter(n => n >= 1 && n <= DATA.meta.grammarUnits);
    if (bookmarks.length) {
      const offset = Math.max(0, vocabIndex - DATA.meta.grammarUnits);
      const unit = bookmarks[offset % bookmarks.length];
      return { item: grammarByUnit.get(unit), mode: 'review' };
    }
    const offset = Math.max(0, vocabIndex - DATA.meta.grammarUnits);
    const unit = (offset % DATA.meta.grammarUnits) + 1;
    return { item: grammarByUnit.get(unit), mode: 'review' };
  }

  function currentGrammar(forDisplay = false) {
    if (forDisplay && isDoneToday() && state.lastCompleted?.grammarUnit) {
      return {
        item: grammarByUnit.get(state.lastCompleted.grammarUnit),
        mode: state.lastCompleted.grammarMode || 'new'
      };
    }
    return grammarForProgress(state.vocabSession);
  }

  function dueWords(limit = 12) {
    const courseDay = currentCourseDay();
    return Object.entries(state.wordReview)
      .filter(([, info]) => Number(info.dueCourseDay || Infinity) <= courseDay)
      .sort((a, b) => (a[1].dueCourseDay || 0) - (b[1].dueCourseDay || 0))
      .slice(0, limit)
      .map(([word, info]) => ({ word, ...info }));
  }

  function wordStatus(word) {
    return state.wordReview[word.toLowerCase()] || null;
  }

  function rateWord(word, rating) {
    const key = word.toLowerCase();
    const current = state.wordReview[key] || { word, level: 0, dueCourseDay: currentCourseDay() + 1, mistakes: 0 };
    const baseDay = currentCourseDay();

    if (rating === 'hard') {
      current.level = 0;
      current.mistakes = (current.mistakes || 0) + 1;
      current.dueCourseDay = baseDay + 1;
    } else {
      current.level = Math.min((current.level || 0) + 1, REVIEW_INTERVALS.length - 1);
      current.dueCourseDay = baseDay + REVIEW_INTERVALS[current.level];
    }
    current.word = word;
    current.lastRatedDate = dateKey(new Date());
    state.wordReview[key] = current;
    saveState();
    showToast(rating === 'hard' ? `«${word}» فردا دوباره می‌آید.` : `«${word}» برای مرور بعدی زمان‌بندی شد.`);
    render();
  }

  function scheduleNewWords(words, activeCourseDay) {
    for (const word of words) {
      const key = word.toLowerCase();
      if (!state.wordReview[key]) {
        state.wordReview[key] = {
          word,
          level: 0,
          dueCourseDay: activeCourseDay + 1,
          mistakes: 0,
          introducedOn: activeCourseDay
        };
      }
    }
  }

  function updateStreak(today) {
    if (state.lastCompletionDate === today) return;
    if (!state.lastCompletionDate) {
      state.streak = 1;
      return;
    }
    const prev = new Date(`${state.lastCompletionDate}T12:00:00`);
    const now = new Date(`${today}T12:00:00`);
    const diffDays = Math.round((now - prev) / 86400000);
    state.streak = diffDays === 1 ? state.streak + 1 : 1;
  }

  function finishToday() {
    if (isDoneToday()) {
      showToast('جلسه امروز قبلاً ثبت شده است.');
      return;
    }
    if (state.grammarIndex >= DATA.meta.grammarUnits && state.vocabSession >= DATA.meta.vocabCoreSessions) {
      showFinishDialog();
      return;
    }

    const today = dateKey(new Date());
    const activeDay = state.courseDaysCompleted + 1;
    const grammar = currentGrammar(false);
    const vocabInfo = currentVocabInfo(false);

    if (vocabInfo) {
      const source = vocabByKey.get(`${vocabInfo.week}-${vocabInfo.day}`);
      const words = vocabInfo.day <= 4 ? (source?.words || []) : getWeekWords(vocabInfo.week);
      scheduleNewWords(words, activeDay);
    }

    const snapshot = {
      date: today,
      courseDay: activeDay,
      grammarUnit: grammar?.item?.unit || null,
      grammarMode: grammar?.mode || null,
      vocabSessionIndex: vocabInfo?.index ?? null,
      vocabWeek: vocabInfo?.week ?? null,
      vocabDay: vocabInfo?.day ?? null
    };

    if (state.grammarIndex < DATA.meta.grammarUnits) state.grammarIndex += 1;
    if (state.vocabSession < DATA.meta.vocabCoreSessions) state.vocabSession += 1;
    state.courseDaysCompleted += 1;
    updateStreak(today);
    state.lastCompletionDate = today;
    state.lastCompleted = snapshot;
    state.history.push(snapshot);
    state.history = state.history.slice(-365);
    saveState();

    if (state.grammarIndex >= DATA.meta.grammarUnits && state.vocabSession >= DATA.meta.vocabCoreSessions) {
      state.finishPromptShown = true;
      saveState();
      showFinishDialog();
    } else {
      showToast('جلسه امروز ثبت شد. آفرین که پیوستگی را حفظ کردی.');
    }
    render();
  }

  function showFinishDialog() {
    if (typeof finishDialog.showModal === 'function') finishDialog.showModal();
    else alert('هر دو کتاب اصلی تمام شدند. کتاب‌های بعدی را برایم آپلود کن تا دوره را ادامه بدهیم.');
  }

  function showToast(message) {
    clearTimeout(toastTimer);
    toastEl.textContent = message;
    toastEl.classList.add('show');
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2500);
  }

  function speak(word) {
    if (!('speechSynthesis' in window)) {
      showToast('مرورگر شما تلفظ صوتی را پشتیبانی نمی‌کند.');
      return;
    }
    speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(word);
    utterance.lang = 'en-US';
    utterance.rate = 0.88;
    speechSynthesis.speak(utterance);
  }

  // IndexedDB ---------------------------------------------------------------
  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(BOOK_STORE)) db.createObjectStore(BOOK_STORE, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function putBook(id, file) {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(BOOK_STORE, 'readwrite');
      tx.objectStore(BOOK_STORE).put({ id, name: file.name, blob: file, savedAt: Date.now() });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }

  async function getBook(id) {
    const db = await openDb();
    const result = await new Promise((resolve, reject) => {
      const tx = db.transaction(BOOK_STORE, 'readonly');
      const req = tx.objectStore(BOOK_STORE).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return result;
  }

  async function importPdf(kind, file) {
    if (!file) return;
    if (file.type && file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      showToast('فقط فایل PDF انتخاب کن.');
      return;
    }
    try {
      await putBook(kind, file);
      state.sourcePdfNames[kind] = file.name;
      saveState();
      if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
      showToast('PDF با موفقیت داخل اپ ذخیره شد.');
      render();
    } catch (error) {
      console.error(error);
      showToast('ذخیره PDF انجام نشد. فضای ذخیره‌سازی مرورگر را بررسی کن.');
    }
  }

  async function openBookPage(kind, page) {
    const tab = window.open('about:blank', '_blank');
    if (!tab) {
      showToast('مرورگر باز شدن تب جدید را مسدود کرده است.');
      return;
    }
    try {
      const record = await getBook(kind);
      if (!record?.blob) {
        tab.close();
        showToast('اول از بخش تنظیمات، PDF این کتاب را وارد کن.');
        activeTab = 'settings';
        render();
        return;
      }
      const url = URL.createObjectURL(record.blob);
      tab.location.href = `${url}#page=${page}`;
      setTimeout(() => URL.revokeObjectURL(url), 120000);
    } catch (error) {
      console.error(error);
      tab.close();
      showToast('باز کردن PDF ممکن نشد.');
    }
  }

  // Rendering ---------------------------------------------------------------
  function progressBar(label, value, total, extra = '') {
    const pct = percent(value, total);
    return `
      <div class="progress-label"><span>${escapeHtml(label)}</span><span class="ltr">${value}/${total} ${extra}</span></div>
      <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
    `;
  }

  function wordCards(words, due = false) {
    if (!words?.length) return '<div class="empty"><span class="emoji">🧠</span>واژه‌ای برای این بخش نیست.</div>';
    return `<div class="word-grid">${words.map(word => {
      const status = wordStatus(word);
      const level = status ? Math.min(5, (status.level || 0) + 1) : 0;
      return `
        <div class="word-card ${due ? 'due' : ''}">
          <div class="word-main">
            <b>${escapeHtml(word)}</b>
            <div class="subtle">${level ? `مرور ${level}/5` : 'واژه جدید'}</div>
          </div>
          <div class="word-actions">
            <button type="button" data-action="speak" data-word="${escapeHtml(word)}" title="تلفظ">🔊</button>
            <button class="hard" type="button" data-action="rate-hard" data-word="${escapeHtml(word)}" title="سخت بود">↻</button>
            <button class="know" type="button" data-action="rate-know" data-word="${escapeHtml(word)}" title="بلدم">✓</button>
          </div>
        </div>`;
    }).join('')}</div>`;
  }

  function grammarCard(grammar, completedToday = false) {
    if (!grammar?.item) {
      return `
        <section class="card">
          <div class="section-head"><h2>گرامر</h2><span class="badge success">تمام شده</span></div>
          <p class="muted">هر ۱۴۵ واحد اصلی گرامر تمام شده‌اند.</p>
        </section>`;
    }
    const g = grammar.item;
    const modeLabel = grammar.mode === 'review' ? 'مرور دوره‌ای' : 'درس جدید';
    return `
      <section class="card">
        <div class="section-head">
          <div><span class="badge ${grammar.mode === 'review' ? 'warning' : 'primary'}">${modeLabel}</span></div>
          <span class="source-ref">Grammar • Unit ${g.unit}</span>
        </div>
        <div class="subtle">${escapeHtml(g.section)}</div>
        <h2 class="lesson-title">${escapeHtml(g.title)}</h2>
        <div class="checklist">
          <div class="check-item"><span class="check-dot">1</span><div><b>آموزش را بخوان</b><div class="subtle">صفحه توضیح و مثال‌ها را با دقت بخوان.</div></div></div>
          <div class="check-item"><span class="check-dot">2</span><div><b>تمرین را حل کن</b><div class="subtle">بدون نگاه کردن به جواب‌ها، تمرین صفحه بعد را انجام بده.</div></div></div>
          <div class="check-item"><span class="check-dot">3</span><div><b>جواب‌ها را چک کن</b><div class="subtle">اشتباه‌ها را مشخص کن و همان بخش را دوباره بخوان.</div></div></div>
        </div>
        <div class="action-row">
          <button class="btn soft" type="button" data-action="open-grammar" data-page="${g.lessonPdfPage}">صفحه آموزش · ${g.lessonPrintedPage}</button>
          <button class="btn" type="button" data-action="open-grammar" data-page="${g.exercisePdfPage}">صفحه تمرین · ${g.exercisePrintedPage}</button>
        </div>
        ${completedToday ? '<div class="subtle" style="margin-top:10px">این همان گرامری است که امروز ثبت کردی.</div>' : ''}
      </section>`;
  }

  function vocabCard(info, completedToday = false) {
    if (!info) {
      const hard = Object.values(state.wordReview).filter(x => (x.mistakes || 0) > 0).map(x => x.word).slice(0, 20);
      return `
        <section class="card">
          <div class="section-head"><h2>لغت</h2><span class="badge success">هفته ۴۶ تمام شد</span></div>
          <p class="muted">بخش اصلی کتاب لغت تمام شده است. تا اضافه شدن منبع بعدی می‌توانی واژه‌های سخت را مرور کنی.</p>
          ${wordCards(hard)}
        </section>`;
    }

    const item = vocabByKey.get(`${info.week}-${info.day}`);
    const isReview = info.day === 5;
    const words = isReview ? getWeekWords(info.week) : (item?.words || []);
    return `
      <section class="card">
        <div class="section-head">
          <span class="badge ${isReview ? 'warning' : 'primary'}">${isReview ? 'مرور هفتگی' : '۵ واژه جدید'}</span>
          <span class="source-ref">1100 Words • Week ${info.week} / Day ${info.day}</span>
        </div>
        <h2>${isReview ? `مرور ۲۰ واژه هفته ${info.week}` : `لغت‌های امروز`}</h2>
        <p class="muted">${isReview
          ? 'واژه‌های چهار روز قبل را بدون نگاه کردن به معنی‌ها مرور کن، بعد آزمون Day 5 را از کتاب انجام بده.'
          : 'اول متن کوتاه همان صفحه را بخوان، بعد واژه‌ها را در متن و مثال‌ها ببین و تمرین Definitions / Sample Sentences را انجام بده.'}</p>
        ${wordCards(words)}
        <div class="action-row">
          <button class="btn soft" type="button" data-action="open-vocab" data-page="${item?.pdfPage || 1}">باز کردن صفحه کتاب · ${item?.printedPage ?? ''}</button>
        </div>
        ${completedToday ? '<div class="subtle" style="margin-top:10px">این همان بخش لغتی است که امروز ثبت کردی.</div>' : ''}
      </section>`;
  }

  function renderToday() {
    const doneToday = isDoneToday();
    const grammar = currentGrammar(true);
    const vocabInfo = currentVocabInfo(true);
    const due = doneToday ? [] : dueWords(12);
    const gPct = percent(state.grammarIndex, DATA.meta.grammarUnits);
    const vPct = percent(state.vocabSession, DATA.meta.vocabCoreSessions);
    const bothDone = state.grammarIndex >= DATA.meta.grammarUnits && state.vocabSession >= DATA.meta.vocabCoreSessions;
    const today = dateKey(new Date());
    const note = state.notes[today] || '';
    const dayNum = currentCourseDay();

    pageTitle.textContent = 'درس امروز';

    if (bothDone) {
      main.innerHTML = `
        <div class="stack">
          <section class="card hero">
            <span class="badge">دوره اصلی کامل شد</span>
            <h2 style="margin-top:12px">هر دو کتاب را تمام کردی 🎓</h2>
            <p class="muted">برای ادامه، کتاب‌های بعدی را در همین گفت‌وگو برای من آپلود کن تا نسخه بعدی دوره را آماده کنم.</p>
            <div class="metric-grid">
              <div class="metric"><b>145</b><span>واحد گرامر</span></div>
              <div class="metric"><b>46</b><span>هفته لغت</span></div>
              <div class="metric"><b>${state.streak}</b><span>استریک فعلی</span></div>
            </div>
          </section>
          <section class="card"><button class="btn primary wide" type="button" data-action="show-finish">پیام ادامه دوره</button></section>
        </div>`;
      return;
    }

    main.innerHTML = `
      <div class="stack">
        <section class="card hero">
          <div class="row between">
            <div>
              <div class="subtle">${escapeHtml(persianDate())}</div>
              <h2 style="margin:5px 0 4px">${doneToday ? 'جلسه امروز انجام شد ✓' : `جلسه ${dayNum}`}</h2>
              <div class="subtle">برنامه پیشنهادی: حدود ۳۰ تا ۳۵ دقیقه</div>
            </div>
            <span class="badge">🔥 ${state.streak}</span>
          </div>
          <div class="metric-grid">
            <div class="metric"><b>${gPct}%</b><span>گرامر</span></div>
            <div class="metric"><b>${vPct}%</b><span>لغت</span></div>
            <div class="metric"><b>${due.length}</b><span>مرور موعددار</span></div>
          </div>
        </section>

        ${!doneToday && due.length ? `
          <section class="card">
            <div class="section-head"><h2>مرور فاصله‌دار</h2><span class="badge warning">۵ دقیقه</span></div>
            <p class="muted">قبل از درس جدید، این واژه‌ها را از حافظه بازیابی کن. ✓ یعنی «بلدم»، ↻ یعنی «فردا دوباره ببینم».</p>
            ${wordCards(due.map(x => x.word), true)}
          </section>` : ''}

        ${grammarCard(grammar, doneToday)}
        ${vocabCard(vocabInfo, doneToday)}

        <section class="card">
          <div class="section-head"><h2>خروجی فعال</h2><span class="badge">۵ دقیقه</span></div>
          <p class="muted">با ساختار گرامری امروز و حداقل دو واژه امروز، ۳ جمله درباره زندگی یا کار خودت بنویس.</p>
          <textarea id="daily-note" placeholder="Write three sentences here…">${escapeHtml(note)}</textarea>
          <div class="subtle" style="margin-top:8px">متن به‌صورت خودکار روی همین دستگاه ذخیره می‌شود.</div>
        </section>

        <section class="card compact">
          ${doneToday
            ? '<button class="btn success wide" type="button" disabled>✓ جلسه امروز ثبت شده است</button>'
            : '<button class="btn primary wide" type="button" data-action="finish-today">پایان جلسه امروز و ثبت پیشرفت</button>'}
        </section>
      </div>`;
  }

  function renderGrammar() {
    pageTitle.textContent = 'گرامر';
    const currentUnit = state.grammarIndex < DATA.meta.grammarUnits ? state.grammarIndex + 1 : null;
    const sections = new Map();
    for (const item of DATA.grammar) {
      if (!sections.has(item.section)) sections.set(item.section, []);
      sections.get(item.section).push(item);
    }

    main.innerHTML = `
      <div class="stack">
        <section class="card hero">
          <span class="badge">English Grammar in Use</span>
          <h2 style="margin-top:12px">${state.grammarIndex}/${DATA.meta.grammarUnits} واحد اصلی</h2>
          ${progressBar('پیشرفت گرامر', state.grammarIndex, DATA.meta.grammarUnits)}
          <p class="muted" style="margin:12px 0 0">در برنامه روزانه، هر جلسه یک Unit پیش می‌رود. بعد از Unit 145، تا پایان کتاب لغت مرور دوره‌ای فعال می‌شود.</p>
        </section>
        <section class="card">
          <div class="row between"><h2>واحدها</h2><span class="subtle">روی «درس» یا «تمرین» بزن.</span></div>
          ${Array.from(sections.entries()).map(([section, items]) => `
            <details ${items.some(x => x.unit === currentUnit) ? 'open' : ''}>
              <summary class="strong" style="padding:12px 0;cursor:pointer">${escapeHtml(section)}</summary>
              <div class="list">
                ${items.map(g => `
                  <div class="list-item ${g.unit === currentUnit ? 'current' : ''}">
                    <span class="num">${g.unit}</span>
                    <div class="grow ltr"><b>${escapeHtml(g.title)}</b><div class="subtle">pp. ${g.lessonPrintedPage}–${g.exercisePrintedPage}</div></div>
                    <button class="btn small-btn" data-action="open-grammar" data-page="${g.lessonPdfPage}" type="button">درس</button>
                    <button class="btn small-btn" data-action="open-grammar" data-page="${g.exercisePdfPage}" type="button">تمرین</button>
                  </div>`).join('')}
              </div>
            </details>`).join('')}
        </section>
        <section class="card">
          <h2>رفتن به یک Unit مشخص</h2>
          <p class="muted">اگر Study Guide کتاب نشان داد که باید روی یک مبحث خاص کار کنی، می‌توانی نقطه ادامه برنامه را تغییر بدهی.</p>
          <div class="row">
            <input id="jump-unit" type="number" min="1" max="145" placeholder="مثلاً 37" />
            <button class="btn soft" type="button" data-action="jump-grammar">از این Unit ادامه بده</button>
          </div>
        </section>
      </div>`;
  }

  function renderWords() {
    pageTitle.textContent = 'لغت';
    const current = currentVocabInfo(false);
    const currentWeek = current?.week || 46;
    main.innerHTML = `
      <div class="stack">
        <section class="card hero">
          <span class="badge">1100 Words You Need to Know</span>
          <h2 style="margin-top:12px">${Math.min(state.vocabSession, DATA.meta.vocabCoreSessions)}/${DATA.meta.vocabCoreSessions} جلسه اصلی</h2>
          ${progressBar('پیشرفت لغت', Math.min(state.vocabSession, DATA.meta.vocabCoreSessions), DATA.meta.vocabCoreSessions)}
          <p class="muted" style="margin:12px 0 0">هر هفته چهار روز واژه جدید و روز پنجم مرور دارد.</p>
        </section>
        <section class="card">
          <div class="section-head"><h2>هفته‌های کتاب</h2><span class="badge">46 هفته</span></div>
          <div class="list">
            ${Array.from({length:46}, (_,i) => i+1).map(week => {
              const firstSession = (week - 1) * 5;
              const completedInWeek = Math.max(0, Math.min(5, state.vocabSession - firstSession));
              return `
                <div class="list-item ${week === currentWeek && state.vocabSession < 230 ? 'current' : ''}">
                  <span class="num">${week}</span>
                  <div class="grow"><b>هفته ${week}</b><div class="subtle">${completedInWeek}/5 جلسه انجام شده</div></div>
                  <div class="row wrap" style="gap:4px;direction:ltr">
                    ${[1,2,3,4,5].map(day => {
                      const item = vocabByKey.get(`${week}-${day}`);
                      return `<button class="btn small-btn" type="button" data-action="open-vocab" data-page="${item.pdfPage}" title="Week ${week} Day ${day}">${day}</button>`;
                    }).join('')}
                  </div>
                </div>`;
            }).join('')}
          </div>
        </section>
      </div>`;
  }

  function renderProgress() {
    pageTitle.textContent = 'پیشرفت';
    const hardCount = Object.values(state.wordReview).filter(x => (x.mistakes || 0) > 0).length;
    const dueCount = dueWords(9999).length;
    const recent = [...state.history].reverse().slice(0, 14);
    main.innerHTML = `
      <div class="stack">
        <section class="card">
          <div class="stats-grid">
            <div class="stat-card"><span class="muted">روزهای انجام‌شده</span><b>${state.courseDaysCompleted}</b></div>
            <div class="stat-card"><span class="muted">استریک فعلی</span><b>🔥 ${state.streak}</b></div>
            <div class="stat-card"><span class="muted">واژه‌های سخت</span><b>${hardCount}</b></div>
            <div class="stat-card"><span class="muted">مرور موعددار</span><b>${dueCount}</b></div>
          </div>
        </section>
        <section class="card">
          <h2>منابع اصلی</h2>
          ${progressBar('Grammar', state.grammarIndex, DATA.meta.grammarUnits)}
          <div style="height:10px"></div>
          ${progressBar('Vocabulary', state.vocabSession, DATA.meta.vocabCoreSessions)}
        </section>
        <section class="card">
          <div class="section-head"><h2>جلسه‌های اخیر</h2><span class="subtle">حداکثر ۱۴ مورد</span></div>
          ${recent.length ? `<div class="timeline">${recent.map(h => `
            <div class="timeline-item">
              <span class="timeline-date ltr">${escapeHtml(h.date)}</span>
              <span>${h.grammarUnit ? `Grammar U${h.grammarUnit}` : 'Grammar —'} · ${h.vocabWeek ? `Words W${h.vocabWeek}D${h.vocabDay}` : 'Words —'}</span>
            </div>`).join('')}</div>` : '<div class="empty"><span class="emoji">📆</span>هنوز جلسه‌ای ثبت نشده است.</div>'}
        </section>
      </div>`;
  }

  function renderSettings() {
    pageTitle.textContent = 'تنظیمات';
    main.innerHTML = `
      <div class="stack">
        <section class="card">
          <h2>کتاب‌های مرجع</h2>
          <p class="muted">برای اینکه فایل‌های دارای حق نشر وارد GitHub عمومی نشوند، PDFها را یک‌بار روی همین گوشی داخل اپ وارد کن. فایل‌ها در حافظه مرورگر همین دستگاه می‌مانند.</p>
          <div class="status-row">
            <div class="row"><span id="grammar-status-dot" class="status-dot"></span><div><b>English Grammar in Use</b><div id="grammar-status" class="subtle">${escapeHtml(state.sourcePdfNames.grammar || 'هنوز وارد نشده')}</div></div></div>
            <button class="btn soft" type="button" data-action="choose-pdf" data-kind="grammar">انتخاب PDF</button>
          </div>
          <div class="status-row">
            <div class="row"><span id="vocab-status-dot" class="status-dot"></span><div><b>1100 Words You Need to Know</b><div id="vocab-status" class="subtle">${escapeHtml(state.sourcePdfNames.vocab || 'هنوز وارد نشده')}</div></div></div>
            <button class="btn soft" type="button" data-action="choose-pdf" data-kind="vocab">انتخاب PDF</button>
          </div>
          <input id="pdf-input-grammar" class="hidden" type="file" accept="application/pdf,.pdf" data-pdf-kind="grammar" />
          <input id="pdf-input-vocab" class="hidden" type="file" accept="application/pdf,.pdf" data-pdf-kind="vocab" />
        </section>

        <section class="card">
          <h2>نصب روی گوشی</h2>
          <p class="muted">اگر دکمه نصب مرورگر در دسترس باشد، از همین‌جا می‌توانی اپ را نصب کنی. در iPhone از Safari → Share → Add to Home Screen و در Android معمولاً از منوی Chrome → Install app / Add to Home screen استفاده کن.</p>
          <button class="btn primary wide" type="button" data-action="install-app">نصب / راهنمای نصب</button>
        </section>

        <section class="card">
          <h2>پشتیبان پیشرفت</h2>
          <p class="muted">پیشرفت در مرورگر ذخیره می‌شود. برای تعویض گوشی یا مرورگر، فایل پشتیبان بگیر.</p>
          <div class="action-row">
            <button class="btn" type="button" data-action="export-progress">خروجی JSON</button>
            <button class="btn" type="button" data-action="choose-progress-import">بازیابی JSON</button>
          </div>
          <input id="progress-import" class="hidden" type="file" accept="application/json,.json" />
        </section>

        <section class="card">
          <h2>ریست</h2>
          <p class="muted">فقط پیشرفت و یادداشت‌ها پاک می‌شوند؛ PDFهای ذخیره‌شده دست‌نخورده می‌مانند.</p>
          <button class="btn danger wide" type="button" data-action="reset-progress">پاک کردن همه پیشرفت‌ها</button>
        </section>
      </div>`;
    refreshPdfStatuses();
  }

  async function refreshPdfStatuses() {
    if (activeTab !== 'settings') return;
    for (const kind of ['grammar', 'vocab']) {
      try {
        const record = await getBook(kind);
        const dot = document.getElementById(`${kind}-status-dot`);
        const label = document.getElementById(`${kind}-status`);
        if (!dot || !label) continue;
        if (record) {
          dot.classList.add('ok');
          label.textContent = record.name || 'ذخیره شده';
        } else {
          dot.classList.remove('ok');
          label.textContent = 'هنوز وارد نشده';
        }
      } catch { /* ignore status refresh errors */ }
    }
  }

  function render() {
    document.querySelectorAll('.nav-item').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === activeTab));
    if (activeTab === 'today') renderToday();
    else if (activeTab === 'grammar') renderGrammar();
    else if (activeTab === 'words') renderWords();
    else if (activeTab === 'progress') renderProgress();
    else renderSettings();
    window.scrollTo({ top: 0, behavior: 'instant' });
  }

  // Backup / restore --------------------------------------------------------
  function exportProgress() {
    const payload = {
      exportedAt: new Date().toISOString(),
      app: 'Daily English',
      state
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `daily-english-progress-${dateKey(new Date())}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function importProgress(file) {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const incoming = parsed.state || parsed;
      if (typeof incoming.grammarIndex !== 'number' || typeof incoming.vocabSession !== 'number') throw new Error('Invalid backup');
      state = {
        ...structuredClone(DEFAULT_STATE),
        ...incoming,
        grammarIndex: Math.max(0, Math.min(DATA.meta.grammarUnits, incoming.grammarIndex)),
        vocabSession: Math.max(0, Math.min(DATA.meta.vocabCoreSessions, incoming.vocabSession))
      };
      saveState();
      showToast('پشتیبان با موفقیت بازیابی شد.');
      render();
    } catch (error) {
      console.error(error);
      showToast('این فایل پشتیبان معتبر نیست.');
    }
  }

  function resetProgress() {
    const ok = confirm('همه پیشرفت‌ها، استریک، مرورها و یادداشت‌ها پاک شوند؟ PDFهای واردشده باقی می‌مانند.');
    if (!ok) return;
    const pdfNames = { ...state.sourcePdfNames };
    state = structuredClone(DEFAULT_STATE);
    state.startedAt = dateKey(new Date());
    state.sourcePdfNames = pdfNames;
    saveState();
    activeTab = 'today';
    showToast('پیشرفت‌ها ریست شدند.');
    render();
  }

  // Events -----------------------------------------------------------------
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
      activeTab = btn.dataset.tab;
      render();
    });
  });

  main.addEventListener('click', event => {
    const target = event.target.closest('[data-action]');
    if (!target) return;
    const action = target.dataset.action;

    if (action === 'finish-today') finishToday();
    if (action === 'show-finish') showFinishDialog();
    if (action === 'speak') speak(target.dataset.word);
    if (action === 'rate-hard') rateWord(target.dataset.word, 'hard');
    if (action === 'rate-know') rateWord(target.dataset.word, 'know');
    if (action === 'open-grammar') openBookPage('grammar', Number(target.dataset.page));
    if (action === 'open-vocab') openBookPage('vocab', Number(target.dataset.page));

    if (action === 'choose-pdf') {
      document.getElementById(`pdf-input-${target.dataset.kind}`)?.click();
    }
    if (action === 'choose-progress-import') document.getElementById('progress-import')?.click();
    if (action === 'export-progress') exportProgress();
    if (action === 'reset-progress') resetProgress();
    if (action === 'install-app') handleInstall();

    if (action === 'jump-grammar') {
      const input = document.getElementById('jump-unit');
      const unit = Number(input?.value);
      if (!Number.isInteger(unit) || unit < 1 || unit > 145) {
        showToast('شماره Unit باید بین ۱ تا ۱۴۵ باشد.');
        return;
      }
      const ok = confirm(`ادامه برنامه گرامر از Unit ${unit} تنظیم شود؟`);
      if (!ok) return;
      state.grammarIndex = unit - 1;
      saveState();
      showToast(`گرامر از Unit ${unit} ادامه پیدا می‌کند.`);
      render();
    }
  });

  main.addEventListener('change', event => {
    const input = event.target;
    if (input.matches('[data-pdf-kind]')) {
      importPdf(input.dataset.pdfKind, input.files?.[0]);
      input.value = '';
    }
    if (input.id === 'progress-import') {
      importProgress(input.files?.[0]);
      input.value = '';
    }
  });

  main.addEventListener('input', event => {
    if (event.target.id === 'daily-note') {
      state.notes[dateKey(new Date())] = event.target.value;
      saveState();
    }
  });

  document.getElementById('finish-dialog-close').addEventListener('click', () => finishDialog.close());

  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    deferredInstallPrompt = event;
    installBtn.classList.remove('hidden');
  });

  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    installBtn.classList.add('hidden');
    showToast('اپ روی دستگاه نصب شد.');
  });

  installBtn.addEventListener('click', handleInstall);

  async function handleInstall() {
    if (deferredInstallPrompt) {
      deferredInstallPrompt.prompt();
      await deferredInstallPrompt.userChoice.catch(() => null);
      deferredInstallPrompt = null;
      installBtn.classList.add('hidden');
    } else {
      showToast('در iPhone: Safari → Share → Add to Home Screen. در Android: منوی مرورگر → Install app.');
    }
  }

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(err => console.warn('SW registration failed', err)));
  }

  render();
})();
