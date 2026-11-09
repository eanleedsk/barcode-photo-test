/*
 * 재고 입출고 기록 — 찍은 물건(REF)을 [넣음]/[뺌]으로 회사 엑셀(원드라이브 '재고 입출고 기록')에 쌓기
 *
 *  - 흐름 주소는 설정 링크(REF 글자 읽기와 같은 링크, 'l' 항목)로 폰에만 저장. 접속 키도 같은 것
 *  - '이름'은 폰에서 한 번 입력(기록 확인용). 직원별 실적 평가·순위에는 쓰지 않음(회사 규정)
 *  - 실수로 기록되지 않게: 넣음/뺌을 고르고 [기록 보내기]를 눌렀을 때만 보냄. 보낸 것은 화면이 기억해 다시 안 보냄
 */
(function (global) {
  'use strict';
  var C = global.KtsCore, R = global.KtsRefOcr, L = {};
  var WHO_KEY = 'ktsInv.who.v1';

  L.logUrl = function () { var c = R.getConf(); return c && c.l ? c.l : ''; };
  L.getWho = function () { try { return (localStorage.getItem(WHO_KEY) || '').trim(); } catch (e) { return ''; } };
  L.setWho = function (v) { try { localStorage.setItem(WHO_KEY, String(v || '').trim().slice(0, 40)); } catch (e) { /* 무시 */ } };

  // items: [{ref, name, qty, shelf, loc, serial, how}] / dir: 'in' | 'out'
  L.send = function (dir, items, memo) {
    var conf = R.getConf();
    if (!conf || !conf.l) return Promise.reject(new Error('기록이 연결되지 않았습니다(새 설정 링크 필요)'));
    var body = {
      key: conf.k, op: 'log', who: L.getWho(), dir: dir, memo: String(memo || '').slice(0, 200), device: C.deviceText(),
      entries: items.map(function (it) {
        return { ref: it.ref, name: it.name || '', qty: it.qty, shelf: it.shelf || '', loc: it.loc || '',
                 serial: it.serial || '', how: it.how || '' };
      })
    };
    return fetch(conf.l, {
      method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body: JSON.stringify(body),
      cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer'
    }).then(function (res) {
      return res.text().then(function (txt) {
        var j = null;
        try { j = JSON.parse(txt); } catch (e) { /* 아래 */ }
        if (!res.ok || !j || !j.ok) {
          throw new Error(res.status === 403 ? '접속 키·이름·내용을 확인해 주세요(설정 링크를 다시 열어 보세요)'
            : res.status === 404 ? '기록 흐름이 꺼져 있거나 주소가 바뀌었습니다'
            : (j && j.error) ? String(j.error).slice(0, 200) : ('응답 ' + res.status));
        }
        return j;
      });
    });
  };

  /* 화면 칸: getItems() → {items:[...], skipped: REF 미확인 수} / onSent(items) → 보낸 것 표시 */
  L.mountBox = function (container, getItems, onSent) {
    var E = C.el, dir = '';
    var card = E('section', 'card log-card');
    card.setAttribute('aria-labelledby', 'h-log-box');
    var h = E('h2', 'h2', '입출고 기록 (회사 엑셀)'); h.id = 'h-log-box';
    card.appendChild(h);
    var conn = E('p', 'status'); conn.id = 'log-conn'; conn.style.marginTop = '0';
    card.appendChild(conn);

    var whoRow = E('label', 'field');
    whoRow.appendChild(E('span', '', '내 이름'));
    var who = E('input'); who.type = 'text'; who.id = 'log-who'; who.maxLength = 40; who.autocomplete = 'name';
    who.placeholder = '처음 한 번만 입력'; who.value = L.getWho();
    whoRow.appendChild(who);
    card.appendChild(whoRow);

    var seg = E('div', 'seg'); seg.setAttribute('role', 'radiogroup'); seg.setAttribute('aria-label', '넣음 또는 뺌');
    seg.style.marginTop = '10px';
    var bIn = E('button', '', '📥 넣음'); bIn.type = 'button'; bIn.id = 'log-in'; bIn.setAttribute('role', 'radio');
    var bOut = E('button', '', '📤 뺌'); bOut.type = 'button'; bOut.id = 'log-out'; bOut.setAttribute('role', 'radio');
    seg.appendChild(bIn); seg.appendChild(bOut);
    card.appendChild(seg);

    var memoRow = E('label', 'field');
    memoRow.appendChild(E('span', '', '메모'));
    var memo = E('input'); memo.type = 'text'; memo.id = 'log-memo'; memo.maxLength = 200; memo.placeholder = 'AS번호 등 (선택)';
    memoRow.appendChild(memo);
    card.appendChild(memoRow);

    var prev = E('ul', 'att-list'); prev.id = 'log-preview';
    card.appendChild(prev);
    var skipNote = E('p', 'note'); skipNote.id = 'log-skip';
    card.appendChild(skipNote);
    var send = E('button', 'btn primary', '기록 보내기'); send.type = 'button'; send.id = 'log-send'; send.style.marginTop = '10px';
    card.appendChild(send);
    var st = E('p', 'status'); st.id = 'log-status'; st.setAttribute('role', 'status');
    card.appendChild(st);
    card.appendChild(E('p', 'note', "기록은 회사 원드라이브 엑셀 '재고 입출고 기록'에 쌓입니다. '이름'은 기록 확인용이며 직원 평가에는 쓰지 않습니다."));
    container.appendChild(card);

    var busy = false;
    function setDir(d) {
      dir = d;
      bIn.setAttribute('aria-checked', d === 'in' ? 'true' : 'false');
      bOut.setAttribute('aria-checked', d === 'out' ? 'true' : 'false');
      refresh();
    }
    function refresh() {
      var hasUrl = !!L.logUrl();
      conn.textContent = hasUrl ? '기록 연결됨' : '기록 연결 안 됨 — 관리자에게 받은 새 설정 링크를 이 폰에서 열어 주세요.';
      conn.className = 'status ' + (hasUrl ? 'ok' : 'warn');
      var g = getItems() || { items: [], skipped: 0 };
      prev.textContent = '';
      var total = 0;
      g.items.forEach(function (it) {
        total += it.qty;
        var li = E('li'), d = E('div', 'grow');
        d.appendChild(E('b', 'iref', 'REF ' + it.ref + '  ×' + it.qty));
        d.appendChild(E('span', 'meta', (it.name || '') + (it.shelf ? ' · 선반 ' + it.shelf : (it.loc ? ' · 전산 위치 ' + it.loc : ''))));
        li.appendChild(d); prev.appendChild(li);
      });
      if (!g.items.length) prev.appendChild(E('li', 'meta', '보낼 물건이 없습니다. 먼저 찍어 주세요.'));
      skipNote.textContent = g.skipped ? 'REF 미확인 ' + g.skipped + '건은 빠집니다(REF 연결 후 기록돼요).' : '';
      var why = !hasUrl ? '' : !who.value.trim() ? '이름을 입력해 주세요' : !dir ? '넣음/뺌을 골라 주세요' : !g.items.length ? '' : '';
      send.disabled = busy || !hasUrl || !who.value.trim() || !dir || !g.items.length;
      send.textContent = busy ? '보내는 중…' : (dir === 'out' ? '📤 뺌' : dir === 'in' ? '📥 넣음' : '') + ' 기록 보내기 (' + g.items.length + '종 ' + total + '개)';
      if (why && !busy && !/✅|❌/.test(st.textContent)) { st.textContent = why; st.className = 'status'; }
    }
    who.addEventListener('input', function () { L.setWho(who.value); refresh(); });
    bIn.addEventListener('click', function () { setDir('in'); });
    bOut.addEventListener('click', function () { setDir('out'); });
    send.addEventListener('click', function () {
      var g = getItems() || { items: [] };
      if (!g.items.length || !dir || busy) return;
      busy = true; st.textContent = ''; refresh();
      var d = dir, items = g.items;
      L.send(d, items, memo.value).then(function (j) {
        busy = false;
        if (onSent) onSent(items);
        st.textContent = '✅ ' + (d === 'out' ? '뺌' : '넣음') + ' ' + j.added + '줄 기록함 (' + (j.time || '') + ')';
        st.className = 'status ok';
        memo.value = '';
        refresh();
      }, function (e) {
        busy = false;
        st.textContent = '❌ 기록 못 함: ' + ((e && e.message) || e) + ' — 다시 눌러 주세요.';
        st.className = 'status bad';
        refresh();
      });
    });
    setDir('');
    return { refresh: refresh };
  };

  global.KtsStockLog = L;
})(window);
