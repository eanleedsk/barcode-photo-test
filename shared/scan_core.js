/*
 * 재고 시험 페이지 공통 부품 (사진 선반 안내 / 연속 스캔 시험에서 같이 씀)
 *
 *  1) 바코드 읽기 : zxing-wasm(MIT)로 이 폰 안에서만 읽는다. 사진은 어디로도 보내지 않는다.
 *  2) 바코드 해석 : 선반 라벨(KTS-/KN-), 제조사 라벨(M+7자리+S+시리얼), HIBC(+E276…), 7자리 숫자
 *  3) 전산 목록   : 엑셀(.xlsx)·CSV 파일 또는 붙여넣기. 외부 라이브러리 없이 브라우저 기능으로 읽는다.
 *  4) 저장        : 목록은 기본적으로 이 창(탭)에서만 쓰고 창을 닫으면 지워진다.
 *                   "이 폰에 기억하기"를 켰을 때만 폰 브라우저에 남긴다.
 *                   번호 연결(제조사 번호 → 전산 품목번호)은 번호만 남기므로 폰에 기억한다.
 *
 * 화면에 넣는 바코드·목록 내용은 항상 textContent(글자)로만 넣는다(HTML로 해석되지 않게).
 */
(function (global) {
  'use strict';

  var Core = {};

  /* ============================== 작은 도우미 ============================== */
  Core.$ = function (id) { return document.getElementById(id); };
  Core.el = function (tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  };
  Core.tick = function () { return new Promise(function (r) { setTimeout(r, 0); }); };
  Core.pad2 = function (n) { return (n < 10 ? '0' : '') + n; };
  Core.fmtClock = function (d) { return Core.pad2(d.getHours()) + ':' + Core.pad2(d.getMinutes()) + ':' + Core.pad2(d.getSeconds()); };
  Core.fmtDate = function (d) { return d.getFullYear() + '-' + Core.pad2(d.getMonth() + 1) + '-' + Core.pad2(d.getDate()); };

  Core.deviceText = function () {
    var ua = navigator.userAgent || '';
    var kind = /iPhone|iPod/.test(ua) ? '아이폰'
      : /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? '아이패드'
      : /Android/.test(ua) ? '안드로이드' : '컴퓨터 또는 기타';
    var br = /SamsungBrowser/.test(ua) ? '삼성 인터넷'
      : /EdgA|EdgiOS|Edg\//.test(ua) ? '엣지'
      : /CriOS|Chrome/.test(ua) ? '크롬'
      : /FxiOS|Firefox/.test(ua) ? '파이어폭스'
      : /Safari/.test(ua) ? '사파리' : '기타 브라우저';
    return kind + ' · ' + br + ' · 화면 ' + screen.width + '×' + screen.height;
  };

  Core.copyText = function (text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return fallback(); });
    }
    return Promise.resolve(fallback());
    function fallback() {
      try {
        var ta = document.createElement('textarea');
        ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
      } catch (e) { return false; }
    }
  };

  /* ============================== 읽기 엔진 ============================== */
  var enginePromise = null;
  Core.initEngine = function (vendorPath) {
    if (enginePromise) return enginePromise;
    if (typeof ZXingWASM === 'undefined' || typeof WebAssembly === 'undefined') {
      enginePromise = Promise.resolve(false);
    } else {
      enginePromise = ZXingWASM.prepareZXingModule({
        overrides: { locateFile: function (p) { return vendorPath + p; } },
        fireImmediately: true
      }).then(function () { return true; }, function () { return false; });
    }
    return enginePromise;
  };
  Core.engineText = function () {
    return '읽기 엔진: zxing-wasm ' + ((typeof ZXingWASM !== 'undefined' && ZXingWASM.ZXING_WASM_VERSION) || '');
  };

  /* ============================== 사진 → 픽셀 ============================== */
  Core.loadImage = function (file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { resolve({ img: img, url: url }); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('사진을 열 수 없습니다')); };
      img.src = url;
    });
  };
  // 화면 표시용 작은 미리보기(저장하지 않음)
  Core.thumbOf = function (img, side) {
    try {
      var W = img.naturalWidth, H = img.naturalHeight, s = side / Math.max(W, H);
      var c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(W * s)); c.height = Math.max(1, Math.round(H * s));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      var url = c.toDataURL('image/jpeg', 0.6);
      c.width = c.height = 0;
      return url;
    } catch (e) { return ''; }
  };
  function drawRegion(img, a) {
    var w = Math.max(1, Math.round(a.sw * a.scale)), h = Math.max(1, Math.round(a.sh * a.scale));
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, a.sx, a.sy, a.sw, a.sh, 0, 0, w, h);
    var id = ctx.getImageData(0, 0, w, h);
    c.width = c.height = 0;                       // 아이폰에서 그림판 메모리를 바로 반납
    return id;
  }
  function grayOf(id) {
    var d = id.data, n = d.length / 4, g = new Uint8ClampedArray(n);
    for (var i = 0, j = 0; i < n; i++, j += 4) g[i] = (d[j] * 299 + d[j + 1] * 587 + d[j + 2] * 114) / 1000;
    return g;
  }
  function grayToImageData(g, w, h) {
    var out = new ImageData(w, h), d = out.data;
    for (var i = 0, j = 0; i < g.length; i++, j += 4) { d[j] = d[j + 1] = d[j + 2] = g[i]; d[j + 3] = 255; }
    return out;
  }
  function stretch(g) {                            // 어두운 쪽 2%, 밝은 쪽 2%를 잘라내고 0~255로 넓힘
    var hist = new Uint32Array(256), i;
    for (i = 0; i < g.length; i++) hist[g[i]]++;
    var cut = g.length * 0.02, acc = 0, lo = 0, hi = 255;
    for (i = 0; i < 256; i++) { acc += hist[i]; if (acc >= cut) { lo = i; break; } }
    acc = 0;
    for (i = 255; i >= 0; i--) { acc += hist[i]; if (acc >= cut) { hi = i; break; } }
    if (hi - lo < 10) return g;
    var out = new Uint8ClampedArray(g.length), k = 255 / (hi - lo);
    for (i = 0; i < g.length; i++) out[i] = (g[i] - lo) * k;
    return out;
  }
  function binarize(g, t) {
    var out = new Uint8ClampedArray(g.length);
    for (var i = 0; i < g.length; i++) out[i] = g[i] > t ? 255 : 0;
    return out;
  }

  /* ============================== 사진 읽기 ============================== */
  var MAX_AREA = 12e6;   // 아이폰 사파리 그림판 한도(약 1,670만 화소)보다 작게
  function att(tag, r, scale, mode, t) {
    var s = Math.min(scale, Math.sqrt(MAX_AREA / (r.sw * r.sh)));
    return { tag: tag, sx: r.sx, sy: r.sy, sw: r.sw, sh: r.sh, scale: s, mode: mode, t: t };
  }
  // 읽기 방법 목록. mode: 'thorough'(꼼꼼히) / 'fast'(빠르게)
  Core.photoAttempts = function (W, H, mode) {
    var L = Math.max(W, H), full = { sx: 0, sy: 0, sw: W, sh: H }, list = [];
    var thorough = mode !== 'fast';
    if (L > 2000) {
      var s = Math.min(1, 3000 / L);
      list.push(att('원본', full, s, 'plain'));
      list.push(att('대비 보정', full, s, 'contrast'));
      if (thorough) {
        list.push(att('축소', full, 1600 / L, 'plain'));
        list.push(att('흑백 변환(문턱 140)', full, 2000 / L, 'thr', 140));
        list.push(att('흑백 변환(문턱 180)', full, 2000 / L, 'thr', 180));
      }
      // 조각 확대: 사진을 겹치게 4등분해서 더 크게 읽는다(한 장에 작은 라벨이 여러 개일 때)
      // 조각은 가능한 한 원래 크기로 읽는다(2,400만 화소 사진에서 75%로 줄이면 작은 네모 바코드를 놓쳤음 — 실제 선반 사진으로 확인)
      var tw = Math.round(W * 0.56), th = Math.round(H * 0.56);
      var ts = Math.min(1, 3300 / Math.max(tw, th));
      [[0, 0], [W - tw, 0], [0, H - th], [W - tw, H - th]].forEach(function (p, i) {
        list.push(att('조각 ' + (i + 1) + '/4 확대', { sx: p[0], sy: p[1], sw: tw, sh: th }, ts, 'plain'));
      });
    } else {
      list.push(att('원본', full, 1, 'plain'));
      list.push(att('대비 보정', full, 1, 'contrast'));
      list.push(att('2배 확대', full, 2, 'plain'));
      if (thorough) {
        list.push(att('2배 확대 + 흑백(문턱 140)', full, 2, 'thr', 140));
        list.push(att('2배 확대 + 흑백(문턱 180)', full, 2, 'thr', 180));
      }
    }
    return list;
  };

  var PHOTO_OPTS = { tryHarder: true, tryRotate: true, tryInvert: true, tryDownscale: true, maxNumberOfSymbols: 50 };

  function geom(r, a) {
    var p = r.position;
    if (!p || !p.topLeft) return null;
    var xs = [], ys = [];
    [p.topLeft, p.topRight, p.bottomRight, p.bottomLeft].forEach(function (q) {
      xs.push(a.sx + q.x / a.scale); ys.push(a.sy + q.y / a.scale);
    });
    var x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs);
    var y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys);
    return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, size: Math.max(x1 - x0, y1 - y0, 1) };
  }
  // 같은 내용이 같은 자리에서 여러 방법으로 읽히면 하나로 합친다.
  // 같은 내용이라도 자리가 떨어져 있으면(같은 물건 상자 2개) 따로 센다.
  function addCode(codes, r, a, L) {
    var g = geom(r, a);
    for (var i = 0; i < codes.length; i++) {
      var c = codes[i];
      if (c.text !== r.text) continue;
      if (!g || !c.g) { c.hits++; return; }
      var d = Math.hypot(c.g.cx - g.cx, c.g.cy - g.cy);
      var lim = Math.max(c.g.size, g.size) * (c.format === r.format ? 0.6 : 2.5) + 0.01 * L;
      if (d < lim) { c.hits++; return; }
    }
    codes.push({ format: r.format, text: r.text, g: g, first: a.tag, hits: 1 });
  }

  Core.decodePhoto = async function (img, mode, onStep) {
    var W = img.naturalWidth, H = img.naturalHeight, L = Math.max(W, H);
    var attempts = Core.photoAttempts(W, H, mode);
    var codes = [], log = [];
    var cacheKey = '', cacheId = null, cacheGray = null;
    for (var i = 0; i < attempts.length; i++) {
      var a = attempts[i];
      if (onStep) onStep(i, attempts.length);
      await Core.tick();
      var t0 = performance.now(), n = 0, err = '';
      try {
        var key = [a.sx, a.sy, a.sw, a.sh, a.scale.toFixed(4)].join(',');
        if (key !== cacheKey) { cacheId = null; cacheId = drawRegion(img, a); cacheGray = null; cacheKey = key; }
        var input = cacheId;
        if (a.mode !== 'plain') {
          if (!cacheGray) cacheGray = grayOf(cacheId);
          var g = a.mode === 'contrast' ? stretch(cacheGray) : binarize(stretch(cacheGray), a.t);
          input = grayToImageData(g, cacheId.width, cacheId.height);
        }
        var res = await ZXingWASM.readBarcodes(input, PHOTO_OPTS);
        for (var k = 0; k < res.length; k++) {
          var r = res[k];
          if (!r.isValid || !r.text) continue;
          n++;
          addCode(codes, r, a, L);
        }
      } catch (e) { err = '오류'; }
      log.push({ tag: a.tag, n: n, err: err, ms: Math.round(performance.now() - t0) });
    }
    return { W: W, H: H, codes: codes, log: log };
  };

  /* ============================== 카메라 화면 읽기 ============================== */
  var LIVE_OPTS = { tryHarder: true, tryRotate: true, tryInvert: false, tryDownscale: true, maxNumberOfSymbols: 8 };
  Core.decodeFrame = async function (imageData) {
    var res = await ZXingWASM.readBarcodes(imageData, LIVE_OPTS);
    var out = [];
    for (var i = 0; i < res.length; i++) {
      if (res[i].isValid && res[i].text) out.push({ format: res[i].format, text: res[i].text });
    }
    return out;
  };

  Core.formatLabel = function (f) {
    var map = { Code128: 'Code 128(막대)', DataMatrix: 'Data Matrix(네모)', QRCode: 'QR', Code39: 'Code 39', Code93: 'Code 93',
                EAN13: 'EAN-13', EAN8: 'EAN-8', ITF: 'ITF', PDF417: 'PDF417', Aztec: 'Aztec', Codabar: 'Codabar' };
    return map[f] || f;
  };

  /* ============================== 바코드 내용 해석 ============================== */
  var LOC_RE = /^(KTS|KN)-\d+(?:-[0-9A-Z가-힣]+)*$/i;

  Core.interpret = function (text) {
    var t = String(text || '').trim(), m;
    if (LOC_RE.test(t)) return { type: 'location', loc: Core.normLoc(t), kind: '선반 라벨' };
    if ((m = /^M(\d{7})S([0-9A-Z]{3,15})$/.exec(t))) return { type: 'part', part: m[1], serial: m[2], kind: '제조사 라벨(M…S…)' };
    if (/^\+[A-Z][0-9A-Z]{3}/.test(t)) return parseHIBC(t);
    if (/^\d{7}$/.test(t)) return { type: 'seven', part: t, kind: '7자리 숫자' };
    return { type: 'other', kind: '기타 형식' };
  };

  // HIBC: +업체코드(4) + 품목번호 + 포장단위(1) [/ 추가정보(시리얼 등)] + 검사문자(1)
  // 예) +E27666935220/$+2031587Y  → 품목 6693522, 시리얼 2031587
  //     +E27667185190L           → 품목 6718519
  //     +E276M65281730/$$/16D…E  → 품목 6528173 (앞의 M은 떼어냄)
  function parseHIBC(t) {
    var body = t.slice(1), slash = body.indexOf('/'), primary, secondary = '';
    if (slash >= 0) { primary = body.slice(0, slash); secondary = body.slice(slash + 1); }
    else primary = body.slice(0, -1);
    var pcn = primary.slice(4, -1);
    var mm = /^M?(\d{7})$/.exec(pcn);
    var info = { type: 'part', part: mm ? mm[1] : pcn, kind: 'HIBC(+' + primary.slice(0, 4) + '…)' };
    var sm = /\$\+([0-9A-Z\-.]+)/.exec(secondary);
    if (sm) {
      var s = sm[1];
      if (secondary.indexOf('/', sm.index + 2) < 0) s = s.slice(0, -1);   // 맨 끝이면 마지막 글자는 검사문자
      if (s) info.serial = s;
    }
    if (!info.part) info.type = 'other';
    return info;
  }

  Core.normCode = function (s) {
    var t = String(s === undefined || s === null ? '' : s).trim().toUpperCase().replace(/\s+/g, '');
    if (/^\d+\.0+$/.test(t)) t = t.replace(/\.0+$/, '');
    return t;
  };
  // 연결(별칭) 저장에 쓰는 번호: 해석한 품목번호가 있으면 그것, 없으면 바코드 글자 그대로
  Core.lookupKey = function (text, info) {
    return Core.normCode(info && info.part ? info.part : text);
  };
  Core.makeIndex = function (items) {
    var idx = {};
    for (var i = 0; i < items.length; i++) { var k = Core.normCode(items[i].code); if (k && !idx[k]) idx[k] = items[i]; }
    return idx;
  };
  // 1) 바코드 글자 그대로 = 전산 품목번호  2) 해석한 품목번호  3) 사람이 연결해 둔 번호
  Core.resolve = function (text, info, index, aliases) {
    var k1 = Core.normCode(text);
    if (index[k1]) return { item: index[k1], via: 'direct' };
    if (info && info.part) {
      var k2 = Core.normCode(info.part);
      if (index[k2]) return { item: index[k2], via: 'part' };
    }
    var lk = Core.lookupKey(text, info);
    var a = aliases && aliases[lk];
    if (a && index[Core.normCode(a)]) return { item: index[Core.normCode(a)], via: 'alias', from: lk };
    return null;
  };

  /* ============================== REF(제품 코드) 우선 정리 ============================== */
  // 한 장의 사진(또는 한 번 찍기)에서 읽힌 바코드들을 REF 기준으로 정리한다.
  //  - 같은 시리얼을 가진 바코드가 여럿이면 = 같은 물건의 라벨들 → REF(전산 제품 코드)로 찾아지는 것 하나만 남긴다
  //  - 그때 REF로 못 찾은 쪽 번호(예: 제조사 구성품 번호)는 그 REF로 자동 연결할 후보(learned)로 돌려준다
  //  - 시리얼만 든 바코드(네모)는 따로 세지 않는다
  // 돌려주는 것: entries[i] = { text, info, res(REF 찾음: {item,via} 또는 null), skip('' | 'sameLabel' | 'serialOnly') }
  Core.refBatch = function (texts, index, aliases) {
    var ents = texts.map(function (t) {
      var info = Core.interpret(t);
      var res = (index && info.type !== 'location') ? Core.resolve(t, info, index, aliases) : null;
      return { text: t, info: info, res: res, skip: '' };
    });
    var learned = [], bySerial = {}, serialSet = {};
    ents.forEach(function (e) {
      if (e.info.serial) { (bySerial[e.info.serial] = bySerial[e.info.serial] || []).push(e); serialSet[e.info.serial] = true; }
    });
    Object.keys(bySerial).forEach(function (s) {
      var g = bySerial[s];
      if (g.length < 2) return;
      var keep = g.filter(function (e) { return e.res; })[0] || g[0];
      g.forEach(function (e) {
        if (e === keep) return;
        e.skip = 'sameLabel';
        if (keep.res && !e.res) learned.push({ from: Core.lookupKey(e.text, e.info), to: keep.res.item.code });
      });
    });
    ents.forEach(function (e) {
      if (!e.skip && !e.res && e.info.type !== 'location' && serialSet[e.text]) e.skip = 'serialOnly';
    });
    return { entries: ents, learned: learned };
  };
  // REF 번호 순서(숫자는 숫자로: 644401 < 6346055)
  Core.compareCode = function (a, b) { return String(a || '').localeCompare(String(b || ''), 'en', { numeric: true }); };

  /* ============================== 선반 위치 ============================== */
  Core.normLoc = function (s) {
    return String(s || '').trim().toUpperCase().replace(/\s*-\s*/g, '-').replace(/\s*,\s*/g, ', ').replace(/\s{2,}/g, ' ');
  };
  Core.splitLocs = function (s) { return Core.normLoc(s).split(/\s*[,;\/]\s*/).filter(Boolean); };
  function locTokens(s) { return Core.normLoc(s).split(/[-,\s\/;]+/).filter(Boolean); }
  function zoneRank(z) { return z === 'KTS' ? 0 : z === 'KN' ? 1 : z ? 2 : 9; }
  // 창고를 도는 순서: KTS → KN, 랙 번호 → 단 번호 순(숫자는 숫자로 비교: 2 < 10)
  Core.compareLoc = function (a, b) {
    var ta = locTokens(a), tb = locTokens(b);
    var za = zoneRank(ta[0]), zb = zoneRank(tb[0]);
    if (za !== zb) return za - zb;
    for (var i = 0; i < Math.max(ta.length, tb.length); i++) {
      var x = ta[i], y = tb[i];
      if (x === undefined) return -1;
      if (y === undefined) return 1;
      var nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
      if (nx && ny) { var d = parseInt(x, 10) - parseInt(y, 10); if (d) return d; }
      else if (nx !== ny) return nx ? -1 : 1;
      else { var c = x.localeCompare(y, 'ko'); if (c) return c; }
    }
    return 0;
  };
  // 물건의 전산 위치가 찍은 선반 라벨과 맞는지(한쪽이 다른 쪽의 세부 칸이어도 맞는 것으로 봄: KTS-1-1 ↔ KTS-1-1-DOWN)
  Core.locMatches = function (itemLoc, shelf) {
    var s = Core.normLoc(shelf);
    if (!s) return false;
    return Core.splitLocs(itemLoc).some(function (l) { return l === s || l.indexOf(s + '-') === 0 || s.indexOf(l + '-') === 0; });
  };

  /* ============================== 저장(목록·번호 연결) ============================== */
  var LIST_KEY = 'ktsInv.list.v1', ALIAS_KEY = 'ktsInv.alias.v1', ALIAS_AUTO_KEY = 'ktsInv.aliasAuto.v1', ALIAS_BLOCK_KEY = 'ktsInv.aliasBlock.v1';
  function sget(store, k) { try { return global[store].getItem(k); } catch (e) { return null; } }
  function sset(store, k, v) { try { global[store].setItem(k, v); return true; } catch (e) { return false; } }
  function sdel(store, k) { try { global[store].removeItem(k); } catch (e) { /* 무시 */ } }

  var listCache;
  Core.getList = function () {
    if (listCache !== undefined) return listCache;
    var raw = sget('localStorage', LIST_KEY) || sget('sessionStorage', LIST_KEY);
    listCache = null;
    if (raw) { try { var l = JSON.parse(raw); if (l && l.items && l.items.length) listCache = l; } catch (e) { /* 깨진 값 무시 */ } }
    return listCache;
  };
  Core.isRemembered = function () { return !!sget('localStorage', LIST_KEY); };
  Core.setList = function (list, remember) {
    listCache = list;
    var json = JSON.stringify(list);
    sset('sessionStorage', LIST_KEY, json);
    if (remember) sset('localStorage', LIST_KEY, json); else sdel('localStorage', LIST_KEY);
  };
  Core.setRemember = function (remember) {
    var l = Core.getList();
    if (remember && l) sset('localStorage', LIST_KEY, JSON.stringify(l));
    if (!remember) sdel('localStorage', LIST_KEY);
  };
  Core.clearList = function () { listCache = null; sdel('sessionStorage', LIST_KEY); sdel('localStorage', LIST_KEY); };

  Core.getAliases = function () {
    try { return JSON.parse(sget('localStorage', ALIAS_KEY) || '{}') || {}; } catch (e) { return {}; }
  };
  function getSet(key) { try { return JSON.parse(sget('localStorage', key) || '{}') || {}; } catch (e) { return {}; } }
  // auto=true: 같은 라벨의 REF 바코드를 보고 자동으로 연결한 것(사람이 연결한 것과 구분해 표시)
  Core.setAlias = function (from, toCode, auto) {
    var k = Core.normCode(from), a = Core.getAliases(), s = getSet(ALIAS_AUTO_KEY), b = getSet(ALIAS_BLOCK_KEY);
    a[k] = Core.normCode(toCode);
    if (auto) s[k] = true; else { delete s[k]; delete b[k]; }   // 사람이 직접 연결하면 '자동 연결 막음'도 풂
    sset('localStorage', ALIAS_KEY, JSON.stringify(a));
    sset('localStorage', ALIAS_AUTO_KEY, JSON.stringify(s));
    sset('localStorage', ALIAS_BLOCK_KEY, JSON.stringify(b));
  };
  // 아직 연결이 없는 번호만 자동 연결(사람이 직접 연결한 것은 덮어쓰지 않고, 사람이 푼 자동 연결은 다시 잇지 않음). 새로 연결했으면 true
  Core.learnAliases = function (learned) {
    var a = Core.getAliases(), b = getSet(ALIAS_BLOCK_KEY), changed = false;
    (learned || []).forEach(function (l) {
      var k = Core.normCode(l.from);
      if (k && !a[k] && !b[k]) { Core.setAlias(k, l.to, true); a[k] = Core.normCode(l.to); changed = true; }
    });
    return changed;
  };
  Core.isAutoAlias = function (from) { return !!getSet(ALIAS_AUTO_KEY)[Core.normCode(from)]; };
  Core.removeAlias = function (from) {
    var k = Core.normCode(from), a = Core.getAliases(), s = getSet(ALIAS_AUTO_KEY), b = getSet(ALIAS_BLOCK_KEY);
    if (s[k]) b[k] = true;                         // 자동 연결을 사람이 풀었으면 다시 자동으로 잇지 않음
    delete a[k]; delete s[k];
    sset('localStorage', ALIAS_KEY, JSON.stringify(a));
    sset('localStorage', ALIAS_AUTO_KEY, JSON.stringify(s));
    sset('localStorage', ALIAS_BLOCK_KEY, JSON.stringify(b));
  };

  /* ============================== REF 연결 창(두 화면 공통) ============================== */
  // 전산에 없는 바코드 번호를 어떤 REF(제품 코드)로 볼지 사람이 한 번 고르면 이 폰이 기억한다.
  Core.openLinkDialog = function (list, fromKey, kindText, onPicked) {
    var E = Core.el;
    var ov = E('div', 'overlay');
    ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true'); ov.setAttribute('aria-label', 'REF 연결');
    var sh = E('div', 'sheet');
    sh.appendChild(E('h2', 'h2', 'REF(제품 코드) 연결'));
    sh.appendChild(E('p', 'note', '바코드 번호 ' + fromKey + (kindText ? ' (' + kindText + ')' : '') +
      '는 전산 REF가 아닙니다. 라벨에 적힌 REF 번호나 제품 이름으로 찾아 골라 주세요. 한 번 연결하면 이 폰이 기억합니다.'));
    var q = E('input'); q.type = 'search'; q.placeholder = 'REF 번호나 제품 이름 (예: 6693522, sleeve)';
    q.setAttribute('aria-label', 'REF 찾기'); q.style.marginTop = '10px';
    sh.appendChild(q);
    var res = E('div'); res.style.marginTop = '8px';
    sh.appendChild(res);
    var cancel = E('button', 'btn ghost', '취소'); cancel.type = 'button'; cancel.style.marginTop = '12px';
    sh.appendChild(cancel);
    ov.appendChild(sh);
    function close() { if (ov.parentNode) ov.parentNode.removeChild(ov); }
    cancel.addEventListener('click', close);
    ov.addEventListener('click', function (ev) { if (ev.target === ov) close(); });
    function run() {
      res.textContent = '';
      var words = q.value.toLowerCase().split(/\s+/).filter(Boolean);
      if (!words.length) { res.appendChild(E('p', 'note', 'REF 번호 일부나 제품 이름을 입력하면 후보가 나옵니다.')); return; }
      var hits = list.items.filter(function (it) {
        var hay = (it.code + ' ' + it.name + ' ' + it.loc).toLowerCase();
        return words.every(function (w) { return hay.indexOf(w) >= 0; });
      }).slice(0, 30);
      if (!hits.length) { res.appendChild(E('p', 'note', '맞는 REF가 없습니다.')); return; }
      hits.forEach(function (it) {
        var b = E('button', 'pick-row'); b.type = 'button';
        b.appendChild(E('b', 'iref', 'REF ' + it.code));
        b.appendChild(E('span', '', (it.name || '') + ' · ' + (it.loc || '위치 없음')));
        b.addEventListener('click', function () { Core.setAlias(fromKey, it.code, false); close(); if (onPicked) onPicked(it); });
        res.appendChild(b);
      });
    }
    q.addEventListener('input', run);
    document.body.appendChild(ov);
    run();
    q.focus();
  };

  /* ============================== 엑셀(.xlsx) 읽기 ============================== */
  // .xlsx 는 압축(zip) 안에 XML 파일들이 들어 있는 구조. 브라우저의 압축 풀기 기능으로 직접 읽는다.
  function u16(b, o) { return b[o] | (b[o + 1] << 8); }
  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
  function zipEntries(b) {
    var eocd = -1;
    for (var i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) {
      if (u32(b, i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('엑셀 파일 구조를 읽을 수 없습니다.');
    var count = u16(b, eocd + 10), off = u32(b, eocd + 16), map = {};
    var td = new TextDecoder('utf-8');
    for (var k = 0; k < count; k++) {
      if (off + 46 > b.length || u32(b, off) !== 0x02014b50) break;
      var method = u16(b, off + 10), csize = u32(b, off + 20);
      var nlen = u16(b, off + 28), xlen = u16(b, off + 30), clen = u16(b, off + 32), lho = u32(b, off + 42);
      map[td.decode(b.subarray(off + 46, off + 46 + nlen))] = { method: method, csize: csize, lho: lho };
      off += 46 + nlen + xlen + clen;
    }
    return map;
  }
  async function inflateRaw(u8) {
    if (typeof DecompressionStream === 'undefined') throw new Error('이 브라우저는 엑셀 파일을 직접 못 엽니다. 최신 버전으로 업데이트하거나 CSV로 저장해 주세요.');
    var stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  async function zipRead(b, map, name) {
    var e = map[name];
    if (!e) return null;
    var o = e.lho;
    if (u32(b, o) !== 0x04034b50) throw new Error('엑셀 파일 일부가 손상되었습니다.');
    var start = o + 30 + u16(b, o + 26) + u16(b, o + 28);
    var data = b.subarray(start, start + e.csize);
    if (e.method === 0) return data;
    if (e.method === 8) return inflateRaw(data);
    throw new Error('지원하지 않는 엑셀 압축 방식입니다.');
  }
  function xml(u8) {
    var doc = new DOMParser().parseFromString(new TextDecoder('utf-8').decode(u8), 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('엑셀 내용을 해석할 수 없습니다.');
    return doc;
  }
  function tags(node, local) { return node.getElementsByTagNameNS('*', local); }
  function relId(el) {
    for (var i = 0; i < el.attributes.length; i++) {
      var at = el.attributes[i];
      if (at.localName === 'id' && at.namespaceURI && /relationships/i.test(at.namespaceURI)) return at.value;
    }
    return el.getAttribute('r:id');
  }
  function textOf(si) {   // 공유 문자열 하나(서식 있는 글자 포함). 읽는 법 표시(rPh)는 뺀다.
    var ts = tags(si, 't'), s = '';
    for (var i = 0; i < ts.length; i++) {
      var p = ts[i].parentNode, skip = false;
      while (p && p !== si) { if (p.localName === 'rPh') { skip = true; break; } p = p.parentNode; }
      if (!skip) s += ts[i].textContent;
    }
    return s;
  }
  function colIndex(ref) {
    var m = /^([A-Z]+)/.exec(ref || '');
    if (!m) return -1;
    var n = 0;
    for (var i = 0; i < m[1].length; i++) n = n * 26 + (m[1].charCodeAt(i) - 64);
    return n - 1;
  }
  function sheetRows(doc, sst, maxRows) {
    var rows = [], rowEls = tags(doc, 'row');
    for (var i = 0; i < rowEls.length && rows.length < maxRows; i++) {
      var re = rowEls[i], rn = parseInt(re.getAttribute('r'), 10);
      var ri = isNaN(rn) ? rows.length : rn - 1;
      if (ri >= maxRows) break;
      var row = [], cells = re.children || [], ci = 0;
      for (var j = 0; j < cells.length; j++) {
        var c = cells[j];
        if (c.localName !== 'c') continue;
        var idx = colIndex(c.getAttribute('r'));
        if (idx < 0) idx = ci;
        ci = idx + 1;
        var t = c.getAttribute('t'), v = '';
        if (t === 'inlineStr') { var is = tags(c, 'is')[0]; v = is ? textOf(is) : ''; }
        else {
          var ve = tags(c, 'v')[0];
          v = ve ? ve.textContent : '';
          if (t === 's') v = sst[parseInt(v, 10)] || '';
        }
        row[idx] = v;
      }
      rows[ri] = row;
    }
    for (var k = 0; k < rows.length; k++) if (!rows[k]) rows[k] = [];
    return rows;
  }
  async function readXlsx(b) {
    var map = zipEntries(b);
    var wbXml = await zipRead(b, map, 'xl/workbook.xml');
    if (!wbXml) throw new Error('엑셀(.xlsx) 파일이 아닙니다.');
    var wb = xml(wbXml);
    var rels = {}, relsXml = await zipRead(b, map, 'xl/_rels/workbook.xml.rels'), sstPath = 'xl/sharedStrings.xml';
    if (relsXml) {
      var rs = tags(xml(relsXml), 'Relationship');
      for (var i = 0; i < rs.length; i++) {
        var target = rs[i].getAttribute('Target') || '';
        var path = target.charAt(0) === '/' ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '');
        rels[rs[i].getAttribute('Id')] = path;
        if (/sharedStrings$/i.test(rs[i].getAttribute('Type') || '')) sstPath = path;
      }
    }
    var sst = [], sstXml = await zipRead(b, map, sstPath);
    if (sstXml) { var sis = tags(xml(sstXml), 'si'); for (var s = 0; s < sis.length; s++) sst.push(textOf(sis[s])); }
    var sheetEls = tags(wb, 'sheet'), sheets = [];
    for (var k = 0; k < sheetEls.length; k++) {
      var nm = sheetEls[k].getAttribute('name') || ('시트' + (k + 1));
      sheets.push({ name: nm, path: rels[relId(sheetEls[k])] || ('xl/worksheets/sheet' + (k + 1) + '.xml') });
    }
    return {
      names: sheets.map(function (x) { return x.name; }),
      read: async function (name) {
        var sh = sheets.filter(function (x) { return x.name === name; })[0];
        if (!sh) return null;
        var u8 = await zipRead(b, map, sh.path);
        return u8 ? sheetRows(xml(u8), sst, 20000) : null;
      }
    };
  }

  /* ============================== CSV·붙여넣기 읽기 ============================== */
  function decodeText(buf) {
    var t = new TextDecoder('utf-8').decode(buf);
    if ((t.match(/�/g) || []).length > 3) { try { t = new TextDecoder('euc-kr').decode(buf); } catch (e) { /* 그대로 */ } }
    if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
    return t;
  }
  Core.parseDelimited = function (text) {
    var head = text.split(/\r?\n/).slice(0, 5).join('\n');
    var counts = { '\t': (head.match(/\t/g) || []).length, ',': (head.match(/,/g) || []).length, ';': (head.match(/;/g) || []).length };
    var delim = '\t';
    if (counts[','] > counts[delim]) delim = ',';
    if (counts[';'] > counts[delim]) delim = ';';
    var rows = [], row = [], cell = '', q = false;
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i);
      if (q) {
        if (ch === '"') { if (text.charAt(i + 1) === '"') { cell += '"'; i++; } else q = false; }
        else cell += ch;
      } else if (ch === '"' && cell === '') q = true;
      else if (ch === delim) { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text.charAt(i + 1) === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
        if (rows.length >= 20000) break;
      } else cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows;
  };

  /* ============================== 목록에서 칸 찾기 ============================== */
  var CODE_RE = /^\d{7}$/;
  var LOCV_RE = /^(KTS|KN)-/i;
  function cellStr(v) { return String(v === undefined || v === null ? '' : v).trim(); }

  function detectColumns(rows) {
    // 1) 머리글 이름으로 찾기
    for (var h = 0; h < Math.min(15, rows.length); h++) {
      var idx = { code: -1, name: -1, group: -1, loc: -1 };
      (rows[h] || []).forEach(function (cell, i) {
        var s = cellStr(cell).toLowerCase();
        if (!s) return;
        if (idx.code < 0 && /제품\s*코드|품목\s*(코드|번호)|부품\s*번호|product\s*code|item\s*(no|number|code)|part\s*(no|number)|material/.test(s)) idx.code = i;
        else if (idx.loc < 0 && /기본\s*위치|^위치$|location|^bin/.test(s)) idx.loc = i;
        else if (idx.group < 0 && /제품군|product\s*(family|line|group)|category/.test(s)) idx.group = i;
        else if (idx.name < 0 && /제품\s*이름|제품명|품명|품목명|부품명|product\s*name|description|^name$/.test(s)) idx.name = i;
      });
      if (idx.code >= 0 && idx.loc >= 0) return { header: h, idx: idx, how: '머리글' };
    }
    // 2) 내용으로 찾기: 7자리 숫자가 가장 많은 칸 = 품목번호, KTS-/KN- 가 가장 많은 칸 = 위치
    var sample = rows.slice(0, 400), ncol = 0;
    sample.forEach(function (r) { ncol = Math.max(ncol, (r || []).length); });
    var best = { code: -1, cn: 0, loc: -1, ln: 0 };
    for (var c = 0; c < ncol; c++) {
      var cn = 0, ln = 0;
      sample.forEach(function (r) { var v = cellStr((r || [])[c]); if (CODE_RE.test(v)) cn++; if (LOCV_RE.test(v)) ln++; });
      if (cn > best.cn) { best.cn = cn; best.code = c; }
      if (ln > best.ln) { best.ln = ln; best.loc = c; }
    }
    if (best.cn < 5 || best.ln < 3) return null;
    var first = 0;
    for (var r = 0; r < sample.length; r++) { if (CODE_RE.test(cellStr((sample[r] || [])[best.code]))) { first = r; break; } }
    var nameCol = -1, bestLen = 0;
    for (var c2 = 0; c2 < ncol; c2++) {
      if (c2 === best.code || c2 === best.loc) continue;
      var tot = 0, cnt = 0;
      sample.slice(first, first + 60).forEach(function (r) { var v = cellStr((r || [])[c2]); if (v && !/^[\d.\-]+$/.test(v)) { tot += v.length; cnt++; } });
      var avg = cnt ? tot / cnt : 0;
      if (cnt >= 5 && avg > bestLen) { bestLen = avg; nameCol = c2; }
    }
    return { header: first - 1, idx: { code: best.code, name: nameCol, group: -1, loc: best.loc }, how: '내용' };
  }

  function buildList(rows, sheetName) {
    var det = detectColumns(rows);
    if (!det) return null;
    var items = [], seen = {}, ix = det.idx;
    for (var r = det.header + 1; r < rows.length; r++) {
      var row = rows[r] || [];
      var code = cellStr(row[ix.code]);
      if (/^\d+\.0+$/.test(code)) code = code.replace(/\.0+$/, '');
      if (!code || code.length > 40) continue;
      var key = Core.normCode(code);
      if (seen[key]) continue;
      seen[key] = true;
      items.push({
        code: code,
        name: ix.name >= 0 ? cellStr(row[ix.name]) : '',
        group: ix.group >= 0 ? cellStr(row[ix.group]) : '',
        loc: ix.loc >= 0 ? cellStr(row[ix.loc]) : ''
      });
    }
    if (items.length < 5) return null;
    return { items: items, sheet: sheetName || '', how: det.how };
  }

  // 전산(SFDC)에서 내려받은 ".xls"는 실제로는 웹페이지 표(HTML)인 경우가 많다 → 표 칸을 글자로만 읽는다(스크립트는 실행되지 않음)
  function htmlTableRows(text) {
    var doc = new DOMParser().parseFromString(text, 'text/html');
    var rows = [], trs = doc.getElementsByTagName('tr');
    for (var i = 0; i < trs.length && rows.length < 20000; i++) {
      var row = [], cells = trs[i].children;
      for (var j = 0; j < cells.length; j++) {
        var tn = cells[j].tagName;
        if (tn === 'TD' || tn === 'TH') row.push((cells[j].textContent || '').replace(/\s+/g, ' ').trim());
      }
      rows.push(row);
    }
    return rows;
  }

  Core.readListFile = async function (file) {
    var b = new Uint8Array(await file.arrayBuffer());
    var built = null;
    if (b[0] === 0xD0 && b[1] === 0xCF) throw new Error('예전 엑셀 형식(.xls)은 못 엽니다. 엑셀에서 ".xlsx" 또는 "CSV"로 저장해 주세요.');
    var headText = '';
    if (!(b[0] === 0x50 && b[1] === 0x4B)) headText = decodeText(b);
    if (headText && /<\s*(table|tr|html)\b/i.test(headText.slice(0, 20000))) {
      built = buildList(htmlTableRows(headText), '');
    } else if (b[0] === 0x50 && b[1] === 0x4B) {
      var x = await readXlsx(b);
      var names = x.names.slice();
      var pref = names.filter(function (n) { return /^sfdc_raw$/i.test(n.trim()); });
      var order = pref.concat(names.filter(function (n) { return pref.indexOf(n) < 0; }));
      for (var i = 0; i < order.length && !built; i++) {
        var rows = await x.read(order[i]);
        if (rows) built = buildList(rows, order[i]);
      }
    } else {
      built = buildList(Core.parseDelimited(headText), '');
    }
    if (!built) throw new Error('목록에서 품목번호·위치 칸을 찾지 못했습니다. 전산(SFDC) 재고 목록 파일인지 확인해 주세요.');
    built.source = file.name || '';
    built.fileDate = file.lastModified || 0;
    built.loadedAt = Date.now();
    return built;
  };
  Core.readListText = function (text) {
    var built = buildList(Core.parseDelimited(text), '');
    if (!built) throw new Error('붙여넣은 내용에서 품목번호·위치 칸을 찾지 못했습니다. 머리글(제품 코드·기본위치) 줄까지 같이 복사해 주세요.');
    built.source = '붙여넣기';
    built.fileDate = 0;
    built.loadedAt = Date.now();
    return built;
  };

  /* ============================== 목록 불러오기 화면(두 페이지 공통) ============================== */
  Core.mountListLoader = function (container, onChange) {
    var E = Core.el;
    var card = E('section', 'card');
    card.setAttribute('aria-labelledby', 'h-list');
    var h = E('h2', 'h2', '전산 목록'); h.id = 'h-list';
    card.appendChild(h);
    var st = E('p', 'status'); st.setAttribute('role', 'status'); st.style.marginTop = '0';
    card.appendChild(st);

    var inp = E('input', 'sr');
    inp.type = 'file'; inp.id = 'list-file';
    inp.accept = '.xlsx,.xls,.csv,.tsv,.txt,.htm,.html,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv,text/plain,text/tab-separated-values,text/html';
    inp.setAttribute('aria-label', '전산 목록 파일 고르기');
    var lab = E('label', 'btn ghost', '📄 목록 파일 고르기 (엑셀·CSV)');
    lab.htmlFor = 'list-file'; lab.setAttribute('role', 'button'); lab.style.marginTop = '10px';
    card.appendChild(lab); card.appendChild(inp);

    var chkWrap = E('label', 'check');
    var chk = E('input'); chk.type = 'checkbox'; chk.id = 'list-remember'; chk.checked = Core.isRemembered();
    chkWrap.appendChild(chk);
    chkWrap.appendChild(E('span', '', '이 폰에 기억하기 (끄면 이 창을 닫을 때 지워짐)'));
    card.appendChild(chkWrap);

    var det = E('details');
    det.appendChild(E('summary', '', '파일이 안 열리면: 엑셀에서 복사해 붙여넣기'));
    det.appendChild(E('p', 'note', '엑셀에서 머리글 줄(제품 코드·제품 이름·기본위치)부터 아래까지 복사해서 붙여넣어 주세요.'));
    var ta = E('textarea'); ta.id = 'list-paste'; ta.setAttribute('aria-label', '목록 붙여넣기');
    det.appendChild(ta);
    var pbtn = E('button', 'small-btn', '붙여넣은 내용 읽기'); pbtn.type = 'button'; pbtn.style.marginTop = '8px';
    det.appendChild(pbtn);
    card.appendChild(det);

    var row = E('div', 'row');
    var clr = E('button', 'small-btn', '목록 지우기'); clr.type = 'button'; clr.id = 'list-clear';
    row.appendChild(clr);
    card.appendChild(row);
    card.appendChild(E('p', 'note', '목록은 이 폰 안에서만 쓰고 어디로도 보내지 않습니다.'));
    container.appendChild(card);

    function show(msg, cls) { st.textContent = msg; st.className = 'status ' + (cls || ''); }
    function refresh() {
      var l = Core.getList();
      clr.disabled = !l;
      if (!l) { show('목록이 없습니다. 전산(SFDC) 재고 목록 파일을 골라 주세요. (기존 카운팅 엑셀도 됩니다)', 'warn'); return; }
      var withLoc = l.items.filter(function (i) { return i.loc; }).length;
      var parts = ['✅ ' + l.items.length + '개 품목 (위치 있음 ' + withLoc + '개)'];
      if (l.sheet) parts.push('시트 ' + l.sheet);
      if (l.source) parts.push(l.source);
      var msg = parts.join(' · ');
      var cls = 'ok';
      if (l.fileDate) {
        var days = Math.floor((Date.now() - l.fileDate) / 86400000);
        msg += ' · 파일 날짜 ' + Core.fmtDate(new Date(l.fileDate));
        if (days > 30) { msg += ' ⚠️ ' + days + '일 지난 목록입니다. 최신 전산 목록으로 바꾸면 더 정확합니다.'; cls = 'warn'; }
      }
      show(msg, cls);
    }
    function done(list) { Core.setList(list, chk.checked); refresh(); if (onChange) onChange(list); }

    inp.addEventListener('change', function () {
      var f = inp.files && inp.files[0];
      inp.value = '';
      if (!f) return;
      show('목록 읽는 중…');
      Core.readListFile(f).then(done, function (e) { show('❌ ' + (e && e.message ? e.message : '목록을 읽지 못했습니다.'), 'bad'); });
    });
    pbtn.addEventListener('click', function () {
      try { done(Core.readListText(ta.value || '')); ta.value = ''; det.open = false; }
      catch (e) { show('❌ ' + e.message, 'bad'); }
    });
    chk.addEventListener('change', function () { Core.setRemember(chk.checked); });
    clr.addEventListener('click', function () { Core.clearList(); refresh(); if (onChange) onChange(null); });
    refresh();
  };

  global.KtsCore = Core;
})(window);
