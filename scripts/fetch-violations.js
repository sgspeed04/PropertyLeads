/**
 * 위반건축물 공시송달 공고 자동 수집 스크립트 (파일럿: 강남구청)
 *
 * ── 배경 ──────────────────────────────────────────────────────────────────
 *  위반건축물은 서울시/경기도 재개발 데이터(fetch-redevelopment.js)와 달리
 *  전국 통합 오픈API가 없다. 대신 각 구청이 "위반건축물 철거명령 및
 *  이행강제금 부과 공시송달 공고" 게시판을 운영하며, 이는 소유주에게 직접
 *  연락이 닿지 않을 때 공개로 알리는 공고라 주소가 그대로 노출된다.
 *
 *  이 스크립트는 강남구청 게시판 하나를 대상으로 한 파일럿이다. 실제 페이지
 *  마크업을 사전 확인하지 못한 상태로 작성했으므로(개발 환경 네트워크 제약),
 *  여러 선택자 후보를 순서대로 시도하고 진단 로그를 남긴다. 처음 실행 후
 *  Actions 로그를 보고 선택자를 맞춰야 할 수 있다.
 * ─────────────────────────────────────────────────────────────────────────
 */

const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const DATA_FILE = path.join(__dirname, '..', 'data', 'violations_notices.json');
const TODAY = new Date().toISOString().split('T')[0];
const MAX_PAGES = 5;

const BOARDS = [
  {
    district: '강남구',
    listUrl: 'https://www.gangnam.go.kr/board/B_000046/list.do?mid=ID05_050209',
    pageParam: 'pageIndex',
  },
];

// 리스트 행에서 (제목, 링크)를 뽑아내기 위한 선택자 후보들 — 사이트마다 마크업이
// 달라서 위에서부터 순서대로 시도하고, 처음으로 결과가 나오는 후보를 사용한다.
const ROW_SELECTORS = [
  'table tbody tr td.subject a, table tbody tr td.title a',
  'table tbody tr a[href*="view.do"]',
  'ul.board-list li a[href*="view.do"]',
  'a[href*="view.do"]',
];

function absoluteUrl(base, href) {
  try { return new URL(href, base).toString(); } catch { return href; }
}

function extractDate(text) {
  const m = (text || '').match(/(20\d{2})[.\-\/](\d{1,2})[.\-\/](\d{1,2})/);
  if (!m) return null;
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
}

async function fetchPage(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'Accept-Language': 'ko-KR,ko;q=0.9',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
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
    console.log(`  [PARSE] 진단용 HTML 스니펫(앞 1500자):\n${html.slice(0, 1500)}`);
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

async function main() {
  let existing = { updated_at: TODAY, notices: [] };
  if (fs.existsSync(DATA_FILE)) {
    try { existing = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8')); } catch {}
  }

  const results = [];
  for (const board of BOARDS) {
    console.log(`[BOARD] ${board.district} 공고 게시판 수집 시작 — ${board.listUrl}`);
    try {
      const items = await fetchBoard(board);
      console.log(`[BOARD] ${board.district} 완료 — ${items.length}건`);
      results.push(...items);
    } catch (e) {
      console.error(`[BOARD] ${board.district} 실패: ${e.message}`);
    }
  }

  if (results.length === 0) {
    console.warn('[DONE] 수집된 공고가 없습니다 — 기존 데이터 유지, 선택자 점검 필요');
    return;
  }

  // 기존 공고와 URL 기준 병합 (중복 제거, 최신 수집 결과 우선)
  const byUrl = new Map(existing.notices.map(n => [n.url, n]));
  results.forEach(n => byUrl.set(n.url, n));

  const merged = { updated_at: TODAY, notices: [...byUrl.values()] };
  fs.writeFileSync(DATA_FILE, JSON.stringify(merged, null, 2), 'utf-8');
  console.log(`[DONE] 총 ${merged.notices.length}건 저장 완료`);
}

main().catch(e => { console.error('오류:', e); process.exit(1); });
