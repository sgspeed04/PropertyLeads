/**
 * 위반건축물 공시송달 공고 자동 수집 스크립트 (파일럿: 강남·광진·송파·성동·용산구)
 *
 * ── 배경 ──────────────────────────────────────────────────────────────────
 *  위반건축물은 서울시/경기도 재개발 데이터(fetch-redevelopment.js)와 달리
 *  전국 통합 오픈API가 없다. 대신 각 구청이 "공시송달/고시공고" 게시판에
 *  위반건축물 철거명령·이행강제금 공고를 다른 기관 공고(토지거래허가, 채용,
 *  결혼중개업법 위반 등)와 섞어서 올린다. 첫 실행 결과 최근 10건 중
 *  위반건축물 관련 공고가 없어, 제목에 관련 키워드가 있는 것만 걸러낸다.
 *
 *  게시판은 과거 글로 갈수록 게시글 번호가 급격히 낮아지는 것으로 보아
 *  pageIndex 파라미터로 과거 아카이브까지 훑는 건 비현실적이다(수천 페이지
 *  차이). 따라서 이 스크립트는 "매일 최근 게시물 중 신규 위반건축물 공고를
 *  잡아내는" 용도로 설계했다 — 과거 이력 백필용이 아니다.
 *
 *  실전 실행으로 5개 구 모두 검증 완료(광진구는 실제 위반건축물 공고 3건
 *  수집). 강동구는 목록이 자바스크립트로 렌더링되는 방식(CSR)이라 단순
 *  HTTP 요청 + HTML 파싱으로는 목록 자체를 못 읽어와 제외했다 — 필요하면
 *  headless 브라우저(Playwright 등)를 추가해야 하는데, 그러면 이 구 하나
 *  때문에 전체 파이프라인이 무거워져서 우선 보류.
 * ─────────────────────────────────────────────────────────────────────────
 */

const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const DATA_FILE = path.join(__dirname, '..', 'data', 'violations_notices.json');
const TODAY = new Date().toISOString().split('T')[0];
const MAX_PAGES = 3;

const VIOLATION_KEYWORDS = [
  '위반건축물', '철거명령', '이행강제금', '무단증축', '무단용도변경',
  '불법건축', '불법가설물', '원상복구', '시정명령',
];

const BOARDS = [
  {
    district: '강남구',
    listUrl: 'https://www.gangnam.go.kr/board/B_000046/list.do?mid=ID05_050209',
    pageParam: 'pageIndex',
  },
  {
    // 고시공고/입법예고 게시판 — 실제 위반건축물 공고 수집 확인됨
    district: '광진구',
    listUrl: 'https://www.gwangjin.go.kr/portal/bbs/B0000003/list.do?menuNo=200192',
    pageParam: 'pageIndex',
  },
  {
    // 공지사항 게시판 — 실전 검증 완료
    district: '송파구',
    listUrl: 'https://www.songpa.go.kr/www/selectBbsNttList.do?bbsNo=92&key=2775',
    pageParam: 'pageIndex',
  },
  {
    // 고시공고(토지관리과) 게시판 — 실전 검증 완료
    district: '성동구',
    listUrl: 'https://www.sd.go.kr/main/selectBbsNttList.do?bbsNo=184&key=3730',
    pageParam: 'pageIndex',
  },
  {
    // 고시공고 게시판 — 실전 검증 완료
    district: '용산구',
    listUrl: 'https://www.yongsan.go.kr/portal/bbs/B0000168/list.do?menuNo=200846',
    pageParam: 'pageIndex',
  },
];

// 리스트 행에서 (제목, 링크)를 뽑아내기 위한 선택자 후보들 — 사이트마다 마크업이
// 달라서 위에서부터 순서대로 시도하고, 처음으로 결과가 나오는 후보를 사용한다.
const ROW_SELECTORS = [
  'table tbody tr td.subject a, table tbody tr td.title a',
  'table tbody tr a[href*="view.do" i]',
  'table tbody tr a[href*="ntt" i]',
  'ul.board-list li a[href*="view.do" i]',
  'a[href*="view.do" i]',
  'a[href*="ntt" i]',
];

function absoluteUrl(base, href) {
  try { return new URL(href, base).toString(); } catch { return href; }
}

function extractDate(text) {
  const m = (text || '').match(/(20\d{2})[.\-\/](\d{1,2})[.\-\/](\d{1,2})/);
  if (!m) return null;
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
}

const FETCH_RETRIES = 3;
const FETCH_TIMEOUT_MS = 15000;

async function fetchPage(url, attempt = 1) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept-Language': 'ko-KR,ko;q=0.9',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  } catch (e) {
    if (attempt >= FETCH_RETRIES) throw e;
    const delay = attempt * 3000;
    console.warn(`    요청 실패(${attempt}/${FETCH_RETRIES}, ${e.message}) — ${delay}ms 후 재시도: ${url}`);
    await new Promise(r => setTimeout(r, delay));
    return fetchPage(url, attempt + 1);
  }
}

function parseListHtml(html, baseUrl) {
  const $ = cheerio.load(html);

  let usedSelector = null;
  let anchors = $();
  for (const sel of ROW_SELECTORS) {
    const found = $(sel);
    if (found.length > 0) { usedSelector = sel; anchors = found; break; }
  }

  console.log(`  [PARSE] 선택자 "${usedSelector}" 로 ${anchors.length}개 링크 발견`);
  if (anchors.length === 0) {
    // 페이지 전체 <a href>를 훑어서 실제 상세보기 링크 패턴(파일명 기준)을 빈도순으로 보여준다.
    // 내비게이션 메뉴 등 노이즈에 섞여도, 게시글 개수만큼 반복되는 패턴이 상위에 뜬다.
    const hrefCounts = new Map();
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') || '';
      const m = href.match(/([A-Za-z0-9_]+\.do)/);
      const key = m ? m[1] : (href.split('?')[0] || href).slice(0, 40);
      if (!key || key === '#' || key.startsWith('javascript')) return;
      hrefCounts.set(key, (hrefCounts.get(key) || 0) + 1);
    });
    const top = [...hrefCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    console.log(`  [PARSE] 진단: 전체 <a> ${$('a[href]').length}개, href 패턴 빈도 상위 10개:`);
    top.forEach(([k, c]) => console.log(`    ${c}회 — ${k}`));

    // href가 아니라 onclick(javascript:)으로 상세보기를 여는 사이트도 있어 함께 확인한다.
    const onclickCounts = new Map();
    $('[onclick]').each((_, el) => {
      const oc = $(el).attr('onclick') || '';
      const m = oc.match(/^[A-Za-z_][A-Za-z0-9_]*\(/);
      const key = m ? m[0] : oc.slice(0, 30);
      onclickCounts.set(key, (onclickCounts.get(key) || 0) + 1);
    });
    const topOnclick = [...onclickCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    if (topOnclick.length) {
      console.log(`  [PARSE] 진단: onclick 속성 ${$('[onclick]').length}개, 패턴 빈도 상위 5개:`);
      topOnclick.forEach(([k, c]) => console.log(`    ${c}회 — ${k}`));
    }
    return [];
  }

  const items = [];
  anchors.each((_, el) => {
    const $el = $(el);
    const title = $el.text().trim().replace(/\s+/g, ' ');
    const href = $el.attr('href');
    if (!title || !href) return;
    const row = $el.closest('tr, li');
    const rowText = row.length ? row.text() : title;
    items.push({
      title,
      url: absoluteUrl(baseUrl, href),
      detected_date: extractDate(rowText),
    });
  });
  return items;
}

async function fetchBoard(board) {
  const all = [];
  const seenUrls = new Set();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `${board.listUrl}${board.listUrl.includes('?') ? '&' : '?'}${board.pageParam}=${page}`;
    let html;
    try {
      html = await fetchPage(url);
    } catch (e) {
      console.warn(`  [${board.district}] 페이지 ${page} 요청 실패: ${e.message}`);
      break;
    }
    const items = parseListHtml(html, url).filter(it => !seenUrls.has(it.url));
    if (items.length === 0) { console.log(`  [${board.district}] 페이지 ${page}: 신규 항목 없음 — 중단`); break; }
    items.forEach(it => seenUrls.add(it.url));
    all.push(...items);
    console.log(`  [${board.district}] 페이지 ${page}: ${items.length}건 수집 (누계 ${all.length})`);
    await new Promise(r => setTimeout(r, 300));
  }
  return all.map((it, i) => ({
    id: `${board.district}_${i}_${Buffer.from(it.url).toString('base64').slice(0, 10)}`,
    district: board.district,
    title: it.title,
    url: it.url,
    detected_date: it.detected_date,
    collected_at: TODAY,
  }));
}

function matchesViolationKeyword(title) {
  return VIOLATION_KEYWORDS.some(k => title.includes(k));
}

// ── 상세 페이지에서 주소·담당부서·연락처를 뽑아낸다 ──────────────────────────
// 목록 제목만으로는 리드를 실행할 수 없다(어느 건물인지, 누구에게 연락할지
// 모름). 매칭된 공고 수가 적으므로(하루 몇 건) 상세 페이지까지 들어가서
// 본문 텍스트에서 정규식으로 최대한 뽑아내고, 실패하면 스니펫을 남겨
// 사람이 직접 확인할 수 있게 한다.
function extractAddress(text) {
  // 시/도+구+동+번지 전체형 ("서울특별시 광진구 자양동 123-45번지")
  const full = text.match(/([가-힣]+(?:시|도)\s*[가-힣0-9]+(?:시|군|구)\s*[가-힣0-9]+(?:동|읍|면|리)\s*[0-9]+(?:-[0-9]+)?(?:번지)?)/);
  if (full) return full[0].replace(/\s+/g, ' ').trim();

  const m2 = text.match(/([가-힣0-9]+(?:동|읍|면|리))\s*([0-9]+(?:-[0-9]+)?)\s*번지/);
  if (m2) return `${m2[1]} ${m2[2]}번지`;

  // 공시송달 공고는 표를 텍스트로 펼치면 "위반 물건지"/"건축물 위치" 같은 라벨 뒤에
  // "OO동\n123-45"처럼 번지 단어 없이 줄바꿈으로만 구분된 형태로 나온다. 개인정보
  // 보호를 위해 번지 뒷자리가 ○나 *로 마스킹된 경우도 있어 그 문자도 허용한다.
  const labelIdx = text.search(/위반\s*물건지|건축물\s*위치|건축물위치/);
  const searchText = labelIdx >= 0 ? text.slice(labelIdx) : text;
  const m3 = searchText.match(/([가-힣0-9]{1,6}(?:동|읍|면|리))\s*\n?\s*([0-9○*]+(?:-[0-9○*]+)?)/);
  if (m3) return `${m3[1]} ${m3[2]}`.replace(/\s+/g, ' ').trim();

  return null;
}
function extractPhone(text) {
  const m = text.match(/(0\d{1,2}[-.\s]?\d{3,4}[-.\s]?\d{4})/);
  return m ? m[0].replace(/\s+/g, '') : null;
}
function extractDept(text) {
  // "부서\n주택과"처럼 라벨 뒤에 단독으로 나오는 경우가 흔해서 먼저 시도
  const m1 = text.match(/부서\s*\n?\s*([가-힣]{2,10}(?:과|팀|센터))/);
  if (m1) return m1[1];
  const m2 = text.match(/([가-힣]{2,10}(?:건축과|주택과|주택관리과|건축지도과|안전건축과|건설과|도시관리과|도시계획과))/);
  return m2 ? m2[0] : null;
}

// 실제 게시글 본문이 있을 법한 영역을 우선순위대로 찾는다.
const CONTENT_SELECTORS = [
  '.bbs_content', '.board_content', '.view_cont', '.viewCont', '.bbsV_content',
  'td.content', '.content_view', '.board-view-content', '.view-content',
  '.bbsView', '.bbs-view', 'article',
];
// 잡음(메뉴/헤더/푸터 등)은 태그가 아니라 클래스/id로만 구분되는 사이트가 많아 넓게 잡는다.
const NOISE_SELECTOR = [
  'script', 'style',
  '[class*="gnb" i]', '[class*="lnb" i]', '[class*="snb" i]', '[class*="nav" i]',
  '[class*="menu" i]', '[class*="header" i]', '[class*="footer" i]',
  '[class*="quick" i]', '[class*="banner" i]', '[class*="skip" i]',
  '[id*="gnb" i]', '[id*="lnb" i]', '[id*="header" i]', '[id*="footer" i]',
].join(',');

async function fetchDetail(url) {
  try {
    const html = await fetchPage(url);
    const $ = cheerio.load(html);

    // "본문 바로가기" 접근성 스킵링크가 있으면 그 타겟이 실제 콘텐츠 루트인 경우가 많다 —
    // 한국 공공기관 사이트는 이 스킵링크가 거의 항상 있어서, gnb/lnb 잡음을 통째로
    // 건너뛰는 가장 확실한 방법이다.
    let root = $('body');
    const skipHref = $('a').filter((_, el) => $(el).text().includes('본문')).first().attr('href');
    if (skipHref && skipHref.startsWith('#') && $(skipHref).length) root = $(skipHref);

    $(NOISE_SELECTOR, root).remove();

    let contentEl = null;
    for (const sel of CONTENT_SELECTORS) {
      const found = root.find(sel).first();
      if (found.length && found.text().trim().length > 20) { contentEl = found; break; }
    }
    const bodyText = (contentEl || root).text().replace(/[ \t]+/g, ' ').replace(/\n+/g, '\n').trim();

    return {
      address: extractAddress(bodyText),
      contact_phone: extractPhone(bodyText),
      contact_dept: extractDept(bodyText),
      detail_snippet: bodyText.slice(0, 800),
    };
  } catch (e) {
    console.warn(`    상세 페이지 실패 (${url}): ${e.message}`);
    return { address: null, contact_phone: null, contact_dept: null, detail_snippet: null };
  }
}

async function main() {
  let existing = { updated_at: TODAY, notices: [] };
  if (fs.existsSync(DATA_FILE)) {
    try { existing = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8')); } catch {}
  }

  let rawCount = 0;
  const matched = [];
  for (const board of BOARDS) {
    console.log(`[BOARD] ${board.district} 공고 게시판 수집 시작 — ${board.listUrl}`);
    try {
      const items = await fetchBoard(board);
      rawCount += items.length;
      const boardMatched = items.filter(it => matchesViolationKeyword(it.title));
      console.log(`[BOARD] ${board.district} 완료 — 전체 ${items.length}건 중 위반건축물 관련 ${boardMatched.length}건`);
      matched.push(...boardMatched);
    } catch (e) {
      console.error(`[BOARD] ${board.district} 실패: ${e.message}`);
    }
  }

  if (rawCount === 0) {
    console.warn('[DONE] 게시판에서 아무 항목도 못 읽었습니다 — 사이트 구조 변경 가능성, 선택자 점검 필요. 기존 데이터 유지.');
    return;
  }

  if (matched.length === 0) {
    console.log('[DONE] 게시판은 정상 수집됐지만 위반건축물 관련 공고는 없었습니다. updated_at만 갱신.');
  }

  // 상세 페이지 보강 — 이미 상세 정보가 있는 기존 공고는 다시 안 긁는다(요청 절약 + 수기 수정 보존).
  const existingByUrl = new Map(existing.notices.map(n => [n.url, n]));
  for (const n of matched) {
    const already = existingByUrl.get(n.url);
    if (already && already.detail_snippet) { Object.assign(n, {
      address: already.address, contact_phone: already.contact_phone,
      contact_dept: already.contact_dept, detail_snippet: already.detail_snippet,
    }); continue; }
    console.log(`  [상세] ${n.district} — ${n.title}`);
    const detail = await fetchDetail(n.url);
    Object.assign(n, detail);
    console.log(`    주소: ${detail.address || '(추출 실패)'} / 담당부서: ${detail.contact_dept || '-'} / 연락처: ${detail.contact_phone || '-'}`);
    await new Promise(r => setTimeout(r, 300));
  }

  // 기존 공고와 URL 기준 병합 (중복 제거, 최신 수집 결과 우선)
  const byUrl = new Map(existing.notices.map(n => [n.url, n]));
  matched.forEach(n => byUrl.set(n.url, n));

  const merged = { updated_at: TODAY, notices: [...byUrl.values()] };
  fs.writeFileSync(DATA_FILE, JSON.stringify(merged, null, 2), 'utf-8');
  console.log(`[DONE] 위반건축물 관련 공고 누계 ${merged.notices.length}건 저장 완료 (이번 실행 신규 매칭 ${matched.length}건)`);
}

main().catch(e => { console.error('오류:', e); process.exit(1); });
