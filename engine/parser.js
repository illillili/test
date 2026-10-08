/* ============================================================
   대본 읽기 (parser)
   story 폴더의 대본 파일을 읽어 게임 데이터로 바꿉니다.
   대본을 쓰는 사람은 이 파일을 고칠 필요가 없습니다.
   ============================================================ */
"use strict";

window.STORY = { list: [], files: [], loading: null, calls: {} };

/* story/list.js 에서 부르는 함수 */
function 파일목록(strings) {
  STORY.list = strings.raw.join("").split(/\r?\n/)
    .map(s => s.trim()).filter(s => s && !s.startsWith("//"));
}

/* 각 대본 파일에서 부르는 함수 */
function 대본(strings) {
  const file = STORY.loading || "(알 수 없는 파일)";
  STORY.calls[file] = (STORY.calls[file] || 0) + 1;
  STORY.files.push({ file, text: strings.raw.join("") });
}

const SCENE_KEYS = ["종류", "다음", "대기", "제목", "증인", "게임오버", "본문", "다시 시작", "모두 추궁하면", "챕터"];
const BLOCK_KEYS = ["조건", "자물쇠", "정답", "번호", "나이", "설명", "숨김"];
const MARKERS = { "다시 볼 때": "again", "조건 미달": "need", "정답일 때": "ok", "증언이 바뀐 뒤": "changed" };
/* 조사 장면의 첫 대사(## 블록 위)를 처음 방문 / 다시 방문으로 나눕니다 */
const VISIT_MARKERS = { "처음 올 때": "first", "다시 올 때": "revisit" };
/* [제시 요구] 안에서 정답/오답 대사를 나누는 표시 */
const DEMAND_MARKERS = ["정답일 때", "그럴듯할 때", "틀렸을 때", "틀리면 넘어감"];
const COMMANDS = ["장소", "증거", "인물", "증거갱신", "인물갱신", "흔들기", "외침", "판결", "해제", "법정 시작", "법정 끝", "회복", "신뢰도", "자물쇠 표시", "이동", "선택", "선택 끝", "선택2", "선택2 끝", "오답", "제시 요구", "제시 요구 끝", "증거 삭제", "증거 이름 변경", "증언 추가", "증언 수정", "질문 추가", "표시", "표시 해제", "자물쇠 숨김"];
const TYPES = { "대화": "dialog", "조사": "investigate", "증언": "testimony", "사이코록": "lock", "엔딩": "end" };
const RESERVED = ["설정", "등장인물", "증거", "인물파일"];

/* 1단계: 줄 단위로 장면(#)과 블록(##)을 나눕니다 */
function parseStory(files) {
  const errors = [], scenes = [];
  const err = (at, msg) => errors.push({ at, msg });
  for (const f of files) {
    /* inDemand: [제시 요구] ~ [제시 요구 끝] 사이. 그 안의 [정답일 때]/[틀렸을 때]는 블록 표시가 아니라 제시 요구의 일부예요 */
    let scene = null, block = null, target = null, inDemand = false;
    f.text.split(/\r?\n/).forEach((raw, i) => {
      const at = { file: f.file, line: i + 1 };
      const t = raw.trim();
      if (!t || t.startsWith("//")) return;
      let m;
      if (t.startsWith("#")) inDemand = false;
      if ((m = t.match(/^##(?!#)\s*(.*)$/))) {
        if (!scene) return err(at, "## 줄은 # 장면 이름 아래에 와야 해요.");
        const h = m[1].trim(), c = h.search(/[:：]/);
        block = {
          kind: (c >= 0 ? h.slice(0, c) : h).trim(), arg: c >= 0 ? h.slice(c + 1).trim() : "",
          head: h, at, settings: {}, lines: [], alt: [], marker: null
        };
        scene.blocks.push(block); target = block.lines; return;
      }
      if ((m = t.match(/^#(?!#)\s*(.*)$/))) {
        scene = { name: m[1].trim(), at, settings: {}, lines: [], blocks: [] };
        scenes.push(scene); block = null; target = scene.lines; return;
      }
      if (!scene) return err(at, "첫 번째 # 장면 이름보다 앞에 내용이 있어요.");
      if ((m = t.match(/^\[([^\]]+)\]\s*(.*)$/))) {
        const key = m[1].replace(/\s+/g, " ").trim(), val = m[2].trim();
        if (key === "제시 요구") inDemand = true;
        if (key === "제시 요구 끝") inDemand = false;
        if (inDemand && DEMAND_MARKERS.includes(key)) { target.push({ cmd: key, val, at }); return; }
        if (block && MARKERS[key]) { block.marker = MARKERS[key]; target = block.alt; return; }
        if (!block && VISIT_MARKERS[key]) {
          const k = VISIT_MARKERS[key];
          scene[k] = scene[k] || []; scene.visitAt = scene.visitAt || at; target = scene[k]; return;
        }
        /* ## 이동 블록의 [조건]은 여러 번 쓸 수 있어요. [조건]마다 그 아래 대사가 한 갈래가 돼요 */
        if (block && key === "조건" && block.kind === "이동") {
          if (target === block.alt) return err(at, "[조건]은 [조건 미달]보다 위에 적어 주세요.");
          (block.conds = block.conds || []).push({ val, at, from: block.lines.length });
        }
        if (block && BLOCK_KEYS.includes(key)) { block.settings[key] = { val, at }; return; }
        if (!block && (SCENE_KEYS.includes(key) || scene.name === "설정")) { scene.settings[key] = { val, at }; return; }
        target.push({ cmd: key, val, at }); return;
      }
      target.push({ text: t, at });
    });
  }
  return { scenes, errors };
}

/* 2단계: 게임 데이터로 바꾸고 틀린 곳을 찾습니다 */
function buildGame(files) {
  const { scenes: raw, errors } = parseStory(files);
  const err = (at, msg) => errors.push({ at, msg });
  const split = s => (s || "").split(/[,，]/).map(x => x.trim()).filter(Boolean);
  /* <br> 자리에서 줄을 바꿉니다 */
  const br = s => (s || "").replace(/\s*<br\s*\/?>\s*/gi, "\n");
  const val = (o, k) => (o[k] ? o[k].val : "");

  const byName = {};
  for (const s of raw) {
    if (byName[s.name]) { err(s.at, `'${s.name}' 장면이 두 번 있어요. (처음 것은 ${where(byName[s.name].at)})`); continue; }
    byName[s.name] = s;
  }

  /* 설정 */
  const set = byName["설정"] ? byName["설정"].settings : {};
  const config = {
    title: val(set, "제목") || "제목 없는 게임",
    sub: val(set, "부제"), desc: val(set, "설명"),
    start: val(set, "첫 장면"),
    hp: parseInt(val(set, "신뢰도"), 10) || 5,
    startEv: split(val(set, "처음 증거")),
    magatama: val(set, "곡옥"),
    hero: val(set, "주인공") || "나루호도",
    presentLine: val(set, "제시 대사") || "이걸 봐 주십시오!",
    /* 신뢰도가 0이 되면 갈 장면. 장면마다 [게임오버]로 바꿀 수 있어요 */
    gameover: val(set, "게임오버"),
    test: /^(켬|켜기|예|네|on|true)$/i.test(val(set, "테스트 모드"))
  };

  /* 등장인물 */
  /* 한 줄에 한 명, 또는 쉼표로 여러 명. 이름표 색은 '이름 = #색깔'로 적을 때만 (없으면 기본색) */
  const cast = Object.create(null);
  if (byName["등장인물"]) for (const it of byName["등장인물"].lines) {
    if (!it.text) { err(it.at, "등장인물 목록에는 이름만 적어 주세요."); continue; }
    const m = it.text.match(/^(.+?)\s*[=:：]\s*(#[0-9a-fA-F]{3,8})$/);
    if (m) { cast[m[1].trim()] = m[2]; continue; }
    if (/[=:：#]/.test(it.text)) { err(it.at, "등장인물은 이름만 적거나, '이름 = #색깔' 모양으로 적어 주세요. 예) 나루호도   또는   나루호도 = #6ea8ea"); continue; }
    split(it.text).forEach(n => { if (/\s/.test(n)) err(it.at, `등장인물 이름 '${n}'에 띄어쓰기가 있어요. 대사에서 부를 수 없으니 붙여 써 주세요.`); cast[n] = ""; });
  }

  /* 증거와 인물 파일 */
  const readItems = (name, noKey) => {
    const out = {};
    if (!byName[name]) return out;
    for (const b of byName[name].blocks) {
      const extra = b.lines.filter(x => x.text).map(x => x.text);
      out[b.head] = {
        no: val(b.settings, noKey) || val(b.settings, "번호"),
        name: b.head,
        desc: br([val(b.settings, "설명"), ...extra].filter(Boolean).join(" "))
      };
    }
    return out;
  };
  const evidence = readItems("증거", "번호");
  const people = readItems("인물파일", "나이");
  for (const n in people) if (evidence[n]) err({ file: "", line: 0 }, `'${n}'이(가) 증거와 인물 파일에 모두 있어요. 이름을 다르게 해 주세요.`);

  /* [증거 이름 변경] 옛 이름 | 새 이름 을 미리 모아, 새 이름도 같은 물건을 가리키게 합니다.
     대본에서는 바뀐 뒤에도 옛 이름과 새 이름 둘 다 쓸 수 있어요. 게임 안에서는 '원래 이름'으로 기억해요. */
  const alias = {};
  const canon = n => alias[n] || n;
  for (const s of raw) {
    const all = [s.lines, s.first || [], s.revisit || [], ...s.blocks.flatMap(b => [b.lines, b.alt])].flat();
    for (const it of all) {
      if (it.cmd !== "증거 이름 변경") continue;
      const i = it.val.indexOf("|");
      const from = canon((i < 0 ? it.val : it.val.slice(0, i)).trim()), to = i < 0 ? "" : it.val.slice(i + 1).trim();
      if (!to || !(evidence[from] || people[from])) continue; /* 틀린 경우는 아래 명령 확인에서 알려 줘요 */
      if ((evidence[to] || people[to]) && to !== from) { err(it.at, `새 이름 '${to}'은(는) 이미 다른 증거나 인물 이름이에요. 다른 이름으로 해 주세요.`); continue; }
      if (alias[to] && alias[to] !== from) { err(it.at, `새 이름 '${to}'을(를) 이미 다른 물건의 새 이름으로 썼어요.`); continue; }
      if (to !== from) alias[to] = from;
    }
  }
  const isThing = n => evidence[canon(n)] || people[canon(n)];
  if (config.start && !byName[config.start]) err(set["첫 장면"].at, `첫 장면 '${config.start}'을(를) 찾지 못했어요.`);
  if (!config.start) err({ file: "설정", line: 0 }, "설정에 [첫 장면]이 없어요.");
  config.startEv.forEach(n => { if (!isThing(n)) err(set["처음 증거"].at, `처음 증거 '${n}'이(가) 증거 목록에 없어요.`); });
  if (config.magatama && !evidence[config.magatama]) err(set["곡옥"].at, `곡옥으로 지정한 '${config.magatama}'이(가) 증거 목록에 없어요.`);

  const sceneType = s => TYPES[val(s.settings, "종류") || "대화"];
  const needScene = (name, at, what) => {
    if (!name) return;
    if (!byName[name] || RESERVED.includes(name)) err(at, `${what} '${name}' 장면을 찾지 못했어요.`);
    else if (sceneType(byName[name]) === "lock") err(at, `'${name}'은(는) 사이코록이라 장면으로 이동할 수 없어요.`);
  };

  /* 대사와 명령 한 줄씩 */
  const starCheck = (text, at) => { if ((text.match(/\*/g) || []).length % 2) err(at, "강조 표시 * 의 짝이 안 맞아요. *강조할 글자* 처럼 앞뒤로 하나씩 적어 주세요."); };
  /* ctx.press: 증언의 추궁 대사 안인지 ([증언 추가]는 거기서만 쓸 수 있어요)
     ctx.adds: 조사 장면 안인지. [질문 추가]를 모아 두었다가 장면을 다 읽은 뒤 확인합니다
     ctx.inLock: 사이코록 장면 안인지 ([자물쇠 표시]를 이름 없이 쓸 수 있어요)
     ctx.inWrong: [오답] 선택지 안인지 (그 안의 [틀리면 넘어감]은 신뢰도를 따로 안 깎아요. [오답]이 깎으니까) */
  const compileLines = (items, ctx = {}) => {
    const out = [];
    let choice = null;
    /* [선택] 부터 [선택 끝] 까지를 선택지 하나로 묶습니다 */
    const closeChoice = () => {
      if (!choice) return;
      if (choice.options.length < 2) err(choice.at, "선택지는 [선택]을 두 개 이상 적어 주세요.");
      if (choice.options.every(o => o.wrong)) err(choice.at, "선택지가 모두 [오답]이에요. 정답 선택지가 하나는 있어야 빠져나갈 수 있어요.");
      out.push({ do: "choice", options: choice.options.map(o => ({ label: o.label, wrong: o.wrong, lines: compileLines(o.raw, o.wrong ? { ...ctx, inWrong: true } : ctx) })) });
      choice = null;
    };
    /* [제시 요구] 부터 [제시 요구 끝] 까지를 하나로 묶습니다. 안에 선택지가 들어가도 돼요 */
    let demand = null;
    const closeDemand = () => {
      if (!demand) return;
      /* 정답 없는 [제시 요구]: 무엇을 내도 틀려요. 빠져나갈 수 있게 [틀리면 넘어감]과 함께만 */
      if (!demand.answers.length && demand.mode !== "pass") err(demand.at, "[제시 요구] 뒤에 정답 증거(또는 인물) 이름을 적어 주세요. 여러 개면 쉼표로. 정답 없이 쓰려면 [틀렸을 때] 대신 [틀리면 넘어감]을 써 주세요.");
      if (!demand.answers.length && demand.ok.length) err(demand.at, "정답이 없는 [제시 요구]라서 [정답일 때] 대사는 나올 일이 없어요. 지워 주세요.");
      demand.answers.forEach(n => { if (!isThing(n)) err(demand.at, `[제시 요구]의 정답 '${n}'이(가) 증거나 인물 파일에 없어요.`); });
      /* [그럴듯할 때]: 정답은 아니지만 그럴듯한 증거. 대사 → 신뢰도 그대로 → 같은 요구로 돌아옴 */
      const nearSeen = new Set(demand.answers.map(canon));
      demand.near.forEach(nr => {
        if (!nr.names.length) err(nr.at, "[그럴듯할 때] 뒤에 증거(또는 인물) 이름을 적어 주세요. 여러 개면 쉼표로.");
        if (!nr.lines.length) err(nr.at, "[그럴듯할 때] 아래에 대사를 적어 주세요.");
        nr.names.forEach(n => {
          if (!isThing(n)) err(nr.at, `[그럴듯할 때]의 '${n}'이(가) 증거나 인물 파일에 없어요.`);
          else if (demand.answers.map(canon).includes(canon(n))) err(nr.at, `'${n}'은(는) 이미 [제시 요구]의 정답이에요. [그럴듯할 때]에서 빼 주세요.`);
          else if (nearSeen.has(canon(n))) err(nr.at, `'${n}'이(가) [그럴듯할 때]에 두 번 나와요. 한 곳에만 적어 주세요.`);
          nearSeen.add(canon(n));
        });
      });
      out.push({ do: "demand", answers: demand.answers.map(canon), ok: compileLines(demand.ok, ctx),
        near: demand.near.map(nr => ({ ids: nr.names.map(canon), lines: compileLines(nr.lines, ctx) })),
        wrong: demand.wrong.length ? compileLines(demand.wrong, ctx) : [["", "(이게 아닌 것 같다….)"]], pass: demand.mode === "pass", nohp: demand.mode === "pass" && !!ctx.inWrong });
      demand = null;
    };
    for (const it of items) {
      if (demand) {
        if (it.cmd === "정답일 때") demand.cur = demand.ok;
        else if (it.cmd === "그럴듯할 때") { const nr = { at: it.at, names: split(it.val), lines: [] }; demand.near.push(nr); demand.cur = nr.lines; }
        else if (it.cmd === "틀렸을 때" || it.cmd === "틀리면 넘어감") {
          /* [틀렸을 때]: 다시 고르기 / [틀리면 넘어감]: 대사 → (법정 중이면 신뢰도 -1) → 그대로 다음 대사로 */
          const mode = it.cmd === "틀리면 넘어감" ? "pass" : "retry";
          if (demand.mode && demand.mode !== mode) err(it.at, "[틀렸을 때]와 [틀리면 넘어감]은 한 [제시 요구] 안에 하나만 쓸 수 있어요.");
          demand.mode = mode; demand.cur = demand.wrong;
        }
        else if (it.cmd === "제시 요구 끝") closeDemand();
        else if (it.cmd === "제시 요구") err(it.at, "[제시 요구] 안에 또 [제시 요구]를 넣을 수는 없어요. 앞의 것을 [제시 요구 끝]으로 닫아 주세요.");
        else if (!demand.cur) err(it.at, "[제시 요구] 바로 아래에는 [정답일 때], [그럴듯할 때], [틀렸을 때], [틀리면 넘어감] 중 하나를 먼저 적어 주세요.");
        else demand.cur.push(it);
        continue;
      }
      /* [선택2]: 선택지 안의 선택지. [선택2 끝]까지는 [오답] 등 모든 줄을 바깥 선택지 대사로 넘기고,
         그 대사를 다시 읽을 때 [선택]/[선택 끝]으로 바꿔서 보통 선택지처럼 묶어요.
         [선택2 끝]이 없어도 바깥의 다음 [선택]이나 [선택 끝]에서 닫혀요 */
      if (choice && choice.nested && it.cmd !== "선택" && it.cmd !== "선택 끝") {
        const raw = choice.options[choice.options.length - 1].raw;
        if (it.cmd === "선택2 끝") { choice.nested = false; raw.push({ ...it, cmd: "선택 끝" }); }
        else raw.push(it.cmd === "선택2" ? { ...it, cmd: "선택" } : it);
        continue;
      }
      if (choice) choice.nested = false;
      if (it.cmd === "선택2") {
        if (!choice) err(it.at, "[선택2]는 [선택] 아래에서만 쓸 수 있어요. 선택지 안의 선택지예요.");
        else { choice.nested = true; choice.options[choice.options.length - 1].raw.push({ ...it, cmd: "선택" }); }
        continue;
      }
      if (it.cmd === "선택2 끝") { err(it.at, "[선택2 끝] 앞에 [선택2]가 없어요."); continue; }
      /* 선택지 안에 있는 [제시 요구]는 그 선택지 대사로 넘겨서 따로 묶어요 */
      if (it.cmd === "제시 요구" && !choice) {
        demand = { at: it.at, answers: split(it.val), ok: [], near: [], wrong: [], cur: null };
        hpDrops.push({ scene: curScene, at: it.at, courtOnly: true });
        continue;
      }
      if (!choice && ["정답일 때", "그럴듯할 때", "틀렸을 때", "틀리면 넘어감", "제시 요구 끝"].includes(it.cmd)) {
        err(it.at, `[${it.cmd}]은(는) [제시 요구] 아래에서만 쓸 수 있어요.`);
        continue;
      }
      if (it.cmd === "선택") {
        if (!it.val) err(it.at, "[선택] 뒤에 선택지 문구를 적어 주세요.");
        if (!choice) choice = { at: it.at, options: [] };
        choice.options.push({ label: it.val, raw: [] });
      } else if (it.cmd === "선택 끝") {
        if (!choice) err(it.at, "[선택 끝] 앞에 [선택]이 없어요.");
        closeChoice();
      } else if (it.cmd === "오답") {
        /* [오답]: 이 선택지 대사를 보여 준 뒤 (법정 중이면 신뢰도 -1) 같은 선택지로 돌아감 */
        if (!choice) err(it.at, "[오답]은 [선택] 바로 아래에 적어 주세요.");
        else { choice.options[choice.options.length - 1].wrong = true; hpDrops.push({ scene: curScene, at: it.at, courtOnly: true }); }
      } else if (choice) choice.options[choice.options.length - 1].raw.push(it);
      else compileOne(it, out, ctx);
    }
    closeChoice();
    if (demand) err(demand.at, "[제시 요구 끝]이 빠졌어요. 이 [제시 요구]가 끝나는 자리에 [제시 요구 끝]을 적어 주세요.");
    closeDemand();
    return out;
  };
  const compileOne = (it, out, ctx) => {
      if (it.text !== undefined) {
        starCheck(it.text, it.at);
        /* 콜론 앞이 등장인물 이름일 때만 대사. 아니면 콜론이 들어간 지문으로 봅니다. */
        const m = it.text.match(/^([^\s:：]{1,12})\s*[:：]\s*(.*)$/);
        if (m && m[1] in cast) { out.push([m[1], br(m[2])]); return; }
        const near = m && Object.keys(cast).find(n => oneOff(n, m[1]));
        if (near) err(it.at, `'${m[1]}'은(는) 등장인물에 없는 이름이에요. 혹시 '${near}'인가요? 지문이라면 무시해도 돼요.`);
        out.push(["", br(it.text)]);
        return;
      }
      const { cmd, val: v, at } = it;
      switch (cmd) {
        case "장소": { const p = v.split("|"); out.push(p.length > 1 ? { do: "place", time: p[0].trim(), loc: p.slice(1).join("|").trim() } : { do: "place", time: "", loc: v }); break; }
        case "증거": if (!evidence[canon(v)]) err(at, `증거 '${v}'이(가) 증거 목록에 없어요.`); else out.push({ do: "give", id: canon(v) }); break;
        case "인물": if (!people[canon(v)]) err(at, `인물 '${v}'이(가) 인물 파일에 없어요.`); else out.push({ do: "person", id: canon(v) }); break;
        case "증거 삭제": if (!isThing(v)) err(at, `[증거 삭제] '${v}'이(가) 증거나 인물 파일에 없어요.`); else out.push({ do: "remove", id: canon(v) }); break;
        case "증거 이름 변경": {
          const i = v.indexOf("|"), n = (i < 0 ? v : v.slice(0, i)).trim(), to = i < 0 ? "" : v.slice(i + 1).trim();
          if (!isThing(n)) err(at, `[증거 이름 변경] '${n}'이(가) 증거나 인물 파일에 없어요.`);
          else if (!to) err(at, "[증거 이름 변경] 옛 이름 | 새 이름 모양으로 적어 주세요.");
          else if (canon(to) !== canon(n)) { /* 새 이름이 다른 물건 이름과 겹침. 위에서 이미 알려 줬어요 */ }
          else out.push({ do: "rename", id: canon(n), name: to });
          break;
        }
        case "증거갱신":
        case "인물갱신": {
          const isEv = cmd === "증거갱신", list = isEv ? evidence : people, what = isEv ? "증거" : "인물";
          const i = v.indexOf("|"), n = (i < 0 ? v : v.slice(0, i)).trim(), d = i < 0 ? "" : v.slice(i + 1).trim();
          if (!list[canon(n)]) err(at, isEv ? `증거 '${n}'이(가) 증거 목록에 없어요.` : `인물 '${n}'이(가) 인물 파일에 없어요.`);
          else if (!d) err(at, `[${cmd}] ${what} 이름 | 새 설명 모양으로 적어 주세요.`);
          else out.push({ do: "update", id: canon(n), desc: br(d) });
          break;
        }
        case "표시":
        case "표시 해제":
        case "표시해제": {
          /* [표시] 이름: 증거 카드를 위쪽에 띄움 / [표시 해제] 이름: 그 카드만 내림 (이름 없으면 전부). 여러 개면 쉼표로 */
          const names = split(v), ids = [];
          names.forEach(n => { if (!isThing(n)) err(at, `[${cmd}] '${n}'이(가) 증거나 인물 파일에 없어요.`); else ids.push(canon(n)); });
          if (cmd === "표시") {
            if (!names.length) err(at, "[표시] 뒤에 보여 줄 증거(또는 인물) 이름을 적어 주세요. 여러 개면 쉼표로.");
            else if (ids.length) out.push({ do: "card", ids });
          } else if (!names.length || ids.length) out.push({ do: "uncard", ids });
          break;
        }
        case "흔들기": out.push({ do: "shake" }); break;
        case "외침": out.push({ do: "objection", text: v || "이의 있음!" }); break;
        case "판결": out.push({ do: "objection", text: v || "유죄", verdict: true }); break;
        case "해제": out.push({ do: "objection", text: v || "해제", style: "unlock" }); break;
        case "법정 시작": out.push({ do: "court" }); courtMarks.push({ scene: curScene, at, on: true }); break;
        case "법정 끝": out.push({ do: "court", on: false }); courtMarks.push({ scene: curScene, at, on: false }); break;
        case "회복": out.push({ do: "heal" }); break;
        case "신뢰도": {
          const n = parseInt(v, 10);
          if (isNaN(n)) err(at, "[신뢰도] 뒤에는 -1 같은 숫자를 적어 주세요.");
          else { out.push({ do: "hp", n }); if (n < 0) hpDrops.push({ scene: curScene, at }); }
          break;
        }
        case "자물쇠 표시":
          if (!v) { if (!ctx.inLock) err(at, "[자물쇠 표시] 뒤에 사이코록 장면 이름을 적어 주세요. 예) [자물쇠 표시] 야마모토의 자물쇠"); out.push({ do: "locks" }); }
          else if (!byName[v] || sceneType(byName[v]) !== "lock") err(at, `사이코록 '${v}'을(를) 찾지 못했어요. [종류] 사이코록 장면이 있어야 해요.`);
          else out.push({ do: "locks", id: v });
          break;
        case "자물쇠 숨김":
          /* [자물쇠 표시]로 띄운 자물쇠 그래픽을 내림. 사이코록 도중에는 남은 자물쇠가 보여야 해서 막아요 */
          if (ctx.inLock) err(at, "[자물쇠 숨김]은 사이코록 장면 안에서는 쓸 수 없어요. 대화 중에 [자물쇠 표시]로 띄운 자물쇠를 내릴 때 써요.");
          else out.push({ do: "unlocks" });
          break;
        case "질문 추가": {
          if (!v) { err(at, "[질문 추가] 뒤에 나타나게 할 항목 이름을 적어 주세요."); break; }
          /* 장면이름:항목이름 → 다른 조사 장면의 [숨김] 항목. 어느 장면에서나 쓸 수 있어요 */
          const c = v.search(/[:：]/);
          if (c >= 0) {
            const scName = v.slice(0, c).trim(), item = v.slice(c + 1).trim();
            crossAdds.push({ scName, item, at });
            out.push({ do: "show", key: scName + ":" + item });
          }
          else if (!ctx.adds) err(at, "[질문 추가] 항목이름 은 조사 장면 안에서만 쓸 수 있어요. 다른 장면의 항목은 [질문 추가] 장면이름:항목이름 으로 적어 주세요.");
          else { ctx.adds.push({ name: v, at }); out.push({ do: "show", id: v }); }
          break;
        }
        case "이동": needScene(v, at, "이동할"); out.push({ do: "goto", to: v }); flows.push({ from: curScene, to: v, at }); break;
        case "증언 추가":
        case "증언 수정":
          if (!ctx.press) err(at, `[${cmd}]은(는) 증언 장면의 추궁 대사 안에서만 쓸 수 있어요.`);
          else out.push({ do: "reveal" });
          break;
        default:
          if (VISIT_MARKERS[cmd]) err(at, `[${cmd}]은(는) 조사 장면의 ## 블록보다 위에 적어 주세요.`);
          else if (MARKERS[cmd] || BLOCK_KEYS.includes(cmd) || SCENE_KEYS.includes(cmd)) err(at, `[${cmd}]은(는) 여기에 쓸 수 없어요.`);
          else err(at, `[${cmd}]은(는) 모르는 명령이에요. 쓸 수 있는 명령: ${COMMANDS.map(c => "[" + c + "]").join(" ")}`);
      }
  };
  /* 선택지 안까지 살펴서 이 명령이 있는지 */
  const hasDo = (lines, d) => lines.some(l => l.do === d || (l.do === "choice" && l.options.some(o => hasDo(o.lines, d))));
  const hasGoto = lines => hasDo(lines, "goto");
  const blockErr = (b, allowed, sceneName) => { if (!allowed.includes(b.kind)) err(b.at, `'${sceneName}' 장면에는 '## ${b.kind}' 블록을 쓸 수 없어요. 쓸 수 있는 것: ${allowed.map(a => "## " + a).join(", ")}`); };
  const markerErr = (b, ok) => { if (b.marker && b.marker !== ok) err(b.at, `이 블록에는 그 [표시]를 쓸 수 없어요.`); };

  /* [조건] 한 개를 어떤 확인인지로 바꿉니다. 같은 이름이 여러 뜻이면 위에 있는 것부터:
     장면이름:항목이름 → 그 장면의 항목을 봤는지 / 이 장면의 항목 → 봤는지 /
     증거·인물 → 가지고 있는지 / 사이코록 장면 → 풀었는지 / 조사 장면 → 조사·대화를 전부 봤는지 */
  const crossNeeds = [];
  /* [질문 추가] 장면이름:항목이름 들과, 모든 조사 장면의 [숨김] 항목. 장면을 다 읽은 뒤 서로 맞춰 봅니다 */
  const crossAdds = [], allHidden = [];
  const resolveNeed = (n, sceneName, labels, at) => {
    const c = n.search(/[:：]/);
    if (c >= 0) {
      const scName = n.slice(0, c).trim(), item = n.slice(c + 1).trim();
      crossNeeds.push({ scName, item, at });
      return { seen: scName + ":" + item };
    }
    if (labels.includes(n)) return { seen: sceneName + ":" + n };
    if (isThing(n)) return { have: canon(n) };
    if (byName[n] && sceneType(byName[n]) === "lock") return { lock: n };
    /* 조사 장면 이름만 적으면: 그 장면의 ## 조사 / ## 대화 항목을 ([숨김] 포함) 전부 봤는지 */
    if (byName[n] && sceneType(byName[n]) === "investigate") {
      const all = byName[n].blocks.filter(b => (b.kind === "조사" || b.kind === "대화") && b.arg).map(b => n + ":" + b.arg);
      if (!all.length) err(at, `조건 '${n}' 장면에는 ## 조사 / ## 대화 항목이 하나도 없어요.`);
      return { seenAll: all };
    }
    err(at, `조건 '${n}'을(를) 찾지 못했어요. 이 장면의 ## 조사/## 대화 이름, 증거·인물 이름, 사이코록 장면 이름, 조사 장면 이름, 또는 '장면이름:항목이름' 중 하나로 적어 주세요.`);
    return null;
  };

  /* 신뢰도가 깎일 수 있는 곳([신뢰도] -n, [오답]). 갈 게임오버 장면이 있는지 마지막에 확인합니다 */
  const hpDrops = [];
  /* 법정 중인지 알아내려고 [법정 시작]/[법정 끝] 위치와 장면 사이 이동([다음], [이동])을 모아 둡니다 */
  const courtMarks = [], flows = [];
  let curScene = "";
  if (config.gameover) needScene(config.gameover, set["게임오버"].at, "[게임오버]");

  const scenes = {}, locks = {};
  for (const s of raw) {
    if (RESERVED.includes(s.name) || byName[s.name] !== s) continue;
    curScene = s.name;
    const kind = val(s.settings, "종류") || "대화";
    const type = TYPES[kind];
    if (!type) { err(s.settings["종류"].at, `[종류] '${kind}'은(는) 없어요. 대화, 조사, 증언, 사이코록, 엔딩 중에서 골라 주세요.`); continue; }
    const next = val(s.settings, "다음");
    if (next) needScene(next, s.settings["다음"].at, "[다음]");
    const ownGameover = val(s.settings, "게임오버");
    if (ownGameover) needScene(ownGameover, s.settings["게임오버"].at, "[게임오버]");
    /* [모두 추궁하면]: 증언 장면에서 추궁할 수 있는 증언을 전부 추궁하면 이 장면으로 */
    const allPressed = val(s.settings, "모두 추궁하면");
    if (s.settings["모두 추궁하면"]) {
      const at = s.settings["모두 추궁하면"].at;
      if (type !== "testimony") err(at, "[모두 추궁하면]은 증언 장면에서만 쓸 수 있어요.");
      else if (!allPressed) err(at, "[모두 추궁하면] 뒤에 다 추궁했을 때 갈 장면 이름을 적어 주세요.");
      else { needScene(allPressed, at, "[모두 추궁하면]"); flows.push({ from: s.name, to: allPressed, at: null }); }
    }
    if (s.visitAt && type !== "investigate") err(s.visitAt, "[처음 올 때] / [다시 올 때]는 조사 장면에서만 쓸 수 있어요.");

    if (type === "dialog") {
      if (s.blocks.length) err(s.blocks[0].at, `대화 장면에는 ## 블록을 쓰지 않아요. [종류]를 확인해 주세요.`);
      const lines = compileLines(s.lines);
      if (!next && !hasGoto(lines)) err(s.at, `'${s.name}' 장면이 끝난 뒤 갈 곳이 없어요. [다음] 장면 이름을 적어 주세요.`);
      scenes[s.name] = { type, lines, next };
    }

    else if (type === "investigate") {
      const ctx = { adds: [] }, hidden = [], used = {};
      const sc = { type, entry: compileLines(s.lines, ctx), first: compileLines(s.first || [], ctx), revisit: compileLines(s.revisit || [], ctx), idle: val(s.settings, "대기") || "(무엇을 할까?)" };
      for (const b of s.blocks) {
        blockErr(b, ["조사", "대화", "제시", "이동"], s.name);
        if (!b.arg) { err(b.at, `'## ${b.kind}:' 뒤에 이름을 적어 주세요.`); continue; }
        /* 같은 이름이 두 번 있으면 메뉴에 버튼이 두 개 생기고, [조건]이 한쪽에만 걸려요 */
        const dup = b.kind === "제시" ? "제시:" + b.arg : b.kind === "이동" ? "이동:" + b.arg : "항목:" + b.arg;
        if (used[dup]) err(b.at, `'## ${b.kind}: ${b.arg}'이(가) 이 장면에 이미 있어요. (${where(used[dup])}) 하나만 남겨 주세요.`);
        else used[dup] = b.at;
        /* ## 이동은 [조건]마다 갈래를 나눠서 따로 읽어요 (아래) */
        const lines = b.kind === "이동" ? [] : compileLines(b.lines, ctx), alt = compileLines(b.alt, ctx);
        /* [숨김] 항목은 [질문 추가]가 실행되기 전까지 메뉴에 안 보여요 */
        const isHidden = !!b.settings["숨김"];
        if (isHidden) {
          if (b.kind === "제시") err(b.settings["숨김"].at, "[숨김]은 ## 조사, ## 대화, ## 이동 항목에만 쓸 수 있어요.");
          else hidden.push({ name: b.arg, at: b.at });
        }
        if (b.kind === "조사" || b.kind === "대화") {
          markerErr(b, "again");
          const key = b.kind === "조사" ? "examine" : "talk";
          const it = { id: b.arg, label: b.arg, lines, hidden: isHidden };
          if (b.marker === "again") it.again = alt;
          const lk = val(b.settings, "자물쇠");
          if (lk) {
            if (!byName[lk] || sceneType(byName[lk]) !== "lock") err(b.settings["자물쇠"].at, `사이코록 '${lk}'을(를) 찾지 못했어요. [종류] 사이코록 장면이 있어야 해요.`);
            it.lock = lk; sc.present = sc.present || {};
          }
          (sc[key] = sc[key] || []).push(it);
        } else if (b.kind === "제시") {
          markerErr(b, null);
          sc.present = sc.present || {};
          if (b.arg === "그 외") sc.present.default = lines;
          else { if (!isThing(b.arg)) err(b.at, `'${b.arg}'이(가) 증거나 인물 파일에 없어요.`); sc.present[canon(b.arg)] = lines; }
        } else if (b.kind === "이동") {
          markerErr(b, "need");
          /* [조건]이 하나(또는 없음)면 블록 전체가 한 갈래. 여러 개면 [조건]부터 다음 [조건] 앞까지가 한 갈래이고,
             게임에서는 위에서부터 조건을 다 채운 첫 갈래로 가요. 아무것도 못 채우면 [조건 미달] */
          const conds = b.conds || [];
          const multi = conds.length > 1;
          if (multi && conds[0].from > 0) err(b.lines[0].at, `[조건]이 여러 개인 ## 이동 블록에서는 맨 위에 [조건]부터 적어 주세요.`);
          const branches = (conds.length ? conds : [{ val: "", at: null }]).map((c, i) => {
            const seg = multi ? b.lines.slice(c.from, i + 1 < conds.length ? conds[i + 1].from : b.lines.length) : b.lines;
            const brLines = compileLines(seg, ctx);
            if (multi && !split(c.val).length) err(c.at, `[조건] 뒤에 조건을 적어 주세요.`);
            if (!hasGoto(brLines)) err(multi ? c.at : b.at, multi ? `이 [조건] 아래에 [이동] 장면 이름 이 필요해요. (## 이동: ${b.arg})` : `'## 이동: ${b.arg}' 블록에 [이동] 장면 이름 이 필요해요.`);
            return { lines: brLines, rawNeed: split(c.val), needAt: c.at };
          });
          (sc.move = sc.move || []).push({ label: b.arg, hidden: isHidden, branches, needLines: alt.length ? alt : [[config.hero, "(아직 할 일이 남아 있다.)"]] });
        }
      }
      const labels = [...(sc.examine || []), ...(sc.talk || [])].map(x => x.id);
      for (const br of (sc.move || []).flatMap(mv => mv.branches)) {
        br.need = br.rawNeed.map(n => resolveNeed(n, s.name, labels, br.needAt)).filter(Boolean);
        delete br.rawNeed; delete br.needAt;
      }
      if (!sc.examine && !sc.talk && !sc.move) err(s.at, `'${s.name}' 조사 장면에 ## 조사, ## 대화, ## 이동 블록이 하나도 없어요.`);
      ctx.adds.forEach(a => { if (!hidden.some(h => h.name === a.name)) err(a.at, `[질문 추가] '${a.name}'은(는) 이 장면의 [숨김] 항목에 없어요. 항목 이름과 [숨김]을 확인해 주세요.`); });
      hidden.forEach(h => allHidden.push({ scene: s.name, name: h.name, at: h.at, local: ctx.adds.some(a => a.name === h.name) }));
      scenes[s.name] = sc;
    }

    else if (type === "testimony") {
      const sc = { type, entry: compileLines(s.lines), title: val(s.settings, "제목") || "증언", witness: val(s.settings, "증인"), statements: [], after: [], gameover: val(s.settings, "게임오버"), allPressed,
        wrong: [["재판장", "변호인, 그 증거가 지금 증언과 무슨 관계가 있습니까?"]] };
      if (!sc.witness) err(s.at, `'${s.name}' 증언 장면에 [증인]이 없어요.`);
      else if (!(sc.witness in cast)) err(s.settings["증인"].at, `증인 '${sc.witness}'이(가) 등장인물에 없어요.`);
      if (!sc.gameover && !config.gameover) err(s.at, `'${s.name}' 증언 장면에서 신뢰도가 0이 되면 갈 곳이 없어요. 이 장면에 [게임오버] 장면 이름을 적거나, 설정에 기본 [게임오버]를 적어 주세요.`);
      for (const b of s.blocks) {
        blockErr(b, ["증언", "추가 증언", "수정 증언", "제시", "신문 시작 전", "틀렸을 때", "끝까지 들었을 때"], s.name);
        markerErr(b, b.kind === "끝까지 들었을 때" ? "changed" : null);
        const isStmt = b.kind === "증언" || b.kind === "추가 증언" || b.kind === "수정 증언";
        const lines = compileLines(b.lines, { press: isStmt });
        if (isStmt) {
          if (!b.arg) err(b.at, `'## ${b.kind}:' 뒤에 증언 내용을 적어 주세요.`);
          starCheck(b.arg, b.at);
          /* manual: 추궁 대사에 [증언 추가]가 있으면 그 명령이 실행될 때만 증언이 나타남 */
          const st = { text: br(b.arg), press: lines.length ? lines : null, present: {}, manual: hasDo(lines, "reveal"), at: b.at };
          /* 추가/수정 증언은 바로 위 증언을 추궁하면 나타납니다 */
          if (b.kind !== "증언") {
            const from = sc.statements.length - 1;
            if (from < 0) { err(b.at, `## ${b.kind} 블록은 ## 증언 블록 아래에 적어 주세요.`); continue; }
            if (!sc.statements[from].press) err(b.at, `## ${b.kind}은(는) 바로 위 증언을 추궁하면 나타나요. 위 증언에 추궁 대사를 적어 주세요.`);
            st.from = from;
            if (b.kind === "수정 증언") st.replaces = from;
          }
          sc.statements.push(st);
        } else if (b.kind === "제시") {
          const st = sc.statements[sc.statements.length - 1];
          if (!st) { err(b.at, "## 제시 블록은 해당 ## 증언 블록 아래에 적어 주세요."); continue; }
          if (!isThing(b.arg)) err(b.at, `'${b.arg}'이(가) 증거나 인물 파일에 없어요.`);
          st.present[canon(b.arg)] = lines;
        } else if (b.kind === "끝까지 들었을 때") {
          sc.loop = lines;
          if (b.marker === "changed") sc.loopChanged = compileLines(b.alt);
        } else if (b.kind === "신문 시작 전") sc.after = lines;
        else if (b.kind === "틀렸을 때") sc.wrong = lines;
      }
      sc.statements.forEach((st, i) => {
        if (st.manual && !sc.statements.some(o => o.from === i)) err(st.at, "추궁 대사에 [증언 추가]가 있는데, 바로 아래에 ## 추가 증언이나 ## 수정 증언이 없어요.");
      });
      if (!sc.statements.some(st => st.from === undefined)) err(s.at, `'${s.name}' 증언 장면에 ## 증언 블록이 없어요.`);
      scenes[s.name] = sc;
    }

    else if (type === "lock") {
      const L = { steps: [],
        refuse: [[config.hero, "(마음의 자물쇠가 보인다.)"], { do: "locks" }],
        intro: [], wrong: [["", "통하지 않은 모양이다."]],
        fail: [["", "자물쇠가 다시 단단히 잠겼다."]], giveup: [[config.hero, "(지금은 물러나자.)"]],
        done: [{ do: "objection", text: "해제", style: "unlock" }] };
      const map = { "거부": "refuse", "시작": "intro", "틀렸을 때": "wrong", "실패": "fail", "포기": "giveup", "해제": "done" };
      for (const b of s.blocks) {
        blockErr(b, ["거부", "시작", "자물쇠", "틀렸을 때", "실패", "포기", "해제"], s.name);
        if (b.kind === "자물쇠") {
          markerErr(b, "ok");
          const ans = val(b.settings, "정답");
          if (!ans) err(b.at, "## 자물쇠 블록에 [정답] 증거 이름이 필요해요.");
          else if (!isThing(ans)) err(b.settings["정답"].at, `정답 '${ans}'이(가) 증거나 인물 파일에 없어요.`);
          if (!b.alt.length) err(b.at, "## 자물쇠 블록에 [정답일 때] 아래 대사가 필요해요.");
          L.steps.push({ lines: compileLines(b.lines, { inLock: true }), answer: canon(ans), ok: compileLines(b.alt, { inLock: true }) });
        } else if (map[b.kind]) {
          markerErr(b, null);
          let lines = compileLines(b.lines, { inLock: true });
          if (b.kind === "거부" && !lines.some(l => l.do === "locks")) lines = [{ do: "locks" }, ...lines];
          L[map[b.kind]] = lines;
        }
      }
      if (!L.steps.length) err(s.at, `'${s.name}' 사이코록에 ## 자물쇠 블록이 없어요.`);
      locks[s.name] = L;
    }

    else if (type === "end") {
      const body = br(val(s.settings, "본문") || s.lines.filter(x => x.text).map(x => x.text).join("\n"));
      const retry = val(s.settings, "다시 시작");
      if (retry) needScene(retry, s.settings["다시 시작"].at, "[다시 시작]");
      scenes[s.name] = { type, title: val(s.settings, "제목") || s.name, body, retry };
    }
    /* 이 장면에서 신뢰도가 0이 되면 갈 곳: 장면의 [게임오버] → 설정의 [게임오버] */
    if (scenes[s.name]) scenes[s.name].gameover = ownGameover || config.gameover;
  }
  /* 법정 중인지 판단: 첫 장면은 법정 밖에서 시작. [다음]/[이동]을 따라가며, 그 자리까지의
     [법정 시작]/[법정 끝]을 반영해 '법정 중에 도착할 수 있는 장면'을 넓혀 갑니다. */
  for (const s of raw) { const nx = val(s.settings, "다음"); if (nx) flows.push({ from: s.name, to: nx, at: null }); }
  const courtEntry = {};
  const courtAt = (scene, at) => {
    let on = !!courtEntry[scene];
    courtMarks.filter(m => m.scene === scene && (!at || (m.at.file === at.file && m.at.line < at.line)))
      .sort((a, b) => a.at.line - b.at.line).forEach(m => { on = m.on; });
    return on;
  };
  for (let changed = true, n = 0; changed && n < raw.length + 2; n++) {
    changed = false;
    for (const f of flows) if (!courtEntry[f.to] && courtAt(f.from, f.at)) { courtEntry[f.to] = true; changed = true; }
  }

  for (const d of hpDrops) {
    const sc = byName[d.scene];
    if (!sc || sceneType(sc) === "lock") continue;
    /* [오답]·[제시 요구]는 법정 중일 때만 신뢰도가 깎여요. 법정 밖이면 게임오버 장면이 필요 없어요 */
    if (d.courtOnly && !courtAt(d.scene, d.at)) continue;
    if (!val(sc.settings, "게임오버") && !config.gameover) err(d.at, `여기서 신뢰도가 0이 되면 갈 게임오버 장면이 없어요. 설정에 기본 [게임오버]를 적거나, '${d.scene}' 장면에 [게임오버]를 적어 주세요.`);
  }

  /* 다른 장면의 항목을 가리키는 [조건]은 모든 장면을 읽은 뒤에 확인합니다 */
  for (const { scName, item, at } of crossNeeds) {
    const sc = byName[scName];
    if (!sc || sceneType(sc) !== "investigate") err(at, `조건 '${scName}:${item}'의 '${scName}' 조사 장면을 찾지 못했어요.`);
    else if (!sc.blocks.some(b => (b.kind === "조사" || b.kind === "대화") && b.arg === item)) err(at, `조건 '${scName}:${item}'의 '${item}'이(가) '${scName}' 장면의 ## 조사/## 대화 이름에 없어요.`);
  }

  for (const { scName, item, at } of crossAdds) {
    const sc = byName[scName];
    const b = sc && sceneType(sc) === "investigate" && sc.blocks.find(b => ["조사", "대화", "이동"].includes(b.kind) && b.arg === item);
    if (!sc || sceneType(sc) !== "investigate") err(at, `[질문 추가] '${scName}:${item}'의 '${scName}' 조사 장면을 찾지 못했어요.`);
    else if (!b) err(at, `[질문 추가] '${scName}:${item}'의 '${item}'이(가) '${scName}' 장면의 ## 조사/## 대화/## 이동 이름에 없어요.`);
    else if (!b.settings["숨김"]) err(at, `'${scName}' 장면의 '${item}'은(는) [숨김] 항목이 아니라서 처음부터 보여요. 숨기려면 그 항목 아래에 [숨김]을 적어 주세요.`);
  }
  for (const h of allHidden) {
    if (!h.local && !crossAdds.some(a => a.scName === h.scene && a.item === h.name))
      err(h.at, `'${h.name}'은(는) [숨김]인데, [질문 추가] ${h.name} (이 장면 안) 이나 [질문 추가] ${h.scene}:${h.name} (다른 장면) 이 어디에도 없어서 영영 안 보여요.`);
  }

  /* [챕터]: 타이틀의 "챕터 선택"에 나오는 시작 지점 */
  const chapterNames = {};
  for (const s of raw) {
    const c = s.settings["챕터"];
    if (!c || !scenes[s.name] || byName[s.name] !== s) continue;
    if (!c.val) { err(c.at, "[챕터] 뒤에 챕터 이름을 적어 주세요. 예) [챕터] 1일차 · 탐정"); continue; }
    if (["lock", "end"].includes(scenes[s.name].type)) { err(c.at, "[챕터]는 사이코록이나 엔딩 장면에는 쓸 수 없어요."); continue; }
    if (chapterNames[c.val]) err(c.at, `챕터 이름 '${c.val}'이(가) '${chapterNames[c.val]}' 장면에도 있어요. 다른 이름으로 바꿔 주세요.`);
    chapterNames[c.val] = s.name;
    scenes[s.name].chapter = c.val;
  }

  return { config, cast, evidence, people, scenes, locks, errors };
}

/* 두 이름이 글자 하나만 다른지 (오타 찾기용) */
function oneOff(a, b) {
  if (a === b || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

function where(at) {
  if (!at || !at.file) return "설정";
  return at.line ? `${at.file} ${at.line}번째 줄` : at.file;
}
