/* ============================================================
   엔진 (대본을 읽어 화면을 그립니다)
   대본을 쓰는 사람은 이 파일을 고칠 필요가 없습니다.
   ============================================================ */
"use strict";

let CONFIG, CAST, EVIDENCE, PEOPLE, SCENES, LOCKS, MAX_HP, ORIGINAL_DESC, GAME_ID;
let STORY_ERRORS = [];

const $ = id => document.getElementById(id);
const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const S = {
  scene: null, queue: [], onDone: null, typing: false, typeTimer: null, fullText: "",
  ev: [], people: [], fresh: new Set(), seen: new Set(), hp: 5, court: false,
  stmt: 0, idle: null, recordTab: "ev", recordSel: null, presentCb: null,
  unlocked: new Set(), lock: null, pendingLock: null, shown: new Set(), revealed: new Set(), pressed: new Set(), revealNow: false, keepMid: false, descs: {}, names: {}, checkpoint: null, placeAt: {}, gameover: false,
  cards: [], cardsAt: {}
};

function setPlace(time, loc) {
  $("time").textContent = time || ""; $("loc").textContent = loc || "";
  $("placard").hidden = !time && !loc;
}

function toast(msg) {
  const t = document.createElement("div");
  t.className = "toast"; t.textContent = msg; t.setAttribute("role", "status");
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2400);
}

function renderHP() {
  const el = $("hp");
  el.hidden = !(S.court || S.lock);
  el.innerHTML = "";
  for (let i = 0; i < MAX_HP; i++) {
    const s = document.createElement("span");
    if (i >= S.hp) s.className = "off";
    el.appendChild(s);
  }
}

/* 받침에 맞는 조사. josa("권총", "을를") → "을". 한글로 안 끝나면 "을(를)" */
function josa(word, pair) {
  const c = (word || "").charCodeAt(word.length - 1) - 0xAC00;
  if (!(c >= 0 && c <= 11171)) return `${pair[0]}(${pair[1]})`;
  return c % 28 ? pair[0] : pair[1];
}
/* (으)로: 받침이 없거나 ㄹ 받침이면 "로" */
function josaRo(word) {
  const c = (word || "").charCodeAt(word.length - 1) - 0xAC00;
  if (!(c >= 0 && c <= 11171)) return "(으)로";
  return c % 28 === 0 || c % 28 === 8 ? "로" : "으로";
}

function shake(el) { el.classList.remove("shake"); void el.offsetWidth; el.classList.add("shake"); }

/* *글자* 를 강조색으로. n 글자까지만 그립니다 (타자 효과용) */
function richSegs(text) {
  const out = [], re = /\*([^*\n]+)\*/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push([text.slice(last, m.index), false]);
    out.push([m[1], true]); last = re.lastIndex;
  }
  if (last < text.length) out.push([text.slice(last), false]);
  return out;
}
function setRich(el, text, n = Infinity) {
  el.textContent = "";
  for (const [s, em] of richSegs(text || "")) {
    if (n <= 0) break;
    const part = s.slice(0, n); n -= part.length;
    if (!em) { el.appendChild(document.createTextNode(part)); continue; }
    const sp = document.createElement("span"); sp.className = "em"; sp.textContent = part; el.appendChild(sp);
  }
}

function showLine(who, text, cls) {
  const name = $("name"), box = $("text");
  if (who) {
    name.hidden = false; name.textContent = who;
    name.style.color = CAST[who] || "var(--brass)";
  } else name.hidden = true;
  box.className = "text" + (cls ? " " + cls : !who ? " nar" : text.startsWith("(") ? " thought" : "");
  $("dialog").classList.remove("idle");
  $("hint").hidden = true;
  S.fullText = text;
  clearInterval(S.typeTimer);
  if (reduce) { setRich(box, text); S.typing = false; $("hint").hidden = !!S.idle; return; }
  const len = richSegs(text).reduce((n, [s]) => n + s.length, 0);
  let i = 0; box.textContent = ""; S.typing = true;
  S.typeTimer = setInterval(() => {
    i++; setRich(box, text, i);
    if (i >= len) { clearInterval(S.typeTimer); S.typing = false; $("hint").hidden = !!S.idle; }
  }, 26);
}

function idleLine(text) {
  clearInterval(S.typeTimer); S.typing = false;
  $("name").hidden = true; $("text").className = "text nar"; setRich($("text"), text);
  $("hint").hidden = true; $("dialog").classList.add("idle");
}

function run(lines, done) {
  S.queue = (lines || []).slice(); S.onDone = done; S.idle = null;
  $("controls").innerHTML = "";
  if (!S.keepMid) $("middle").innerHTML = "";
  else $("middle").querySelectorAll(".choices.float").forEach(el => el.remove());
  step();
}

function step() {
  if (!S.queue.length) {
    const cb = S.onDone; S.onDone = null;
    if (cb) cb();
    return;
  }
  const item = S.queue.shift();
  if (Array.isArray(item)) { showLine(item[0], item[1]); return; }
  exec(item);
}

function exec(a) {
  switch (a.do) {
    case "place": setPlace(a.time, a.loc); return step();
    case "court": S.court = a.on !== false; renderHP(); return step();
    case "heal": S.hp = MAX_HP; renderHP(); return step();
    case "give":
      if (!S.ev.includes(a.id)) {
        S.ev.push(a.id); S.fresh.add(a.id); markRecord();
        S.queue.unshift(["", `법정기록에 〈${EVIDENCE[a.id].name}〉${josa(EVIDENCE[a.id].name, "을를")} 추가했다.`]);
      }
      return step();
    case "update": {
      const it = EVIDENCE[a.id] || PEOPLE[a.id];
      it.desc = a.desc; S.descs[a.id] = a.desc; S.fresh.add(a.id); markRecord(); renderCards();
      S.queue.unshift(["", PEOPLE[a.id] ? `법정기록의 〈${it.name}〉 인물 파일이 갱신되었다.` : `법정기록의 〈${it.name}〉 내용이 갱신되었다.`]);
      return step();
    }
    case "remove": {
      /* [증거 삭제]: 가지고 있을 때만 알림. 없으면 조용히 넘어가요 */
      const had = S.ev.includes(a.id) || S.people.includes(a.id);
      S.ev = S.ev.filter(n => n !== a.id); S.people = S.people.filter(n => n !== a.id);
      S.fresh.delete(a.id); markRecord();
      if (had) { const nm = (EVIDENCE[a.id] || PEOPLE[a.id]).name; S.queue.unshift(["", `법정기록에서 〈${nm}〉${josa(nm, "이가")} 사라졌다.`]); }
      return step();
    }
    case "rename": {
      /* [증거 이름 변경]: 가지고 있지 않아도 이름은 바뀌어요 (나중에 얻으면 새 이름으로) */
      const it = EVIDENCE[a.id] || PEOPLE[a.id], old = it.name;
      if (old === a.name) return step();
      it.name = a.name; S.names[a.id] = a.name; renderCards();
      if (S.ev.includes(a.id) || S.people.includes(a.id)) {
        S.fresh.add(a.id); markRecord();
        S.queue.unshift(["", `법정기록의 〈${old}〉${josa(old, "이가")} 〈${a.name}〉${josaRo(a.name)} 바뀌었다.`]);
      }
      return step();
    }
    case "person":
      if (!S.people.includes(a.id)) {
        S.people.push(a.id); S.fresh.add(a.id); markRecord();
        S.queue.unshift(["", `법정기록에 〈${PEOPLE[a.id].name}〉의 인물 파일을 추가했다.`]);
      }
      return step();
    case "card": {
      /* [표시]: 증거 카드를 위쪽에 띄워요. 이미 떠 있는 카드는 자리 그대로 */
      const added = a.ids.filter(id => !S.cards.includes(id));
      S.cards.push(...added); renderCards(added);
      return step();
    }
    case "uncard":
      /* [표시 해제]: 이름을 적으면 그 카드만, 안 적으면 전부 */
      S.cards = a.ids.length ? S.cards.filter(id => !a.ids.includes(id)) : [];
      renderCards();
      return step();
    case "shake": shake(document.querySelector(".stage")); return step();
    case "hp":
      S.hp = Math.max(0, Math.min(MAX_HP, S.hp + a.n)); renderHP(); shake($("hp"));
      /* 0이 되는 순간 게임오버. 사이코록 안에서는 사이코록의 '실패'가 따로 처리해요 */
      if (a.n < 0 && S.hp <= 0 && !S.lock) return gameOver();
      return step();
    case "goto":
      S.queue = []; S.onDone = null;
      if (S.lock) { S.lock = null; renderHP(); }
      return go(a.to);
    case "show": S.shown.add(a.key || S.scene + ":" + a.id); return step();
    case "locks": {
      const L = LOCKS[a.id || S.pendingLock || (S.lock && S.lock.id)];
      if (L) { S.keepMid = true; renderLocks(L.steps.length, 0); }
      return step();
    }
    case "unlocks":
      /* [자물쇠 숨김]: [자물쇠 표시]로 띄운 자물쇠 그래픽을 내려요. 사이코록 도중에는 그대로 둬요 */
      if (!S.lock) { $("middle").querySelector(".psyche")?.remove(); S.keepMid = false; }
      return step();
    case "unlock": {
      const el = document.querySelector(".lock:not(.gone)");
      S.lock.broken++;
      if (el) {
        el.classList.add("break");
        setTimeout(() => { el.classList.remove("break"); el.classList.add("gone"); updateLockLabel(); step(); }, reduce ? 0 : 700);
        return;
      }
      return step();
    }
    case "reveal": S.revealNow = true; return step();
    case "choice": {
      /* [오답]으로 돌아온 경우, 선택지 직전의 질문 대사를 다시 띄워요 */
      if (a.prompt) showLine(a.prompt[0], a.prompt[1]);
      const prompt = a.prompt || [$("name").hidden ? "" : $("name").textContent, S.fullText];
      S.idle = "choice";
      $("hint").hidden = true; $("dialog").classList.add("idle");
      /* 선택지는 대사창 아래가 아니라 위의 빈 자리에 띄워요. 대사창을 빠르게 누르다가 잘못 고르지 않게.
         나타난 직후 잠깐은 눌러도 무시해요 (연타·Enter 연타 방지) */
      $("controls").innerHTML = "";
      const box = document.createElement("div"); box.className = "choices float";
      const readyAt = Date.now() + (reduce ? 250 : 450);
      a.options.forEach(o => {
        const b = document.createElement("button"); b.type = "button"; b.textContent = o.label;
        b.onclick = () => {
          if (Date.now() < readyAt) return;
          box.remove(); S.idle = null; $("dialog").classList.remove("idle"); $("dialog").focus({ preventScroll: true });
          /* [오답]: 대사 → 신뢰도 -1 → 같은 선택지로. 0이 되면 hp 명령이 게임오버로 보냄 */
          if (o.wrong) S.queue.unshift(...o.lines, ...penalty(), { ...a, prompt });
          else S.queue.unshift(...o.lines);
          step();
        };
        box.appendChild(b);
      });
      $("middle").appendChild(box);
      box.firstChild.focus({ preventScroll: true });
      return;
    }
    case "demand": {
      /* [제시 요구]: 법정기록을 열어 고르게 합니다. 남은 대사(rest)는 고른 뒤에 이어서 나와요.
         틀리면 [틀렸을 때] → 신뢰도 -1 → 같은 요구로 돌아옴. [틀리면 넘어감]이면 돌아오지 않고 남은 대사로.
         기록을 닫아도 버튼으로 다시 열 수 있어요. */
      if (a.prompt) showLine(a.prompt[0], a.prompt[1]);
      const prompt = a.prompt || [$("name").hidden ? "" : $("name").textContent, S.fullText];
      const rest = S.queue, done = S.onDone, keep = S.keepMid;
      S.queue = []; S.onDone = null;
      S.idle = "demand";
      $("hint").hidden = true; $("dialog").classList.add("idle");
      const answer = id => {
        S.keepMid = keep; S.idle = null; $("dialog").classList.remove("idle"); $("controls").innerHTML = "";
        const right = a.answers.includes(id);
        /* [그럴듯할 때]: 정답은 아니지만 그럴듯한 증거. 신뢰도는 그대로, 대사 뒤 같은 요구로 돌아옴 */
        const near = !right && (a.near || []).find(n => n.ids.includes(id));
        /* nohp: [오답] 선택지 안이라 신뢰도는 [오답]이 깎아요 (두 번 깎이지 않게) */
        const hp = a.nohp ? [] : penalty();
        S.queue = (right ? a.ok : near ? [...near.lines, { ...a, prompt }] : a.pass ? [...a.wrong, ...hp] : [...a.wrong, ...hp, { ...a, prompt }]).concat(rest);
        S.onDone = done;
        step();
      };
      const ask = () => { S.keepMid = true; openRecord(answer); };
      const c = $("controls"); c.innerHTML = "";
      const box = document.createElement("div"); box.className = "choices";
      const b = document.createElement("button"); b.type = "button"; b.textContent = "증거를 제시한다"; b.onclick = ask;
      box.appendChild(b); c.appendChild(box);
      ask();
      return;
    }
    case "objection": {
      const o = $("objection"), b = $("burst");
      b.textContent = a.text;
      b.className = "burst" + (a.verdict ? " verdict" : "") + (a.style ? " " + a.style : "");
      o.hidden = false; shake(document.querySelector(".stage"));
      idleLine("");
      o.onclick = () => { o.hidden = true; step(); };
      return;
    }
    default: return step();
  }
}

/* [오답]·[제시 요구]에서 틀렸을 때의 벌점. 법정 중([법정 시작] 뒤)에만 신뢰도 -1, 법정 밖이면 대사만 */
function penalty() { return S.court ? [{ do: "hp", n: -1 }] : []; }

/* 신뢰도 0: 지금 장면의 [게임오버] (없으면 설정의 [게임오버]) 로 갑니다.
   게이지가 비는 모습이 잠깐 보이도록 조금 기다렸다가 넘어가요. */
function gameOver() {
  const sc = SCENES[S.scene], to = sc && sc.gameover;
  S.queue = []; S.onDone = null;
  if (!to) { toast("게임오버 장면이 정해져 있지 않아요."); return; }
  S.failedAt = S.scene; /* [다시 시작]이 없는 게임오버의 "다시 도전"은 여기로 돌아와요 */
  S.gameover = true; /* 게임오버 장면들은 자동저장하지 않음 */
  S.idle = "gameover"; $("controls").innerHTML = "";
  setTimeout(() => go(to), reduce ? 0 : 600);
}

function advance() {
  if (!$("objection").hidden || !$("record").hidden || !$("menu").hidden) return;
  if (S.idle) return;
  if (S.typing) { clearInterval(S.typeTimer); setRich($("text"), S.fullText); S.typing = false; $("hint").hidden = false; return; }
  step();
}

/* ---------- 장면 전환 ---------- */
/* 메뉴에 보이는 항목들. [숨김] 항목은 [질문 추가]로 나타난 뒤에만 */
function shownItems(sc, k) {
  return (sc[k] || []).filter(it => !it.hidden || S.shown.has(S.scene + ":" + (it.id || it.label)));
}
function firstTab(sc) { return ["examine", "talk", "move"].find(k => shownItems(sc, k).length); }

function go(id) {
  const sc = SCENES[id];
  if (!sc) { toast(`'${id}' 장면을 찾지 못했어요.`); return; }
  const from = S.scene;
  /* 엔딩에 닿으면 '어느 장면에서 이 엔딩으로 왔는지'를 저장해 둡니다. 대본을 이어 쓴 뒤 이어하기를 누르면 새 장면으로 갑니다. */
  if (sc.type === "end" && !S.gameover && SCENES[from] && SCENES[from].type !== "end") {
    S.checkpoint = { ...snapshot(), scene: from, ended: id };
    store.set(KEY_AUTO(), S.checkpoint);
  }
  S.scene = id; S.keepMid = false;
  S.placeAt[id] = [$("time").textContent, $("loc").textContent];
  S.cardsAt[id] = S.cards.slice();
  recordChapter(id, from);
  checkpoint();
  if (sc.type === "dialog") run(sc.lines, () => sc.next ? go(sc.next) : toast("다음 장면이 정해져 있지 않아요."));
  else if (sc.type === "investigate") {
    /* [처음 올 때] 대사는 첫 방문에만. 다 본 뒤에 '방문함'으로 기록해서, 도중에 껐다 켜면 다시 나와요 */
    const visitKey = id + ":@방문", first = !S.seen.has(visitKey);
    const lines = sc.entry.concat(first ? sc.first : sc.revisit);
    const open = () => { S.seen.add(visitKey); showInvestigate(firstTab(sc)); };
    if (lines.length) run(lines, open);
    else open();
  }
  else if (sc.type === "testimony") startTestimony(sc);
  else if (sc.type === "end") showEnd(sc);
}

/* ---------- 탐정 파트 ---------- */
/* [조건] 하나를 만족했는지: 항목을 봤는지 / 증거·인물을 가졌는지 / 자물쇠를 풀었는지 / 조사 장면의 항목을 전부 봤는지 */
function needMet(c) {
  if (c.seen) return S.seen.has(c.seen);
  if (c.have) return S.ev.includes(c.have) || S.people.includes(c.have);
  if (c.lock) return S.unlocked.has(c.lock);
  if (c.seenAll) return c.seenAll.every(k => S.seen.has(k));
  return true;
}

function lockedTopic(sc) {
  return shownItems(sc, "talk").find(t => t.lock && !S.unlocked.has(t.lock));
}

function showInvestigate(tab) {
  const sc = SCENES[S.scene];
  S.keepMid = false;
  checkpoint();
  S.idle = "inv";
  idleLine(sc.idle);
  const mid = $("middle"); mid.innerHTML = "";
  const menu = document.createElement("div"); menu.className = "menu";
  const tabs = document.createElement("div"); tabs.className = "menu-tabs";
  const all = [["examine", "조사한다"], ["talk", "대화한다"], ["present", "제시한다"], ["move", "이동한다"]]
    .filter(([k]) => k === "present" ? sc.present : shownItems(sc, k).length);
  all.forEach(([k, label]) => {
    const b = document.createElement("button"); b.type = "button"; b.textContent = label;
    b.setAttribute("aria-pressed", String(tab === k));
    b.onclick = () => k === "present" ? openRecord(invPresent) : showInvestigate(k);
    tabs.appendChild(b);
  });
  menu.appendChild(tabs);
  if (tab && tab !== "present" && sc[tab]) {
    const list = document.createElement("div"); list.className = "menu-list";
    shownItems(sc, tab).forEach(it => {
      const b = document.createElement("button"); b.type = "button";
      const key = S.scene + ":" + (it.id || it.label);
      const locked = it.lock && !S.unlocked.has(it.lock);
      const tag = locked ? '<span class="mini-lock" aria-label="사이코 록"></span>'
        : tab !== "move" && S.seen.has(key) ? '<span class="seen">확인함</span>' : "";
      b.innerHTML = `<span></span>${tag}`;
      b.firstChild.textContent = it.label;
      b.onclick = () => {
        if (tab === "move") {
          const missing = (it.need || []).filter(c => !needMet(c));
          if (missing.length) run(it.needLines, () => showInvestigate("move"));
          else run(it.lines, () => showInvestigate("move"));
          return;
        }
        if (locked) {
          S.pendingLock = it.lock;
          run(LOCKS[it.lock].refuse, () => showInvestigate("talk"));
          return;
        }
        const first = !S.seen.has(key);
        S.seen.add(key);
        run(first || !it.again ? it.lines : it.again, () => showInvestigate(tab));
      };
      list.appendChild(b);
    });
    menu.appendChild(list);
  }
  mid.appendChild(menu);
  $("controls").innerHTML = "";
}

function invPresent(id) {
  const sc = SCENES[S.scene];
  const back = () => showInvestigate(shownItems(sc, "talk").length ? "talk" : firstTab(sc));
  /* 잠긴 대화 항목이 있으면 사이코록 시작. 없으면 곡옥도 보통 증거처럼 ## 제시 블록을 따라요 */
  if (id === CONFIG.magatama && lockedTopic(sc)) return startPsyche(lockedTopic(sc));
  const p = sc.present || {};
  run(p[id] || p.default || [[CONFIG.hero, "(지금 보여 줄 건 아닌 것 같다.)"]], back);
}

/* ---------- 사이코 록 ---------- */
function renderLocks(total, broken) {
  const mid = $("middle");
  mid.innerHTML = `<div class="psyche"><div class="locks"></div><div class="psyche-label"></div></div>`;
  const row = mid.querySelector(".locks");
  for (let i = 0; i < total; i++) {
    const l = document.createElement("span");
    l.className = "lock" + (i < broken ? " gone" : "");
    row.appendChild(l);
  }
  updateLockLabel();
}

function updateLockLabel() {
  const left = document.querySelectorAll(".lock:not(.gone)").length;
  const lab = document.querySelector(".psyche-label");
  if (lab) lab.textContent = left ? `PSYCHE-LOCK · 남은 자물쇠 ${left}` : "PSYCHE-LOCK · 해제";
}

function startPsyche(topic) {
  const L = LOCKS[topic.lock];
  S.lock = { id: topic.lock, topic, step: 0, broken: 0 };
  renderHP();
  S.keepMid = true;
  renderLocks(L.steps.length, 0);
  run(L.intro, psycheStep);
}

function psycheStep() {
  const L = LOCKS[S.lock.id];
  run(L.steps[S.lock.step].lines, psycheAsk);
}

function psycheAsk() {
  S.idle = "psyche";
  $("hint").hidden = true; $("dialog").classList.add("idle");
  const c = $("controls"); c.innerHTML = "";
  const box = document.createElement("div"); box.className = "ce-ctrl two";
  const mk = (cls, label, fn) => { const b = document.createElement("button"); b.type = "button"; b.className = cls; b.textContent = label; b.onclick = fn; box.appendChild(b); };
  mk("present", "증거를 제시한다", () => openRecord(psychePresent));
  mk("press", "포기한다", () => run(LOCKS[S.lock.id].giveup, psycheExit));
  c.appendChild(box);
}

function psychePresent(id) {
  const L = LOCKS[S.lock.id], st = L.steps[S.lock.step];
  if (id === st.answer) {
    run(st.ok.concat([{ do: "unlock" }]), () => {
      S.lock.step++;
      if (S.lock.step < L.steps.length) psycheStep();
      else psycheDone();
    });
    return;
  }
  run(L.wrong.concat([{ do: "hp", n: -1 }]), () => {
    if (S.hp <= 0) run(L.fail.concat([{ do: "heal" }]), psycheExit);
    else psycheAsk();
  });
}

function psycheDone() {
  const L = LOCKS[S.lock.id], topic = S.lock.topic;
  S.unlocked.add(S.lock.id);
  S.seen.add(S.scene + ":" + topic.id);
  S.keepMid = true;
  run(L.done, () => {
    S.lock = null; S.keepMid = false; renderHP();
    run(topic.lines, () => showInvestigate("talk"));
  });
}

function psycheExit() {
  S.lock = null; S.keepMid = false; renderHP();
  showInvestigate("talk");
}

/* ---------- 증언과 신문 ---------- */
/* 지금 보이는 증언들의 번호. 추궁으로 나타난 추가/수정 증언을 반영합니다 */
function visibleStatements(sc) {
  return sc.statements.map((st, i) => i).filter(i => {
    if (sc.statements[i].from !== undefined && !S.revealed.has(i)) return false;
    return !sc.statements.some((o, j) => o.replaces === i && S.revealed.has(j));
  });
}

function startTestimony(sc) {
  S.revealed = new Set(); S.pressed = new Set();
  const vis = visibleStatements(sc);
  S.stmt = vis[0];
  const reading = vis.map(i => [sc.witness, sc.statements[i].text]);
  run(sc.entry.concat(reading, sc.after || []), () => showStatement());
  $("middle").innerHTML = `<div class="ce-banner"></div>`;
  $("middle").firstChild.textContent = `~ ${sc.title} ~`;
}

function showStatement() {
  const sc = SCENES[S.scene], st = sc.statements[S.stmt];
  const vis = visibleStatements(sc), pos = vis.indexOf(S.stmt);
  S.idle = "cross";
  const mid = $("middle");
  mid.innerHTML = `<div class="ce-banner"><span></span><span class="count">증언 ${pos + 1} / ${vis.length}</span></div>`;
  mid.querySelector(".ce-banner span").textContent = `~ ${sc.title} ~`;
  showLine(sc.witness, st.text, "stmt");
  $("hint").hidden = true; $("dialog").classList.add("idle");
  const c = $("controls"); c.innerHTML = "";
  const box = document.createElement("div"); box.className = "ce-ctrl";
  const mk = (cls, label, fn) => { const b = document.createElement("button"); b.type = "button"; b.className = cls; b.textContent = label; b.onclick = fn; box.appendChild(b); };
  mk("prev", "◀", () => { S.stmt = vis[(pos - 1 + vis.length) % vis.length]; showStatement(); });
  mk("press", "추궁한다", () => { S.revealNow = false; run(st.press || [[CONFIG.hero, "(더 물어볼 건 없을 것 같다.)"]], () => afterPress(sc)); });
  mk("present", "제시한다", () => openRecord(present));
  mk("next", "▶", () => {
    if (pos === vis.length - 1) run(loopLines(sc), () => { S.stmt = vis[0]; showStatement(); });
    else { S.stmt = vis[pos + 1]; showStatement(); }
  });
  c.appendChild(box);
}

/* 마지막 증언에서 ▶를 눌렀을 때. 추가/수정 증언이 나온 뒤에는 [증언이 바뀐 뒤] 대사로 */
function loopLines(sc) {
  if (S.revealed.size && sc.loopChanged && sc.loopChanged.length) return sc.loopChanged;
  if (sc.loop && sc.loop.length) return sc.loop;
  return [["", "(증언이 처음으로 돌아갔다.)"]];
}

/* 추궁한 증언 아래에 숨은 추가/수정 증언이 있으면 나타나게 합니다 */
function afterPress(sc) {
  S.pressed.add(S.stmt);
  if (sc.statements[S.stmt].manual && !S.revealNow) return backToCross(sc);
  const news = sc.statements.map((st, i) => i).filter(i => sc.statements[i].from === S.stmt && !S.revealed.has(i));
  if (!news.length) return backToCross(sc);
  news.forEach(i => S.revealed.add(i));
  const edited = news.some(i => sc.statements[i].replaces !== undefined);
  run([["", edited ? "(증언이 바뀌었다.)" : "(증언이 추가되었다.)"]], () => { S.stmt = news[0]; backToCross(sc); });
}

/* [모두 추궁하면]: 지금 보이는 증언 중 추궁 대사가 있는 것을 전부 추궁했으면 그 장면으로, 아니면 신문을 계속해요.
   [증언 추가]가 있는 증언은 그 추가/수정 증언까지 나타나야 다 들은 걸로 쳐요 (무시한다를 고르면 아직) */
function allPressed(sc) {
  return visibleStatements(sc).every(i => {
    const st = sc.statements[i];
    if (!st.press) return true;
    if (!S.pressed.has(i)) return false;
    return !st.manual || sc.statements.some((o, j) => o.from === i && S.revealed.has(j));
  });
}
function backToCross(sc) {
  if (sc.allPressed && allPressed(sc)) return go(sc.allPressed);
  showStatement();
}

function present(id) {
  const sc = SCENES[S.scene], st = sc.statements[S.stmt];
  const r = st.present[id];
  if (r) return run(r, showStatement);
  /* 신뢰도가 0이 되면 hp 명령이 게임오버로 보내요 */
  run(sc.wrong.concat([{ do: "hp", n: -1 }]), showStatement);
}

/* ---------- 법정기록 ---------- */
function markRecord() {
  const btn = $("btnRecord");
  if (S.fresh.size && !btn.querySelector(".dot")) { const d = document.createElement("span"); d.className = "dot"; btn.appendChild(d); }
  if (!S.fresh.size) btn.querySelector(".dot")?.remove();
}

/* ---------- 증거 카드 ([표시] / [표시 해제]) ----------
   위쪽부터 차례대로 쌓여요. pop 에 든 카드만 나타나는 움직임을 보여 줘요. */
function renderCards(pop = []) {
  const box = $("cards");
  box.innerHTML = "";
  S.cards.forEach(id => {
    const it = EVIDENCE[id] || PEOPLE[id]; if (!it) return;
    const c = document.createElement("div");
    c.className = "pcard" + (pop.includes(id) ? " pop" : "");
    c.innerHTML = `<div class="pc-head"><span class="pc-name"></span><span class="pc-no"></span></div><p class="pc-desc"></p>`;
    c.querySelector(".pc-name").textContent = it.name;
    c.querySelector(".pc-no").textContent = it.no || "";
    setRich(c.querySelector(".pc-desc"), it.desc);
    box.appendChild(c);
  });
  box.hidden = !box.children.length;
}

function openRecord(cb) {
  S.presentCb = typeof cb === "function" ? cb : null;
  S.recordTab = "ev"; S.recordSel = null;
  renderRecord(); $("record").hidden = false;
}

function closeRecord() { $("record").hidden = true; S.presentCb = null; markRecord(); }

function renderRecord() {
  const R = $("record"), tab = S.recordTab;
  const ids = tab === "ev" ? S.ev : S.people, src = tab === "ev" ? EVIDENCE : PEOPLE;
  const sel = S.recordSel && src[S.recordSel];
  R.innerHTML = `
    <div class="record-box" role="dialog" aria-label="법정기록">
      <div class="record-head">
        <h2>${S.presentCb ? "무엇을 제시할까?" : "법정기록"}</h2>
        <div class="tabs">
          <button type="button" data-tab="ev" aria-pressed="${tab === "ev"}">증거품</button>
          <button type="button" data-tab="pp" aria-pressed="${tab === "pp"}">인물</button>
        </div>
      </div>
      <div class="cards">${ids.length ? "" : '<p class="empty">아직 아무것도 없다.</p>'}</div>
      <div class="detail">${sel ? "" : '<p>항목을 누르면 자세한 내용이 보인다.</p>'}</div>
      <div class="record-foot">
        <button type="button" data-act="close">닫기</button>
        ${S.presentCb ? `<button type="button" class="go" data-act="present" ${S.recordSel ? "" : "disabled"}>제시한다</button>` : ""}
      </div>
    </div>`;
  const cards = R.querySelector(".cards");
  ids.forEach(id => {
    const it = src[id]; if (!it) return;
    const b = document.createElement("button");
    b.type = "button"; b.className = "card"; b.setAttribute("aria-pressed", String(S.recordSel === id));
    b.innerHTML = `<span class="no"><span></span>${S.fresh.has(id) ? "<b>NEW</b>" : ""}</span><span class="nm"></span>`;
    b.querySelector(".no span").textContent = it.no;
    b.querySelector(".nm").textContent = it.name;
    b.onclick = () => { S.recordSel = id; S.fresh.delete(id); renderRecord(); };
    cards.appendChild(b);
  });
  if (sel) {
    const d = R.querySelector(".detail");
    const h = document.createElement("h3"); h.textContent = sel.name;
    const p = document.createElement("p"); setRich(p, sel.desc);
    d.append(h, p);
  }
  R.querySelectorAll("[data-tab]").forEach(b => b.onclick = () => { S.recordTab = b.dataset.tab; S.recordSel = null; renderRecord(); });
  R.querySelector('[data-act="close"]').onclick = closeRecord;
  const go_ = R.querySelector('[data-act="present"]');
  if (go_) go_.onclick = () => {
    const id = S.recordSel, cb = S.presentCb;
    closeRecord();
    const name = (EVIDENCE[id] || PEOPLE[id]).name;
    const raise = id === CONFIG.magatama && cb === invPresent && lockedTopic(SCENES[S.scene]);
    const line = ["", `〈${name}〉${josa(name, "을를")} ${raise ? "꺼내 들었다." : "제시했다."}`];
    /* [제시 대사]는 법정에서만 (증언 신문 중, 또는 [법정 시작] 뒤). 조사·사이코록에서는 담백하게 한 줄만 */
    const inCourt = (S.court && !S.lock) || (SCENES[S.scene] && SCENES[S.scene].type === "testimony");
    run(inCourt ? [[CONFIG.hero, CONFIG.presentLine], line] : [line], () => cb(id));
  };
}

/* ---------- 끝 카드 ---------- */
function showEnd(sc) {
  $("cards").hidden = true; /* 엔딩 카드만 보이게. "다시 도전"하면 그 장면에 들어갈 때의 카드로 돌아와요 */
  S.idle = "end";
  idleLine("");
  $("controls").innerHTML = "";
  const mid = $("middle"); mid.innerHTML = "";
  const box = document.createElement("div"); box.className = "end";
  const h = document.createElement("h2"); h.textContent = sc.title;
  const p = document.createElement("p"); setRich(p, sc.body); p.style.whiteSpace = "pre-wrap";
  const acts = document.createElement("div"); acts.className = "actions";
  /* [다시 시작]이 없는 게임오버는 신뢰도가 0이 된 장면의 처음으로 돌아가요 */
  const retry = sc.retry || (S.gameover && SCENES[S.failedAt] ? S.failedAt : null);
  if (retry) {
    const r = document.createElement("button"); r.type = "button"; r.textContent = "다시 도전";
    r.onclick = () => {
      S.hp = MAX_HP; S.gameover = false; renderHP();
      const pl = S.placeAt[retry]; if (pl) setPlace(pl[0], pl[1]);
      S.cards = (S.cardsAt[retry] || []).slice(); renderCards();
      go(retry);
    };
    acts.appendChild(r);
  }
  const a = document.createElement("button"); a.type = "button"; a.className = retry ? "ghost" : ""; a.textContent = "처음부터";
  a.onclick = reset; acts.appendChild(a);
  /* 게임오버가 아닌 엔딩은 저장돼 있으니, 타이틀에서 이어하기로 돌아올 수 있어요 */
  if (!S.gameover) {
    const t = document.createElement("button"); t.type = "button"; t.className = "ghost"; t.textContent = "타이틀로";
    t.onclick = showTitle; acts.appendChild(t);
  }
  box.append(h, p, acts); mid.appendChild(box);
}

function freshState(ev, people) {
  restoreDescs({}, {});
  Object.assign(S, { test: false, ev, people, fresh: new Set(), seen: new Set(), shown: new Set(), hp: MAX_HP, court: false, stmt: 0, unlocked: new Set(), lock: null, keepMid: false, descs: {}, names: {}, placeAt: {}, gameover: false, cards: [], cardsAt: {} });
  setPlace("", ""); renderHP(); markRecord(); renderCards();
}

function reset() {
  freshState(CONFIG.startEv.filter(n => EVIDENCE[n] || PEOPLE[n]), []);
  go(CONFIG.start);
}

/* ============================================================
   저장과 불러오기
   ============================================================ */
const SAVE_VER = 2;
const KEY_AUTO = () => GAME_ID + ":auto";
const KEY_SLOT = n => `${GAME_ID}:slot${n}`;
const SLOTS = 3;

const store = {
  get(k) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }
};

function snapshot() {
  return {
    game: GAME_ID, v: SAVE_VER, savedAt: Date.now(),
    scene: S.scene, time: $("time").textContent, loc: $("loc").textContent,
    ev: [...S.ev], people: [...S.people], fresh: [...S.fresh], seen: [...S.seen], shown: [...S.shown],
    hp: S.hp, court: S.court, unlocked: [...S.unlocked], descs: { ...S.descs }, names: { ...S.names }, placeAt: { ...S.placeAt },
    cards: [...S.cards], cardsAt: { ...S.cardsAt }
  };
}

function checkpoint() {
  const sc = SCENES[S.scene];
  if (!sc || sc.type === "end" || S.lock || S.gameover) return;
  S.checkpoint = snapshot();
  store.set(KEY_AUTO(), S.checkpoint);
}

/* 증거·인물의 설명과 이름을 원래대로 돌린 뒤, 세이브에 적힌 갱신/이름 변경을 다시 적용합니다 (원래 이름 = 목록의 키) */
function restoreDescs(descs, names) {
  for (const k in ORIGINAL_DESC) { const it = EVIDENCE[k] || PEOPLE[k]; it.desc = ORIGINAL_DESC[k]; it.name = k; }
  for (const [k, v] of Object.entries(descs || {})) { const it = EVIDENCE[k] || PEOPLE[k]; if (it) it.desc = v; }
  for (const [k, v] of Object.entries(names || {})) { const it = EVIDENCE[k] || PEOPLE[k]; if (it) it.name = v; }
}

function validSave(d) {
  return d && d.game === GAME_ID && typeof d.scene === "string" && SCENES[d.scene] && Array.isArray(d.ev);
}

function restore(d, msg = "불러왔다.") {
  if (!validSave(d)) throw new Error("bad save");
  clearInterval(S.typeTimer);
  S.queue = []; S.onDone = null;
  $("objection").hidden = true; $("record").hidden = true; $("menu").hidden = true;
  restoreDescs(d.descs, d.names);
  Object.assign(S, {
    ev: d.ev.filter(n => EVIDENCE[n] || PEOPLE[n]), people: (d.people || []).filter(n => PEOPLE[n]),
    fresh: new Set(d.fresh || []), seen: new Set(d.seen || []), shown: new Set(d.shown || []),
    hp: typeof d.hp === "number" ? d.hp : MAX_HP, court: !!d.court, unlocked: new Set(d.unlocked || []),
    descs: { ...(d.descs || {}) }, names: { ...(d.names || {}) }, placeAt: { ...(d.placeAt || {}) },
    cards: (d.cards || []).filter(n => EVIDENCE[n] || PEOPLE[n]), cardsAt: { ...(d.cardsAt || {}) }, lock: null, keepMid: false, stmt: 0, gameover: false, test: false
  });
  setPlace(d.time, d.loc); renderHP(); markRecord(); renderCards();
  S.scene = d.scene; S.checkpoint = d;
  go(resumeTarget(d));
  toast(msg);
}

/* 엔딩에서 저장된 세이브: 그 사이 [다음]이 새 장면으로 바뀌었으면 거기로, 아니면 그 엔딩을 다시 보여 줍니다 */
function resumeTarget(d) {
  if (!d.ended) return d.scene;
  const nx = SCENES[d.scene].next;
  if (nx && nx !== d.ended && SCENES[nx]) return nx;
  return SCENES[d.ended] ? d.ended : d.scene;
}

function encodeSave(d) {
  const bytes = new TextEncoder().encode(JSON.stringify(d));
  let bin = ""; bytes.forEach(b => bin += String.fromCharCode(b));
  return "RT1:" + btoa(bin);
}
function decodeSave(text) {
  const t = (text || "").trim();
  if (t.startsWith("{")) return JSON.parse(t);
  const body = t.replace(/^RT1:/, "").replace(/\s+/g, "");
  const bin = atob(body);
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))));
}

function describeSave(d) {
  if (!d) return { t: "비어 있음", m: "" };
  const when = new Date(d.savedAt);
  const stamp = isNaN(when) ? "" : `${when.getMonth() + 1}/${when.getDate()} ${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")} 저장`;
  return { t: d.loc || d.scene || "타이틀", m: [d.time, stamp].filter(Boolean).join(" · ") };
}

function downloadSave() {
  const d = S.checkpoint;
  const now = new Date();
  const p = n => String(n).padStart(2, "0");
  const name = `save-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}.json`;
  const url = URL.createObjectURL(new Blob([JSON.stringify(d, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

let menuConfirmReset = false;
function openMenu() { menuConfirmReset = false; renderMenu(); $("menu").hidden = false; }
function closeMenu() { $("menu").hidden = true; }

function renderMenu(msg, isErr) {
  const M = $("menu"), cp = S.checkpoint, auto = store.get(KEY_AUTO());
  M.innerHTML = `
    <div class="record-box" role="dialog" aria-label="메뉴">
      <div class="record-head"><h2>메뉴</h2><button type="button" class="small-btn" data-act="close">닫기</button></div>
      <section class="menu-sec">
        <h3>이 브라우저에 저장</h3>
        <div class="slots"></div>
      </section>
      <section class="menu-sec">
        <h3>다른 브라우저로 옮기기</h3>
        <p>세이브 파일을 내려받아 두었다가, 다른 브라우저에서 이 게임을 열고 "세이브 파일 열기"로 불러오세요.</p>
        <div class="row">
          <button type="button" class="small-btn primary" data-act="download" ${cp ? "" : "disabled"}>세이브 파일 내려받기</button>
          <button type="button" class="small-btn" data-act="openfile">세이브 파일 열기</button>
        </div>
      </section>
      <section class="menu-sec">
        <h3>저장 코드</h3>
        <p>파일을 내려받을 수 없는 곳에서는 이 코드를 복사해 보관하세요. 불러올 때는 칸에 코드를 붙여 넣고 "코드로 불러오기"를 누르면 됩니다.</p>
        <textarea class="code" id="saveCode" spellcheck="false" aria-label="저장 코드"></textarea>
        <div class="row">
          <button type="button" class="small-btn" data-act="copy" ${cp ? "" : "disabled"}>코드 복사</button>
          <button type="button" class="small-btn" data-act="paste">코드로 불러오기</button>
        </div>
      </section>
      <div class="menu-msg${isErr ? " err" : ""}" role="status"></div>
      <section class="menu-sec">
        <div class="row">
          <button type="button" class="small-btn" data-act="title">타이틀로</button>
          <button type="button" class="small-btn danger" data-act="reset">${menuConfirmReset ? "한 번 더 누르면 처음부터 시작" : "처음부터"}</button>
        </div>
      </section>
    </div>`;
  M.querySelector(".menu-msg").textContent = msg || "";
  $("saveCode").value = cp ? encodeSave(cp) : "";

  const slots = M.querySelector(".slots");
  const rows = [{ key: KEY_AUTO(), label: "자동 저장", data: auto, canSave: false }]
    .concat(Array.from({ length: SLOTS }, (_, i) => ({ key: KEY_SLOT(i + 1), label: `슬롯 ${i + 1}`, data: store.get(KEY_SLOT(i + 1)), canSave: true })));
  rows.forEach(r => {
    const info = describeSave(r.data);
    const el = document.createElement("div"); el.className = "slot";
    el.innerHTML = `<div class="info"><span class="t"></span><span class="m"></span></div>`;
    el.querySelector(".t").textContent = `${r.label} · ${info.t}`;
    el.querySelector(".m").textContent = info.m;
    const load = document.createElement("button"); load.type = "button"; load.className = "small-btn"; load.textContent = "불러오기";
    load.disabled = !validSave(r.data);
    load.onclick = () => restore(r.data);
    if (r.canSave) {
      const sv = document.createElement("button"); sv.type = "button"; sv.className = "small-btn primary"; sv.textContent = "저장";
      sv.disabled = !cp;
      sv.onclick = () => {
        const ok = store.set(r.key, { ...cp, savedAt: Date.now() });
        renderMenu(ok ? `${r.label}에 저장했어요.` : "이 브라우저에는 저장할 수 없어요. 세이브 파일이나 저장 코드를 써 주세요.", !ok);
      };
      el.append(sv, load);
    } else el.append(document.createElement("span"), load);
    slots.appendChild(el);
  });

  M.querySelector('[data-act="close"]').onclick = closeMenu;
  M.querySelector('[data-act="download"]').onclick = () => {
    downloadSave();
    renderMenu("세이브 파일을 내려받았어요. 내려받기가 시작되지 않았다면 저장 코드를 복사해 두세요.");
  };
  M.querySelector('[data-act="openfile"]').onclick = () => { $("loadFile").value = ""; $("loadFile").click(); };
  M.querySelector('[data-act="copy"]').onclick = () => {
    const ta = $("saveCode");
    const fallback = () => { ta.focus(); ta.select(); M.querySelector(".menu-msg").textContent = "코드를 선택해 뒀어요. 직접 복사해 주세요."; };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(ta.value).then(() => { M.querySelector(".menu-msg").textContent = "저장 코드를 복사했어요."; }, fallback);
    } else fallback();
  };
  M.querySelector('[data-act="paste"]').onclick = () => {
    try { restore(decodeSave($("saveCode").value)); }
    catch (e) { const v = $("saveCode").value; renderMenu("저장 코드를 읽지 못했어요. 코드 전체를 빠짐없이 붙여 넣었는지 확인해 주세요.", true); $("saveCode").value = v; }
  };
  M.querySelector('[data-act="title"]').onclick = () => { closeMenu(); showTitle(); };
  M.querySelector('[data-act="reset"]').onclick = () => {
    if (!menuConfirmReset) { menuConfirmReset = true; renderMenu(); return; }
    closeMenu(); reset();
  };
}

$("loadFile").addEventListener("change", e => {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  const r = new FileReader();
  r.onload = () => {
    try { restore(decodeSave(String(r.result))); }
    catch (err) { if ($("menu").hidden) openMenu(); renderMenu("이 파일은 이 게임의 세이브 파일이 아니에요.", true); }
  };
  r.onerror = () => renderMenu("파일을 읽지 못했어요. 다시 골라 주세요.", true);
  r.readAsText(f);
});

/* ---------- 타이틀 ---------- */
function errorPanel() {
  if (!STORY_ERRORS.length) return null;
  const box = document.createElement("div"); box.className = "errors";
  box.innerHTML = `<h2></h2><p>아래 줄을 고친 뒤 이 페이지를 새로고침하세요. 고치기 전에도 플레이는 되지만, 해당 부분이 이상하게 움직일 수 있어요.</p><ol></ol>`;
  box.querySelector("h2").textContent = `대본에서 고칠 곳 ${STORY_ERRORS.length}개`;
  const ol = box.querySelector("ol");
  STORY_ERRORS.forEach(e => {
    const li = document.createElement("li");
    const at = document.createElement("span"); at.className = "at"; at.textContent = where(e.at);
    li.append(at, document.createTextNode(e.msg));
    ol.appendChild(li);
  });
  return box;
}

function showTitle() {
  clearInterval(S.typeTimer);
  S.queue = []; S.onDone = null; S.scene = null; S.checkpoint = null; S.idle = "title";
  S.court = false; S.lock = null; S.gameover = false; renderHP();
  S.cards = []; renderCards();
  setPlace("", ""); idleLine("");
  $("controls").innerHTML = "";
  const auto = store.get(KEY_AUTO());
  const mid = $("middle");
  mid.innerHTML = `
    <div class="title-card">
      <div class="sub"></div>
      <h1></h1>
      <p></p>
      <div class="actions"></div>
    </div>`;
  mid.querySelector(".sub").textContent = CONFIG.sub;
  mid.querySelector("h1").textContent = CONFIG.title;
  mid.querySelector("p").textContent = CONFIG.desc;
  const panel = errorPanel();
  if (panel) mid.querySelector(".title-card").insertBefore(panel, mid.querySelector(".actions"));
  const acts = mid.querySelector(".actions");
  const mk = (label, fn, primary) => { const b = document.createElement("button"); b.type = "button"; b.textContent = label; if (primary) b.className = "primary"; b.onclick = fn; acts.appendChild(b); };
  if (validSave(auto)) mk(`이어하기 · ${describeSave(auto).t}`, () => restore(auto), true);
  mk("새로 시작", reset, !validSave(auto));
  mk("불러오기", openMenu);
  if (Object.values(SCENES).some(sc => sc.chapter)) mk("챕터 선택", showChapters);
  if (CONFIG.test) mk("장면 고르기 (테스트)", showSceneList);
}

/* ---------- 챕터 선택 ----------
   [챕터]를 단 장면에 플레이로 도착하면, 그 순간의 상태(증거, 본 항목 등)를 기억해 둡니다.
   챕터 선택은 그 상태로 다시 시작해요. 그래서 한 번 도착한 챕터만 고를 수 있어요 (첫 장면은 언제나).
   대본을 고친 뒤 그 챕터에 다시 도착하면 새 상태로 바뀌어요. */
const KEY_CHAP = () => GAME_ID + ":chapters";

function recordChapter(id, from) {
  const sc = SCENES[id];
  /* 테스트 모드로 시작했거나, 게임오버의 "다시 도전"으로 돌아온 경우는 기억하지 않아요 */
  if (!sc.chapter || S.test || S.gameover || (SCENES[from] && SCENES[from].type === "end")) return;
  /* 같은 판에서 이미 도착한 챕터면 덮어쓰지 않아요. 조사 장면에 다시 돌아오거나, 이어하기로 그 장면에 들어와도 챕터 처음 상태가 남아요 */
  const mark = id + ":@챕터";
  if (S.seen.has(mark)) return;
  S.seen.add(mark);
  if (from === id) return;
  const all = store.get(KEY_CHAP()) || {};
  all[id] = { ...snapshot(), scene: id };
  store.set(KEY_CHAP(), all);
}

function showChapters() {
  const saved = store.get(KEY_CHAP()) || {};
  const mid = $("middle");
  mid.innerHTML = `<div class="title-card"><div class="sub">CHAPTER</div><p>한 번 도착한 챕터부터 다시 시작할 수 있어요.<br>그때 가지고 있던 증거 그대로 시작해요.</p><div class="scene-list"></div><div class="actions"></div></div>`;
  const list = mid.querySelector(".scene-list");
  Object.keys(SCENES).filter(id => SCENES[id].chapter).forEach(id => {
    const first = id === CONFIG.start, d = saved[id], ok = first || validSave(d);
    const b = document.createElement("button"); b.type = "button"; b.disabled = !ok;
    b.innerHTML = "<span></span><small></small>";
    b.firstChild.textContent = SCENES[id].chapter;
    b.lastChild.textContent = ok ? "" : "아직 도착하지 않음";
    b.onclick = () => {
      if (first) return reset();
      restore({ ...d, hp: MAX_HP, ended: undefined }, `${SCENES[id].chapter}부터 시작했다.`);
    };
    list.appendChild(b);
  });
  const back = document.createElement("button"); back.type = "button"; back.textContent = "돌아가기"; back.onclick = showTitle;
  mid.querySelector(".actions").appendChild(back);
}

/* 테스트 모드: 아무 장면에서나 시작. 모든 증거와 인물을 가진 채로 시작합니다. */
function showSceneList() {
  const mid = $("middle");
  mid.innerHTML = `<div class="title-card"><div class="sub">TEST MODE</div><p>모든 증거와 인물 파일을 가진 채로 그 장면부터 시작해요.</p><div class="scene-list"></div><div class="actions"></div></div>`;
  const list = mid.querySelector(".scene-list");
  const names = { dialog: "대화", investigate: "조사", testimony: "증언", end: "엔딩" };
  Object.keys(SCENES).forEach(id => {
    const b = document.createElement("button"); b.type = "button";
    b.innerHTML = "<span></span><small></small>";
    b.firstChild.textContent = id; b.lastChild.textContent = names[SCENES[id].type];
    b.onclick = () => {
      freshState(Object.keys(EVIDENCE), Object.keys(PEOPLE));
      S.test = true; /* 테스트 시작은 챕터 기록을 남기지 않아요 */
      S.court = SCENES[id].type === "testimony"; renderHP();
      go(id);
    };
    list.appendChild(b);
  });
  const back = document.createElement("button"); back.type = "button"; back.textContent = "돌아가기"; back.onclick = showTitle;
  mid.querySelector(".actions").appendChild(back);
}

/* ---------- 입력 ---------- */
$("dialog").addEventListener("click", advance);
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && !$("menu").hidden) { closeMenu(); return; }
  if (e.key === "Escape" && !$("record").hidden) { closeRecord(); return; }
  if (e.key !== "Enter" && e.key !== " ") return;
  if (!$("objection").hidden) { e.preventDefault(); $("objection").click(); return; }
  if (document.activeElement === $("dialog")) { e.preventDefault(); advance(); }
});
$("btnRecord").onclick = () => openRecord(null);
$("btnMenu").onclick = openMenu;
$("menu").addEventListener("click", e => { if (e.target === $("menu")) closeMenu(); });
$("record").addEventListener("click", e => { if (e.target === $("record")) closeRecord(); });

/* ---------- 대본 파일 불러오기 ---------- */
function loadStory(done) {
  const list = STORY.list, loadErr = [];
  if (!list.length) {
    loadErr.push({ at: { file: "list.js" }, msg: "story/list.js 를 찾지 못했거나, 안에 대본 파일 이름이 하나도 없어요." });
    return done(loadErr);
  }
  let i = 0;
  const next = () => {
    if (i >= list.length) { STORY.loading = null; return done(loadErr); }
    const name = list[i++];
    STORY.loading = name;
    const s = document.createElement("script");
    /* ?v= 를 붙여 브라우저가 예전 대본을 기억해 두고 쓰지 않게 합니다 (새로고침하면 바로 반영) */
    s.charset = "utf-8"; s.src = "story/" + name + "?v=" + Date.now();
    s.onload = () => {
      if (!STORY.calls[name]) loadErr.push({ at: { file: name }, msg: "이 파일을 읽지 못했어요. 첫 줄이 대본` 으로 시작하고 마지막 줄이 ` 하나로 끝나는지, 중간에 ` (백틱) 문자나 ${ 를 쓰지 않았는지 확인해 주세요." });
      next();
    };
    s.onerror = () => { loadErr.push({ at: { file: "list.js" }, msg: `list.js 에 적힌 '${name}' 파일이 story 폴더에 없어요. 파일 이름을 확인해 주세요. (인터넷에 올릴 때를 위해 파일 이름은 영어로 지어 주세요.)` }); next(); };
    document.body.appendChild(s);
  };
  next();
}

loadStory(loadErr => {
  const G = buildGame(STORY.files);
  CONFIG = G.config; CAST = G.cast; EVIDENCE = G.evidence; PEOPLE = G.people; SCENES = G.scenes; LOCKS = G.locks;
  STORY_ERRORS = loadErr.concat(G.errors);
  if (STORY_ERRORS.length) console.warn("대본 오류", STORY_ERRORS);
  MAX_HP = CONFIG.hp; S.hp = MAX_HP;
  GAME_ID = "txtgame:" + CONFIG.title;
  ORIGINAL_DESC = Object.fromEntries(Object.entries({ ...PEOPLE, ...EVIDENCE }).map(([k, v]) => [k, v.desc]));
  document.title = CONFIG.title;
  $("brand").textContent = CONFIG.title;
  showTitle();
});
