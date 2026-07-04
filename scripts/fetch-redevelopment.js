/**
 * 서울시 재개발·재건축 데이터 자동 업데이트 스크립트
 *
 * ── API 키 발급 방법 ─────────────────────────────────────────────────────────
 *  1. https://data.seoul.go.kr 회원가입 (무료)
 *  2. 마이페이지 → 인증키 발급
 *  3. GitHub 저장소 → Settings → Secrets → Actions
 *     → New repository secret → Name: SEOUL_API_KEY, Value: 발급받은 키
 *
 * ── 사용 API ─────────────────────────────────────────────────────────────────
 *  서울시 열린데이터광장 — 도시정비사업 현황
 *  서비스명: SttsJeongseSBSNInfo  (정비구역 지정 이후 진행 중 전체)
 *  URL: http://openapi.seoul.go.kr:8088/{KEY}/json/SttsJeongseSBSNInfo/{start}/{end}/
 *
 *  * API 키가 없으면 기존 수작업 데이터(188개+)를 유지한 채 updated_at만 갱신
 *  * API 데이터 수신 성공 시, 기존 수작업 항목의 notes/ref_note/subway/hangang은 병합 보존
 * ─────────────────────────────────────────────────────────────────────────────
 */

const fs   = require('fs');
const path = require('path');

const DATA_FILE    = path.join(__dirname, '..', 'data', 'redevelopment.json');
const TODAY        = new Date().toISOString().split('T')[0];
const SEOUL_KEY    = process.env.SEOUL_API_KEY;
const PAGE_SIZE    = 1000;

// ── 단계 매핑 ────────────────────────────────────────────────────────────────
const STAGE_MAP = [
  { key: '완료',         idx: 5 },
  { key: '준공',         idx: 5 },
  { key: '입주',         idx: 5 },
  { key: '착공',         idx: 4 },
  { key: '이주',         idx: 4 },
  { key: '철거',         idx: 4 },
  { key: '관리처분',     idx: 3 },
  { key: '사업시행',     idx: 2 },
  { key: '조합설립',     idx: 1 },
  { key: '추진위',       idx: 1 },
  { key: '정비구역',     idx: 0 },
  { key: '구역지정',     idx: 0 },
];

function getStageIdx(name = '') {
  for (const { key, idx } of STAGE_MAP) {
    if (name.includes(key)) return idx;
  }
  return 0;
}

// ── 좌표 정규화 (서울 API는 도수×10^7 반환하는 경우 있음) ───────────────────
function normCoord(v) {
  const n = parseFloat(v) || 0;
  if (n > 900000) return n / 1e7;
  return n;
}

function isSeoulCoord(lat, lng) {
  return lat > 37.4 && lat < 37.7 && lng > 126.7 && lng < 127.3;
}

// ── 구(區) 중심 좌표 — upisRebuild는 좌표 없어서 LOGVM으로 대체 ─────────────
const DISTRICT_COORD = {
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
};

// ── Seoul Open API 단일 페이지 요청 ──────────────────────────────────────────
async function fetchPage(serviceName, start, end) {
  // HTTPS(443) 먼저 시도 — 일부 환경에서 HTTP:8088 차단
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
        console.log(`    [RESULT] ${code} — ${msg}`);
        if (!code.includes('INFO-000')) throw new Error(`API 오류: ${msg}`);
      }
      return { rows: root.row || [], total: parseInt(root.list_total_count || 0) };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

// ── 전체 페이지 순회 ──────────────────────────────────────────────────────────
async function fetchAllPages(serviceName) {
  const first = await fetchPage(serviceName, 1, PAGE_SIZE);
  const allRows = [...first.rows];
  const total   = first.total || allRows.length;

  console.log(`[SEOUL API] ${serviceName}: 전체 ${total}건`);

  let start = PAGE_SIZE + 1;
  while (start <= total) {
    const end = Math.min(start + PAGE_SIZE - 1, total);
    const { rows } = await fetchPage(serviceName, start, end);
    allRows.push(...rows);
    console.log(`  …페이지 ${Math.ceil(start / PAGE_SIZE) + 1} 수신 (누계 ${allRows.length})`);
    start = end + 1;
    await new Promise(r => setTimeout(r, 200));
  }

  return allRows;
}

// ── API row → 프로젝트 객체 변환 ─────────────────────────────────────────────
function rowToProject(r, idx) {
  // upisRebuild 실제 필드명 기준
  const name      = r.RGN_NM || r.PSTN_NM || r.RPT_NM || r.SBSN_NM || '알 수 없음';
  const stageName = r.LCLSF  || r.MCLSF   || r.SCLSF  || '';
  const typeName  = r.RPT_TYPE || '';
  const district  = r.LOGVM  || r.SGG_NM  || '';

  // 좌표 없으면 구 중심 좌표로 대체 (약간 랜덤 분산으로 겹침 방지)
  let lat = normCoord(r.CNTRD_Y || r.LAT || r.Y_COORD || 0);
  let lng = normCoord(r.CNTRD_X || r.LON || r.X_COORD || 0);
  if (!isSeoulCoord(lat, lng)) {
    const center = DISTRICT_COORD[district];
    if (center) {
      lat = center[0] + (Math.random() - 0.5) * 0.02;
      lng = center[1] + (Math.random() - 0.5) * 0.02;
    }
  }

  return {
    id:           `api_${idx}`,
    name,
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

// ── 기존 수작업 데이터와 병합 (notes/ref_note 등 보존) ───────────────────────
function mergeWithExisting(apiProjects, existingProjects) {
  const existingMap = new Map();
  for (const p of existingProjects) {
    existingMap.set(p.name.trim(), p);
  }

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

// ── 메인 ─────────────────────────────────────────────────────────────────────
async function main() {
  let existing = { updated_at: TODAY, source: 'sample', projects: [] };
  if (fs.existsSync(DATA_FILE)) {
    existing = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  }

  if (!SEOUL_KEY) {
    console.log('[INFO] SEOUL_API_KEY 없음 — 기존 데이터 유지, 타임스탬프만 갱신.');
    console.log('[INFO] data.seoul.go.kr 에서 무료 API 키를 발급하세요.');
    existing.updated_at = TODAY;
    fs.writeFileSync(DATA_FILE, JSON.stringify(existing, null, 2), 'utf-8');
    return;
  }

  const SERVICE_CANDIDATES = [
    'upisRebuild',                // ✓ 서울시 도시계획 정비사업 목록 (6574건, 일간 갱신)
  ];

  let rawRows = [];
  for (const svc of SERVICE_CANDIDATES) {
    try {
      console.log(`[SEOUL API] 시도: ${svc}`);
      rawRows = await fetchAllPages(svc);
      if (rawRows.length > 0) {
        console.log(`[SEOUL API] ✓ ${svc} 성공 — ${rawRows.length}건`);
        console.log(`[FIELDS] 첫번째 row 키: ${Object.keys(rawRows[0]).join(', ')}`);
        break;
      }
    } catch (e) {
      console.warn(`  ✗ ${svc}: ${e.message}`);
    }
  }

  if (rawRows.length === 0) {
    console.warn('[SEOUL API] 모든 서비스 실패 — 기존 데이터 유지.');
    existing.updated_at = TODAY;
    fs.writeFileSync(DATA_FILE, JSON.stringify(existing, null, 2), 'utf-8');
    return;
  }

  // 변환 + 필터 (서울 구에 해당하는 것만)
  const apiProjects = rawRows
    .map((r, i) => rowToProject(r, i))
    .filter(p => isSeoulCoord(p.lat, p.lng) && p.name !== '알 수 없음' && p.district);

  console.log(`[PROCESS] 서울 구역 통과: ${apiProjects.length}건`);

  // 기존 수작업 데이터와 병합
  const merged = mergeWithExisting(apiProjects, existing.projects);

  existing.projects   = merged;
  existing.updated_at = TODAY;
  existing.source     = 'seoul_open_api';
  existing.note       = `서울시 열린데이터광장 실데이터 — ${merged.length}개 구역 (${TODAY} 갱신)`;

  fs.writeFileSync(DATA_FILE, JSON.stringify(existing, null, 2), 'utf-8');
  console.log(`[DONE] ${merged.length}개 구역 저장 완료 (${TODAY})`);
}

main().catch(e => { console.error('오류:', e); process.exit(1); });
