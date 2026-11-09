/*
 * REF 글자 읽기 — 회사 Power Automate(AI Builder 텍스트 인식) 연결
 *
 *  - 사진(줄인 JPEG)을 회사 흐름으로 보내 글자 줄·좌표를 받고, 'REF' 뒤 번호를 찾아 전산 목록과 맞춘다.
 *  - 흐름 주소(비밀 sig 포함)와 접속 키는 공개 사이트에 넣지 않는다:
 *      설정 링크(...#refocr=<부호>)를 폰에서 한 번 열면 그 폰 브라우저에만 저장(주소창의 # 뒤는 서버로 안 감)
 *  - 사진은 회사 마이크로소프트 클라우드로만 가고, 흐름은 저장하지 않는다(사장님 승인 조건, 2026-11-09)
 *  - 'REF' 바로 뒤 번호만 REF로 인정. 전산 목록에 없으면 흔한 오인식(O→0, I→1, S→5 …)을 고쳐 보고,
 *    그래도 없으면 1글자만 다른 REF가 딱 하나일 때 '추정'으로 표시.
 */
(function (global) {
  'use strict';
  var C = global.KtsCore;
  var R = {};
  var CONF_KEY = 'ktsInv.refOcr.v1', ON_KEY = 'ktsInv.refOcrOn.v1';

  /* ---------------- 설정(폰에만 저장) ---------------- */
  function b64urlDecode(s) {
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    var bin = atob(s), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  }
  var FLOW_URL_RE = /^https:\/\/[a-z0-9.-]+\.(environment\.api\.powerplatform\.com|logic\.azure\.com)(:443)?\//i;
  // u: REF 글자 읽기 흐름 주소, k: 접속 키, l: 재고 입출고 기록 흐름 주소(있을 때만)
  function validConf(c) {
    return c && typeof c.u === 'string' && typeof c.k === 'string' && c.k.length >= 32 && FLOW_URL_RE.test(c.u) &&
      (c.l === undefined || (typeof c.l === 'string' && FLOW_URL_RE.test(c.l)));
  }
  R.parseSetup = function (text) {   // 설정 링크 전체 또는 '#refocr=' 뒤 부호
    var m = /refocr=([A-Za-z0-9_\-]+)/.exec(String(text || ''));
    var code = m ? m[1] : String(text || '').trim();
    try { var c = JSON.parse(b64urlDecode(code)); return validConf(c) ? c : null; } catch (e) { return null; }
  };
  R.getConf = function () {
    try { var c = JSON.parse(localStorage.getItem(CONF_KEY) || 'null'); return validConf(c) ? c : null; } catch (e) { return null; }
  };
  R.setConf = function (c) { try { localStorage.setItem(CONF_KEY, JSON.stringify(c)); return true; } catch (e) { return false; } };
  R.clearConf = function () { try { localStorage.removeItem(CONF_KEY); } catch (e) { /* 무시 */ } };
  R.isOn = function () {
    if (!R.getConf()) return false;
    try { return localStorage.getItem(ON_KEY) !== '0'; } catch (e) { return true; }
  };
  R.setOn = function (on) { try { localStorage.setItem(ON_KEY, on ? '1' : '0'); } catch (e) { /* 무시 */ } };
  // 주소창의 #refocr=... 를 읽어 저장하고 주소창에서 지움(화면 캡처·공유 때 새지 않게)
  R.consumeHash = function () {
    if (!/refocr=/.test(location.hash)) return null;
    var c = R.parseSetup(location.hash);
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { location.hash = ''; }
    if (c) { R.setConf(c); R.setOn(true); }
    return c ? 'ok' : 'bad';
  };

  /* ---------------- 사진 보내기 ---------------- */
  // 그림(img/video/canvas)의 한 부분을 긴 변 maxSide 이하 JPEG(base64)로
  R.toJpeg = function (src, sx, sy, sw, sh, maxSide, quality) {
    var s = Math.min(1, maxSide / Math.max(sw, sh));
    var w = Math.max(1, Math.round(sw * s)), h = Math.max(1, Math.round(sh * s));
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
    ctx.drawImage(src, sx, sy, sw, sh, 0, 0, w, h);
    var url = c.toDataURL('image/jpeg', quality || 0.85);
    c.width = c.height = 0;
    return { b64: url.slice(url.indexOf(',') + 1), w: w, h: h, scale: s };
  };
  R.stats = { calls: 0, ok: 0, fail: 0, lastErr: '', lastMs: 0 };
  // 보내고 받은 글자 줄 목록을 돌려줌: [{t, x0,y0,x1,y1(보낸 그림 기준 픽셀)}]
  R.recognize = function (jpeg, timeoutMs) {
    var conf = R.getConf();
    if (!conf) return Promise.reject(new Error('REF 글자 읽기가 연결되지 않았습니다'));
    R.stats.calls++;
    var t0 = performance.now();
    var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, timeoutMs || 45000) : null;
    // text/plain 으로 보내면 브라우저 사전 확인(preflight)이 없음 → 흐름이 글자를 JSON으로 다시 읽음
    return fetch(conf.u, {
      method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({ key: conf.k, img: jpeg.b64, type: 'image/jpeg' }),
      cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer',
      signal: ctl ? ctl.signal : undefined
    }).then(function (res) {
      return res.text().then(function (txt) {
        var j = null;
        try { j = JSON.parse(txt); } catch (e) { /* 아래에서 처리 */ }
        if (!res.ok || !j || !j.ok) {
          var why = res.status === 403 ? '접속 키가 맞지 않습니다(설정 링크를 다시 열어 주세요)'
            : res.status === 404 ? '흐름이 꺼져 있거나 주소가 바뀌었습니다'
            : (j && j.error) ? String(j.error).slice(0, 200) : ('응답 ' + res.status);
          throw new Error(why);
        }
        return j.out;
      });
    }).then(function (out) {
      R.stats.ok++; R.stats.lastMs = Math.round(performance.now() - t0);
      return R.collectLines(out, jpeg.w, jpeg.h);
    }, function (e) {
      R.stats.fail++;
      R.stats.lastErr = (e && e.name === 'AbortError') ? '시간 초과' : (e && e.message) || String(e);
      throw new Error(R.stats.lastErr);
    }).finally(function () { if (timer) clearTimeout(timer); });
  };

  /* ---------------- 응답에서 글자 줄 모으기 ---------------- */
  // AI Builder 출력 모양이 바뀌어도 되도록, 'text' 글자를 가진 줄 객체를 재귀로 찾아 좌표와 함께 모은다.
  function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
  function boxOf(o) {
    var b = o.boundingBox || o.boundingbox || o.coordinates || o.boundingPolygon || o.polygon || o.box || o.bbox;
    if (!b) return null;
    if (Array.isArray(b)) {
      if (b.length >= 4 && typeof b[0] === 'number') {               // [x1,y1,x2,y2,...] 꼭짓점 목록
        var xs = [], ys = [];
        for (var i = 0; i + 1 < b.length; i += 2) { xs.push(b[i]); ys.push(b[i + 1]); }
        return { x0: Math.min.apply(null, xs), y0: Math.min.apply(null, ys), x1: Math.max.apply(null, xs), y1: Math.max.apply(null, ys) };
      }
      if (b.length && typeof b[0] === 'object') {                    // [{x,y},...]
        var px = b.map(function (p) { return num(p.x); }).filter(function (v) { return v !== null; });
        var py = b.map(function (p) { return num(p.y); }).filter(function (v) { return v !== null; });
        if (px.length && py.length) return { x0: Math.min.apply(null, px), y0: Math.min.apply(null, py), x1: Math.max.apply(null, px), y1: Math.max.apply(null, py) };
      }
      return null;
    }
    var l = num(b.left), t = num(b.top), w = num(b.width), h = num(b.height);
    if (l === null) l = num(b.x);
    if (t === null) t = num(b.y);
    if (l !== null && t !== null && w !== null && h !== null) return { x0: l, y0: t, x1: l + w, y1: t + h };
    return null;
  }
  R.collectLines = function (out, W, H) {
    var lines = [], seen = 0;
    (function walk(o, depth) {
      if (!o || depth > 12 || seen > 20000) return;
      seen++;
      if (Array.isArray(o)) { o.forEach(function (x) { walk(x, depth + 1); }); return; }
      if (typeof o !== 'object') return;
      var hasKids = Array.isArray(o.lines) || Array.isArray(o.words);
      if (typeof o.text === 'string' && o.text.trim() && !hasKids) {
        var b = boxOf(o);
        if (b && b.x1 <= 1.5 && b.y1 <= 1.5) b = { x0: b.x0 * W, y0: b.y0 * H, x1: b.x1 * W, y1: b.y1 * H };   // 0~1 비율이면 픽셀로
        lines.push({ t: o.text.trim(), b: b });
        return;
      }
      Object.keys(o).forEach(function (k) {
        if (/^(fulltext|fullText|text)$/i.test(k) && typeof o[k] === 'string') return;   // 전체 글은 줄과 중복
        walk(o[k], depth + 1);
      });
    })(out, 0);
    return lines;
  };

  /* ---------------- 'REF' 뒤 번호 찾기 ---------------- */
  var KEY_RE = /^[\[\(|{]?(REF|RFF|REE|R3F|KEF|PEF|BEF|REP|RIF|RCF)[\]\)|}:.]*$/i;
  var KEY_JOIN = /^[\[\(|{]?(REF|RFF|REE|R3F|KEF|PEF|BEF|REP|RIF|RCF)[\]\)|}:.]*([A-Z0-9][A-Z0-9_\-+./]{3,})$/i;
  var FIX = { O: '0', Q: '0', D: '0', U: '0', I: '1', L: '1', '|': '1', J: '1', Z: '2', S: '5', B: '8', G: '6', T: '7', A: '4' };
  function clean(s) { return String(s || '').toUpperCase().replace(/^[^A-Z0-9|]+|[^A-Z0-9|]+$/g, ''); }
  function lev(a, b, cap) {   // 편집 거리(cap 넘으면 cap+1)
    if (Math.abs(a.length - b.length) > cap) return cap + 1;
    var prev = [], cur, i, j;
    for (j = 0; j <= b.length; j++) prev[j] = j;
    for (i = 1; i <= a.length; i++) {
      cur = [i]; var rowMin = i;
      for (j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1));
        if (cur[j] < rowMin) rowMin = cur[j];
      }
      if (rowMin > cap) return cap + 1;
      prev = cur;
    }
    return prev[b.length];
  }
  var digitCodesCache = { index: null, list: [] };
  function digitCodes(index) {
    if (digitCodesCache.index !== index) {
      digitCodesCache = { index: index, list: Object.keys(index).filter(function (k) { return /^\d{6,10}$/.test(k); }) };
    }
    return digitCodesCache.list;
  }
  // 글자 덩어리 → 전산 REF. how: exact(그대로) / fixed(흔한 오인식 고침) / fuzzy(1글자 차이 추정)
  R.matchCode = function (raw, index) {
    var t = clean(raw);
    if (t.length < 4) return null;
    if (index[C.normCode(t)]) return { code: index[C.normCode(t)].code, how: 'exact', raw: t };
    var digits = (t.match(/\d/g) || []).length;
    if (digits >= Math.max(4, t.length - 2)) {
      var f = t.split('').map(function (ch) { return /\d/.test(ch) ? ch : (FIX[ch] || ch); }).join('');
      if (index[f]) return { code: index[f].code, how: 'fixed', raw: t };
      if (/^\d{6,10}$/.test(f)) {
        var best = [], bd = 2;
        digitCodes(index).forEach(function (c) {
          var d = lev(f, c, 1);
          if (d < bd) { bd = d; best = [c]; } else if (d === bd) best.push(c);
        });
        if (bd === 1 && best.length === 1) return { code: index[best[0]].code, how: 'fuzzy', raw: t };
      }
    }
    return null;
  };
  function center(b) { return b ? { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2, h: Math.max(1, b.y1 - b.y0) } : null; }
  // 줄 목록 → REF 표시 목록 [{code, how, raw, cx, cy, h, keyword}]
  R.findRefs = function (lines, index) {
    if (!index) return [];
    var marks = [];
    function push(m, line) {
      var c = center(line.b);
      m.cx = c ? c.x : -1; m.cy = c ? c.y : -1; m.h = c ? c.h : 0;
      marks.push(m);
    }
    lines.forEach(function (line, li) {
      var toks = line.t.split(/\s+/).filter(Boolean);
      for (var i = 0; i < toks.length; i++) {
        var jm = KEY_JOIN.exec(toks[i]);
        if (jm) { var m0 = R.matchCode(jm[2], index); if (m0) { m0.keyword = true; push(m0, line); } continue; }
        if (!KEY_RE.test(toks[i])) continue;
        // 'REF' 다음 덩어리(띄어 쓴 번호 '66 93 522'도 붙여 봄)
        var cands = [], acc = '';
        for (var j = i + 1; j < Math.min(toks.length, i + 4); j++) { acc += toks[j]; cands.push(acc); }
        // 'REF' 상자만 한 줄로 읽히고 번호가 다른 줄이면: 오른쪽 같은 높이 줄 → 바로 아래 줄 순서로
        if (!cands.length) {
          var near = R.neighbor(lines, li);
          if (near) near.t.split(/\s+/).slice(0, 3).reduce(function (a, s) { a = a + s; cands.push(a); return a; }, '');
        }
        for (var k = 0; k < cands.length; k++) {
          var m = R.matchCode(cands[k], index);
          if (m) { m.keyword = true; push(m, line); break; }
        }
      }
    });
    if (!marks.length) {   // 'REF' 표시를 못 읽었으면: 전산 REF와 글자 그대로 똑같은 7자리 이상 덩어리만(추정)
      lines.forEach(function (line) {
        line.t.split(/\s+/).forEach(function (tok) {
          var t = clean(tok);
          if (t.length >= 7 && index[C.normCode(t)]) push({ code: index[C.normCode(t)].code, how: 'noKeyword', raw: t, keyword: false }, line);
        });
      });
    }
    // 같은 REF가 가까이 두 번 잡히면 하나로(좋은 쪽 남김)
    var rank = { exact: 0, fixed: 1, fuzzy: 2, noKeyword: 3 }, outM = [];
    marks.sort(function (a, b) { return rank[a.how] - rank[b.how]; }).forEach(function (m) {
      var dup = outM.some(function (o) {
        return o.code === m.code && (o.cx < 0 || m.cx < 0 || Math.hypot(o.cx - m.cx, o.cy - m.cy) < Math.max(o.h, m.h) * 4);
      });
      if (!dup) outM.push(m);
    });
    return outM;
  };
  R.neighbor = function (lines, li) {
    var a = lines[li], ca = center(a.b);
    if (ca) {
      var best = null, bd = Infinity;
      lines.forEach(function (l, i) {
        if (i === li || !l.b) return;
        var c = center(l.b);
        if (Math.abs(c.y - ca.y) < ca.h * 0.8 && l.b.x0 >= a.b.x0) {          // 같은 높이 오른쪽
          var d = l.b.x0 - a.b.x1; if (d < bd && d > -ca.h) { bd = d; best = l; }
        }
      });
      if (best) return best;
      lines.forEach(function (l, i) {                                        // 바로 아래
        if (i === li || !l.b || best) return;
        var c = center(l.b);
        if (c.y > ca.y && c.y - ca.y < ca.h * 2.2 && Math.abs(l.b.x0 - a.b.x0) < ca.h * 6) best = l;
      });
      if (best) return best;
    }
    return lines[li + 1] || null;
  };

  /* ---------------- 화면 칸(두 화면 공통): 켜기·연결 상태·설정 ---------------- */
  R.mountBox = function (container, onChange) {
    var E = C.el;
    var box = E('div', 'ref-box');
    var chkWrap = E('label', 'check');
    var chk = E('input'); chk.type = 'checkbox'; chk.id = 'ref-on';
    chkWrap.appendChild(chk);
    chkWrap.appendChild(E('span', '', 'REF 글자도 읽기 (회사 AI Builder 텍스트 인식)'));
    box.appendChild(chkWrap);
    var st = E('p', 'status'); st.id = 'ref-status'; st.style.marginTop = '0';
    box.appendChild(st);
    var det = E('details'); det.id = 'ref-setup';
    det.appendChild(E('summary', '', 'REF 글자 읽기 연결 설정'));
    det.appendChild(E('p', 'note', '관리자에게 받은 설정 링크를 이 폰에서 한 번 열면 자동으로 연결됩니다. 안 되면 링크 전체를 아래에 붙여넣어 주세요.'));
    var ta = E('textarea'); ta.id = 'ref-code'; ta.setAttribute('aria-label', '설정 링크 붙여넣기'); ta.style.minHeight = '70px';
    det.appendChild(ta);
    var row = E('div', 'row');
    var save = E('button', 'small-btn', '연결'); save.type = 'button'; save.id = 'ref-save';
    var clr = E('button', 'small-btn', '연결 해제'); clr.type = 'button'; clr.id = 'ref-clear';
    row.appendChild(save); row.appendChild(clr);
    det.appendChild(row);
    box.appendChild(det);
    container.appendChild(box);

    function refresh(msg, cls) {
      var conf = R.getConf();
      chk.disabled = !conf;
      chk.checked = R.isOn();
      clr.disabled = !conf;
      if (msg) { st.textContent = msg; st.className = 'status ' + (cls || ''); }
      else if (!conf) { st.textContent = '연결 안 됨 — 관리자에게 받은 설정 링크를 이 폰에서 한 번 열어 주세요.'; st.className = 'status warn'; }
      else if (chk.checked) { st.textContent = '연결됨 · 켜짐: 사진이 회사 마이크로소프트 클라우드(AI Builder)로 가서 글자만 읽고, 저장하지 않습니다.'; st.className = 'status ok'; }
      else { st.textContent = '연결됨 · 꺼짐: 바코드만 읽습니다(사진은 폰 밖으로 안 나감).'; st.className = 'status'; }
      if (onChange) onChange(R.isOn());
    }
    chk.addEventListener('change', function () { R.setOn(chk.checked); refresh(); });
    save.addEventListener('click', function () {
      var c = R.parseSetup(ta.value);
      if (!c) { refresh('❌ 설정 링크가 올바르지 않습니다. 받은 링크 전체를 붙여넣어 주세요.', 'bad'); return; }
      R.setConf(c); R.setOn(true); ta.value = ''; det.open = false; refresh();
    });
    clr.addEventListener('click', function () { R.clearConf(); refresh(); });
    var h = R.consumeHash();
    refresh(h === 'bad' ? '❌ 설정 링크가 올바르지 않습니다. 관리자에게 다시 받아 주세요.' : h === 'ok' ? '✅ REF 글자 읽기가 이 폰에 연결됐습니다.' : null, h === 'ok' ? 'ok' : 'bad');
    return { refresh: refresh };
  };

  global.KtsRefOcr = R;
})(window);
