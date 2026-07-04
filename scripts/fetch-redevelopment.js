/**
 * 수도권(서울+경기) 재개발·재건축 데이터 자동 업데이트 스크립트
 *
 * ── GitHub Secrets ────────────────────────────────────────────────────────────
 *  SEOUL_API_KEY   : data.seoul.go.kr  (서울시 열린데이터광장)
 *  DATA_GO_KR_KEY  : data.go.kr        (공공데이터포털 — 서울+경기 모두 사용)
 *
 * ── 사용 API ──────────────────────────────────────────────────────────────────
 *  [서울] openapi.seoul.go.kr  서비스: upisRebuild              (6574건, 일간)
 *  [경기] apis.data.go.kr      서비스: GyeonggiUrbanRenewalInfo  (경기도 정비사업)
 *
 *  경기도 서비스명을 data.go.kr 에서 찾는 방법:
 *    → data.go.kr → 검색: "경기도 도시정비사업" → 오픈API 탭
 *    → 서비스명을 GG_SERVICE 상수에 입력
 * ─────────────────────────────────────────────────────────────────────────────
 */

const fs   = require('fs');
const path = require('path');

const DATA_FILE   = path.join(__dirname, '..', 'data', 'redevelopment.json');
const TODAY       = new Date().toISOString().split('T')[0];
const SEOUL_KEY   = process.env.SEOUL_API_KEY;
const DATA_GO_KEY = process.env.DATA_GO_KR_KEY;
const PAGE_SIZE   = 1000;

// ── 단계 매핑 ────────────────────────────────────────────────────────────────
const STAGE_MAP = [
  { key: '완료',     idx: 5 }, { key: '준공',     idx: 5 }, { key: '입주',     idx: 5 },
  { key: '착공',     idx: 4 }, { key: '이주',     idx: 4 }, { key: '철거',     idx: 4 },
  { key: '관리처분', idx: 3 },
  { key: '사업시행', idx: 2 },
  { key: '조합설립', idx: 1 }, { key: '추진위',   idx: 1 },
  { key: '정비구역', idx: 0 }, { key: '구역지정', idx: 0 },
];

function getStageIdx(name = '') {
  for (const { key, idx } of STAGE_MAP) {
    if (name.includes(key)) return idx;
  }
  return 0;
}

function normCoord(v) {
  const n = parseFloat(v) || 0;
  if (n > 900000) return n / 1e7;
  return n;
}

function isSeoulCoord(lat, lng) {
  return lat > 37.4 && lat < 37.7 && lng > 126.7 && lng < 127.3;
}
function isGyeonggiCoord(lat, lng) {
  return lat > 36.9 && lat < 38.3 && lng > 126.3 && lng < 127.8 && !isSeoulCoord(lat, lng);
}
function isMetroCoord(lat, lng) {
  return isSeoulCoord(lat, lng) || isGyeonggiCoord(lat, lng);
}

// ── 구(區)·시(市) 중심 좌표 ──────────────────────────────────────────────────
const DISTRICT_COORD = {
  // 서울 25개 구
  '종로구': [37.5926, 126.9794], '중구':    [37.5641, 126.9979],
  '용산구': [37.5311, 126.9788], '성동구':  [37.5635, 127.0366],
  '광진구': [37.5385, 127.0823], '동대문구':[37.5744, 127.0394],
  '중랑구': [37.6063, 127.0931], '성북구':  [37.5894, 127.0167],
  '강북구': [37.6396, 127.0253], '도봉구':  [37.6688, 127.0471],
  '노원구': [37.6542, 127.0568], '은평구':  [37.6026, 126.9291],
  '서대문구':[37.5792, 126.9368],'마포구':  [37.5638, 126.9086],
  '양천구': [37.5169, 126.8664], '강서구':  [37.5510, 126.8495],
  '구로구': [37.4954, 126.8874], '금천구':  [37.4570, 126.8951],
  '영등포구':[37.5262, 126.8966],'동작구':  [37.5124, 126.9393],
  '관악구': [37.4784, 126.9516], '서초구':  [37.4837, 127.0325],
  '강남구': [37.5172, 127.0473], '송파구':  [37.5145, 127.1059],
  '강동구': [37.5300, 127.1237],
  // 경기도 주요 시
  '수원시': [37.2636, 127.0286], '성남시':  [37.4201, 127.1263],
  '안양시': [37.3943, 126.9568], '부천시':  [37.5034, 126.7660],
  '광명시': [37.4784, 126.8659], '시흥시':  [37.3800, 126.8029],
  '안산시': [37.3219, 126.8310], '의왕시':  [37.3445, 126.9677],
  '군포시': [37.3616, 126.9348], '고양시':  [37.6584, 126.8320],
  '의정부시':[37.7380, 127.0339],'남양주시':[37.6360, 127.2161],
  '하남시': [37.5393, 127.2146], '광주시':  [37.4296, 127.2553],
  '용인시': [37.2411, 127.1776], '평택시':  [36.9921, 127.1129],
  '화성시': [37.1996, 126.8312], '오산시':  [37.1498, 127.0772],
  '구리시': [37.5943, 127.1296], '양주시':  [37.7852, 126.9994],
  '파주시': [37.7597, 126.7798], '김포시':  [37.6152, 126.7156],
  '이천시': [37.2794, 127.4428], '안성시':  [37.0078, 127.2797],
  '포천시': [37.8948, 127.2001], '여주시':  [37.2983, 127.6376],
  '동두천시':[37.9036, 127.0607],'과천시':  [37.4296, 126.9874],
};

// ── Seoul Open API 페이지 요청 ────────────────────────────────────────────────
async function fetchSeoulPage(serviceName, start, end) {
  const urls = [
    `https://openapi.seoul.go.kr:443/rest/${SEOUL_KEY}/json/${serviceName}/${start}/${end}/`,
    `http://openapi.seoul.go.kr:8088/${SEOUL_KEY}/json/${serviceName}/${start}/${end}/`,
  ];
  let lastErr;
  for (const url of urls) {
    try {
      const res  = await fetch(url);
      const json = await res.json();
      const root = json[serviceName] || json;
      if (root.RESULT) {
        const code = root.RESULT.CODE || '';
        const msg  = root.RESULT.MESSAGE || code;
        if (!code.includes('INFO-000')) throw new Error(`API 오류: ${msg}`);
      }
      return { rows: root.row || [], total: parseInt(root.list_total_count || 0) };
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

async function fetchSeoulAllPages(serviceName) {
  const first   = await fetchSeoulPage(serviceName, 1, PAGE_SIZE);
  const allRows = [...first.rows];
  const total   = first.total || allRows.length;
  console.log(`[SEOUL API] ${serviceName}: 전체 ${total}건`);
  let start = PAGE_SIZE + 1;
  while (start <= total) {
    const end = Math.min(start + PAGE_SIZE - 1, total);
    const { rows } = await fetchSeoulPage(serviceName, start, end);
    allRows.push(...rows);
    console.log(`  …페이지 ${Math.ceil(start / PAGE_SIZE) + 1} 수신 (누계 ${allRows.length})`);
    start = end + 1;
    await new Promise(r => setTimeout(r, 200));
  }
  return allRows;
}

// ── data.go.kr 경기도 API 페이지 요청 ────────────────────────────────────────
// data.go.kr REST API 형식 A (JSON, REST)
async function fetchDataGoPage(baseUrl, params, pageNo, numOfRows) {
  const qs = new URLSearchParams({
    ...params,
    serviceKey: DATA_GO_KEY,
    pageNo,
    numOfRows,
    _type: 'json',
  });
  const res  = await fetch(`${baseUrl}?${qs}`);
  const json = await res.json();
  // data.go.kr 응답 구조: json.response.body.items.item / totalCount
  const body  = json?.response?.body;
  if (!body) {
    const resultCode = json?.response?.header?.resultCode;
    if (resultCode && resultCode !== '00') throw new Error(`API 오류: ${json?.response?.header?.resultMsg}`);
    throw new Error('응답 구조 불명');
  }
  const items = body.items?.item;
  const rows  = !items ? [] : Array.isArray(items) ? items : [items];
  return { rows, total: parseInt(body.totalCount || 0) };
}

async function fetchDataGoAllPages(baseUrl, params) {
  const first   = await fetchDataGoPage(baseUrl, params, 1, PAGE_SIZE);
  const allRows = [...first.rows];
  const total   = first.total || allRows.length;
  console.log(`[DATA.GO.KR] ${baseUrl.split('/').pop()}: 전체 ${total}건`);
  let pageNo = 2;
  while ((pageNo - 1) * PAGE_SIZE < total) {
    const { rows } = await fetchDataGoPage(baseUrl, params, pageNo, PAGE_SIZE);
    if (rows.length === 0) break;
    allRows.push(...rows);
    console.log(`  …페이지 ${pageNo} 수신 (누계 ${allRows.length})`);
    pageNo++;
    await new Promise(r => setTimeout(r, 300));
  }
  return allRows;
}

// ── row → 프로젝트 객체 변환 ──────────────────────────────────────────────────
function rowToProject(r, idx, region = '서울') {
  const name      = r.RGN_NM || r.PSTN_NM || r.RPT_NM || r.SBSN_NM || r.JNGB_NM || '알 수 없음';
  const stageName = r.LCLSF  || r.MCLSF   || r.SCLSF  || r.STEP_NM || '';
  const typeName  = r.RPT_TYPE || r.JNGB_TYPE || '';
  // LOGVM returns "서울특별시 광진구" or "경기도 수원시" — extract just the 구/시 name
  const logvmRaw  = r.LOGVM  || r.SGG_NM  || r.SIGUNGU_NM || '';
  const district  = Object.keys(DISTRICT_COORD).find(k => logvmRaw.includes(k)) || logvmRaw;

  let lat = normCoord(r.CNTRD_Y || r.LAT || r.Y_COORD || r.LAT_CD || 0);
  let lng = normCoord(r.CNTRD_X || r.LON || r.X_COORD || r.LOT_CD || 0);
  if (!isMetroCoord(lat, lng)) {
    const center = DISTRICT_COORD[district];
    if (center) {
      lat = center[0] + (Math.random() - 0.5) * 0.02;
      lng = center[1] + (Math.random() - 0.5) * 0.02;
    }
  }

  return {
    id:           `${region === '서울' ? 'api' : 'gg'}_${idx}`,
    name,
    region,
    district,
    dong:         r.EMD_NM  || r.DONG_NM || '',
    type:         typeName.includes('재건축') ? '재건축' : '재개발',
    stage:        stageName,
    stage_idx:    getStageIdx(stageName),
    lat,
    lng,
    area_m2:      parseInt(r.AREA_EXS || r.TOT_AREA || r.ZONE_AR || 0),
    units:        parseInt(r.TOT_HSHLD || r.TOT_HSHLD_CO || r.PLAN_HH || 0),
    contractor:   r.CNSTR_CO_NM || '',
    stage_date:   (r.STEP_DT || r.PRGSRT_DE || '').substring(0, 7),
    notes:        '',
    subway:       '',
    hangang:      false,
    completion_est: '',
    ref_note:     '',
  };
}

// ── 기존 수작업 데이터와 병합 ────────────────────────────────────────────────
function mergeWithExisting(apiProjects, existingProjects) {
  const existingMap = new Map();
  for (const p of existingProjects) existingMap.set(p.name.trim(), p);
  return apiProjects.map(ap => {
    const ex = existingMap.get(ap.name.trim());
    if (!ex) return ap;
    return {
      ...ap,
      notes:          ex.notes          || ap.notes,
      subway:         ex.subway         || ap.subway,
      hangang:        ex.hangang        || ap.hangang,
      completion_est: ex.completion_est || ap.completion_est,
      ref_note:       ex.ref_note       || ap.ref_note,
    };
  });
}

// ── 서울 데이터 수집 ─────────────────────────────────────────────────────────
async function fetchSeoul(existing) {
  if (!SEOUL_KEY) {
    console.log('[SEOUL] SEOUL_API_KEY 없음 — 기존 서울 데이터 유지.');
    return existing.projects.filter(p => !p.region || p.region === '서울');
  }
  let rawRows = [];
  try {
    console.log('[SEOUL API] 시도: upisRebuild');
    rawRows = await fetchSeoulAllPages('upisRebuild');
    if (rawRows.length > 0) {
      console.log(`[SEOUL API] ✓ upisRebuild 성공 — ${rawRows.length}건`);
      console.log(`[FIELDS] ${Object.keys(rawRows[0]).join(', ')}`);
      console.log(`[SAMPLE] LOGVM="${rawRows[0].LOGVM}" RGN_NM="${rawRows[0].RGN_NM}"`);
    }
  } catch (e) {
    console.warn(`[SEOUL] 실패: ${e.message} — 기존 데이터 유지`);
    return existing.projects.filter(p => !p.region || p.region === '서울');
  }
  if (rawRows.length === 0) return existing.projects.filter(p => !p.region || p.region === '서울');

  const apiProjects = rawRows
    .map((r, i) => rowToProject(r, i, '서울'))
    .filter(p => isSeoulCoord(p.lat, p.lng) && p.name !== '알 수 없음' && p.district);
  console.log(`[SEOUL] 서울 구역 통과: ${apiProjects.length}건`);
  return mergeWithExisting(apiProjects, existing.projects);
}

// ── 경기도 데이터 수집 (data.go.kr 사용) ────────────────────────────────────
async function fetchGyeonggi(existing) {
  if (!DATA_GO_KEY) {
    console.log('[GG] DATA_GO_KR_KEY 없음 — 경기도 데이터 스킵.');
    return existing.projects.filter(p => p.region === '경기');
  }

  // data.go.kr에서 경기도 정비사업 데이터를 제공하는 API 후보
  // → data.go.kr 검색: "경기도 도시정비사업" 또는 "정비사업 현황 경기"
  const GG_API_CANDIDATES = [
    {
      // 국토교통부 도시정비사업 현황 (경기도 포함 전국)
      url: 'https://apis.data.go.kr/1613000/UrbanRenewalService/getUrbanRenewalList',
      params: { sido: '경기도' },
    },
    {
      // 국토부 공간정보 포털 — 정비구역 현황
      url: 'https://apis.data.go.kr/1613000/udip/getJeongbiGuyeokList',
      params: { ctprvnCd: '41' }, // 경기도 코드
    },
    {
      // 한국토지주택공사 정비사업
      url: 'https://apis.data.go.kr/1741000/RenovAreaService/getRenovAreaList',
      params: { sido: '경기' },
    },
    {
      // 전국 도시정비사업 현황 — 경기도 필터
      url: 'https://apis.data.go.kr/1613000/UrbanRenewalSvc/getUrbanRenewalSvcList',
      params: {},
    },
  ];

  let rawRows = [];
  let usedUrl = '';
  for (const { url, params } of GG_API_CANDIDATES) {
    try {
      const svcName = url.split('/').pop();
      console.log(`[GG API] 시도: ${svcName}`);
      const rows = await fetchDataGoAllPages(url, params);
      if (rows.length > 0) {
        rawRows = rows;
        usedUrl = url;
        console.log(`[GG API] ✓ ${svcName} 성공 — ${rows.length}건`);
        console.log(`[GG FIELDS] ${Object.keys(rows[0]).join(', ')}`);
        break;
      }
    } catch (e) {
      console.warn(`  ✗ ${url.split('/').pop()}: ${e.message}`);
    }
  }

  if (rawRows.length === 0) {
    console.warn('[GG] 모든 data.go.kr 서비스 실패 — 기존 경기도 데이터 유지.');
    console.warn('[GG] data.go.kr 에서 "경기도 도시정비사업" 검색 후 정확한 서비스명을 확인하세요.');
    return existing.projects.filter(p => p.region === '경기');
  }

  // 경기도인지 확인: 좌표 또는 지역명으로 필터
  const apiProjects = rawRows
    .map((r, i) => rowToProject(r, i, '경기'))
    .filter(p => isGyeonggiCoord(p.lat, p.lng) && p.name !== '알 수 없음' && p.district);
  console.log(`[GG] 경기 구역 통과: ${apiProjects.length}건`);
  return mergeWithExisting(apiProjects, existing.projects.filter(p => p.region === '경기'));
}

// ── 메인 ─────────────────────────────────────────────────────────────────────
async function main() {
  let existing = { updated_at: TODAY, source: 'sample', projects: [] };
  if (fs.existsSync(DATA_FILE)) {
    existing = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
    // 기존 프로젝트에 region 없으면 서울로 태그
    existing.projects = existing.projects.map(p => ({ region: '서울', ...p }));
  }

  const [seoulProjects, ggProjects] = await Promise.all([
    fetchSeoul(existing),
    fetchGyeonggi(existing),
  ]);

  const merged = [...seoulProjects, ...ggProjects];
  const seoulCount = seoulProjects.length;
  const ggCount    = ggProjects.length;

  existing.projects   = merged;
  existing.updated_at = TODAY;
  existing.source     = 'seoul_open_api' + (ggCount > 0 ? '+gg_open_api' : '');
  existing.note       = `수도권 실데이터 — 서울 ${seoulCount}개·경기 ${ggCount}개 구역 (${TODAY} 갱신)`;

  fs.writeFileSync(DATA_FILE, JSON.stringify(existing, null, 2), 'utf-8');
  console.log(`[DONE] 총 ${merged.length}개 구역 저장 완료 (서울 ${seoulCount} + 경기 ${ggCount})`);
}

main().catch(e => { console.error('오류:', e); process.exit(1); });
